import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { buildGatewayWebSocketUrl } from '@/lib/gateway-url'
import { getDetectedGatewayToken } from '@/lib/gateway-runtime'

interface GatewayEntry {
  id: number
  host: string
  port: number
  token: string
  is_primary: number
}

function inferBrowserProtocol(request: NextRequest): 'http:' | 'https:' {
  const forwardedProto = String(request.headers.get('x-forwarded-proto') || '').split(',')[0]?.trim().toLowerCase()
  if (forwardedProto === 'https') return 'https:'
  if (forwardedProto === 'http') return 'http:'

  const origin = request.headers.get('origin') || request.headers.get('referer') || ''
  if (origin) {
    try {
      const parsed = new URL(origin)
      if (parsed.protocol === 'https:') return 'https:'
      if (parsed.protocol === 'http:') return 'http:'
    } catch {
      // ignore and continue fallback resolution
    }
  }

  if (request.nextUrl.protocol === 'https:') return 'https:'
  return 'http:'
}

const LOCALHOST_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'host.docker.internal'])

/**
 * Detect the browser-facing Tailscale Serve path that proxies to the OpenClaw gateway.
 *
 * Checks in order:
 * 1. `tailscale serve status --json` — find the handler that proxies to the gateway (authoritative)
 * 2. Fallback: `gateway.controlUi.basePath` when `gateway.tailscale.mode === 'serve'` in openclaw.json (legacy)
 */
function detectTailscaleServeGatewayPath(): string | null {
  // 1. Check live Tailscale Serve config for a handler proxying to the gateway.
  try {
    const { execFileSync } = require('node:child_process')
    const raw = execFileSync('tailscale', ['serve', 'status', '--json'], {
      timeout: 3000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const config = JSON.parse(raw)
    const web = config?.Web
    if (web) {
      for (const host of Object.values(web) as any[]) {
        const handlers = (host as any)?.Handlers || {}
        for (const [routePath, handler] of Object.entries(handlers) as Array<[string, any]>) {
          const proxy = String(handler?.Proxy || '').trim()
          if (!proxy) continue
          if (
            proxy.startsWith('http://127.0.0.1:18789') ||
            proxy.startsWith('http://localhost:18789') ||
            proxy.startsWith('http://[::1]:18789')
          ) {
            return routePath || '/'
          }
        }
      }
    }
  } catch {
    // tailscale CLI not available or not running — fall through
  }

  // 2. Legacy: check openclaw.json config
  const configPath = process.env.OPENCLAW_CONFIG_PATH || ''
  if (!configPath) return null
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const config = JSON.parse(raw)
    if (config?.gateway?.tailscale?.mode === 'serve') {
      return String(config?.gateway?.controlUi?.basePath || '/').trim() || '/'
    }
    return null
  } catch {
    return null
  }
}

/** Cache detected Tailscale Serve gateway path with 60-second TTL. */
let _tailscaleServeCache: { value: string | null; expiresAt: number } | null = null
const TAILSCALE_CACHE_TTL_MS = 60_000
function getTailscaleServeGatewayPath(): string | null {
  const now = Date.now()
  if (!_tailscaleServeCache || now > _tailscaleServeCache.expiresAt) {
    _tailscaleServeCache = { value: detectTailscaleServeGatewayPath(), expiresAt: now + TAILSCALE_CACHE_TTL_MS }
  }
  return _tailscaleServeCache.value
}

/** Extract the browser-facing hostname from the request. */
function getBrowserHostname(request: NextRequest): string {
  const origin = request.headers.get('origin') || request.headers.get('referer') || ''
  if (origin) {
    try { return new URL(origin).hostname } catch { /* ignore */ }
  }
  const hostHeader = request.headers.get('host') || ''
  return hostHeader.split(':')[0]
}

/**
 * When the gateway is on localhost but the browser is remote, resolve the
 * correct WebSocket URL the browser should use.
 *
 * - Tailscale Serve mode: `wss://<dashboard-host><serve-path>`
 * - Otherwise: rewrite host to dashboard hostname with the gateway port
 */
function resolveRemoteGatewayUrl(
  gateway: { host: string; port: number },
  request: NextRequest,
): string | null {
  const normalized = (gateway.host || '').toLowerCase().trim()
  if (!LOCALHOST_HOSTS.has(normalized)) return null // remote host — use normal path

  const browserHost = getBrowserHostname(request)
  if (!browserHost || LOCALHOST_HOSTS.has(browserHost.toLowerCase())) return null // local access

  // Browser is remote — determine the correct proxied URL
  const tailscaleServePath = getTailscaleServeGatewayPath()
  if (tailscaleServePath) {
    // Tailscale Serve proxies the detected path → localhost gateway with TLS.
    const normalizedPath = tailscaleServePath === '/' ? '' : tailscaleServePath.replace(/\/+$/, '')
    return `wss://${browserHost}${normalizedPath}`
  }

  // No Tailscale Serve — try direct connection to dashboard host on gateway port
  const protocol = inferBrowserProtocol(request) === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${browserHost}:${gateway.port}`
}

function ensureTable(db: ReturnType<typeof getDatabase>) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      host TEXT NOT NULL DEFAULT '127.0.0.1',
      port INTEGER NOT NULL DEFAULT 18789,
      token TEXT NOT NULL DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_seen INTEGER,
      latency INTEGER,
      sessions_count INTEGER NOT NULL DEFAULT 0,
      agents_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
}

/**
 * POST /api/gateways/connect
 * Resolves websocket URL and token for a selected gateway without exposing tokens in list payloads.
 */
export async function POST(request: NextRequest) {
  // Any authenticated dashboard user may initiate a gateway websocket connect.
  // Restricting this to operator can cause startup fallback to connect without auth,
  // which then fails as "device identity required".
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = getDatabase()
  ensureTable(db)

  let id: number | null = null
  try {
    const body = await request.json()
    id = Number(body?.id)
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!id || !Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const gateway = db.prepare('SELECT id, host, port, token, is_primary FROM gateways WHERE id = ?').get(id) as GatewayEntry | undefined
  if (!gateway) {
    return NextResponse.json({ error: 'Gateway not found' }, { status: 404 })
  }

  // When gateway host is localhost but the browser is remote (e.g. Tailscale),
  // resolve the correct browser-accessible WebSocket URL.
  const remoteUrl = resolveRemoteGatewayUrl(gateway, request)
  const ws_url = remoteUrl || buildGatewayWebSocketUrl({
    host: gateway.host,
    port: gateway.port,
    browserProtocol: inferBrowserProtocol(request),
  })

  const dbToken = (gateway.token || '').trim()
  const detectedToken = gateway.is_primary === 1 ? getDetectedGatewayToken() : ''
  const token = detectedToken || dbToken

  // Keep runtime DB aligned with detected OpenClaw gateway token for primary gateway.
  if (gateway.is_primary === 1 && detectedToken && detectedToken !== dbToken) {
    try {
      db.prepare('UPDATE gateways SET token = ?, updated_at = (unixepoch()) WHERE id = ?').run(detectedToken, gateway.id)
    } catch {
      // Non-fatal: connect still succeeds with detected token even if persistence fails.
    }
  }

  return NextResponse.json({
    id: gateway.id,
    ws_url,
    token,
    token_set: token.length > 0,
  })
}
