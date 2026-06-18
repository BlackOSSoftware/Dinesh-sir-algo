/**
 * Display-only strategy math — source of truth: product strategy reference doc.
 * Does NOT execute trades; mirrors documented formulas for the dashboard terminal.
 */

export type StrategyWorkflowPhase =
  | "WAITING_SESSION"
  | "WAITING_BASE"
  | "BASE_CAPTURED"
  | "WATCHING_TRIGGERS"
  | "CALL_ACTIVE"
  | "PUT_ACTIVE"
  | "TP1_ACTIVE"
  | "REFILL_WINDOW"
  | "TP2_ACTIVE"
  | "ADAPTIVE_TRACKING"
  | "ADAPTIVE_ENTRY"
  | "COMPLETED"
  | "SESSION_END";

export type CalculatedTradeType =
  | "Initial Call Entry"
  | "Initial Put Entry"
  | "Call TP1 Refill"
  | "Put TP1 Refill"
  | "Call TP2 Re-entry"
  | "Put TP2 Re-entry"
  | "Adaptive Call Entry"
  | "Adaptive Put Entry";

export type CalculatedTradeRow = {
  id: string;
  tradeType: CalculatedTradeType;
  entryLevel: number | null;
  lots: number;
  tp1: number | null;
  tp2: number | null;
  stoploss: number | null;
  status: string;
  side: "CALL" | "PUT";
  editableLots: boolean;
};

export type StrategyLevels = {
  basePrice: number | null;
  upperTrigger: number | null;
  lowerTrigger: number | null;
  capturedCandleTime: string | null;
};

export type StrategyParams = {
  startTime: string;
  endTime: string;
  rangeGap: number;
  tp1Points: number;
  tp2Points: number;
  totalLots: number;
  tp1ExitLots: number;
  tp2ExitLots: number;
  firstEntryEnabled: boolean;
  /** Adaptive retrace from HIGH (call = 100, put = 190 per spec) */
  adaptiveCallRetraceHigh: number;
  adaptivePutRetraceHigh: number;
  /** Adaptive retrace from LOW (put = 100, call = 190 per spec) */
  adaptivePutRetraceLow: number;
  adaptiveCallRetraceLow: number;
};

export const STRATEGY_SPEC_DEFAULTS: StrategyParams = {
  startTime: "09:15",
  endTime: "15:30",
  rangeGap: 200,
  tp1Points: 80,
  tp2Points: 150,
  totalLots: 6,
  tp1ExitLots: 3,
  tp2ExitLots: 3,
  firstEntryEnabled: true,
  adaptiveCallRetraceHigh: 100,
  adaptivePutRetraceHigh: 190,
  adaptivePutRetraceLow: 100,
  adaptiveCallRetraceLow: 190,
};

export function roundPx(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmtLevel(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export function computeLevels(basePrice: number | null, rangeGap: number): StrategyLevels {
  if (basePrice == null || !Number.isFinite(basePrice) || basePrice <= 0) {
    return { basePrice: null, upperTrigger: null, lowerTrigger: null, capturedCandleTime: null };
  }
  return {
    basePrice: roundPx(basePrice),
    upperTrigger: roundPx(basePrice + rangeGap),
    lowerTrigger: roundPx(basePrice - rangeGap),
    capturedCandleTime: null,
  };
}

export function callTargets(entry: number, tp1Pts: number, tp2Pts: number) {
  return { tp1: roundPx(entry + tp1Pts), tp2: roundPx(entry + tp2Pts) };
}

export function putTargets(entry: number, tp1Pts: number, tp2Pts: number) {
  return { tp1: roundPx(entry - tp1Pts), tp2: roundPx(entry - tp2Pts) };
}

export function buildCalculatedTradeRows(
  levels: StrategyLevels,
  params: StrategyParams,
  adaptiveHigh: number | null,
  adaptiveLow: number | null,
  liveIndex: number | null,
): CalculatedTradeRow[] {
  const { upperTrigger: upper, lowerTrigger: lower, basePrice: base } = levels;
  if (upper == null || lower == null || base == null) return [];

  const statusAt = (entry: number, side: "CALL" | "PUT") => {
    if (liveIndex == null) return "Pending";
    if (side === "CALL") {
      if (liveIndex >= entry) return "Trigger reached";
      return "Waiting";
    }
    if (liveIndex <= entry) return "Trigger reached";
    return "Waiting";
  };

  const initialCallTp = callTargets(upper, params.tp1Points, params.tp2Points);
  const initialPutTp = putTargets(lower, params.tp1Points, params.tp2Points);

  const rows: CalculatedTradeRow[] = [
    {
      id: "initial-call",
      tradeType: "Initial Call Entry",
      entryLevel: upper,
      lots: params.totalLots,
      tp1: initialCallTp.tp1,
      tp2: initialCallTp.tp2,
      stoploss: lower,
      status: params.firstEntryEnabled ? statusAt(upper, "CALL") : "First entry disabled",
      side: "CALL",
      editableLots: true,
    },
    {
      id: "initial-put",
      tradeType: "Initial Put Entry",
      entryLevel: lower,
      lots: params.totalLots,
      tp1: initialPutTp.tp1,
      tp2: initialPutTp.tp2,
      stoploss: upper,
      status: params.firstEntryEnabled ? statusAt(lower, "PUT") : "First entry disabled",
      side: "PUT",
      editableLots: true,
    },
    {
      id: "call-tp1-refill",
      tradeType: "Call TP1 Refill",
      entryLevel: upper,
      lots: params.tp1ExitLots,
      tp1: initialCallTp.tp1,
      tp2: initialCallTp.tp2,
      stoploss: lower,
      status: `Refill if ${fmtLevel(initialCallTp.tp1)} → ${fmtLevel(upper)}`,
      side: "CALL",
      editableLots: true,
    },
    {
      id: "put-tp1-refill",
      tradeType: "Put TP1 Refill",
      entryLevel: lower,
      lots: params.tp1ExitLots,
      tp1: initialPutTp.tp1,
      tp2: initialPutTp.tp2,
      stoploss: upper,
      status: `Refill if ${fmtLevel(initialPutTp.tp1)} → ${fmtLevel(lower)}`,
      side: "PUT",
      editableLots: true,
    },
    {
      id: "call-tp2-reentry",
      tradeType: "Call TP2 Re-entry",
      entryLevel: initialCallTp.tp1,
      lots: params.tp1ExitLots,
      tp1: initialCallTp.tp1,
      tp2: initialCallTp.tp2,
      stoploss: lower,
      status: `Re-entry at TP1 level ${fmtLevel(initialCallTp.tp1)}`,
      side: "CALL",
      editableLots: true,
    },
    {
      id: "put-tp2-reentry",
      tradeType: "Put TP2 Re-entry",
      entryLevel: initialPutTp.tp1,
      lots: params.tp1ExitLots,
      tp1: initialPutTp.tp1,
      tp2: initialPutTp.tp2,
      stoploss: upper,
      status: `Re-entry at TP1 level ${fmtLevel(initialPutTp.tp1)}`,
      side: "PUT",
      editableLots: true,
    },
  ];

  if (adaptiveHigh != null && adaptiveHigh > base) {
    const callTrig = roundPx(adaptiveHigh - params.adaptiveCallRetraceHigh);
    const putTrig = roundPx(adaptiveHigh - params.adaptivePutRetraceHigh);
    const callTp = callTargets(callTrig, params.tp1Points, params.tp2Points);
    const putTp = putTargets(putTrig, params.tp1Points, params.tp2Points);
    rows.push(
      {
        id: "adaptive-call-high",
        tradeType: "Adaptive Call Entry",
        entryLevel: callTrig,
        lots: params.totalLots,
        tp1: callTp.tp1,
        tp2: callTp.tp2,
        stoploss: lower,
        status: statusAt(callTrig, "CALL"),
        side: "CALL",
        editableLots: true,
      },
      {
        id: "adaptive-put-high",
        tradeType: "Adaptive Put Entry",
        entryLevel: putTrig,
        lots: params.totalLots,
        tp1: putTp.tp1,
        tp2: putTp.tp2,
        stoploss: upper,
        status: statusAt(putTrig, "PUT"),
        side: "PUT",
        editableLots: true,
      },
    );
  }

  if (adaptiveLow != null && adaptiveLow < base) {
    const putTrigLow = roundPx(adaptiveLow + params.adaptivePutRetraceLow);
    const callTrigLow = roundPx(adaptiveLow + params.adaptiveCallRetraceLow);
    const putTpL = putTargets(putTrigLow, params.tp1Points, params.tp2Points);
    const callTpL = callTargets(callTrigLow, params.tp1Points, params.tp2Points);
    rows.push(
      {
        id: "adaptive-put-low",
        tradeType: "Adaptive Put Entry",
        entryLevel: putTrigLow,
        lots: params.totalLots,
        tp1: putTpL.tp1,
        tp2: putTpL.tp2,
        stoploss: upper,
        status: statusAt(putTrigLow, "PUT"),
        side: "PUT",
        editableLots: true,
      },
      {
        id: "adaptive-call-low",
        tradeType: "Adaptive Call Entry",
        entryLevel: callTrigLow,
        lots: params.totalLots,
        tp1: callTpL.tp1,
        tp2: callTpL.tp2,
        stoploss: lower,
        status: statusAt(callTrigLow, "CALL"),
        side: "CALL",
        editableLots: true,
      },
    );
  }

  return rows;
}

export function parseIstMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function nowIstMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const min = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return h * 60 + min;
}

export type PositionProgress = "NONE" | "FULL" | "POST_TP1" | "REFILL_WINDOW";

export function inferPositionProgress(input: {
  activeLots: number;
  totalLots: number;
  tp1ExitLots: number;
  liveIndex: number | null;
  upperTrigger: number | null;
  lowerTrigger: number | null;
  tp1Level: number | null;
  activeSide: "CALL" | "PUT" | "NONE" | "MIXED";
  sawTp1PartialToday: boolean;
  isFlat: boolean;
}): PositionProgress {
  if (input.activeSide !== "NONE" && input.activeSide !== "MIXED") {
    if (input.activeLots > 0 && input.activeLots < input.totalLots) return "POST_TP1";
    if (input.activeLots >= input.totalLots) return "FULL";
    return "NONE";
  }

  if (
    input.isFlat &&
    input.sawTp1PartialToday &&
    input.liveIndex != null &&
    input.tp1Level != null &&
    input.upperTrigger != null &&
    input.lowerTrigger != null
  ) {
    const inCallRefill =
      input.liveIndex <= input.tp1Level && input.liveIndex >= input.upperTrigger;
    const inPutRefill =
      input.liveIndex >= input.tp1Level && input.liveIndex <= input.lowerTrigger;
    if (inCallRefill || inPutRefill) return "REFILL_WINDOW";
  }

  return "NONE";
}

export function deriveWorkflowPhase(input: {
  startTime: string;
  endTime: string;
  basePrice: number | null;
  liveIndex: number | null;
  upperTrigger: number | null;
  lowerTrigger: number | null;
  activeSide: "CALL" | "PUT" | "NONE" | "MIXED";
  adaptiveHigh: number | null;
  adaptiveLow: number | null;
  hasCompletedToday: boolean;
  positionProgress: PositionProgress;
  tp1Reached: boolean;
}): StrategyWorkflowPhase {
  const start = parseIstMinutes(input.startTime);
  const end = parseIstMinutes(input.endTime);
  const now = nowIstMinutes();

  if (start != null && now < start) return "WAITING_SESSION";
  if (input.basePrice == null) return "WAITING_BASE";

  if (end != null && now > end) return "SESSION_END";

  if (input.positionProgress === "REFILL_WINDOW") return "REFILL_WINDOW";
  if (input.positionProgress === "POST_TP1") return "TP2_ACTIVE";
  if (input.activeSide === "CALL" || input.activeSide === "PUT" || input.activeSide === "MIXED") {
    if (input.tp1Reached && input.positionProgress === "FULL") return "TP1_ACTIVE";
    return input.activeSide === "PUT" ? "PUT_ACTIVE" : "CALL_ACTIVE";
  }

  if (input.adaptiveHigh != null || input.adaptiveLow != null) {
    if (input.liveIndex != null && input.upperTrigger != null && input.lowerTrigger != null) {
      const nearAdaptive =
        (input.adaptiveHigh != null && input.liveIndex >= input.adaptiveHigh - 200) ||
        (input.adaptiveLow != null && input.liveIndex <= input.adaptiveLow + 200);
      if (nearAdaptive) return "ADAPTIVE_ENTRY";
    }
    return "ADAPTIVE_TRACKING";
  }

  if (input.hasCompletedToday && input.positionProgress === "NONE") return "COMPLETED";
  if (input.liveIndex != null && input.upperTrigger != null && input.lowerTrigger != null) {
    return "WATCHING_TRIGGERS";
  }
  return "BASE_CAPTURED";
}

export const WORKFLOW_STEPS: { phase: StrategyWorkflowPhase; label: string }[] = [
  { phase: "WAITING_SESSION", label: "Waiting Session" },
  { phase: "WAITING_BASE", label: "Base Capture" },
  { phase: "BASE_CAPTURED", label: "Base Captured" },
  { phase: "WATCHING_TRIGGERS", label: "Triggers Live" },
  { phase: "CALL_ACTIVE", label: "Call Entry" },
  { phase: "TP1_ACTIVE", label: "TP1" },
  { phase: "REFILL_WINDOW", label: "Refill" },
  { phase: "TP2_ACTIVE", label: "TP2" },
  { phase: "ADAPTIVE_TRACKING", label: "Adaptive Track" },
  { phase: "ADAPTIVE_ENTRY", label: "Adaptive Entry" },
  { phase: "COMPLETED", label: "Completion" },
];

export function retracePoints(stored: number | null, specDefault: number): number {
  if (stored != null && stored > 0 && stored < 500) return Math.round(stored);
  return specDefault;
}
