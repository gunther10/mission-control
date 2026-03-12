import { describe, expect, it } from 'vitest'
import { buildPinnedOperatorSnapshot, formatTelegramPinnedOperatorStatus, getOperatorHeartbeatEmoji } from '@/lib/operator-status'
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

describe('operator status snapshot', () => {
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

  it('formats compact telegram text with refreshed time and age', () => {
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
    expect(text).toContain('Age: 7m')
    expect(text).toContain('Updated: 5m')
    expect(text.split('\n')).toHaveLength(6)
  })

  it('marks blocked/reconnecting states orange when no waiting-on-you exists', () => {
    const snapshot = buildPinnedOperatorSnapshot({
      sessions: [baseSession({ active: false, kind: 'background' })],
      tasks: [baseTask()],
      connection: baseConnection({ isConnected: false, reconnectAttempts: 1, state: 'reconnecting', reason: 'Retrying' }),
      execApprovals: [],
      spawnRequests: [],
      now: 1_710_000_300_000,
    })

    expect(snapshot.headline).toBe('Blocked work exists')
    expect(getOperatorHeartbeatEmoji(snapshot)).toBe('🟠')
  })
})
