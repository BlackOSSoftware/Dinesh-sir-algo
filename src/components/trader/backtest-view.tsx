"use client";

import { useCallback, useMemo, useState } from "react";
import { Activity, BarChart3, Download, Loader2, Play, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";

import { useTradingDashboard } from "@/components/trader/trading-dashboard-context";
import { BacktestChart } from "@/components/trader/backtest-chart";
import { CardTitle, FloatingField, PageHeader, PremiumCard } from "@/components/trader/ui/primitives";
import { cn } from "@/components/ui";
import { getApiBase, getStoredToken } from "@/lib/auth";
import {
  MAX_BACKTEST_DAYS,
  addDaysIso,
  buildDaySummary,
  buildPlannedLevels,
  dash,
  dateRange,
  entryTypeLabel,
  fmtDate,
  fmtPx,
  fmtTradeDt,
  round,
  runBacktest,
  type Candle,
  type DaySummary,
  type PlannedLevelRow,
  type Side,
  type StrategyParams,
  type Trade,
} from "@/lib/backtest-engine";

const todayIso = () => new Date().toISOString().slice(0, 10);
const csvCell = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;

function apiErrorMessage(data: unknown, fallback: string) {
  if (data && typeof data === "object" && "detail" in data) {
    const detail = (data as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

function ScrollTable({ children, maxH = "max-h-[280px]" }: { children: React.ReactNode; maxH?: string }) {
  return <div className={cn("overflow-x-auto overflow-y-auto rounded-lg border border-[var(--border-subtle)]", maxH)}>{children}</div>;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="sticky top-0 z-10 bg-[var(--surface-elevated)] px-3 py-2 font-medium">{children}</th>;
}

export function BacktestView() {
  const d = useTradingDashboard();
  const today = todayIso();
  const [fromDate, setFromDate] = useState(addDaysIso(today, -6));
  const [toDate, setToDate] = useState(today);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candleCount, setCandleCount] = useState(0);
  const [daySummaries, setDaySummaries] = useState<DaySummary[]>([]);
  const [plannedRows, setPlannedRows] = useState<PlannedLevelRow[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [daysRun, setDaysRun] = useState(0);
  const [filter, setFilter] = useState<"ALL" | Side>("ALL");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const strategyParams = useMemo<StrategyParams>(() => ({
    startTime: d.startTime || "09:15",
    endTime: d.endTime || "15:30",
    rangeGap: d.entryGap,
    tp1Points: d.target1Pts,
    tp1Lots: d.tp1ExitLots,
    tp2Points: d.target2Pts,
    tp2Lots: d.tp2ExitLots,
    firstEntryEnabled: d.firstEntryEnabled,
    adaptiveCallRetraceHigh: d.adaptiveCallRetraceHigh,
    adaptivePutRetraceHigh: d.adaptivePutRetraceHigh,
    adaptivePutRetraceLow: d.adaptivePutRetraceLow,
    adaptiveCallRetraceLow: d.adaptiveCallRetraceLow,
  }), [
    d.startTime,
    d.endTime,
    d.entryGap,
    d.target1Pts,
    d.tp1ExitLots,
    d.target2Pts,
    d.tp2ExitLots,
    d.firstEntryEnabled,
    d.adaptiveCallRetraceHigh,
    d.adaptivePutRetraceHigh,
    d.adaptivePutRetraceLow,
    d.adaptiveCallRetraceLow,
  ]);

  const visibleTrades = useMemo(
    () => (filter === "ALL" ? trades : trades.filter((t) => t.side === filter)),
    [filter, trades],
  );
  const tradeStats = useMemo(() => {
    let profit = 0;
    let loss = 0;
    let wins = 0;
    const reasonPoints: Record<string, number> = { TP1: 0, TP2: 0, SL: 0, SESSION_END: 0 };
    for (const t of trades) {
      if (t.points > 0) {
        profit += t.points;
        wins += 1;
      } else if (t.points < 0) {
        loss += t.points;
      }
      reasonPoints[t.reason] = (reasonPoints[t.reason] ?? 0) + t.points;
    }
    return {
      profit: round(profit),
      loss: round(loss),
      net: round(profit + loss),
      winRate: trades.length ? Math.round((wins / trades.length) * 100) : 0,
      byReason: (["TP1", "TP2", "SL", "SESSION_END"] as const).map((reason) => ({
        reason,
        points: round(reasonPoints[reason] ?? 0),
      })),
    };
  }, [trades]);

  const chartMeta = useMemo(() => {
    if (!daySummaries.length) return { candles, trades, subtitle: "" };
    const last = daySummaries[daySummaries.length - 1];
    if (candleCount <= 5000) return { candles, trades, subtitle: `${candleCount} candles` };
    const lastCandles = candles.filter((c) => c.time.includes(last.date));
    const lastTrades = trades.filter((t) => t.tradeDate === last.date);
    return {
      candles: lastCandles,
      trades: lastTrades,
      subtitle: `Chart: last session ${fmtDate(last.date)} (${lastCandles.length} candles) · total ${candleCount} candles`,
    };
  }, [candles, trades, daySummaries, candleCount]);

  const showTradeDate = daysRun > 0;

  const processDays = useCallback((days: { date: string; base: number; candles: Candle[] }[]) => {
    const allTrades: Trade[] = [];
    const summaries: DaySummary[] = [];
    const planned: PlannedLevelRow[] = [];
    let nextId = 1;
    let totalCandles = 0;
    const storedCandles: Candle[] = [];
    let chartCandles: Candle[] = [];

    for (const day of days) {
      const base = day.base;
      if (!base || base <= 0 || !day.candles?.length) continue;
      chartCandles = day.candles;
      const result = runBacktest(day.candles, { ...strategyParams, base }, day.date);
      for (const t of result.trades) allTrades.push({ ...t, id: nextId++ });
      summaries.push(buildDaySummary(day.date, base, result, strategyParams));
      planned.push(...buildPlannedLevels(day.date, base, strategyParams));
      totalCandles += day.candles.length;
      if (totalCandles <= 5000) storedCandles.push(...day.candles);
    }

    return { allTrades, summaries, planned, totalCandles, storedCandles, chartCandles, days };
  }, [strategyParams]);

  async function loadAndRun() {
    const token = getStoredToken();
    if (!token) return;
    if (fromDate > toDate) {
      setMessage("From date must be on or before To date.");
      return;
    }
    const dates = dateRange(fromDate, toDate);
    if (dates.length > MAX_BACKTEST_DAYS) {
      setMessage(`Maximum ${MAX_BACKTEST_DAYS} days per backtest.`);
      return;
    }

    setLoading(true);
    setMessage(null);
    setTrades([]);
    setCandles([]);
    setDaySummaries([]);
    setPlannedRows([]);
    setDaysRun(0);
    setCandleCount(0);

    const t0 = performance.now();
    const isSingle = fromDate === toDate;

    try {
      let days: { date: string; base: number; candles: Candle[] }[] = [];

      if (isSingle) {
        const qs = new URLSearchParams({
          date: fromDate,
          start: strategyParams.startTime,
          end: strategyParams.endTime,
          interval: "1",
        });
        const res = await fetch(`${getApiBase()}/angel/historical-candles?${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as {
          detail?: unknown;
          message?: string;
          base?: number;
          candles?: Candle[];
        };
        if (!res.ok) throw new Error(apiErrorMessage(data, `HTTP ${res.status}`));
        if (data.candles?.length && data.base && data.base > 0) {
          days = [{ date: fromDate, base: data.base, candles: data.candles }];
        }
      } else {
        setMessage("Fetching candles in parallel…");
        const qs = new URLSearchParams({
          from_date: fromDate,
          to_date: toDate,
          start: strategyParams.startTime,
          end: strategyParams.endTime,
          interval: "1",
        });
        const res = await fetch(`${getApiBase()}/angel/historical-candles-batch?${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as {
          detail?: unknown;
          message?: string;
          days?: { date: string; base: number; candles: Candle[] }[];
          skipped_count?: number;
        };
        if (!res.ok) throw new Error(apiErrorMessage(data, `HTTP ${res.status}`));
        days = Array.isArray(data.days) ? data.days : [];
      }

      if (!days.length) {
        setMessage("No candles found for the selected date range.");
        return;
      }

      if (!isSingle) setMessage(`Running strategy on ${days.length} day(s)…`);

      const { allTrades, summaries, planned, totalCandles, storedCandles, chartCandles } = processDays(days);

      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      const skipped = Math.max(0, dates.length - summaries.length);

      setTrades(allTrades);
      setDaySummaries(summaries);
      setPlannedRows(planned);
      setDaysRun(summaries.length);
      setCandleCount(totalCandles);
      setCandles(totalCandles <= 5000 ? storedCandles : chartCandles);

      setMessage(
        `${summaries.length} day(s) · ${allTrades.length} trade(s) · ${totalCandles} candles · ${elapsed}s` +
          (skipped > 0 ? ` · ${skipped} skipped` : ""),
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Backtest failed.");
    } finally {
      setLoading(false);
    }
  }

  function exportCsv() {
    const rows = [
      ["From Date", fmtDate(fromDate)],
      ["To Date", fmtDate(toDate)],
      ["Days Backtested", daysRun],
      [],
      ["Date", "Base", "Upper", "Lower", "Adaptive High", "Adaptive Low", "Trades", "Points"],
      ...daySummaries.map((r) => [
        fmtDate(r.date), r.base, r.upper, r.lower,
        r.trackAdaptiveHigh ? r.adaptiveHigh ?? "-" : "-",
        r.trackAdaptiveLow ? r.adaptiveLow ?? "-" : "-",
        r.trades, r.points,
      ]),
      [],
      ["Trade No", "Date", "Side", "Entry Type", "Entry Time", "Exit Time", "Entry", "Exit", "Entry Lots", "Exit Lots", "Reason", "Points", "Note"],
      ...trades.map((t) => [
        t.id, fmtDate(t.tradeDate), t.side, entryTypeLabel(t.entryType),
        fmtTradeDt(t.tradeDate, t.entryTime), fmtTradeDt(t.tradeDate, t.exitTime),
        t.entry, t.exit, t.entryLots, t.exitLots, t.reason, t.points, t.note,
      ]),
    ];
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `sensex-backtest-${fromDate}_to_${toDate}-1m.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const firstDay = daySummaries[0];

  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-10">
      <PageHeader title="Backtest" subtitle={fromDate !== toDate ? `Range ${fromDate} → ${toDate}` : "Single-day SENSEX backtest"} />

      <PremiumCard className="!p-4">
        <CardTitle title="Backtest Setup" action={<button type="button" onClick={() => void loadAndRun()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run Backtest</button>} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <FloatingField id="bt-from" label="From Date" type="date" value={fromDate} onChange={setFromDate} />
          <FloatingField id="bt-to" label="To Date" type="date" value={toDate} onChange={setToDate} />
          <div className="rounded-[var(--radius-input)] border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--accent)]">Candle</p>
            <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">1 minute</p>
          </div>
          <FloatingField id="bt-start" label="Start Time" type="time" value={strategyParams.startTime} onChange={d.setStartTime} />
          <FloatingField id="bt-end" label="End Time" type="time" value={strategyParams.endTime} onChange={d.setEndTime} />
        </div>
        {message ? <p className={cn("mt-3 text-sm", message.includes("failed") || message.includes("Maximum") || message.includes("must be") ? "text-rose-600" : "text-[var(--text-secondary)]")}>{message}</p> : null}
      </PremiumCard>

      <PremiumCard className="!p-4">
        <CardTitle title="Strategy Settings" subtitle="Backtest runs with these exact parameters." />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FloatingField id="bt-gap" label="Range Gap" type="number" value={String(strategyParams.rangeGap || "")} onChange={(v) => d.setEntryGap(Math.max(1, Number(v) || 1))} />
          <FloatingField id="bt-tp1-pts" label="TP1 Points" type="number" value={String(strategyParams.tp1Points || "")} onChange={(v) => d.setTarget1Pts(Math.max(1, Number(v) || 1))} />
          <FloatingField id="bt-tp1-lots" label="TP1 Exit Lots" type="number" value={String(strategyParams.tp1Lots || "")} onChange={(v) => d.applyExitLots(Math.max(1, Number(v) || 1), d.tp2ExitLots)} />
          <FloatingField id="bt-tp2-pts" label="TP2 Points" type="number" value={String(strategyParams.tp2Points || "")} onChange={(v) => d.setTarget2Pts(Math.max(1, Number(v) || 1))} />
          <FloatingField id="bt-tp2-lots" label="TP2 Exit Lots" type="number" value={String(strategyParams.tp2Lots || "")} onChange={(v) => d.applyExitLots(d.tp1ExitLots, Math.max(1, Number(v) || 1))} />
          <FloatingField id="bt-call-high" label="Adaptive Call Retrace" type="number" value={String(strategyParams.adaptiveCallRetraceHigh || "")} onChange={(v) => d.setAdaptiveCallRetraceHigh(Math.max(1, Number(v) || 1))} />
          <FloatingField id="bt-put-high" label="Adaptive Put Retrace" type="number" value={String(strategyParams.adaptivePutRetraceHigh || "")} onChange={(v) => d.setAdaptivePutRetraceHigh(Math.max(1, Number(v) || 1))} />
          <FloatingField id="bt-put-low" label="Adaptive Low Put Retrace" type="number" value={String(strategyParams.adaptivePutRetraceLow || "")} onChange={(v) => d.setAdaptivePutRetraceLow(Math.max(1, Number(v) || 1))} />
          <FloatingField id="bt-call-low" label="Adaptive Low Call Retrace" type="number" value={String(strategyParams.adaptiveCallRetraceLow || "")} onChange={(v) => d.setAdaptiveCallRetraceLow(Math.max(1, Number(v) || 1))} />
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">First Entry</p>
            <div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-0.5">
              {([true, false] as const).map((enabled) => (
                <button key={String(enabled)} type="button" onClick={() => d.setFirstEntryEnabled(enabled)} className={cn("flex-1 rounded-md py-2 text-xs font-medium", strategyParams.firstEntryEnabled === enabled ? "bg-[var(--surface-elevated)] text-[var(--accent)] shadow-sm" : "text-[var(--text-muted)]")}>{enabled ? "Enable" : "Disable"}</button>
              ))}
            </div>
          </div>
        </div>
      </PremiumCard>

      <PremiumCard className="!p-4">
        <CardTitle title="Base & Triggers" subtitle={daySummaries.length ? `${daySummaries.length} trading day(s) — BASE + triggers per date` : "Run backtest to load date-wise levels."} />
        <ScrollTable>
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border-subtle)]">
                <Th>Date</Th><Th>Base</Th><Th>Upper</Th><Th>Lower</Th><Th>Trades</Th><Th>Day Pts</Th>
              </tr>
            </thead>
            <tbody>
              {daySummaries.map((r) => (
                <tr key={r.date} className="border-b border-[var(--border-subtle)] text-[var(--text-secondary)]">
                  <td className="px-3 py-2 font-medium text-[var(--text-primary)]">{fmtDate(r.date)}</td>
                  <td className="px-3 py-2 font-mono">{fmtPx(r.base)}</td>
                  <td className="px-3 py-2 font-mono text-emerald-600">{fmtPx(r.upper)}</td>
                  <td className="px-3 py-2 font-mono text-rose-600">{fmtPx(r.lower)}</td>
                  <td className="px-3 py-2">{r.trades}</td>
                  <td className={cn("px-3 py-2 font-mono font-semibold", r.points >= 0 ? "text-emerald-600" : "text-rose-600")}>{r.points}</td>
                </tr>
              ))}
              {!daySummaries.length ? <tr><td colSpan={6} className="px-3 py-6 text-center text-[var(--text-muted)]">No data yet.</td></tr> : null}
            </tbody>
          </table>
        </ScrollTable>
      </PremiumCard>

      <PremiumCard className="!p-4">
        <CardTitle title="Adaptive" subtitle="Per-date adaptive high/low and retrace trigger levels." />
        <ScrollTable>
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="text-xs text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border-subtle)]">
                <Th>Date</Th><Th>High</Th><Th>Call −{strategyParams.adaptiveCallRetraceHigh}</Th><Th>Put −{strategyParams.adaptivePutRetraceHigh}</Th>
                <Th>Low</Th><Th>Put +{strategyParams.adaptivePutRetraceLow}</Th><Th>Call +{strategyParams.adaptiveCallRetraceLow}</Th>
              </tr>
            </thead>
            <tbody>
              {daySummaries.map((r) => (
                <tr key={r.date} className="border-b border-[var(--border-subtle)] text-[var(--text-secondary)]">
                  <td className="px-3 py-2 font-medium text-[var(--text-primary)]">{fmtDate(r.date)}</td>
                  <td className="px-3 py-2 font-mono">{r.trackAdaptiveHigh ? dash(r.adaptiveHigh) : "-"}</td>
                  <td className="px-3 py-2 font-mono">{r.trackAdaptiveHigh ? dash(r.callTrigHigh) : "-"}</td>
                  <td className="px-3 py-2 font-mono">{r.trackAdaptiveHigh ? dash(r.putTrigHigh) : "-"}</td>
                  <td className="px-3 py-2 font-mono">{r.trackAdaptiveLow ? dash(r.adaptiveLow) : "-"}</td>
                  <td className="px-3 py-2 font-mono">{r.trackAdaptiveLow ? dash(r.putTrigLow) : "-"}</td>
                  <td className="px-3 py-2 font-mono">{r.trackAdaptiveLow ? dash(r.callTrigLow) : "-"}</td>
                </tr>
              ))}
              {!daySummaries.length ? <tr><td colSpan={7} className="px-3 py-6 text-center text-[var(--text-muted)]">No adaptive data yet.</td></tr> : null}
            </tbody>
          </table>
        </ScrollTable>
      </PremiumCard>

      <PremiumCard className="!p-4">
        <CardTitle title="Planned Strategy Levels" subtitle="Calculated levels per date (initial range + refill + TP2 re-entry)." />
        <ScrollTable maxH="max-h-[320px]">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="text-xs text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border-subtle)]">
                <Th>Date</Th><Th>Trade Type</Th><Th>Entry</Th><Th>Lots</Th><Th>TP1</Th><Th>TP2</Th><Th>SL</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {plannedRows.map((row, i) => (
                <tr key={`${row.date}-${row.type}-${i}`} className="border-b border-[var(--border-subtle)] text-[var(--text-secondary)]">
                  <td className="px-3 py-2 whitespace-nowrap font-medium text-[var(--text-primary)]">{fmtDate(row.date)}</td>
                  <td className="px-3 py-2">{row.type}</td>
                  <td className="px-3 py-2 font-mono">{fmtPx(row.entry)}</td>
                  <td className="px-3 py-2">{row.lots}</td>
                  <td className="px-3 py-2 font-mono">{fmtPx(row.tp1)}</td>
                  <td className="px-3 py-2 font-mono">{fmtPx(row.tp2)}</td>
                  <td className="px-3 py-2 font-mono">{fmtPx(row.sl)}</td>
                  <td className="px-3 py-2 text-xs">{row.status}</td>
                </tr>
              ))}
              {!plannedRows.length ? <tr><td colSpan={8} className="px-3 py-6 text-center text-[var(--text-muted)]">Run backtest to calculate levels.</td></tr> : null}
            </tbody>
          </table>
        </ScrollTable>
      </PremiumCard>

      <PremiumCard className="!p-4">
        <CardTitle title="Chart" subtitle={`${chartMeta.subtitle || `${candleCount} candles`} · ▲ buy · ▼ exit`} />
        <BacktestChart
          candles={chartMeta.candles}
          trades={chartMeta.trades}
          base={daysRun === 1 && firstDay ? firstDay.base : undefined}
          upper={daysRun === 1 && firstDay ? firstDay.upper : undefined}
          lower={daysRun === 1 && firstDay ? firstDay.lower : undefined}
        />
      </PremiumCard>

      <div className="grid gap-3 md:grid-cols-5">
        {([["Net Points", tradeStats.net, Activity], ["Trades", trades.length, BarChart3], ["Win Rate", `${tradeStats.winRate}%`, TrendingUp], ["Profit", tradeStats.profit, TrendingUp], ["Loss", tradeStats.loss, TrendingDown]] satisfies [string, string | number, LucideIcon][]).map(([label, value, Icon]) => (
          <PremiumCard key={label} className="!p-4"><Icon className="h-4 w-4 text-[var(--accent)]" /><p className="mt-3 text-[11px] font-bold uppercase text-[var(--text-muted)]">{label}</p><p className="mt-1 font-mono text-xl font-semibold text-[var(--text-primary)]">{value}</p></PremiumCard>
        ))}
      </div>

      <PremiumCard className="!p-4">
        <CardTitle title="Points Breakdown" />
        <div className="grid gap-3 sm:grid-cols-4">
          {tradeStats.byReason.map((row) => <div key={row.reason} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-3"><p className="text-xs font-medium text-[var(--text-secondary)]">{row.reason.replace("_", " ")}</p><p className={cn("mt-1 font-mono text-lg font-semibold", row.points >= 0 ? "text-emerald-600" : "text-rose-600")}>{row.points}</p></div>)}
        </div>
      </PremiumCard>

      <PremiumCard className="!p-4">
        <CardTitle title="Trade Record" subtitle={trades.length ? `${visibleTrades.length} rows · scroll for more` : undefined} action={<div className="flex flex-wrap items-center gap-2"><button type="button" onClick={exportCsv} disabled={!trades.length} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] disabled:opacity-50"><Download className="h-4 w-4" />Export Excel CSV</button><div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-0.5">{(["ALL", "CALL", "PUT"] as const).map((x) => <button key={x} type="button" onClick={() => setFilter(x)} className={cn("rounded-md px-3 py-1.5 text-xs font-medium", filter === x ? "bg-[var(--surface-elevated)] text-[var(--accent)] shadow-sm" : "text-[var(--text-muted)]")}>{x}</button>)}</div></div>} />
        <ScrollTable maxH="max-h-[440px]">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="text-xs text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border-subtle)]">
                {["#", ...(showTradeDate ? ["Date"] : []), "Side", "Entry Type", "Entry Time", "Exit Time", "Entry", "Exit", "Entry Lots", "Exit Lots", "Reason", "Points", "A-Z Details"].map((h) => <Th key={h}>{h}</Th>)}
              </tr>
            </thead>
            <tbody>
              {visibleTrades.map((t) => (
                <tr key={t.id} className="border-b border-[var(--border-subtle)] text-[var(--text-secondary)]">
                  <td className="px-3 py-2">{t.id}</td>
                  {showTradeDate ? <td className="px-3 py-2 whitespace-nowrap">{fmtDate(t.tradeDate)}</td> : null}
                  <td className={cn("px-3 py-2 font-semibold", t.side === "CALL" ? "text-emerald-600" : "text-rose-600")}>{t.side}</td>
                  <td className="px-3 py-2">{entryTypeLabel(t.entryType)}</td>
                  <td className="px-3 py-2">{showTradeDate ? fmtTradeDt(t.tradeDate, t.entryTime) : t.entryTime}</td>
                  <td className="px-3 py-2">{showTradeDate ? fmtTradeDt(t.tradeDate, t.exitTime) : t.exitTime}</td>
                  <td className="px-3 py-2 font-mono">{t.entry}</td>
                  <td className="px-3 py-2 font-mono">{t.exit}</td>
                  <td className="px-3 py-2">{t.entryLots}</td>
                  <td className="px-3 py-2">{t.exitLots}</td>
                  <td className="px-3 py-2">{t.reason}</td>
                  <td className={cn("px-3 py-2 font-mono font-semibold", t.points >= 0 ? "text-emerald-600" : "text-rose-600")}>{t.points}</td>
                  <td className="max-w-[200px] px-3 py-2 text-xs">{t.note}</td>
                </tr>
              ))}
              {!visibleTrades.length ? <tr><td colSpan={showTradeDate ? 13 : 12} className="px-3 py-6 text-center text-[var(--text-muted)]">No trades yet.</td></tr> : null}
            </tbody>
          </table>
        </ScrollTable>
      </PremiumCard>
    </div>
  );
}
