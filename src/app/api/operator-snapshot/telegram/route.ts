import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { TELEGRAM_STATUS_REFRESH_EVERY_MS, readTelegramStatusState, shouldRefreshTelegramStatus, syncOperatorSnapshotToTelegram } from '@/lib/operator-status-telegram'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const body = await request.json().catch(() => ({})) as { chatId?: string; pin?: boolean }
    const result = await syncOperatorSnapshotToTelegram({
      workspaceId: auth.user.workspace_id ?? 1,
      chatId: body.chatId,
      pin: body.pin,
    })
    return NextResponse.json({
      ok: true,
      mode: result.mode,
      state: result.state,
      statePath: result.statePath,
      generatedAt: result.snapshot.generatedAt,
      summary: result.snapshot.summary,
      refreshEveryMs: result.refreshEveryMs,
      nextRefreshAt: result.nextRefreshAt,
      editSameMessage: result.editSameMessage,
    })
  } catch (error: any) {
    logger.error({ err: error }, 'POST /api/operator-snapshot/telegram error')
    return NextResponse.json({ error: error?.message || 'Failed to sync operator snapshot to Telegram' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const state = await readTelegramStatusState()
    return NextResponse.json({
      ok: true,
      state,
      refreshEveryMs: TELEGRAM_STATUS_REFRESH_EVERY_MS,
      dueNow: shouldRefreshTelegramStatus(state),
      nextRefreshAt: state?.lastSyncedAt ? state.lastSyncedAt + TELEGRAM_STATUS_REFRESH_EVERY_MS : null,
      editSameMessage: true,
    })
  } catch (error: any) {
    logger.error({ err: error }, 'GET /api/operator-snapshot/telegram error')
    return NextResponse.json({ error: error?.message || 'Failed to read Telegram status state' }, { status: 500 })
  }
}
