import { describe, expect, it } from 'vitest'
import {
  buildPinnedOperatorSnapshot,
  deriveSessionOperatorStatus,
  deriveTaskOperatorStatus,
  formatTelegramPinnedOperatorStatus,
  getOperatorHeartbeatEmoji,
  summarizeOperatorStatus,
} from '@/lib/operator-status'
import type { ConnectionStatus, ExecApprovalRequest, Session, SpawnRequest, Task } from '@/store'

function baseConnection(overrides: Partial<ConnectionStatus> = {}): ConnectionStatus {
  return {
    isConnected: true,
    url: 'ws://localhost:18789',
    reconnectAttempts: 0,
    state: 'connected',
    reason: 'Gateway healthy',
    lastEventAt: 1_710_000_000_000,
    ...overrides,
  }
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    key: 'agent:chandler:telegram:direct:1',
    kind: 'direct',
    age: '1m',
    model: 'gpt-5.4',
    tokens: '1k/200k',
    flags: [],
    active: true,
    startTime: 1_710_000_000_000,
    lastActivity: 1_710_000_000_000,
    label: 'Chandler Telegram',
    ...overrides,
  }
}

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: 'Ship pinned status',
    status: 'in_progress',
    priority: 'high',
    created_by: 'operator',
    created_at: 1_710_000_000,
    updated_at: 1_710_000_000,
    metadata: {},
    ...overrides,
  }
}

describe('operator status semantics', () => {
  it('prefers waiting-on-you work for headline and emoji', () => {
    const tasks: Task[] = [baseTask({ status: 'review' })]
    const snapshot = buildPinnedOperatorSnapshot({
      sessions: [baseSession()],
      tasks,
      connection: baseConnection(),
      execApprovals: [],
      spawnRequests: [],
      now: 1_710_000_300_000,
    })

    expect(snapshot.headline).toBe('Waiting on you')
    expect(snapshot.focusLabel).toContain('Task • Ship pinned status')
    expect(getOperatorHeartbeatEmoji(snapshot)).toBe('🔵')
  })

  it('does not inflate blocked counts for reconnecting transport issues', () => {
    const connection = baseConnection({
      isConnected: false,
      reconnectAttempts: 2,
      state: 'reconnecting',
      reason: 'Retrying automatically',
    })

    const sessionStatus = deriveSessionOperatorStatus({
      session: baseSession({ active: false, kind: 'background' }),
      connection,
      execApprovals: [],
      spawnRequests: [],
      cronJobs: [],
    })

    const summary = summarizeOperatorStatus({
      sessions: [baseSession({ id: 's1', active: false, kind: 'background' }), baseSession({ id: 's2', active: false, kind: 'background' })],
      connection,
      execApprovals: [],
      spawnRequests: [],
      cronJobs: [],
    })

    expect(sessionStatus.state).toBe('queued')
    expect(sessionStatus.label).toBe('Paused by gateway')
    expect(summary.blocked).toBe(0)
    expect(summary.connectionStatus.state).toBe('reconnecting')
  })

  it('marks thin inbox items as define-first instead of letting them look actionable', () => {
    const status = deriveTaskOperatorStatus({
      task: baseTask({
        status: 'inbox',
        title: 'follow up',
        description: '',
        assigned_to: undefined,
        project_id: undefined,
        tags: [],
        metadata: {},
      }),
      sessions: [],
      connection: baseConnection(),
      execApprovals: [],
      spawnRequests: [],
      cronJobs: [],
    })

    expect(status.state).toBe('queued')
    expect(status.label).toBe('Define first')
  })

  it('surfaces clarification-needed inbox work as waiting on human', () => {
    const status = deriveTaskOperatorStatus({
      task: baseTask({
        status: 'inbox',
        metadata: { needs_clarification: true },
      }),
      sessions: [],
      connection: baseConnection(),
      execApprovals: [],
      spawnRequests: [],
      cronJobs: [],
    })

    expect(status.state).toBe('waiting_for_human')
    expect(status.label).toBe('Needs clarification')
  })

  it('promotes defined queued work to ready and focuses it over thin inbox drafts', () => {
    const snapshot = buildPinnedOperatorSnapshot({
      sessions: [],
      tasks: [
        baseTask({ id: 1, status: 'inbox', title: 'vague idea', description: '' }),
        baseTask({
          id: 2,
          status: 'inbox',
          title: 'Implement dashboard badge',
          description: 'Show operator badge in header when waiting on approval with tooltip and acceptance criteria.',
          project_id: 1,
          tags: ['ui'],
          metadata: { next_step: 'Dispatch to frontend agent' },
        }),
      ],
      connection: baseConnection(),
      execApprovals: [],
      spawnRequests: [],
      now: 1_710_000_300_000,
    })

    expect(snapshot.headline).toBe('Ready to dispatch')
    expect(snapshot.focusLabel).toContain('Implement dashboard badge')
    expect(snapshot.focusStatus.label).toBe('Ready')
  })

  it('keeps disconnected in-progress work paused instead of blocked when transport is down', () => {
    const status = deriveTaskOperatorStatus({
      task: baseTask({ status: 'in_progress' }),
      sessions: [],
      connection: baseConnection({ isConnected: false, state: 'disconnected', reason: 'Gateway offline' }),
      execApprovals: [],
      spawnRequests: [],
      cronJobs: [],
    })

    expect(status.state).toBe('queued')
    expect(status.label).toBe('Waiting on gateway')
  })

  it('formats compact telegram text with new time line', () => {
    const now = 1_710_000_300_000
    const snapshot = buildPinnedOperatorSnapshot({
      sessions: [baseSession({ lastActivity: now - 2 * 60_000 })],
      tasks: [],
      connection: baseConnection({ lastEventAt: now - 2 * 60_000 }),
      execApprovals: [] as ExecApprovalRequest[],
      spawnRequests: [] as SpawnRequest[],
      now,
    })

    const text = formatTelegramPinnedOperatorStatus(snapshot, now + 5 * 60_000)

    expect(text).toContain('MC')
    expect(text).toContain('Time: age 7m')
    expect(text).toContain('upd 5m')
    expect(text.split('\n')).toHaveLength(9)
  })
})
