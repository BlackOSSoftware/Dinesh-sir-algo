"use client";

import { fmtLevel } from "@/lib/strategy-reference";
import { PremiumCard, CardTitle } from "@/components/trader/ui/primitives";

function MiniCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-[var(--text-muted)]">{label}</p>
      <p className="font-mono text-xs font-medium text-[var(--text-primary)]">{value}</p>
    </div>
  );
}

export function AdaptivePanel({
  adaptiveHigh,
  adaptiveLow,
  callRetraceHigh,
  putRetraceHigh,
  putRetraceLow,
  callRetraceLow,
}: {
  adaptiveHigh: number | null;
  adaptiveLow: number | null;
  callRetraceHigh: number;
  putRetraceHigh: number;
  putRetraceLow: number;
  callRetraceLow: number;
  liveIndex: number | null;
}) {
  const callTrigHigh = adaptiveHigh != null ? adaptiveHigh - callRetraceHigh : null;
  const putTrigHigh = adaptiveHigh != null ? adaptiveHigh - putRetraceHigh : null;
  const putTrigLow = adaptiveLow != null ? adaptiveLow + putRetraceLow : null;
  const callTrigLow = adaptiveLow != null ? adaptiveLow + callRetraceLow : null;

  return (
    <PremiumCard compact>
      <CardTitle title="Adaptive" compact />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2 rounded border border-[var(--border-subtle)] p-2.5">
          <p className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">From High</p>
          <div className="grid grid-cols-3 gap-2">
            <MiniCell label="High" value={adaptiveHigh != null ? fmtLevel(adaptiveHigh) : "—"} />
            <MiniCell label={`Call −${callRetraceHigh}`} value={callTrigHigh != null ? fmtLevel(callTrigHigh) : "—"} />
            <MiniCell label={`Put −${putRetraceHigh}`} value={putTrigHigh != null ? fmtLevel(putTrigHigh) : "—"} />
          </div>
        </div>
        <div className="space-y-2 rounded border border-[var(--border-subtle)] p-2.5">
          <p className="text-[10px] font-medium text-rose-600 dark:text-rose-400">From Low</p>
          <div className="grid grid-cols-3 gap-2">
            <MiniCell label="Low" value={adaptiveLow != null ? fmtLevel(adaptiveLow) : "—"} />
            <MiniCell label={`Put +${putRetraceLow}`} value={putTrigLow != null ? fmtLevel(putTrigLow) : "—"} />
            <MiniCell label={`Call +${callRetraceLow}`} value={callTrigLow != null ? fmtLevel(callTrigLow) : "—"} />
          </div>
        </div>
      </div>
    </PremiumCard>
  );
}
