import { describe, expect, it } from 'vitest'
import {
  formatOperatorSnapshotTelegramMessage,
  resolveTelegramStatusBotToken,
  shouldRefreshTelegramStatus,
  STATUS_STATE_PATH,
  TELEGRAM_STATUS_ACCOUNT_KEY,
  TELEGRAM_STATUS_AGENT_KEY,
  TELEGRAM_STATUS_CHAT_ID,
} from '@/lib/operator-status-telegram'
import type { OperatorSnapshot } from '@/lib/operator-snapshot'

describe('formatOperatorSnapshotTelegramMessage', () => {
  it('uses the Chandler group binding state path', () => {
    expect(TELEGRAM_STATUS_AGENT_KEY).toBe('chandler')
    expect(TELEGRAM_STATUS_ACCOUNT_KEY).toBe('chandler')
    expect(TELEGRAM_STATUS_CHAT_ID).toBe('-5289821512')
    expect(STATUS_STATE_PATH).toContain('telegram-status-state.chandler.-5289821512.json')
  })

  it('prefers Chandler\'s explicit bot token over global Telegram defaults', () => {
    const previousChandler = process.env.CHANDLER_TELEGRAM_BOT_TOKEN
    const previousStatus = process.env.MC_TELEGRAM_STATUS_BOT_TOKEN
    const previousDefault = process.env.TELEGRAM_BOT_TOKEN

    process.env.CHANDLER_TELEGRAM_BOT_TOKEN = 'chandler-token'
    process.env.MC_TELEGRAM_STATUS_BOT_TOKEN = 'status-token'
    process.env.TELEGRAM_BOT_TOKEN = 'default-token'

    expect(resolveTelegramStatusBotToken()).toBe('chandler-token')

    process.env.CHANDLER_TELEGRAM_BOT_TOKEN = previousChandler
    process.env.MC_TELEGRAM_STATUS_BOT_TOKEN = previousStatus
    process.env.TELEGRAM_BOT_TOKEN = previousDefault
  })

  it('renders a compact HTML-safe operator-truth status with richer sections', () => {
    const snapshot = {
      generatedAt: Date.UTC(2026, 2, 12, 22, 15),
      summary: {
        waitingOnYou: 1,
        blocked: 2,
        running: 3,
        pendingApprovals: 0,
        nextExpectedAt: 0,
        lastEventAt: 0,
        connectionStatus: {
          state: 'blocked',
          label: 'blocked',
          tone: 'red',
          reason: 'Gateway unreachable',
        },
        headline: 'Waiting <now>',
        reason: 'Need & reply',
      },
      focus: {
        kind: 'task',
        id: 't1',
        label: 'Fix <pin>',
        status: { state: 'waiting_for_human', label: 'Waiting', tone: 'blue', reason: 'Need approval & signoff' },
      },
      connection: {
        raw: { isConnected: false, url: 'http://x', reconnectAttempts: 0, state: 'blocked', reason: 'Gateway unreachable', lastEventAt: Date.now() },
        status: { state: 'blocked', label: 'Blocked', tone: 'red', reason: 'Gateway unreachable' },
      },
      tasks: [
        { kind: 'task', id: 'done-1', label: 'Closed <loop>', status: { state: 'completed', label: 'Done', tone: 'green', reason: 'Finished' } },
        { kind: 'task', id: 'run-1', label: 'A < B', status: { state: 'running', label: 'Running', tone: 'green', reason: 'Shipping' } },
        { kind: 'task', id: 'next-1', label: 'Need human reply', status: { state: 'waiting_for_human', label: 'Waiting', tone: 'blue', reason: 'Waiting for reply' } },
      ],
      sessions: [
        { kind: 'session', id: 's1', label: 'agent & one', status: { state: 'blocked', label: 'Blocked', tone: 'red', reason: 'Needs reconnect' } },
      ],
      meta: {
        workspaceId: 1,
        totalTasks: 3,
        totalSessions: 1,
        totalCronJobs: 0,
        pendingApprovals: 0,
        spawnRequestsTracked: 0,
      },
    } as unknown as OperatorSnapshot

    const message = formatOperatorSnapshotTelegramMessage(snapshot, { now: Date.UTC(2026, 2, 12, 22, 20) })
    expect(message).toContain('MC 22:20')
    expect(message).toContain('Waiting &lt;now&gt; · run 3 · wait 1 · block 2')
    expect(message).toContain('Fix &lt;pin&gt;')
    expect(message).toContain('Why: Need approval &amp; signoff')
    expect(message).toContain('Need: Need &amp; reply')
    expect(message).toContain('Time: age — · next — · upd 5m')
    expect(message).toContain('Just done: • Closed &lt;loop&gt;')
    expect(message).toContain('Doing correctly: • A &lt; B')
    expect(message).toContain('Next: • need Need human reply')
  })

  it('treats the telegram status message as due every five minutes', () => {
    const now = Date.UTC(2026, 2, 12, 22, 20)

    expect(shouldRefreshTelegramStatus(null, now)).toBe(true)
    expect(
      shouldRefreshTelegramStatus({
        agentKey: TELEGRAM_STATUS_AGENT_KEY,
        chatId: TELEGRAM_STATUS_CHAT_ID,
        messageId: 4247,
        lastSyncedAt: now - (5 * 60 * 1000) + 1,
      }, now),
    ).toBe(false)
    expect(
      shouldRefreshTelegramStatus({
        agentKey: TELEGRAM_STATUS_AGENT_KEY,
        chatId: TELEGRAM_STATUS_CHAT_ID,
        messageId: 4247,
        lastSyncedAt: now - (5 * 60 * 1000),
      }, now),
    ).toBe(true)
  })
})
