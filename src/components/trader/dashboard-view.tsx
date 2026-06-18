"use client";

import { Activity, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { useEngineStatus } from "@/components/trader/app-shell";
import { ActivePositionCard } from "@/components/trader/strategy-terminal/active-position-card";
import { AdaptivePanel } from "@/components/trader/strategy-terminal/adaptive-panel";
import { CalculatedTradesTable } from "@/components/trader/strategy-terminal/calculated-trades-table";
import { StrategyLevelsCard } from "@/components/trader/strategy-terminal/levels-card";
import { StrategyWorkflowPanel } from "@/components/trader/strategy-terminal/workflow-panel";
import { CardTitle, PageHeader, PremiumCard } from "@/components/trader/ui/primitives";
import { useStrategyTerminal } from "@/hooks/use-strategy-terminal";
import { fmtLevel } from "@/lib/strategy-reference";
import { cn } from "@/components/ui";

type CompletedFilter = "today" | "week" | "all";

function StatusChip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "warn" | "bad";
}) {
  const tones = {
    neutral: "text-[var(--text-primary)]",
    ok: "text-emerald-600 dark:text-emerald-400",
    warn: "text-amber-600",
    bad: "text-rose-600",
  };
  return (
    <div className="min-w-0">
      <p className="text-[10px] text-[var(--text-muted)]">{label}</p>
      <p className={cn("truncate text-xs font-medium", tones[tone])}>{value}</p>
    </div>
  );
}

function TokenRefreshHint({ text }: { text: string | null | undefined }) {
  if (!text || !/invalid\s*token|jwt\s*expired|token\s*expired|access\s*denied/i.test(text)) return null;
  return <p className="mt-1 text-[11px] text-[var(--text-muted)]">Update Angel JWT in backend/.env and restart worker.</p>;
}

export function DashboardView() {
  const t = useStrategyTerminal();
  const { engineOn, engineCheckPending } = useEngineStatus();
  const [completedFilter, setCompletedFilter] = useState<CompletedFilter>("all");
  const [completedSearch, setCompletedSearch] = useState("");

  const d = t.d;
  const livePx = t.liveIndex;

  const sessionDiff =
    livePx != null && t.basePrice != null ? livePx - t.basePrice : null;

  const directionLabel =
    t.activeSide === "CALL"
      ? "Call"
      : t.activeSide === "PUT"
        ? "Put"
        : t.activeSide === "MIXED"
          ? "Call + Put"
          : "Flat";

  const activeTp = useMemo(() => {
    if (!t.primaryActive || t.levels.upperTrigger == null || t.levels.lowerTrigger == null) {
      return { tp1: null, tp2: null, sl: null };
    }
    const isCall = /call|ce/i.test(t.primaryActive.side);
    const { tp1, tp2 } = t.activeTpLevels;
    return {
      tp1,
      tp2,
      sl: isCall ? t.levels.lowerTrigger : t.levels.upperTrigger,
    };
  }, [t.primaryActive, t.levels, t.activeTpLevels]);

  const filteredCompleted = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const q = completedSearch.trim().toLowerCase();
    return d.completedTrades.filter((row) => {
      if (q) {
        const hay = [row.leg_id, row.side, row.symbol, row.exit_reason].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (completedFilter === "all") return true;
      const time = row.exit_time || row.entry_time;
      if (!time) return true;
      const dt = new Date(time);
      if (Number.isNaN(dt.getTime())) return true;
      if (completedFilter === "today") return dt >= startOfToday;
      return dt >= weekAgo;
    });
  }, [d.completedTrades, completedFilter, completedSearch]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 pb-8">
      <PageHeader
        compact
        title="Dashboard"
        subtitle="Live strategy monitor"
        action={
          <div className="flex items-center gap-2">
            {d.persistError ? (
              <span className="rounded border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-600">
                {d.persistError}
              </span>
            ) : null}
            <div className="flex rounded-md border border-[var(--border-subtle)] p-0.5 text-[11px]">
              {(["PAPER", "LIVE"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    d.setTradingMode(mode);
                    void d.pushSettingsToServer({ trading_mode: mode });
                  }}
                  className={cn(
                    "rounded px-2.5 py-1 font-medium",
                    d.tradingMode === mode
                      ? mode === "LIVE"
                        ? "bg-amber-500 text-white"
                        : "bg-[var(--surface-elevated)] text-[var(--text-primary)]"
                      : "text-[var(--text-muted)]",
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        }
      />

      <PremiumCard compact>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          <StatusChip label="SENSEX" value={livePx != null ? fmtLevel(livePx) : "—"} />
          <StatusChip
            label="Base"
            value={t.basePrice != null ? fmtLevel(t.basePrice) : "—"}
          />
          <StatusChip
            label="Move"
            value={sessionDiff != null ? `${sessionDiff >= 0 ? "+" : ""}${sessionDiff.toFixed(0)}` : "—"}
            tone={sessionDiff != null ? (sessionDiff >= 0 ? "ok" : "bad") : "neutral"}
          />
          <StatusChip label="Position" value={directionLabel} tone={t.activeSide !== "NONE" ? "ok" : "neutral"} />
          <StatusChip label="First Entry" value={d.firstEntryEnabled ? "On" : "Off"} />
          <StatusChip label="Algo" value={d.algoEnabled ? "On" : "Off"} tone={d.algoEnabled ? "ok" : "neutral"} />
          <StatusChip
            label="Engine"
            value={engineCheckPending ? "…" : engineOn ? "Running" : "Stopped"}
            tone={engineOn ? "ok" : "bad"}
          />
          <StatusChip label="Mode" value={d.tradingMode} tone={d.tradingMode === "LIVE" ? "warn" : "neutral"} />
        </div>
      </PremiumCard>

      <StrategyWorkflowPanel phase={t.phase} />

      <div className="grid gap-3 lg:grid-cols-2">
        <StrategyLevelsCard
          levels={t.levels}
          phase={t.phase}
          capturedCandleTime={d.startBar?.candle_time ?? null}
          startTime={t.params.startTime}
        />
        <ActivePositionCard
          trade={t.primaryActive}
          levels={t.levels}
          tp1={activeTp.tp1}
          tp2={activeTp.tp2}
          stoploss={activeTp.sl}
        />
      </div>

      <AdaptivePanel
        adaptiveHigh={t.adaptiveHigh}
        adaptiveLow={t.adaptiveLow}
        callRetraceHigh={t.params.adaptiveCallRetraceHigh}
        putRetraceHigh={t.params.adaptivePutRetraceHigh}
        putRetraceLow={t.params.adaptivePutRetraceLow}
        callRetraceLow={t.params.adaptiveCallRetraceLow}
        liveIndex={livePx}
      />

      <CalculatedTradesTable
        rows={t.calculatedRows}
        onLotsChange={(id, lots) => t.setRowLots((prev) => ({ ...prev, [id]: lots }))}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <PremiumCard compact>
          <CardTitle title="Activity" compact />
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {d.tradingLogs.length === 0 ? (
              <p className="py-4 text-center text-xs text-[var(--text-muted)]">No activity</p>
            ) : (
              d.tradingLogs.slice(0, 20).map((log) => (
                <div key={log.id} className="rounded border border-[var(--border-subtle)] px-2 py-1.5 text-[11px]">
                  <span className="font-mono text-[var(--text-muted)]">{d.formatLogTimestamp(log.created_at)}</span>
                  <span className="mx-1.5 text-[var(--text-muted)]">·</span>
                  <span className="font-medium">{log.action}</span>
                  <span className="mx-1 text-[var(--text-muted)]">{log.leg}</span>
                  <p className="text-[var(--text-secondary)]">{log.message || log.status || ""}</p>
                </div>
              ))
            )}
          </div>
        </PremiumCard>

        <PremiumCard compact>
          <CardTitle
            title="Active Trades"
            compact
            action={
              <button
                type="button"
                onClick={() => void d.fetchStartBarClose()}
                className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium"
              >
                <RefreshCw className="h-3 w-3" />
                Base
              </button>
            }
          />
          <div className="overflow-x-auto rounded border border-[var(--border-subtle)]">
            <table className="w-full min-w-[520px] border-collapse text-xs">
              <thead className="bg-[var(--surface-muted)] text-[10px] text-[var(--text-muted)]">
                <tr>
                  {["Leg", "Side", "Strike", "Lots", "PnL", ""].map((h) => (
                    <th key={h || "x"} className="px-2 py-1 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.activeTrades.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-2 py-4 text-center text-[var(--text-muted)]">
                      No active positions
                    </td>
                  </tr>
                ) : (
                  d.activeTrades.map((a) => (
                    <tr key={a.id} className="border-t border-[var(--border-subtle)]">
                      <td className="px-2 py-1 font-mono font-medium">{a.leg_id}</td>
                      <td className="px-2 py-1">{a.side}</td>
                      <td className="px-2 py-1 font-mono">{a.strike.toLocaleString("en-IN")}</td>
                      <td className="px-2 py-1 font-mono">{a.lots}</td>
                      <td className={cn("px-2 py-1 font-mono", a.pnl >= 0 ? "text-emerald-600" : "text-rose-600")}>
                        {d.fmtInr(a.pnl)}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <button
                          type="button"
                          onClick={() => void d.closeLegManual(a.leg_id)}
                          className="rounded border px-1.5 py-0.5 text-[10px]"
                        >
                          Close
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </PremiumCard>
      </div>

      <PremiumCard compact>
        <CardTitle
          title="Completed Trades"
          compact
          action={
            <div className="flex flex-wrap items-center gap-1.5">
              {(["today", "week", "all"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setCompletedFilter(f)}
                  className={cn(
                    "rounded px-2 py-0.5 text-[10px] font-medium capitalize",
                    completedFilter === f ? "bg-[var(--accent)] text-white" : "border border-[var(--border-subtle)]",
                  )}
                >
                  {f === "week" ? "Week" : f}
                </button>
              ))}
              <input
                value={completedSearch}
                onChange={(e) => setCompletedSearch(e.target.value)}
                placeholder="Search"
                className="rounded border px-2 py-0.5 text-[10px]"
              />
            </div>
          }
        />
        <div className="overflow-x-auto rounded border border-[var(--border-subtle)]">
          <table className="w-full min-w-[640px] border-collapse text-xs">
            <thead className="bg-[var(--surface-muted)] text-[10px] text-[var(--text-muted)]">
              <tr>
                {["Exit", "Leg", "Side", "Strike", "PnL", "Reason"].map((h) => (
                  <th key={h} className="px-2 py-1 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredCompleted.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-[var(--text-muted)]">
                    No completed trades
                  </td>
                </tr>
              ) : (
                filteredCompleted.map((c) => (
                  <tr key={c.id} className="border-t border-[var(--border-subtle)]">
                    <td className="px-2 py-1 font-mono">{d.formatTradeTimeIST(c.exit_time)}</td>
                    <td className="px-2 py-1 font-mono font-medium">{c.leg_id}</td>
                    <td className="px-2 py-1">{c.side ?? "—"}</td>
                    <td className="px-2 py-1 font-mono">
                      {c.strike != null ? c.strike.toLocaleString("en-IN") : "—"}
                    </td>
                    <td className="px-2 py-1 font-mono">{d.fmtInr(c.pnl)}</td>
                    <td className="px-2 py-1">{c.exit_reason ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </PremiumCard>

      {d.showAngelServerRefresh || d.angelErr ? (
        <PremiumCard compact>
          {d.angelErr ? (
            <div className="text-xs text-rose-600">
              <Activity className="mb-0.5 inline h-3.5 w-3.5" /> {d.angelErr}
              <TokenRefreshHint text={d.angelErr} />
            </div>
          ) : null}
          {d.showAngelServerRefresh ? (
            <button
              type="button"
              onClick={() => void d.runAngelServerRefresh()}
              disabled={d.angelRefreshBusy}
              className="mt-1 rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white"
            >
              {d.angelRefreshBusy ? "Refreshing…" : "Refresh Angel JWT"}
            </button>
          ) : null}
        </PremiumCard>
      ) : null}
    </div>
  );
}
