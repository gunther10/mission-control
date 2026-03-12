import type { CronJob, ExecApprovalRequest, Session, SpawnRequest, Task, ConnectionStatus } from '@/store'

export type OperatorState =
  | 'running'
  | 'queued'
  | 'waiting_for_human'
  | 'waiting_for_approval'
  | 'waiting_for_schedule'
  | 'reconnecting'
  | 'blocked'
  | 'completed'
  | 'failed'

export interface OperatorStatus {
  state: OperatorState
  label: string
  tone: 'green' | 'yellow' | 'red' | 'blue' | 'gray' | 'purple'
  reason: string
  since?: number
  nextExpectedAt?: number
  lastProgressAt?: number
  actionRequired?: string
}

function matchSessionRef(session: Session, ref?: string | null) {
  if (!ref) return false
  return ref === session.id || ref === session.key || session.key.includes(ref) || ref.includes(session.key)
}

function inferCronForSession(session: Session, cronJobs: CronJob[]) {
  const loweredKey = session.key.toLowerCase()
  return cronJobs.find((job) => {
    const name = (job.name || '').toLowerCase()
    const agentId = (job.agentId || '').toLowerCase()
    return (name && loweredKey.includes(name)) || (agentId && loweredKey.includes(`:${agentId}:`))
  })
}

function lastProgressForSession(session: Session, connection: ConnectionStatus) {
  return session.lastActivity || session.startTime || connection.lastEventAt
}

export function getOperatorToneClasses(tone: OperatorStatus['tone']) {
  switch (tone) {
    case 'green':
      return 'bg-green-500/15 text-green-400 border-green-500/30'
    case 'yellow':
      return 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30'
    case 'red':
      return 'bg-red-500/15 text-red-400 border-red-500/30'
    case 'blue':
      return 'bg-blue-500/15 text-blue-300 border-blue-500/30'
    case 'purple':
      return 'bg-purple-500/15 text-purple-300 border-purple-500/30'
    case 'gray':
    default:
      return 'bg-secondary text-muted-foreground border-border'
  }
}

export function formatRelativeOperatorTime(timestamp?: number) {
  if (!timestamp) return '—'
  const deltaMs = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(deltaMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function formatNextExpectedTime(timestamp?: number) {
  if (!timestamp) return '—'
  const deltaMs = timestamp - Date.now()
  if (Math.abs(deltaMs) < 60000) return 'now'
  const absMinutes = Math.round(Math.abs(deltaMs) / 60000)
  if (deltaMs > 0) {
    if (absMinutes < 60) return `in ${absMinutes}m`
    const hours = Math.round(absMinutes / 60)
    return `in ${hours}h`
  }
  if (absMinutes < 60) return `${absMinutes}m ago`
  const hours = Math.round(absMinutes / 60)
  return `${hours}h ago`
}

export function deriveConnectionOperatorStatus(connection: ConnectionStatus): OperatorStatus {
  if (connection.isConnected) {
    return {
      state: 'running',
      label: 'Connected',
      tone: 'green',
      reason: connection.latency != null
        ? `Gateway healthy • ${connection.latency}ms latency`
        : 'Gateway healthy',
      lastProgressAt: connection.lastEventAt || connection.lastConnected?.getTime(),
    }
  }

  if (connection.reconnectAttempts > 0) {
    return {
      state: 'reconnecting',
      label: 'Reconnecting',
      tone: 'yellow',
      reason: connection.reason || 'Connection dropped; retrying automatically',
      since: connection.lastEventAt,
      nextExpectedAt: connection.nextExpectedAt,
      actionRequired: connection.actionRequired,
      lastProgressAt: connection.lastEventAt,
    }
  }

  if (connection.actionRequired || connection.help || connection.lastError) {
    return {
      state: 'blocked',
      label: 'Blocked',
      tone: 'red',
      reason: connection.reason || connection.lastError || 'Gateway connection needs attention',
      since: connection.lastEventAt,
      actionRequired: connection.actionRequired || connection.help,
      lastProgressAt: connection.lastEventAt,
    }
  }

  return {
    state: 'blocked',
    label: 'Disconnected',
    tone: 'gray',
    reason: 'Not connected to the gateway',
    since: connection.lastEventAt,
    lastProgressAt: connection.lastEventAt,
  }
}

export function deriveSessionOperatorStatus(args: {
  session: Session
  connection: ConnectionStatus
  execApprovals: ExecApprovalRequest[]
  spawnRequests: SpawnRequest[]
  cronJobs?: CronJob[]
}): OperatorStatus {
  const { session, connection, execApprovals, spawnRequests, cronJobs = [] } = args
  const progressAt = lastProgressForSession(session, connection)
  const pendingApproval = execApprovals.find((approval) => approval.status === 'pending' && matchSessionRef(session, approval.sessionId))

  if (pendingApproval) {
    return {
      state: 'waiting_for_approval',
      label: 'Waiting for approval',
      tone: 'yellow',
      reason: pendingApproval.command
        ? `Waiting for exec approval: ${pendingApproval.command}`
        : `Waiting for approval: ${pendingApproval.toolName}`,
      since: pendingApproval.createdAt,
      actionRequired: 'Approve or deny the pending exec request',
      lastProgressAt: progressAt,
    }
  }

  if (!connection.isConnected) {
    const connectionStatus = deriveConnectionOperatorStatus(connection)
    return {
      ...connectionStatus,
      lastProgressAt: progressAt || connectionStatus.lastProgressAt,
    }
  }

  const matchingSpawn = spawnRequests.find((request) => {
    if (request.sessionId && matchSessionRef(session, request.sessionId)) return true
    if (request.label && session.label && request.label === session.label) return true
    return false
  })

  if (matchingSpawn?.status === 'failed' || matchingSpawn?.status === 'timed_out' || matchingSpawn?.status === 'blocked') {
    return {
      state: matchingSpawn.status === 'failed' ? 'failed' : 'blocked',
      label: matchingSpawn.status === 'failed' ? 'Failed' : 'Blocked',
      tone: 'red',
      reason: matchingSpawn.error || matchingSpawn.reason || 'Spawned run did not complete cleanly',
      since: matchingSpawn.completedAt || matchingSpawn.createdAt,
      actionRequired: matchingSpawn.actionRequired,
      lastProgressAt: progressAt,
    }
  }

  if (matchingSpawn?.status === 'waiting_for_input') {
    return {
      state: 'waiting_for_human',
      label: 'Waiting for you',
      tone: 'blue',
      reason: matchingSpawn.reason || 'Run asked for human input before continuing',
      since: matchingSpawn.updatedAt || matchingSpawn.createdAt,
      actionRequired: matchingSpawn.actionRequired || 'Reply to continue the run',
      lastProgressAt: progressAt,
    }
  }

  if (session.active) {
    return {
      state: 'running',
      label: 'Running',
      tone: 'green',
      reason: 'Receiving activity from this session',
      lastProgressAt: progressAt,
    }
  }

  const cronJob = inferCronForSession(session, cronJobs)
  if (cronJob?.nextRun) {
    return {
      state: 'waiting_for_schedule',
      label: 'Waiting for schedule',
      tone: 'purple',
      reason: `Next scheduled continuation for ${cronJob.name}`,
      nextExpectedAt: cronJob.nextRun * 1000,
      lastProgressAt: progressAt,
    }
  }

  if (session.kind === 'direct' || session.kind === 'group' || session.kind === 'global') {
    return {
      state: 'waiting_for_human',
      label: 'Waiting for you',
      tone: 'blue',
      reason: 'No recent agent activity; likely waiting for the next message',
      lastProgressAt: progressAt,
      actionRequired: 'Send a message if you want this session to continue',
    }
  }

  return {
    state: 'queued',
    label: 'Idle',
    tone: 'gray',
    reason: 'No recent activity reported',
    lastProgressAt: progressAt,
  }
}

export function deriveTaskOperatorStatus(args: {
  task: Task
  sessions: Session[]
  connection: ConnectionStatus
  execApprovals: ExecApprovalRequest[]
  spawnRequests: SpawnRequest[]
  cronJobs?: CronJob[]
}): OperatorStatus {
  const { task, sessions, connection, execApprovals, spawnRequests, cronJobs = [] } = args
  const metadata = (task.metadata || {}) as Record<string, any>
  const dispatchSessionId = typeof metadata.dispatch_session_id === 'string' ? metadata.dispatch_session_id : undefined
  const linkedSession = dispatchSessionId
    ? sessions.find((session) => matchSessionRef(session, dispatchSessionId))
    : undefined

  if (task.status === 'done') {
    return {
      state: 'completed',
      label: 'Completed',
      tone: 'green',
      reason: 'Task is marked done',
      lastProgressAt: task.updated_at * 1000,
    }
  }

  if (task.status === 'review' || task.status === 'quality_review') {
    return {
      state: 'waiting_for_human',
      label: 'Waiting for review',
      tone: 'blue',
      reason: task.status === 'quality_review' ? 'Waiting for quality review' : 'Waiting for review',
      lastProgressAt: task.updated_at * 1000,
      actionRequired: 'Review the task outcome and decide the next step',
    }
  }

  if (linkedSession) {
    return deriveSessionOperatorStatus({
      session: linkedSession,
      connection,
      execApprovals,
      spawnRequests,
      cronJobs,
    })
  }

  if (task.status === 'in_progress') {
    return {
      state: 'blocked',
      label: 'Needs session',
      tone: 'red',
      reason: 'Task is in progress but no linked live session was found',
      lastProgressAt: task.updated_at * 1000,
      actionRequired: 'Check dispatch/session linkage for this task',
    }
  }

  if (task.status === 'assigned') {
    return {
      state: 'queued',
      label: 'Queued',
      tone: 'purple',
      reason: task.assigned_to ? `Assigned to ${task.assigned_to}` : 'Assigned and waiting to start',
      lastProgressAt: task.updated_at * 1000,
    }
  }

  return {
    state: 'queued',
    label: 'Inbox',
    tone: 'gray',
    reason: 'Task has not started yet',
    lastProgressAt: task.updated_at * 1000,
  }
}

export function summarizeOperatorStatus(args: {
  sessions: Session[]
  connection: ConnectionStatus
  execApprovals: ExecApprovalRequest[]
  spawnRequests: SpawnRequest[]
  cronJobs?: CronJob[]
}) {
  const { sessions, connection, execApprovals, spawnRequests, cronJobs = [] } = args
  const sessionStatuses = sessions.map((session) =>
    deriveSessionOperatorStatus({ session, connection, execApprovals, spawnRequests, cronJobs })
  )

  const waitingOnYou = sessionStatuses.filter((status) =>
    status.state === 'waiting_for_human' || status.state === 'waiting_for_approval'
  ).length
  const blocked = sessionStatuses.filter((status) =>
    status.state === 'blocked' || status.state === 'failed' || status.state === 'reconnecting'
  ).length
  const running = sessionStatuses.filter((status) => status.state === 'running').length
  const nextExpectedAt = [
    ...sessionStatuses.map((status) => status.nextExpectedAt).filter((v): v is number => typeof v === 'number'),
    ...cronJobs.map((job) => (job.nextRun ? job.nextRun * 1000 : undefined)).filter((v): v is number => typeof v === 'number'),
  ].sort((a, b) => a - b)[0]

  const lastEventAt = [
    connection.lastEventAt,
    ...sessionStatuses.map((status) => status.lastProgressAt),
    ...spawnRequests.map((request) => request.updatedAt || request.completedAt || request.createdAt),
  ].filter((v): v is number => typeof v === 'number').sort((a, b) => b - a)[0]

  return {
    connectionStatus: deriveConnectionOperatorStatus(connection),
    waitingOnYou,
    blocked,
    running,
    nextExpectedAt,
    lastEventAt,
    pendingApprovals: execApprovals.filter((approval) => approval.status === 'pending').length,
  }
}
