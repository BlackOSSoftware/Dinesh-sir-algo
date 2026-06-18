"use client";

import { fmtLevel, type CalculatedTradeRow } from "@/lib/strategy-reference";
import { PremiumCard, CardTitle } from "@/components/trader/ui/primitives";
import { cn } from "@/components/ui";

export function CalculatedTradesTable({
  rows,
  onLotsChange,
}: {
  rows: CalculatedTradeRow[];
  onLotsChange: (id: string, lots: number) => void;
}) {
  return (
    <PremiumCard compact>
      <CardTitle title="Calculated Trades" compact />
      {rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-[var(--text-muted)]">Waiting for base price capture.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-[var(--border-subtle)]">
          <table className="w-full min-w-[900px] border-collapse text-xs">
            <thead className="bg-[var(--surface-muted)] text-left text-[10px] text-[var(--text-muted)]">
              <tr>
                {["Trade Type", "Entry", "Lots", "TP1", "TP2", "SL", "Status"].map((h) => (
                  <th key={h} className="px-2 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    "border-t border-[var(--border-subtle)]",
                    row.side === "CALL" ? "bg-emerald-500/[0.02]" : "bg-rose-500/[0.02]",
                  )}
                >
                  <td className="px-2 py-1.5 font-medium">{row.tradeType}</td>
                  <td className="px-2 py-1.5 font-mono">{fmtLevel(row.entryLevel)}</td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={row.lots}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        if (Number.isFinite(n) && n > 0) onLotsChange(row.id, n);
                      }}
                      className="w-12 rounded border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-1 py-0.5 text-center font-mono outline-none focus:border-[var(--accent)]"
                    />
                  </td>
                  <td className="px-2 py-1.5 font-mono">{fmtLevel(row.tp1)}</td>
                  <td className="px-2 py-1.5 font-mono">{fmtLevel(row.tp2)}</td>
                  <td className="px-2 py-1.5 font-mono">{fmtLevel(row.stoploss)}</td>
                  <td className="px-2 py-1.5 text-[11px] text-[var(--text-secondary)]">{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PremiumCard>
  );
}
