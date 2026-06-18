"use client";

import { useMemo } from "react";

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Side = "CALL" | "PUT";
type Trade = {
  id: number;
  tradeDate: string;
  side: Side;
  entryTime: string;
  exitTime: string;
  entry: number;
  exit: number;
  entryLots: number;
  exitLots: number;
  entryType: string;
  reason: string;
};

type Marker = {
  key: string;
  kind: "BUY" | "SELL";
  idx: number;
  price: number;
  time: string;
  tradeDate: string;
  label: string;
  side: Side;
};

const shortTime = (s: string) => s.replace("T", " ").slice(11, 16) || s.slice(0, 5);
const fmtPx = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function buildCandleIndex(candles: Candle[]) {
  const exact = new Map<string, number>();
  const byDate = new Map<string, { times: string[]; indexes: number[] }>();
  candles.forEach((c, i) => {
    const raw = c.time.replace("T", " ");
    const date = raw.slice(0, 10);
    const t = shortTime(c.time);
    exact.set(`${date}|${t}`, i);
    const rows = byDate.get(date);
    if (rows) {
      rows.times.push(t);
      rows.indexes.push(i);
    } else {
      byDate.set(date, { times: [t], indexes: [i] });
    }
  });
  return { exact, byDate };
}

function indexedCandleIndex(index: ReturnType<typeof buildCandleIndex>, candles: Candle[], tradeDate: string, time: string) {
  const hit = index.exact.get(`${tradeDate}|${time}`);
  if (hit != null) return hit;
  const day = index.byDate.get(tradeDate);
  if (!day) return Math.max(0, candles.length - 1);
  const next = day.times.findIndex((t) => t >= time);
  return next >= 0 ? day.indexes[next] : day.indexes[day.indexes.length - 1];
}

function buildMarkers(trades: Trade[]): Omit<Marker, "idx">[] {
  const markers: Omit<Marker, "idx">[] = [];
  for (const t of trades) {
    markers.push({
      key: `sell-${t.id}`,
      kind: "SELL",
      price: t.exit,
      time: t.exitTime,
      tradeDate: t.tradeDate,
      label: `${t.reason} · ${t.exitLots}L @ ${fmtPx(t.exit)}`,
      side: t.side,
    });
    if (t.entryType !== "TP2_REMAINING") {
      markers.push({
        key: `buy-${t.id}`,
        kind: "BUY",
        price: t.entry,
        time: t.entryTime,
        tradeDate: t.tradeDate,
        label: `Buy · ${t.entryLots}L @ ${fmtPx(t.entry)}`,
        side: t.side,
      });
    }
  }
  return markers;
}

export function BacktestChart({
  candles,
  trades,
  base,
  upper,
  lower,
}: {
  candles: Candle[];
  trades: Trade[];
  base?: number;
  upper?: number;
  lower?: number;
}) {
  const layout = useMemo(() => {
    if (!candles.length) return null;

    const padL = 58;
    const padR = 16;
    const padT = 28;
    const padB = 36;
    const w = 1100;
    const h = 440;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const prices: number[] = [];
    for (const c of candles) prices.push(c.high, c.low);
    if (base) prices.push(base);
    if (upper) prices.push(upper);
    if (lower) prices.push(lower);
    trades.forEach((t) => {
      prices.push(t.entry, t.exit);
    });

    const rawMin = Math.min(...prices);
    const rawMax = Math.max(...prices);
    const span = Math.max(1, rawMax - rawMin);
    const min = rawMin - span * 0.04;
    const max = rawMax + span * 0.08;

    const xAt = (i: number) => padL + (i / Math.max(1, candles.length - 1)) * plotW;
    const yAt = (p: number) => padT + ((max - p) / (max - min)) * plotH;
    const candleW = Math.max(1.8, (plotW / candles.length) * 0.55);

    const candleLookup = buildCandleIndex(candles);
    const markers = buildMarkers(trades).map((m) => {
      const idx = indexedCandleIndex(candleLookup, candles, m.tradeDate, m.time);
      return {
        ...m,
        idx,
        x: xAt(idx),
        y: yAt(m.price),
      };
    });

    return { w, h, padL, padT, plotW, plotH, min, max, xAt, yAt, candleW, markers };
  }, [candles, trades, base, upper, lower]);

  if (!candles.length || !layout) {
    return (
      <div className="grid h-[440px] place-items-center rounded-lg border border-[var(--border-subtle)] text-sm text-[var(--text-muted)]">
        Load candles to show chart
      </div>
    );
  }

  const { w, h, padL, plotW, min, max, xAt, yAt, candleW, markers } = layout;
  const yTicks = 6;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-4 text-[10px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" /> Up candle
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" /> Down candle
        </span>
        <span className="inline-flex items-center gap-1.5 text-emerald-600">
          <span>▲</span> Buy entry
        </span>
        <span className="inline-flex items-center gap-1.5 text-amber-600">
          <span>▼</span> Exit / sell
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
        <svg viewBox={`0 0 ${w} ${h}`} className="min-w-full" style={{ minWidth: w, height: h }}>
          {/* grid + Y labels */}
          {Array.from({ length: yTicks + 1 }, (_, i) => {
            const p = min + ((max - min) * i) / yTicks;
            const y = yAt(p);
            return (
              <g key={i}>
                <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="var(--border-subtle)" strokeWidth="1" strokeDasharray="4 4" />
                <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="9" fill="var(--text-muted)" fontFamily="monospace">
                  {fmtPx(p)}
                </text>
              </g>
            );
          })}

          {/* level lines */}
          {base != null && base > 0 ? (
            <g>
              <line x1={padL} y1={yAt(base)} x2={padL + plotW} y2={yAt(base)} stroke="#6366f1" strokeWidth="1" strokeDasharray="6 4" opacity={0.7} />
              <text x={padL + plotW - 4} y={yAt(base) - 4} textAnchor="end" fontSize="9" fill="#6366f1">BASE</text>
            </g>
          ) : null}
          {upper != null && upper > 0 ? (
            <g>
              <line x1={padL} y1={yAt(upper)} x2={padL + plotW} y2={yAt(upper)} stroke="#10b981" strokeWidth="1" strokeDasharray="6 4" opacity={0.65} />
              <text x={padL + plotW - 4} y={yAt(upper) - 4} textAnchor="end" fontSize="9" fill="#10b981">UPPER</text>
            </g>
          ) : null}
          {lower != null && lower > 0 ? (
            <g>
              <line x1={padL} y1={yAt(lower)} x2={padL + plotW} y2={yAt(lower)} stroke="#f43f5e" strokeWidth="1" strokeDasharray="6 4" opacity={0.65} />
              <text x={padL + plotW - 4} y={yAt(lower) - 4} textAnchor="end" fontSize="9" fill="#f43f5e">LOWER</text>
            </g>
          ) : null}

          {/* candlesticks */}
          {candles.map((c, i) => {
            const cx = xAt(i);
            const up = c.close >= c.open;
            const color = up ? "#10b981" : "#f43f5e";
            const bodyTop = yAt(Math.max(c.open, c.close));
            const bodyBottom = yAt(Math.min(c.open, c.close));
            const bodyH = Math.max(1, bodyBottom - bodyTop);
            return (
              <g key={c.time + i}>
                <line x1={cx} y1={yAt(c.high)} x2={cx} y2={yAt(c.low)} stroke={color} strokeWidth="1" />
                <rect x={cx - candleW / 2} y={bodyTop} width={candleW} height={bodyH} fill={color} rx="0.3" />
              </g>
            );
          })}

          {/* trade markers */}
          {markers.map((m) => {
            const fill = m.kind === "BUY" ? (m.side === "CALL" ? "#059669" : "#e11d48") : "#d97706";
            const arrowH = 10;
            const arrowW = 8;
            const labelY = m.kind === "BUY" ? m.y + 22 : m.y - 14;
            const arrowY = m.kind === "BUY" ? m.y + 4 : m.y - 4;
            return (
              <g key={m.key}>
                {m.kind === "BUY" ? (
                  <polygon
                    points={`${m.x},${arrowY} ${m.x - arrowW / 2},${arrowY + arrowH} ${m.x + arrowW / 2},${arrowY + arrowH}`}
                    fill={fill}
                    stroke="#fff"
                    strokeWidth="0.8"
                  />
                ) : (
                  <polygon
                    points={`${m.x},${arrowY} ${m.x - arrowW / 2},${arrowY - arrowH} ${m.x + arrowW / 2},${arrowY - arrowH}`}
                    fill={fill}
                    stroke="#fff"
                    strokeWidth="0.8"
                  />
                )}
                <rect x={m.x - 52} y={labelY - 9} width={104} height={14} rx="3" fill="var(--surface-elevated)" stroke="var(--border-subtle)" strokeWidth="0.5" opacity={0.95} />
                <text x={m.x} y={labelY + 1} textAnchor="middle" fontSize="7.5" fill="var(--text-primary)" fontFamily="monospace">
                  {m.label.length > 28 ? `${m.label.slice(0, 26)}…` : m.label}
                </text>
              </g>
            );
          })}

          {/* X time labels (sparse) */}
          {candles
            .map((c, i, arr) => {
              const step = Math.ceil(arr.length / 8);
              return i === 0 || i === arr.length - 1 || i % step === 0 ? { i, t: shortTime(c.time) } : null;
            })
            .filter((x): x is { i: number; t: string } => x != null)
            .map(({ i, t }) => (
              <text key={`${t}-${i}`} x={xAt(i)} y={h - 10} textAnchor="middle" fontSize="9" fill="var(--text-muted)" fontFamily="monospace">
                {t}
              </text>
            ))}
        </svg>
      </div>
    </div>
  );
}
