import {
  resolveTelegramStatusBotToken,
  syncOperatorSnapshotToTelegram,
  TELEGRAM_STATUS_ACCOUNT_KEY,
  TELEGRAM_STATUS_AGENT_KEY,
  TELEGRAM_STATUS_CHAT_ID,
} from '@/lib/operator-status-telegram'

async function main() {
  const result = await syncOperatorSnapshotToTelegram({
    workspaceId: 1,
    pin: true,
  })
  const token = resolveTelegramStatusBotToken()
  console.log(JSON.stringify({
    mode: result.mode,
    binding: {
      agentKey: TELEGRAM_STATUS_AGENT_KEY,
      accountKey: TELEGRAM_STATUS_ACCOUNT_KEY,
      chatId: TELEGRAM_STATUS_CHAT_ID,
      tokenSource: process.env.CHANDLER_TELEGRAM_BOT_TOKEN ? 'CHANDLER_TELEGRAM_BOT_TOKEN' : process.env.MC_TELEGRAM_STATUS_BOT_TOKEN ? 'MC_TELEGRAM_STATUS_BOT_TOKEN' : process.env.TELEGRAM_BOT_TOKEN ? 'TELEGRAM_BOT_TOKEN' : 'unset',
      tokenSuffix: token ? token.slice(-6) : '',
    },
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
