import { syncOperatorSnapshotToTelegram } from '@/lib/operator-status-telegram'

async function main() {
  const result = await syncOperatorSnapshotToTelegram({
    workspaceId: 1,
    pin: true,
  })
  console.log(JSON.stringify({
    mode: result.mode,
    state: result.state,
    refreshEveryMs: result.refreshEveryMs,
    nextRefreshAt: result.nextRefreshAt,
    statePath: result.statePath,
    headline: result.snapshot.summary.headline,
    reason: result.snapshot.summary.reason,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
