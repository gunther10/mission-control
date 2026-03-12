import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '@/lib/config'
import { getDatabase, type Task as DbTask } from '@/lib/db'
import { getAllGatewaySessions } from '@/lib/sessions'
import {
  deriveConnectionOperatorStatus,
  deriveSessionOperatorStatus,
  deriveTaskOperatorStatus,
  summarizeOperatorStatus,
  type OperatorStatus,
} from '@/lib/operator-status'
import type { ConnectionStatus, CronJob, ExecApprovalRequest, Session, SpawnRequest, Task } from '@/store'

interface OpenClawCronJob {
  id: string
  agentId: string
  name: string
  enabled: boolean
  schedule: {
    kind: string
    expr: string
    tz?: string
  }
  payload: {
    kind: string
    message?: string
    model?: string
  }
  delivery?: {
    mode: string
    channel?: string
  }
  state?: {
    nextRunAtMs?: number
    lastRunAtMs?: number
    lastStatus?: string
    lastError?: string
  }
}

interface OpenClawCronFile {
  version: number
  jobs: OpenClawCronJob[]
}

export interface OperatorSnapshotItem<T = Record<string, unknown>> {
  kind: 'task' | 'session' | 'system'
  id: string
  label: string
  status: OperatorStatus
  data?: T
}

export interface OperatorSnapshot {
  generatedAt: number
  summary: ReturnType<typeof summarizeOperatorStatus> & {
    headline: string
    reason: string
  }
  focus: OperatorSnapshotItem
  connection: {
    raw: ConnectionStatus
    status: OperatorStatus
  }
  tasks: OperatorSnapshotItem[]
  sessions: OperatorSnapshotItem[]
  meta: {
    workspaceId: number
    totalTasks: number
    totalSessions: number
    totalCronJobs: number
    pendingApprovals: number
    spawnRequestsTracked: number
  }
}

function formatTokens(total: number) {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`
  return `${total}`
}

function formatAge(timestamp: number) {
  if (!timestamp) return 'unknown'
  const deltaMs = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(deltaMs / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function mapGatewaySessionsToStoreShape(): Session[] {
  const sessionMap = new Map<string, ReturnType<typeof getAllGatewaySessions>[number]>()
  for (const session of getAllGatewaySessions()) {
    const id = session.sessionId || `${session.agent}:${session.key}`
    const existing = sessionMap.get(id)
    if (!existing || session.updatedAt > existing.updatedAt) {
      sessionMap.set(id, session)
    }
  }

  return Array.from(sessionMap.values()).map((session) => {
    const total = session.totalTokens || 0
    const context = session.contextTokens || 35000
    const pct = context > 0 ? Math.round((total / context) * 100) : 0
    return {
      id: session.sessionId || `${session.agent}:${session.key}`,
      key: session.key,
      kind: session.chatType || 'unknown',
      age: formatAge(session.updatedAt),
      model: session.model,
      tokens: `${formatTokens(total)}/${formatTokens(context)} (${pct}%)`,
      flags: [],
      active: session.active,
      startTime: session.updatedAt,
      lastActivity: session.updatedAt,
      label: session.key,
    }
  })
}

function mapLastStatus(status?: string): 'success' | 'error' | 'running' | undefined {
  if (!status) return undefined
  const normalized = status.toLowerCase()
  if (normalized === 'success' || normalized === 'completed' || normalized === 'updated') return 'success'
  if (normalized === 'error' || normalized === 'failed') return 'error'
  if (normalized === 'running' || normalized === 'pending') return 'running'
  return 'success'
}

function mapOpenClawJob(job: OpenClawCronJob): CronJob {
  const payloadSummary = job.payload.message
    ? job.payload.message.slice(0, 200) + (job.payload.message.length > 200 ? '...' : '')
    : `${job.payload.kind} (${job.agentId})`

  const schedule = job.schedule.tz ? `${job.schedule.expr} (${job.schedule.tz})` : job.schedule.expr

  return {
    id: job.id,
    name: job.name,
    schedule,
    command: payloadSummary,
    enabled: job.enabled,
    lastRun: job.state?.lastRunAtMs,
    nextRun: job.state?.nextRunAtMs,
    lastStatus: mapLastStatus(job.state?.lastStatus),
    lastError: job.state?.lastError,
    agentId: job.agentId,
    timezone: job.schedule.tz,
    model: job.payload.model,
    delivery: job.delivery?.mode === 'none' ? undefined : job.delivery?.channel,
  }
}

async function loadCronJobs(): Promise<CronJob[]> {
  if (!config.openclawStateDir) return []
  const filePath = path.join(config.openclawStateDir, 'cron', 'jobs.json')
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as OpenClawCronFile | null
    return Array.isArray(parsed?.jobs) ? parsed.jobs.map(mapOpenClawJob) : []
  } catch {
    return []
  }
}

async function loadExecApprovals(): Promise<ExecApprovalRequest[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(`http://${config.gatewayHost}:${config.gatewayPort}/api/exec-approvals`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    clearTimeout(timeout)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data?.approvals) ? data.approvals : []
  } catch {
    clearTimeout(timeout)
    return []
  }
}

async function inferConnectionStatus(sessions: Session[]): Promise<ConnectionStatus> {
  const now = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)

  try {
    const res = await fetch(`http://${config.gatewayHost}:${config.gatewayPort}/`, {
      signal: controller.signal,
      cache: 'no-store',
    })
    clearTimeout(timeout)

    const isConnected = res.ok
    return {
      isConnected,
      url: `http://${config.gatewayHost}:${config.gatewayPort}`,
      lastConnected: isConnected ? new Date(now) : undefined,
      reconnectAttempts: 0,
      latency: undefined,
      state: isConnected ? 'connected' : 'blocked',
      reason: isConnected ? 'Gateway reachable' : `Gateway returned HTTP ${res.status}`,
      lastEventAt: sessions[0]?.lastActivity || now,
    }
  } catch (error: any) {
    clearTimeout(timeout)
    const lastSeen = sessions[0]?.lastActivity
    return {
      isConnected: false,
      url: `http://${config.gatewayHost}:${config.gatewayPort}`,
      reconnectAttempts: 0,
      state: lastSeen ? 'disconnected' : 'blocked',
      reason: lastSeen ? 'Gateway unreachable; using last observed session state' : 'Gateway unreachable',
      lastError: error?.name === 'AbortError' ? 'Gateway request timed out' : error?.message,
      lastEventAt: lastSeen || now,
    }
  }
}

function mapTaskRow(task: DbTask & Record<string, any>): Task {
  return {
    ...task,
    tags: task.tags ? JSON.parse(task.tags) : [],
    metadata: task.metadata ? JSON.parse(task.metadata) : {},
    ticket_ref:
      task.project_prefix && typeof task.project_ticket_no === 'number' && Number.isFinite(task.project_ticket_no)
        ? `${task.project_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
        : undefined,
  } as Task
}

function loadTasks(workspaceId: number): Task[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT t.*, p.name as project_name, p.ticket_prefix as project_prefix
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.workspace_id = ?
    ORDER BY t.updated_at DESC
    LIMIT 200
  `).all(workspaceId) as Array<DbTask & Record<string, any>>

  return rows.map(mapTaskRow)
}

function chooseHeadline(summary: ReturnType<typeof summarizeOperatorStatus>) {
  if (summary.waitingOnYou > 0) {
    return {
      headline: 'Waiting on you',
      reason: `${summary.waitingOnYou} item${summary.waitingOnYou === 1 ? '' : 's'} need your reply or approval`,
    }
  }

  if (summary.blocked > 0) {
    return {
      headline: 'Blocked work exists',
      reason: `${summary.blocked} item${summary.blocked === 1 ? '' : 's'} are blocked, failed, or reconnecting`,
    }
  }

  if (summary.running > 0) {
    return {
      headline: 'Work is running',
      reason: `${summary.running} active run${summary.running === 1 ? '' : 's'} currently making progress`,
    }
  }

  return {
    headline: 'No active blockers',
    reason: summary.connectionStatus.reason,
  }
}

function prioritizeItems(items: OperatorSnapshotItem[]) {
  const score = (item: OperatorSnapshotItem) => {
    switch (item.status.state) {
      case 'waiting_for_human':
      case 'waiting_for_approval':
        return 0
      case 'blocked':
      case 'failed':
      case 'reconnecting':
        return 1
      case 'running':
        return 2
      case 'waiting_for_schedule':
        return 3
      case 'queued':
        return 4
      case 'completed':
        return 5
      default:
        return 6
    }
  }

  return [...items].sort((a, b) => {
    const scoreDelta = score(a) - score(b)
    if (scoreDelta !== 0) return scoreDelta
    return (b.status.lastProgressAt || 0) - (a.status.lastProgressAt || 0)
  })
}

export async function buildOperatorSnapshot(workspaceId: number): Promise<OperatorSnapshot> {
  const [sessions, cronJobs, execApprovals] = await Promise.all([
    Promise.resolve(mapGatewaySessionsToStoreShape()),
    loadCronJobs(),
    loadExecApprovals(),
  ])

  const connection = await inferConnectionStatus(sessions)
  const tasks = loadTasks(workspaceId)
  const spawnRequests: SpawnRequest[] = []

  const summary = summarizeOperatorStatus({
    sessions,
    connection,
    execApprovals,
    spawnRequests,
    cronJobs,
  })

  const taskItems = prioritizeItems(
    tasks.map((task) => ({
      kind: 'task' as const,
      id: String(task.id),
      label: task.title,
      status: deriveTaskOperatorStatus({
        task,
        sessions,
        connection,
        execApprovals,
        spawnRequests,
        cronJobs,
      }),
      data: {
        ticketRef: task.ticket_ref,
        projectName: task.project_name,
        assignedTo: task.assigned_to,
        priority: task.priority,
        status: task.status,
      },
    }))
  )

  const sessionItems = prioritizeItems(
    sessions.map((session) => ({
      kind: 'session' as const,
      id: session.id,
      label: session.label || session.key,
      status: deriveSessionOperatorStatus({
        session,
        connection,
        execApprovals,
        spawnRequests,
        cronJobs,
      }),
      data: {
        key: session.key,
        model: session.model,
        kind: session.kind,
        active: session.active,
      },
    }))
  )

  const focus = taskItems[0] || sessionItems[0] || {
    kind: 'system' as const,
    id: 'connection',
    label: 'System',
    status: deriveConnectionOperatorStatus(connection),
  }

  const message = chooseHeadline(summary)

  return {
    generatedAt: Date.now(),
    summary: {
      ...summary,
      ...message,
    },
    focus,
    connection: {
      raw: connection,
      status: deriveConnectionOperatorStatus(connection),
    },
    tasks: taskItems.slice(0, 10),
    sessions: sessionItems.slice(0, 10),
    meta: {
      workspaceId,
      totalTasks: tasks.length,
      totalSessions: sessions.length,
      totalCronJobs: cronJobs.length,
      pendingApprovals: execApprovals.filter((approval) => approval.status === 'pending').length,
      spawnRequestsTracked: spawnRequests.length,
    },
  }
}
