"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useTradingDashboard } from "@/components/trader/trading-dashboard-context";
import {
  buildCalculatedTradeRows,
  callTargets,
  computeLevels,
  deriveWorkflowPhase,
  inferPositionProgress,
  putTargets,
  roundPx,
  STRATEGY_SPEC_DEFAULTS,
  type CalculatedTradeRow,
  type StrategyLevels,
  type StrategyParams,
  type StrategyWorkflowPhase,
} from "@/lib/strategy-reference";

function activeSideFromTrades(trades: { side: string }[]): "CALL" | "PUT" | "NONE" | "MIXED" {
  const hasCall = trades.some((t) => /call|ce/i.test(t.side));
  const hasPut = trades.some((t) => /put|pe/i.test(t.side));
  if (hasCall && hasPut) return "MIXED";
  if (hasCall) return "CALL";
  if (hasPut) return "PUT";
  return "NONE";
}

function sawTp1PartialToday(logs: { message: string | null; action?: string | null }[]): boolean {
  return logs.some((l) => {
    const text = `${l.action ?? ""} ${l.message ?? ""}`.toLowerCase();
    return /t1 partial|partial closed|tp1/i.test(text);
  });
}

export function useStrategyTerminal() {
  const d = useTradingDashboard();
  const [rowLots, setRowLots] = useState<Record<string, number>>({});
  const baseCapturedRef = useRef(false);

  const liveIndex = useMemo(() => {
    const row = d.pickAngelQuoteRow(d.angel?.fetched);
    return d.quotePriceFromRow(row);
  }, [d]);

  const basePrice = d.effectiveBase != null && d.effectiveBase > 0 ? d.effectiveBase : null;

  const params: StrategyParams = useMemo(() => {
    const totalLots = Math.max(1, d.lotsPerEntry * d.numEntries);
    const tp1ExitLots = d.tp1ExitLots || STRATEGY_SPEC_DEFAULTS.tp1ExitLots;
    const tp2ExitLots = d.tp2ExitLots || Math.max(1, totalLots - tp1ExitLots);
    return {
      startTime: d.startTime || STRATEGY_SPEC_DEFAULTS.startTime,
      endTime: d.endTime || STRATEGY_SPEC_DEFAULTS.endTime,
      rangeGap: d.entryGap || STRATEGY_SPEC_DEFAULTS.rangeGap,
      tp1Points: d.target1Pts || STRATEGY_SPEC_DEFAULTS.tp1Points,
      tp2Points: d.target2Pts || STRATEGY_SPEC_DEFAULTS.tp2Points,
      totalLots,
      tp1ExitLots,
      tp2ExitLots,
      firstEntryEnabled: d.firstEntryEnabled,
      adaptiveCallRetraceHigh: d.adaptiveCallRetraceHigh || STRATEGY_SPEC_DEFAULTS.adaptiveCallRetraceHigh,
      adaptivePutRetraceHigh: d.adaptivePutRetraceHigh || STRATEGY_SPEC_DEFAULTS.adaptivePutRetraceHigh,
      adaptivePutRetraceLow: d.adaptivePutRetraceLow || STRATEGY_SPEC_DEFAULTS.adaptivePutRetraceLow,
      adaptiveCallRetraceLow: d.adaptiveCallRetraceLow || STRATEGY_SPEC_DEFAULTS.adaptiveCallRetraceLow,
    };
  }, [d]);

  const levels: StrategyLevels = useMemo(() => {
    const l = computeLevels(basePrice, params.rangeGap);
    const candleTime =
      d.startBar?.candle_time ??
      (basePrice != null ? d.startBar?.start_time ?? params.startTime : null);
    return {
      ...l,
      capturedCandleTime: candleTime,
    };
  }, [basePrice, params.rangeGap, params.startTime, d.startBar?.candle_time, d.startBar?.start_time]);

  useEffect(() => {
    if (basePrice != null) baseCapturedRef.current = true;
  }, [basePrice]);

  const adaptiveHigh =
    d.engineAdaptiveHigh != null && d.engineAdaptiveHigh > 0
      ? roundPx(d.engineAdaptiveHigh)
      : null;
  const adaptiveLow =
    d.engineAdaptiveLow != null && d.engineAdaptiveLow > 0
      ? roundPx(d.engineAdaptiveLow)
      : null;

  const activeSide = activeSideFromTrades(d.activeTrades);
  const hasCompletedToday = d.completedTrades.length > 0;
  const primaryActive = d.activeTrades[0] ?? null;
  const activeLots = primaryActive?.lots ?? 0;

  const activeTpLevels = useMemo(() => {
    if (!primaryActive || levels.upperTrigger == null || levels.lowerTrigger == null) {
      return { tp1: null as number | null, tp2: null as number | null };
    }
    const isCall = /call|ce/i.test(primaryActive.side);
    const entry =
      isCall && Math.abs(primaryActive.strike - levels.upperTrigger) < params.rangeGap * 2
        ? levels.upperTrigger
        : !isCall && Math.abs(primaryActive.strike - levels.lowerTrigger) < params.rangeGap * 2
          ? levels.lowerTrigger
          : primaryActive.strike;
    if (isCall) return callTargets(entry, params.tp1Points, params.tp2Points);
    return putTargets(entry, params.tp1Points, params.tp2Points);
  }, [primaryActive, levels, params]);

  const tp1Reached = useMemo(() => {
    if (liveIndex == null || activeTpLevels.tp1 == null || activeSide === "NONE") return false;
    if (activeSide === "CALL" || activeSide === "MIXED") return liveIndex >= activeTpLevels.tp1;
    return liveIndex <= activeTpLevels.tp1;
  }, [liveIndex, activeTpLevels.tp1, activeSide]);

  const positionProgress = inferPositionProgress({
    activeLots,
    totalLots: params.totalLots,
    tp1ExitLots: params.tp1ExitLots,
    liveIndex,
    upperTrigger: levels.upperTrigger,
    lowerTrigger: levels.lowerTrigger,
    tp1Level: activeTpLevels.tp1 ?? (levels.upperTrigger != null ? callTargets(levels.upperTrigger, params.tp1Points, params.tp2Points).tp1 : null),
    activeSide,
    sawTp1PartialToday: sawTp1PartialToday(d.tradingLogs),
    isFlat: activeSide === "NONE",
  });

  const phase: StrategyWorkflowPhase = deriveWorkflowPhase({
    startTime: params.startTime,
    endTime: params.endTime,
    basePrice,
    liveIndex,
    upperTrigger: levels.upperTrigger,
    lowerTrigger: levels.lowerTrigger,
    activeSide,
    adaptiveHigh,
    adaptiveLow,
    hasCompletedToday,
    positionProgress,
    tp1Reached,
  });

  const calculatedRows: CalculatedTradeRow[] = useMemo(() => {
    const rows = buildCalculatedTradeRows(levels, params, adaptiveHigh, adaptiveLow, liveIndex);
    return rows.map((r) => ({
      ...r,
      lots: rowLots[r.id] ?? r.lots,
    }));
  }, [levels, params, adaptiveHigh, adaptiveLow, liveIndex, rowLots]);

  return {
    d,
    liveIndex,
    basePrice,
    params,
    levels,
    phase,
    adaptiveHigh,
    adaptiveLow,
    calculatedRows,
    activeSide,
    primaryActive,
    activeTpLevels,
    positionProgress,
    setRowLots,
  };
}
