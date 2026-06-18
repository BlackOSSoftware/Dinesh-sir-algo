'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';

import { normalizeLegEntryMode, useAlgoRuntime } from '@/components/trader/app-shell';
import { getApiBase, getStoredToken } from '@/lib/auth';

type AngelRow = Record<string, unknown>;

type AngelLive = {
  angel_ok?: boolean;
  angel_message?: string;
  mode?: string;
  fetched?: AngelRow[];
  unfetched?: AngelRow[];
  as_of?: number;
};

type StartBarClose = {
  ok?: boolean;
  start_time?: string;
  close?: number | null;
  candle_time?: string | null;
  message?: string;
};

type TradingMode = 'PAPER' | 'LIVE';

type ApiLogRow = {
  id: number;
  created_at: string;
  mode: string;
  leg: string;
  action: string;
  symbol: string | null;
  strike: number | null;
  quantity: number | null;
  entry_price: number | null;
  exit_price: number | null;
  pnl: number | null;
  status: string | null;
  order_id: string | null;
  message: string | null;
};

type ApiActiveRow = {
  id: number;
  leg_id: string;
  side: string;
  strike: number;
  lots: number;
  quantity: number;
  entry_price: number;
  current_price: number;
  pnl: number;
  status: string;
  trading_mode: string;
};

type ApiCompletedRow = {
  id: number;
  entry_time: string | null;
  exit_time: string | null;
  leg_id: string;
  side: string | null;
  range_level: number | null;
  strike: number | null;
  tp: number | null;
  symbol: string | null;
  entry_price: number | null;
  exit_price: number | null;
  pnl: number | null;
  trading_mode: string;
  exit_reason: string | null;
};

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickAngelQuoteRow(rows: AngelRow[] | undefined): AngelRow | undefined {
  if (!rows?.length) return undefined;
  const tokenOf = (r: AngelRow) => {
    const t = r.symbolToken ?? (r as { symboltoken?: unknown }).symboltoken;
    if (t === undefined || t === null) return '';
    return String(t).trim();
  };
  const symOf = (r: AngelRow) =>
    String(r.tradingSymbol ?? (r as { symbol?: unknown }).symbol ?? '').toUpperCase();
  const isIndexSensex = (r: AngelRow) => {
    if (tokenOf(r) === '99919000') return true;
    const s = symOf(r);
    if (s === 'SENSEX') return true;
    return false;
  };
  const isLikelyEtf = (r: AngelRow) => /ETF|BEES|IETF|BETA|ADD$/i.test(symOf(r));
  const sensex = rows.find((r) => isIndexSensex(r) && !isLikelyEtf(r));
  return sensex ?? rows[0];
}

/** Angel OHLC / FULL payloads use different keys; pick first usable price. */
function quotePriceFromRow(row: AngelRow | undefined): number | null {
  if (!row) return null;
  const keys = [
    'ltp',
    'Ltp',
    'lasttradedprice',
    'lastTradePrice',
    'close',
    'Close',
    'open',
    'Open',
    'netPrice',
    'NetPrice',
  ];
  for (const k of keys) {
    const n = num((row as Record<string, unknown>)[k]);
    if (n != null && n > 0) return n;
  }
  return null;
}

function pctFromRow(row: AngelRow | undefined): number | null {
  if (!row) return null;
  const keys = ['percentChange', 'pChange', 'percentage'];
  for (const k of keys) {
    const n = num((row as Record<string, unknown>)[k]);
    if (n != null && Number.isFinite(n)) return n;
  }
  return null;
}

function netFromRow(row: AngelRow | undefined): number | null {
  if (!row) return null;
  const keys = ['netChange', 'priceChange', 'change'];
  for (const k of keys) {
    const n = num((row as Record<string, unknown>)[k]);
    if (n != null && Number.isFinite(n)) return n;
  }
  return null;
}

function httpErrorDetail(data: Record<string, unknown>, fallback: string): string {
  const d = data.detail;
  if (typeof d === 'string' && d.trim()) return d;
  if (Array.isArray(d) && d.length) {
    const first = d[0] as Record<string, unknown>;
    if (typeof first.msg === 'string') return first.msg;
    if (typeof first.message === 'string') return first.message;
  }
  return fallback;
}

function isAngelTokenErrorText(s: string | null | undefined): boolean {
  if (!s || !s.trim()) return false;
  return /invalid\s*token|jwt\s*expired|token\s*expired|access\s*denied/i.test(s);
}

function TokenRefreshHint({ text }: { text: string | null | undefined }) {
  if (!text || !isAngelTokenErrorText(text)) return null;
  return (
    <p className="mt-2 text-[11px] leading-snug text-slate-600">
      Angel session expired: update{' '}
      <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px]">ANGEL_JWT_TOKEN</code>{' '}
      in <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px]">backend/.env</code> — from{' '}
      <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px]">backend/</code> run{' '}
      <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px]">
        python scripts/angel_smartapi_login.py
      </code>{' '}
      then restart the API worker.
    </p>
  );
}

function fmtInr(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function roundPx(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampNumEntries(n: number): number {
  return Math.min(20, Math.max(1, Math.round(n)));
}

function syncExitLotsToEngine(
  tp1: number,
  tp2: number,
  setLotsPerEntry: (n: number) => void,
  setNumEntries: (n: number) => void,
  setPartialClosePercent: (n: number) => void,
) {
  const t1 = Math.max(1, Math.round(tp1));
  const t2 = Math.max(1, Math.round(tp2));
  const total = t1 + t2;
  setLotsPerEntry(total);
  setNumEntries(1);
  setPartialClosePercent(Math.min(99, Math.max(1, Math.round((t1 / total) * 100))));
  return { tp1: t1, tp2: t2 };
}

function defaultTargetArrays(
  base: number,
  entryGap: number,
  addGap: number,
  numEntries: number,
  t1p: number,
  t2p: number
): { ceT1: number[]; ceT2: number[]; peT1: number[]; peT2: number[] } {
  const n = clampNumEntries(numEntries);
  const ceT1: number[] = [];
  const ceT2: number[] = [];
  let ce = base + entryGap;
  for (let i = 0; i < n; i++) {
    if (i > 0) ce = roundPx(ce - addGap);
    ceT1.push(roundPx(ce + t1p));
    ceT2.push(roundPx(ce + t2p));
  }
  const peT1: number[] = [];
  const peT2: number[] = [];
  let pe = base - entryGap;
  for (let i = 0; i < n; i++) {
    if (i > 0) pe = roundPx(pe + addGap);
    peT1.push(roundPx(pe - t1p));
    peT2.push(roundPx(pe - t2p));
  }
  return { ceT1, ceT2, peT1, peT2 };
}

function parseNumArray(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const x of v) {
    const z = num(x);
    if (z == null || !Number.isFinite(z)) return null;
    out.push(z);
  }
  return out;
}

function setIfChanged<T>(setter: (value: T) => void, lastRef: MutableRefObject<string>, value: T) {
  const next = JSON.stringify(value);
  if (next === lastRef.current) return;
  lastRef.current = next;
  setter(value);
}

/** Default strategy numbers (engine `sensex_option_buy.py` mirrors these). */
const DEFAULT_ENTRY_GAP = 200;
const DEFAULT_ADD_GAP = 50;
const DEFAULT_NUM_ENTRIES = 1;
const DEFAULT_TARGET1_PTS = 80;
const DEFAULT_TARGET2_PTS = 150;
const DEFAULT_LOTS_PER_ENTRY = 6;

type PreviewLegRow = {
  leg: string;
  side: string;
  entry: number;
  target1: number;
  target2: number;
  lots: number;
  status: string;
  tone: 'ce' | 'pe';
  rowIdx: number;
};

function buildPreviewLegRows(
  base: number,
  entryGap: number,
  addGap: number,
  numEntries: number,
  lotsPerEntry: number,
  liveIndex: number | null,
  ceT1: number[],
  ceT2: number[],
  peT1: number[],
  peT2: number[]
): PreviewLegRow[] {
  const n = clampNumEntries(numEntries);
  const rows: PreviewLegRow[] = [];

  const statusFor = (tone: 'ce' | 'pe', entry: number): string => {
    if (liveIndex == null || !Number.isFinite(liveIndex)) return '—';
    if (tone === 'ce') return liveIndex >= entry ? 'At/above entry' : 'Below entry';
    return liveIndex <= entry ? 'At/below entry' : 'Above entry';
  };

  let ceEntry = base + entryGap;
  for (let i = 0; i < n; i++) {
    if (i > 0) ceEntry = roundPx(ceEntry - addGap);
    const entry = roundPx(ceEntry);
    rows.push({
      leg: `CE${i + 1}`,
      side: 'CE BUY',
      entry,
      target1: roundPx(ceT1[i] ?? entry),
      target2: roundPx(ceT2[i] ?? entry),
      lots: Math.max(1, lotsPerEntry),
      status: statusFor('ce', entry),
      tone: 'ce',
      rowIdx: i,
    });
  }

  let peEntry = base - entryGap;
  for (let i = 0; i < n; i++) {
    if (i > 0) peEntry = roundPx(peEntry + addGap);
    const entry = roundPx(peEntry);
    rows.push({
      leg: `PE${i + 1}`,
      side: 'PE BUY',
      entry,
      target1: roundPx(peT1[i] ?? entry),
      target2: roundPx(peT2[i] ?? entry),
      lots: Math.max(1, lotsPerEntry),
      status: statusFor('pe', entry),
      tone: 'pe',
      rowIdx: i,
    });
  }

  return rows;
}

function parseDbUtcIso(iso: string): Date {
  let s = iso.trim();
  if (!s) return new Date(NaN);
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T');
  const hasTz =
    /[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{2}\d{2}$/.test(s);
  if (!hasTz) {
    s = s.replace(/(\.\d{3})\d+/, '$1');
    s = `${s}Z`;
  }
  return new Date(s);
}

function formatLogTimestamp(iso: string): string {
  try {
    const d = parseDbUtcIso(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 19);
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Full date + time in India timezone for completed trades (entry / exit). */
function formatTradeTimeIST(iso: string | null | undefined): string {
  if (iso == null || iso === '') return '—';
  try {
    const d = parseDbUtcIso(iso);
    if (Number.isNaN(d.getTime())) return String(iso).replace('T', ' ').slice(0, 23);
    const s = d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    return `${s} IST`;
  } catch {
    return String(iso).slice(0, 24);
  }
}

type TradingDashboardContextValue = ReturnType<typeof useTradingDashboardState>;

const TradingDashboardContext = createContext<TradingDashboardContextValue | null>(null);

export function useTradingDashboard() {
  const ctx = useContext(TradingDashboardContext);
  if (!ctx) {
    throw new Error('useTradingDashboard must be used within TradingDashboardProvider');
  }
  return ctx;
}

export function TradingDashboardProvider({ children }: { children: ReactNode }) {
  const value = useTradingDashboardState();
  return (
    <TradingDashboardContext.Provider value={value}>{children}</TradingDashboardContext.Provider>
  );
}

function useTradingDashboardState() {
  const { algoEnabled, setAlgoEnabled, legEntryMode, setLegEntryMode } = useAlgoRuntime();
  const [referencePrice, setReferencePrice] = useState<number>(0);
  const [angel, setAngel] = useState<AngelLive | null>(null);
  const [angelErr, setAngelErr] = useState<string | null>(null);

  const [startBar, setStartBar] = useState<StartBarClose | null>(null);
  const [startBarErr, setStartBarErr] = useState<string | null>(null);
  const [startBarLoading, setStartBarLoading] = useState(false);

  const fetchAngel = useCallback(async () => {
    const token = getStoredToken();
    if (!token) return;
    try {
      const res = await fetch(`${getApiBase()}/angel/live-quote`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const detail = httpErrorDetail(data, `HTTP ${res.status}`);
        setAngelErr(detail);
        setAngel(null);
        return;
      }
      const nextAngel = {
        angel_ok: Boolean(data.angel_ok),
        angel_message: typeof data.angel_message === 'string' ? data.angel_message : '',
        mode: typeof data.mode === 'string' ? data.mode : '',
        fetched: Array.isArray(data.fetched) ? (data.fetched as AngelRow[]) : [],
        unfetched: Array.isArray(data.unfetched) ? (data.unfetched as AngelRow[]) : [],
        as_of: typeof data.as_of === 'number' ? data.as_of : undefined,
      };
      setAngelErr(null);
      const nextAngelSig = JSON.stringify({ ...nextAngel, as_of: undefined });
      if (nextAngelSig !== angelSigRef.current) {
        angelSigRef.current = nextAngelSig;
        setAngel(nextAngel);
      }
    } catch {
      setAngelErr('Cannot reach Angel quote API');
      setAngel(null);
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void fetchAngel(), 0);
    const id = window.setInterval(() => void fetchAngel(), 3500);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [fetchAngel]);

  /** Live reference: prefer ltp/close/open from quote row (OHLC shapes vary). */
  useEffect(() => {
    const row = pickAngelQuoteRow(angel?.fetched);
    const px = quotePriceFromRow(row);
    if (px != null && Number.isFinite(px)) {
      const id = window.setTimeout(() => setReferencePrice((prev) => (prev === px ? prev : px)), 0);
      return () => window.clearTimeout(id);
    }
  }, [angel]);

  const [startTime, setStartTime] = useState<string>('09:15');
  const [endTime, setEndTime] = useState<string>('15:30');
  const [referenceClose, setReferenceClose] = useState<number | null>(null);
  const [partialClosePercent, setPartialClosePercent] = useState<number>(50);
  const [tp1ExitLots, setTp1ExitLots] = useState(3);
  const [tp2ExitLots, setTp2ExitLots] = useState(3);
  const [firstEntryEnabled, setFirstEntryEnabled] = useState(true);
  const [adaptiveCallRetraceHigh, setAdaptiveCallRetraceHigh] = useState(100);
  const [adaptivePutRetraceHigh, setAdaptivePutRetraceHigh] = useState(190);
  const [adaptivePutRetraceLow, setAdaptivePutRetraceLow] = useState(100);
  const [adaptiveCallRetraceLow, setAdaptiveCallRetraceLow] = useState(190);
  const [slMode, setSlMode] = useState<'auto' | 'manual'>('auto');
  const [isAdmin, setIsAdmin] = useState(false);
  const [angelRefreshBusy, setAngelRefreshBusy] = useState(false);
  const [angelRefreshFeedback, setAngelRefreshFeedback] = useState<string | null>(null);

  const persistTimerRef = useRef<number | null>(null);
  const lastStartBarCloseRef = useRef<number | null>(null);
  const angelSigRef = useRef('');
  const logsSigRef = useRef('');
  const activeSigRef = useRef('');
  const completedSigRef = useRef('');
  const startBarSigRef = useRef('');

  const [tradingMode, setTradingMode] = useState<TradingMode>('PAPER');
  const [exchangeLotSize, setExchangeLotSize] = useState(20);
  const [entryGap, setEntryGap] = useState(DEFAULT_ENTRY_GAP);
  const [addGap, setAddGap] = useState(DEFAULT_ADD_GAP);
  const [numEntries, setNumEntries] = useState(DEFAULT_NUM_ENTRIES);
  const [target1Pts, setTarget1Pts] = useState(DEFAULT_TARGET1_PTS);
  const [target2Pts, setTarget2Pts] = useState(DEFAULT_TARGET2_PTS);
  const [lotsPerEntry, setLotsPerEntry] = useState(DEFAULT_LOTS_PER_ENTRY);
  const [ceStopLoss, setCeStopLoss] = useState<number | null>(null);
  const [peStopLoss, setPeStopLoss] = useState<number | null>(null);
  const [ceT1, setCeT1] = useState<number[]>([]);
  const [ceT2, setCeT2] = useState<number[]>([]);
  const [peT1, setPeT1] = useState<number[]>([]);
  const [peT2, setPeT2] = useState<number[]>([]);
  const [tradingLogs, setTradingLogs] = useState<ApiLogRow[]>([]);
  const [activeTrades, setActiveTrades] = useState<ApiActiveRow[]>([]);
  const [completedTrades, setCompletedTrades] = useState<ApiCompletedRow[]>([]);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [bootDone, setBootDone] = useState(false);
  const [clearingCompleted, setClearingCompleted] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [engineAdaptiveHigh, setEngineAdaptiveHigh] = useState<number | null>(null);
  const [engineAdaptiveLow, setEngineAdaptiveLow] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = getStoredToken();
      if (!token) {
        if (!cancelled) setBootDone(true);
        return;
      }
      try {
        const res = await fetch(`${getApiBase()}/trading/settings`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok || cancelled) return;
        const cfg = (data.config as Record<string, unknown>) || {};
        if (typeof cfg.startTime === 'string') setStartTime(cfg.startTime.slice(0, 5));
        if (typeof cfg.endTime === 'string') setEndTime(cfg.endTime.slice(0, 5));
        const rc = num(cfg.referenceClose);
        if (rc != null && rc > 0) setReferenceClose(rc);
        const pp = num(cfg.partialClosePercent);
        if (pp != null && pp > 0) setPartialClosePercent(Math.min(100, Math.round(pp)));
        const t1Lots = num(cfg.tp1ExitLots);
        const t2Lots = num(cfg.tp2ExitLots);
        const lpeBoot = num(cfg.lotsPerEntry) ?? DEFAULT_LOTS_PER_ENTRY;
        const tcBoot = num(cfg.tradeCount) ?? DEFAULT_NUM_ENTRIES;
        const totalBoot = Math.max(1, lpeBoot * tcBoot);
        if (t1Lots != null && t1Lots > 0) {
          setTp1ExitLots(Math.round(t1Lots));
          const t2 = t2Lots != null && t2Lots > 0 ? Math.round(t2Lots) : totalBoot - Math.round(t1Lots);
          setTp2ExitLots(Math.max(1, t2));
        } else if (pp != null && pp > 0) {
          const t1 = Math.max(1, Math.round((totalBoot * pp) / 100));
          setTp1ExitLots(t1);
          setTp2ExitLots(Math.max(1, totalBoot - t1));
        }
        if (typeof cfg.firstEntryEnabled === 'boolean') setFirstEntryEnabled(cfg.firstEntryEnabled);
        const acrh = num(cfg.adaptiveCallRetraceHigh);
        if (acrh != null && acrh > 0 && acrh < 500) setAdaptiveCallRetraceHigh(Math.round(acrh));
        const aprh = num(cfg.adaptivePutRetraceHigh);
        if (aprh != null && aprh > 0 && aprh < 500) setAdaptivePutRetraceHigh(Math.round(aprh));
        const aprl = num(cfg.adaptivePutRetraceLow);
        if (aprl != null && aprl > 0 && aprl < 500) setAdaptivePutRetraceLow(Math.round(aprl));
        const acrl = num(cfg.adaptiveCallRetraceLow);
        if (acrl != null && acrl > 0 && acrl < 500) setAdaptiveCallRetraceLow(Math.round(acrl));
        if (cfg.slMode === 'manual' || cfg.slMode === 'auto') setSlMode(cfg.slMode);
        const elsz = cfg.exchangeLotSize;
        if (typeof elsz === 'number' && elsz > 0) setExchangeLotSize(elsz);
        const g = num(cfg.gap);
        if (g != null && g > 0) setEntryGap(Math.round(g));
        const off = num(cfg.offset);
        if (off != null && off > 0) setAddGap(Math.round(off));
        const tc = num(cfg.tradeCount);
        if (tc != null && tc > 0) setNumEntries(Math.min(20, Math.max(1, Math.round(tc))));
        const t1 = num(cfg.target1Points);
        if (t1 != null && t1 > 0) setTarget1Pts(Math.round(t1));
        const t2 = num(cfg.target2Points);
        if (t2 != null && t2 > 0) setTarget2Pts(Math.round(t2));
        const lpe = num(cfg.lotsPerEntry);
        if (lpe != null && lpe > 0) setLotsPerEntry(Math.min(100, Math.max(1, Math.round(lpe))));

        const nBoot = clampNumEntries(num(cfg.tradeCount) ?? DEFAULT_NUM_ENTRIES);
        const ceSl = num(cfg.sensexCeStopLoss);
        const peSl = num(cfg.sensexPeStopLoss);
        if (ceSl != null && ceSl > 0) setCeStopLoss(ceSl);
        else if (rc != null && rc > 0) setCeStopLoss(rc);
        else setCeStopLoss(null);
        if (peSl != null && peSl > 0) setPeStopLoss(peSl);
        else if (rc != null && rc > 0) setPeStopLoss(rc);
        else setPeStopLoss(null);

        const c1 = parseNumArray(cfg.sensexCeT1);
        const c2 = parseNumArray(cfg.sensexCeT2);
        const p1 = parseNumArray(cfg.sensexPeT1);
        const p2 = parseNumArray(cfg.sensexPeT2);
        const gBoot = num(cfg.gap) ?? DEFAULT_ENTRY_GAP;
        const offBoot = num(cfg.offset) ?? DEFAULT_ADD_GAP;
        const t1b = num(cfg.target1Points) ?? DEFAULT_TARGET1_PTS;
        const t2b = num(cfg.target2Points) ?? DEFAULT_TARGET2_PTS;
        const baseBoot = rc != null && rc > 0 ? rc : null;
        if (
          baseBoot != null &&
          c1 &&
          c2 &&
          p1 &&
          p2 &&
          c1.length === nBoot &&
          c2.length === nBoot &&
          p1.length === nBoot &&
          p2.length === nBoot
        ) {
          setCeT1(c1.map(roundPx));
          setCeT2(c2.map(roundPx));
          setPeT1(p1.map(roundPx));
          setPeT2(p2.map(roundPx));
        } else if (baseBoot != null) {
          const d0 = defaultTargetArrays(baseBoot, gBoot, offBoot, nBoot, t1b, t2b);
          setCeT1(d0.ceT1);
          setCeT2(d0.ceT2);
          setPeT1(d0.peT1);
          setPeT2(d0.peT2);
        }

        setLegEntryMode(normalizeLegEntryMode(cfg.legEntryMode), { persist: false });

        const ah = num(cfg.adaptiveHigh);
        if (ah != null && ah > 0) setEngineAdaptiveHigh(ah);
        const al = num(cfg.adaptiveLow);
        if (al != null && al > 0) setEngineAdaptiveLow(al);

        const tm = typeof data.trading_mode === 'string' ? data.trading_mode.toUpperCase() : 'PAPER';
        setTradingMode(tm === 'LIVE' ? 'LIVE' : 'PAPER');
        setAlgoEnabled(Boolean(data.algo_running));
      } finally {
        if (!cancelled) setBootDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setAlgoEnabled, setLegEntryMode]);

  useEffect(() => {
    if (!bootDone) return;
    const token = getStoredToken();
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    const poll = async () => {
      try {
        const [r1, r2, r3, r4] = await Promise.all([
          fetch(`${getApiBase()}/trading/logs?limit=400`, { headers, cache: 'no-store' }),
          fetch(`${getApiBase()}/trading/positions/active`, { headers, cache: 'no-store' }),
          fetch(`${getApiBase()}/trading/positions/completed?limit=150`, { headers, cache: 'no-store' }),
          fetch(`${getApiBase()}/trading/settings`, { headers, cache: 'no-store' }),
        ]);
        if (r1.ok) setIfChanged(setTradingLogs, logsSigRef, (await r1.json()) as ApiLogRow[]);
        if (r2.ok) setIfChanged(setActiveTrades, activeSigRef, (await r2.json()) as ApiActiveRow[]);
        if (r3.ok) setIfChanged(setCompletedTrades, completedSigRef, (await r3.json()) as ApiCompletedRow[]);
        if (r4.ok) {
          const data = (await r4.json()) as Record<string, unknown>;
          const cfg = (data.config as Record<string, unknown>) || {};
          const ah = num(cfg.adaptiveHigh);
          setEngineAdaptiveHigh(ah != null && ah > 0 ? ah : null);
          const al = num(cfg.adaptiveLow);
          setEngineAdaptiveLow(al != null && al > 0 ? al : null);
        }
      } catch {
        /* ignore */
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 3000);
    return () => window.clearInterval(id);
  }, [bootDone]);

  const fetchStartBarClose = useCallback(async () => {
    const token = getStoredToken();
    if (!token) return;
    const st = startTime.length >= 5 ? startTime.slice(0, 5) : startTime;
    setStartBarLoading(true);
    setStartBarErr(null);
    try {
      const qs = new URLSearchParams({ start: st });
      const res = await fetch(`${getApiBase()}/angel/start-bar-close?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const detail = httpErrorDetail(data, `HTTP ${res.status}`);
        setStartBarErr(detail);
        setStartBar(null);
        return;
      }
      const nextStartBar = {
        ok: Boolean(data.ok),
        start_time: typeof data.start_time === 'string' ? data.start_time : st,
        close: typeof data.close === 'number' ? data.close : null,
        candle_time: typeof data.candle_time === 'string' ? data.candle_time : null,
        message: typeof data.message === 'string' ? data.message : '',
      };
      setIfChanged(setStartBar, startBarSigRef, nextStartBar);
      if (typeof data.message === 'string' && data.message && !data.ok) {
        setStartBarErr(data.message);
      }
    } catch {
      setStartBarErr('Cannot load start-bar close');
      setStartBar(null);
    } finally {
      setStartBarLoading(false);
    }
  }, [startTime]);

  useEffect(() => {
    const first = window.setTimeout(() => void fetchStartBarClose(), 0);
    const id = window.setInterval(() => void fetchStartBarClose(), 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [fetchStartBarClose]);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) return;
    void fetch(`${getApiBase()}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        if (r.ok && typeof d.role === 'string') {
          setIsAdmin(String(d.role).toLowerCase() === 'admin');
        }
      })
      .catch(() => setIsAdmin(false));
  }, []);

  const runAngelServerRefresh = useCallback(async () => {
    const token = getStoredToken();
    if (!token) return;
    setAngelRefreshBusy(true);
    setAngelRefreshFeedback(null);
    try {
      const res = await fetch(`${getApiBase()}/angel/refresh-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (res.status === 403) {
        setAngelRefreshFeedback('Admin role required for server refresh.');
        return;
      }
      if (data.ok === true) {
        setAngelRefreshFeedback(
          typeof data.message === 'string' ? data.message : 'Angel session refreshed.'
        );
        await fetchAngel();
        await fetchStartBarClose();
      } else {
        setAngelRefreshFeedback(
          typeof data.error === 'string' ? data.error : `Request failed (HTTP ${res.status})`
        );
      }
    } catch {
      setAngelRefreshFeedback('Network error while refreshing Angel session.');
    } finally {
      setAngelRefreshBusy(false);
    }
  }, [fetchAngel, fetchStartBarClose]);

  const showAngelServerRefresh =
    isAdmin &&
    isAngelTokenErrorText(
      [angelErr, angel?.angel_message, startBarErr, startBar?.message].filter(Boolean).join('\n')
    );

  /** Calculated legs use **start bar close only** — never live LTP. Refresh until close is available. */
  const startBarCloseAnchor =
    startBar?.close != null && Number.isFinite(startBar.close) && startBar.close > 0
      ? startBar.close
      : null;

  useEffect(() => {
    if (startBarCloseAnchor == null || !Number.isFinite(startBarCloseAnchor)) return;
    const prev = lastStartBarCloseRef.current;
    if (prev === startBarCloseAnchor) return;

    setReferenceClose(startBarCloseAnchor);
    lastStartBarCloseRef.current = startBarCloseAnchor;

    if (prev === null) {
      setCeStopLoss((x) => (x == null ? startBarCloseAnchor : x));
      setPeStopLoss((x) => (x == null ? startBarCloseAnchor : x));
      const d = defaultTargetArrays(
        startBarCloseAnchor,
        entryGap,
        addGap,
        numEntries,
        target1Pts,
        target2Pts
      );
      setCeT1((c) => (c.length === 0 ? d.ceT1 : c));
      setCeT2((c) => (c.length === 0 ? d.ceT2 : c));
      setPeT1((c) => (c.length === 0 ? d.peT1 : c));
      setPeT2((c) => (c.length === 0 ? d.peT2 : c));
      return;
    }

    setCeStopLoss(startBarCloseAnchor);
    setPeStopLoss(startBarCloseAnchor);
    const d = defaultTargetArrays(
      startBarCloseAnchor,
      entryGap,
      addGap,
      numEntries,
      target1Pts,
      target2Pts
    );
    setCeT1(d.ceT1);
    setCeT2(d.ceT2);
    setPeT1(d.peT1);
    setPeT2(d.peT2);
  }, [startBarCloseAnchor, entryGap, addGap, numEntries, target1Pts, target2Pts]);

  const resetTargetsFromStructure = useCallback(
    (next: {
      entryGap?: number;
      addGap?: number;
      numEntries?: number;
      target1Pts?: number;
      target2Pts?: number;
    }) => {
      const eg = next.entryGap ?? entryGap;
      const ag = next.addGap ?? addGap;
      const ne = next.numEntries ?? numEntries;
      const t1p = next.target1Pts ?? target1Pts;
      const t2p = next.target2Pts ?? target2Pts;
      const b = referenceClose ?? startBarCloseAnchor;
      if (b == null || !Number.isFinite(b)) return;
      const d = defaultTargetArrays(b, eg, ag, ne, t1p, t2p);
      setCeT1(d.ceT1);
      setCeT2(d.ceT2);
      setPeT1(d.peT1);
      setPeT2(d.peT2);
    },
    [referenceClose, startBarCloseAnchor, entryGap, addGap, numEntries, target1Pts, target2Pts]
  );

  const previewRows = useMemo(() => {
    const base = referenceClose ?? startBarCloseAnchor;
    if (base == null || !Number.isFinite(base)) return null;
    const n = clampNumEntries(numEntries);
    if (ceT1.length !== n || ceT2.length !== n || peT1.length !== n || peT2.length !== n) return null;
    return buildPreviewLegRows(
      base,
      entryGap,
      addGap,
      numEntries,
      lotsPerEntry,
      referencePrice > 0 ? referencePrice : null,
      ceT1,
      ceT2,
      peT1,
      peT2
    );
  }, [
    referenceClose,
    startBarCloseAnchor,
    entryGap,
    addGap,
    numEntries,
    lotsPerEntry,
    referencePrice,
    ceT1,
    ceT2,
    peT1,
    peT2,
  ]);

  const effectiveBase = referenceClose ?? startBarCloseAnchor;

  const applyExitLots = useCallback(
    (tp1: number, tp2: number) => {
      const synced = syncExitLotsToEngine(
        tp1,
        tp2,
        setLotsPerEntry,
        setNumEntries,
        setPartialClosePercent,
      );
      setTp1ExitLots(synced.tp1);
      setTp2ExitLots(synced.tp2);
    },
    [],
  );

  const buildDashboardConfig = useCallback((): Record<string, unknown> => {
    const out: Record<string, unknown> = {
      startTime,
      endTime,
      gap: entryGap,
      offset: addGap,
      tradeCount: numEntries,
      target1Points: target1Pts,
      target2Points: target2Pts,
      lotsPerEntry: Math.max(1, Math.min(100, Math.round(lotsPerEntry))),
      sensexCeT1: ceT1,
      sensexCeT2: ceT2,
      sensexPeT1: peT1,
      sensexPeT2: peT2,
      partialClosePercent,
      tp1ExitLots,
      tp2ExitLots,
      firstEntryEnabled,
      adaptiveCallRetraceHigh,
      adaptivePutRetraceHigh,
      adaptivePutRetraceLow,
      adaptiveCallRetraceLow,
      putSL: '',
      callSL: '',
      slMode,
      exchangeLotSize,
      legEntryMode,
      trades: [],
    };
    if (referenceClose != null && Number.isFinite(referenceClose) && referenceClose > 0) {
      out.referenceClose = referenceClose;
    }
    const baseForSl = referenceClose ?? startBarCloseAnchor;
    if (baseForSl != null && Number.isFinite(baseForSl) && baseForSl > 0) {
      out.sensexCeStopLoss = ceStopLoss ?? baseForSl;
      out.sensexPeStopLoss = peStopLoss ?? baseForSl;
    }
    return out;
  }, [
    referenceClose,
    startTime,
    endTime,
    entryGap,
    addGap,
    numEntries,
    target1Pts,
    target2Pts,
    lotsPerEntry,
    ceT1,
    ceT2,
    peT1,
    peT2,
    ceStopLoss,
    peStopLoss,
    partialClosePercent,
    tp1ExitLots,
    tp2ExitLots,
    firstEntryEnabled,
    adaptiveCallRetraceHigh,
    adaptivePutRetraceHigh,
    adaptivePutRetraceLow,
    adaptiveCallRetraceLow,
    slMode,
    exchangeLotSize,
    legEntryMode,
    startBarCloseAnchor,
  ]);

  const pushSettingsToServer = useCallback(
    async (overrides?: Partial<{ algo_running: boolean; trading_mode: TradingMode }>) => {
      const token = getStoredToken();
      if (!token) return;
      const mode = overrides?.trading_mode ?? tradingMode;
      const run = overrides?.algo_running ?? algoEnabled;
      const body = {
        config: buildDashboardConfig(),
        trading_mode: mode,
        algo_running: run,
      };
      try {
        const res = await fetch(`${getApiBase()}/trading/settings`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          setPersistError(httpErrorDetail(data, `HTTP ${res.status}`));
          return;
        }
        setPersistError(null);
        if (typeof data.trading_mode === 'string') {
          const u = data.trading_mode.toUpperCase();
          setTradingMode(u === 'LIVE' ? 'LIVE' : 'PAPER');
        }
        if (typeof data.algo_running === 'boolean') setAlgoEnabled(data.algo_running);
      } catch {
        setPersistError('Cannot save trading settings');
      }
    },
    [algoEnabled, tradingMode, buildDashboardConfig, setAlgoEnabled]
  );

  useEffect(() => {
    if (!bootDone) return;
    if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      void pushSettingsToServer();
    }, 500);
    return () => {
      if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
    };
  }, [
    bootDone,
    pushSettingsToServer,
    referenceClose,
    startTime,
    endTime,
    partialClosePercent,
    tp1ExitLots,
    tp2ExitLots,
    firstEntryEnabled,
    adaptiveCallRetraceHigh,
    adaptivePutRetraceHigh,
    adaptivePutRetraceLow,
    adaptiveCallRetraceLow,
    slMode,
    tradingMode,
    algoEnabled,
    exchangeLotSize,
    legEntryMode,
    entryGap,
    addGap,
    numEntries,
    target1Pts,
    target2Pts,
    lotsPerEntry,
    ceT1,
    ceT2,
    peT1,
    peT2,
    ceStopLoss,
    peStopLoss,
  ]);

  const closeLegManual = useCallback(
    async (legLabel: string) => {
      const token = getStoredToken();
      if (!token) return;
      try {
        const res = await fetch(`${getApiBase()}/trading/legs/${encodeURIComponent(legLabel)}/close`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          setPersistError(httpErrorDetail(data, `HTTP ${res.status}`));
          return;
        }
        setPersistError(null);
      } catch {
        setPersistError('Manual close request failed');
      }
    },
    []
  );

  const clearCompletedTrades = useCallback(async () => {
    if (
      !window.confirm(
        'Delete all completed trades for your account? This cannot be undone.'
      )
    )
      return;
    const token = getStoredToken();
    if (!token) return;
    setClearingCompleted(true);
    try {
      const res = await fetch(`${getApiBase()}/trading/positions/completed`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setPersistError(httpErrorDetail(data, `HTTP ${res.status}`));
        return;
      }
      setPersistError(null);
      setCompletedTrades([]);
    } catch {
      setPersistError('Could not clear completed trades');
    } finally {
      setClearingCompleted(false);
    }
  }, []);

  const clearTradingLogs = useCallback(async () => {
    if (
      !window.confirm(
        'Delete all trading log entries for your account? This cannot be undone.'
      )
    )
      return;
    const token = getStoredToken();
    if (!token) return;
    setClearingLogs(true);
    try {
      const res = await fetch(`${getApiBase()}/trading/logs`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setPersistError(httpErrorDetail(data, `HTTP ${res.status}`));
        return;
      }
      setPersistError(null);
      setTradingLogs([]);
    } catch {
      setPersistError('Could not clear trading logs');
    } finally {
      setClearingLogs(false);
    }
  }, []);

  return {
    algoEnabled,
    setAlgoEnabled,
    legEntryMode,
    setLegEntryMode,
    tradingMode,
    setTradingMode,
    referencePrice,
    angel,
    angelErr,
    fetchAngel,
    runAngelServerRefresh,
    showAngelServerRefresh,
    angelRefreshBusy,
    angelRefreshFeedback,
    startTime,
    setStartTime,
    endTime,
    setEndTime,
    startBar,
    startBarErr,
    startBarLoading,
    fetchStartBarClose,
    referenceClose,
    effectiveBase,
    startBarCloseAnchor,
    entryGap,
    setEntryGap,
    addGap,
    setAddGap,
    numEntries,
    setNumEntries,
    target1Pts,
    setTarget1Pts,
    target2Pts,
    setTarget2Pts,
    lotsPerEntry,
    setLotsPerEntry,
    exchangeLotSize,
    setExchangeLotSize,
    partialClosePercent,
    setPartialClosePercent,
    tp1ExitLots,
    tp2ExitLots,
    applyExitLots,
    firstEntryEnabled,
    setFirstEntryEnabled,
    adaptiveCallRetraceHigh,
    setAdaptiveCallRetraceHigh,
    adaptivePutRetraceHigh,
    setAdaptivePutRetraceHigh,
    adaptivePutRetraceLow,
    setAdaptivePutRetraceLow,
    adaptiveCallRetraceLow,
    setAdaptiveCallRetraceLow,
    slMode,
    setSlMode,
    ceStopLoss,
    setCeStopLoss,
    peStopLoss,
    setPeStopLoss,
    ceT1,
    setCeT1,
    ceT2,
    setCeT2,
    peT1,
    setPeT1,
    peT2,
    setPeT2,
    previewRows,
    resetTargetsFromStructure,
    tradingLogs,
    activeTrades,
    completedTrades,
    persistError,
    bootDone,
    clearingCompleted,
    clearingLogs,
    pushSettingsToServer,
    closeLegManual,
    clearCompletedTrades,
    clearTradingLogs,
    buildDashboardConfig,
    engineAdaptiveHigh,
    engineAdaptiveLow,
    pickAngelQuoteRow,
    quotePriceFromRow,
    pctFromRow,
    netFromRow,
    fmtInr,
    formatLogTimestamp,
    formatTradeTimeIST,
    roundPx,
  };
}
