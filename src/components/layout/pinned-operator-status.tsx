'use client'

import { Button } from '@/components/ui/button'
import { useMissionControl } from '@/store'
import {
  buildPinnedOperatorSnapshot,
  formatNextExpectedTime,
  formatRelativeOperatorTime,
  getOperatorToneClasses,
} from '@/lib/operator-status'
import { useNavigateToPanel, usePrefetchPanel } from '@/lib/navigation'

export function PinnedOperatorStatus() {
  const { sessions, tasks, connection, execApprovals, spawnRequests, cronJobs, activeTab } = useMissionControl()
  const navigateToPanel = useNavigateToPanel()
  const prefetchPanel = usePrefetchPanel()

  const snapshot = buildPinnedOperatorSnapshot({
    sessions: sessions as any,
    tasks: tasks as any,
    connection,
    execApprovals,
    spawnRequests,
    cronJobs,
  })

  const { summary, headline, reason, focusLabel, focusStatus, actionHint, actionTarget } = snapshot

  return (
    <section className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="px-3 md:px-4 py-3">
        <div className="rounded-xl border border-border bg-card/90 shadow-sm">
          <div className="flex flex-col gap-3 p-3 md:p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${getOperatorToneClasses(summary.connectionStatus.tone)}`}>
                    Pinned status
                  </span>
                  <span className="text-sm font-semibold text-foreground">{headline}</span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{reason}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:min-w-[28rem]">
                <StatChip label="Running" value={String(summary.running)} />
                <StatChip label="Waiting on you" value={String(summary.waitingOnYou)} tone={summary.waitingOnYou > 0 ? 'blue' : undefined} />
                <StatChip label="Blocked" value={String(summary.blocked)} tone={summary.blocked > 0 ? 'red' : undefined} />
                <StatChip label="Next" value={formatNextExpectedTime(summary.nextExpectedAt)} />
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr_auto] lg:items-center">
              <div className="min-w-0 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Focus</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getOperatorToneClasses(focusStatus.tone)}`}>
                    {focusStatus.label}
                  </span>
                  <span className="truncate text-sm font-medium text-foreground">{focusLabel}</span>
                </div>
                <div className="mt-1 text-sm text-muted-foreground">{focusStatus.reason}</div>
              </div>

              <div className="min-w-0 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-sm">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">What happens next</div>
                <div className="mt-1 text-foreground">{actionHint}</div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Last progress: {formatRelativeOperatorTime(focusStatus.lastProgressAt || summary.lastEventAt)}</span>
                  {focusStatus.nextExpectedAt && <span>Next expected: {formatNextExpectedTime(focusStatus.nextExpectedAt)}</span>}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                <Button
                  variant={activeTab === actionTarget ? 'secondary' : 'outline'}
                  size="sm"
                  onMouseEnter={() => prefetchPanel(actionTarget)}
                  onFocus={() => prefetchPanel(actionTarget)}
                  onClick={() => navigateToPanel(actionTarget)}
                >
                  Open {panelLabel(actionTarget)}
                </Button>
                <Button
                  variant={activeTab === 'overview' ? 'secondary' : 'ghost'}
                  size="sm"
                  onMouseEnter={() => prefetchPanel('overview')}
                  onFocus={() => prefetchPanel('overview')}
                  onClick={() => navigateToPanel('overview')}
                >
                  Overview
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function StatChip({ label, value, tone }: { label: string; value: string; tone?: 'blue' | 'red' | 'green' | 'yellow' | 'gray' | 'purple' }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${tone ? getOperatorToneClasses(tone) : 'border-border bg-background/70'}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-foreground">{value}</div>
    </div>
  )
}

function panelLabel(panel: string) {
  switch (panel) {
    case 'tasks':
      return 'Tasks'
    case 'chat':
      return 'Chat'
    case 'notifications':
      return 'Notifications'
    case 'overview':
    default:
      return 'Overview'
  }
}
