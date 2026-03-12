import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { buildOperatorSnapshot } from '@/lib/operator-snapshot'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const snapshot = await buildOperatorSnapshot(auth.user.workspace_id ?? 1)
    return NextResponse.json(snapshot, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/operator-snapshot error')
    return NextResponse.json({ error: 'Failed to build operator snapshot' }, { status: 500 })
  }
}
