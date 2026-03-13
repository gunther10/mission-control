import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildOperatorSnapshot, type OperatorSnapshot } from '@/lib/operator-snapshot'
import { config } from '@/lib/config'

export interface TelegramStatusState {
  agentKey: string
  chatId: string
  messageId: number
  pinnedAt?: number
  lastSyncedAt?: number
}

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

interface TelegramMessageResult {
  message_id: number
  chat?: { id?: number | string }
}

export const TELEGRAM_STATUS_REFRESH_EVERY_MS = 5 * 60 * 1000
export const TELEGRAM_STATUS_AGENT_KEY = 'chandler'
export const TELEGRAM_STATUS_CHAT_ID = '-5289821512'

function formatBindingSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_')
}

export const STATUS_STATE_PATH = config.openclawStateDir
  ? path.join(
      config.openclawStateDir,
      'mission-control',
      `telegram-status-state.${formatBindingSegment(TELEGRAM_STATUS_AGENT_KEY)}.${formatBindingSegment(TELEGRAM_STATUS_CHAT_ID)}.json`,
    )
  : path.join(
      process.cwd(),
      '.data',
      `telegram-status-state.${formatBindingSegment(TELEGRAM_STATUS_AGENT_KEY)}.${formatBindingSegment(TELEGRAM_STATUS_CHAT_ID)}.json`,
    )

function resolveBotToken() {
  return (
    process.env.MC_TELEGRAM_STATUS_BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN ||
    ''
  ).trim()
}

function resolveBoundChatId() {
  return TELEGRAM_STATUS_CHAT_ID
}

function resolveDefaultPin() {
  const raw = (process.env.MC_TELEGRAM_STATUS_PIN || 'true').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'no'
}

export async function readTelegramStatusState(): Promise<TelegramStatusState | null> {
  try {
    const raw = await readFile(STATUS_STATE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<TelegramStatusState>
    if (!parsed.chatId || typeof parsed.messageId !== 'number') return null
    return {
      agentKey: String(parsed.agentKey || TELEGRAM_STATUS_AGENT_KEY),
      chatId: String(parsed.chatId),
      messageId: parsed.messageId,
      pinnedAt: typeof parsed.pinnedAt === 'number' ? parsed.pinnedAt : undefined,
      lastSyncedAt: typeof parsed.lastSyncedAt === 'number' ? parsed.lastSyncedAt : undefined,
    }
  } catch {
    return null
  }
}

async function writeTelegramStatusState(state: TelegramStatusState) {
  await mkdir(path.dirname(STATUS_STATE_PATH), { recursive: true })
  await writeFile(STATUS_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
}

function formatTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleString('en-GB', {
    hour12: false,
    timeZone: 'Europe/Lisbon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatLisbonClock(timestamp: number) {
  return new Date(timestamp).toLocaleString('en-GB', {
    hour12: false,
    timeZone: 'Europe/Lisbon',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatAgeCompact(timestamp?: number, now = Date.now()) {
  if (!timestamp) return '—'
  const deltaMs = Math.max(0, now - timestamp)
  const minutes = Math.floor(deltaMs / 60000)
  if (minutes < 1) return '0m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function statusEmoji(state?: string) {
  switch (state) {
    case 'waiting_for_human':
    case 'waiting_for_approval':
      return '🟠'
    case 'blocked':
    case 'failed':
    case 'reconnecting':
      return '🔴'
    case 'running':
      return '🟢'
    case 'waiting_for_schedule':
    case 'queued':
      return '🟡'
    case 'completed':
      return '⚪️'
    default:
      return '⚪️'
  }
}

function compactReason(reason?: string, max = 120) {
  const value = (reason || '').replace(/\s+/g, ' ').trim()
  if (!value) return 'No detail'
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function formatOperatorSnapshotTelegramMessage(snapshot: OperatorSnapshot, options?: { now?: number }) {
  const now = options?.now ?? Date.now()
  const leadEmoji = statusEmoji(snapshot.focus.status.state || snapshot.summary.connectionStatus.state)
  const focusAge = formatAgeCompact(snapshot.focus.status.lastProgressAt || snapshot.summary.lastEventAt, now)
  const updatedAge = formatAgeCompact(snapshot.generatedAt, now)
  const nextExpected = snapshot.focus.status.nextExpectedAt || snapshot.summary.nextExpectedAt
  const nextText = nextExpected ? compactReason(new Date(nextExpected).toLocaleString('en-GB', {
    hour12: false,
    timeZone: 'Europe/Lisbon',
    hour: '2-digit',
    minute: '2-digit',
  }), 16) : '—'

  const lines = [
    `${leadEmoji} <b>MC ${escapeHtml(formatLisbonClock(now))}</b>`,
    `${escapeHtml(snapshot.summary.headline)} · run ${snapshot.summary.running} · wait ${snapshot.summary.waitingOnYou} · block ${snapshot.summary.blocked}`,
    `<b>${escapeHtml(snapshot.focus.label)}</b> — ${escapeHtml(snapshot.focus.status.label)}`,
    escapeHtml(compactReason(snapshot.focus.status.reason, 160)),
    `Age: ${escapeHtml(focusAge)} · Updated: ${escapeHtml(updatedAge)} · Next: ${escapeHtml(nextText)}`,
    `Action: ${escapeHtml(compactReason(snapshot.focus.status.actionRequired || snapshot.summary.reason, 140))}`,
  ]

  return lines.join('\n')
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

async function telegramRequest<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = resolveBotToken()
  if (!token) throw new Error('Telegram status bot token not configured (set MC_TELEGRAM_STATUS_BOT_TOKEN or TELEGRAM_BOT_TOKEN)')

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })

  const payload = (await res.json()) as TelegramApiResponse<T>
  if (!res.ok || !payload.ok || !payload.result) {
    throw new Error(payload.description || `Telegram ${method} failed with HTTP ${res.status}`)
  }
  return payload.result
}

function isRecoverableEditFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /message to edit not found|message can't be edited|chat not found|message identifier is not specified/i.test(message)
}

export function shouldRefreshTelegramStatus(state: TelegramStatusState | null, now = Date.now()) {
  if (!state?.lastSyncedAt) return true
  return now - state.lastSyncedAt >= TELEGRAM_STATUS_REFRESH_EVERY_MS
}

export async function syncOperatorSnapshotToTelegram(options?: {
  workspaceId?: number
  pin?: boolean
}) {
  const workspaceId = options?.workspaceId ?? 1
  const snapshot = await buildOperatorSnapshot(workspaceId)
  const text = formatOperatorSnapshotTelegramMessage(snapshot)
  const existingState = await readTelegramStatusState()
  const chatId = resolveBoundChatId().trim()
  if (!chatId) {
    throw new Error('Telegram status chat binding is empty')
  }

  const shouldPin = options?.pin ?? resolveDefaultPin()
  let state = existingState && existingState.agentKey === TELEGRAM_STATUS_AGENT_KEY && existingState.chatId === chatId ? existingState : null
  let mode: 'edited' | 'created' = 'created'

  if (state?.messageId) {
    try {
      await telegramRequest<TelegramMessageResult>('editMessageText', {
        chat_id: chatId,
        message_id: state.messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      })
      mode = 'edited'
    } catch (error) {
      if (!isRecoverableEditFailure(error)) throw error
      state = null
    }
  }

  if (!state) {
    const created = await telegramRequest<TelegramMessageResult>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
    state = {
      agentKey: TELEGRAM_STATUS_AGENT_KEY,
      chatId: String(created.chat?.id ?? chatId),
      messageId: created.message_id,
    }
    mode = 'created'
    if (shouldPin) {
      try {
        await telegramRequest<true>('pinChatMessage', {
          chat_id: state.chatId,
          message_id: state.messageId,
          disable_notification: true,
        })
        state.pinnedAt = Date.now()
      } catch {
        // Best effort only. Telegram pin permissions vary by chat type/admin rights.
      }
    }
  }

  state.lastSyncedAt = Date.now()
  await writeTelegramStatusState(state)

  return {
    mode,
    state,
    snapshot,
    statePath: STATUS_STATE_PATH,
    refreshEveryMs: TELEGRAM_STATUS_REFRESH_EVERY_MS,
    nextRefreshAt: state.lastSyncedAt + TELEGRAM_STATUS_REFRESH_EVERY_MS,
    editSameMessage: true,
  }
}
