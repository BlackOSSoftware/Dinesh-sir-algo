"use client";

import { Save } from "lucide-react";
import { useState } from "react";

import { useTradingDashboard } from "@/components/trader/trading-dashboard-context";
import { CardTitle, FloatingField, PageHeader, PremiumCard } from "@/components/trader/ui/primitives";
import { cn } from "@/components/ui";

function displayField(v: number | null | undefined, bootDone: boolean): string {
  if (!bootDone) return "";
  if (v == null || !Number.isFinite(v) || v === 0) return "";
  return String(v);
}

function displayTime(v: string, bootDone: boolean): string {
  if (!bootDone) return "";
  return v || "";
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 border-b border-[var(--border-subtle)] pb-2 text-xs font-semibold text-[var(--text-secondary)]">
      {children}
    </p>
  );
}

export function StrategyView() {
  const d = useTradingDashboard();
  const [saveFlash, setSaveFlash] = useState(false);

  async function handleSave() {
    await d.pushSettingsToServer();
    setSaveFlash(true);
    window.setTimeout(() => setSaveFlash(false), 1200);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-10">
      <PageHeader
        title="Settings"
        subtitle="Strategy parameters"
        action={
          <button
            type="button"
            onClick={() => void handleSave()}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            <Save className="h-4 w-4" />
            {saveFlash ? "Saved" : "Save"}
          </button>
        }
      />

      <PremiumCard className="!p-4">
        <CardTitle title="Session" />
        <div className="grid gap-3 sm:grid-cols-2">
          <FloatingField
            id="set-start"
            label="Start Time"
            type="time"
            value={displayTime(d.startTime, d.bootDone)}
            onChange={(v) => d.setStartTime(v)}
            placeholder="09:15"
          />
          <FloatingField
            id="set-end"
            label="End Time"
            type="time"
            value={displayTime(d.endTime, d.bootDone)}
            onChange={(v) => d.setEndTime(v)}
            placeholder="15:30"
          />
        </div>
      </PremiumCard>

      <PremiumCard className="!p-4">
        <CardTitle title="Range & Targets" />
        <div className="space-y-4">
          <FloatingField
            id="set-gap"
            label="Range Gap"
            type="number"
            value={displayField(d.entryGap, d.bootDone)}
            placeholder="200"
            onChange={(v) => {
              const n = parseInt(v, 10);
              if (!v || !Number.isFinite(n) || n < 1) return;
              d.setEntryGap(n);
              d.resetTargetsFromStructure({ entryGap: n });
            }}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <FloatingField
              id="set-tp1-pts"
              label="TP1 Points"
              type="number"
              value={displayField(d.target1Pts, d.bootDone)}
              placeholder="80"
              onChange={(v) => {
                const n = parseInt(v, 10);
                if (!v || !Number.isFinite(n) || n < 1) return;
                d.setTarget1Pts(n);
                d.resetTargetsFromStructure({ target1Pts: n });
              }}
            />
            <FloatingField
              id="set-tp1-lots"
              label="TP1 Exit Lots"
              type="number"
              value={displayField(d.tp1ExitLots, d.bootDone)}
              placeholder="3"
              onChange={(v) => {
                const n = parseInt(v, 10);
                if (!v || !Number.isFinite(n) || n < 1) return;
                d.applyExitLots(n, d.tp2ExitLots);
              }}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <FloatingField
              id="set-tp2-pts"
              label="TP2 Points"
              type="number"
              value={displayField(d.target2Pts, d.bootDone)}
              placeholder="150"
              onChange={(v) => {
                const n = parseInt(v, 10);
                if (!v || !Number.isFinite(n) || n < 1) return;
                d.setTarget2Pts(n);
                d.resetTargetsFromStructure({ target2Pts: n });
              }}
            />
            <FloatingField
              id="set-tp2-lots"
              label="TP2 Exit Lots"
              type="number"
              value={displayField(d.tp2ExitLots, d.bootDone)}
              placeholder="3"
              onChange={(v) => {
                const n = parseInt(v, 10);
                if (!v || !Number.isFinite(n) || n < 1) return;
                d.applyExitLots(d.tp1ExitLots, n);
              }}
            />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">First Entry</p>
            <div className="flex max-w-xs rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-0.5">
              {([true, false] as const).map((enabled) => (
                <button
                  key={String(enabled)}
                  type="button"
                  onClick={() => d.setFirstEntryEnabled(enabled)}
                  className={cn(
                    "flex-1 rounded-md py-2 text-xs font-medium transition",
                    d.firstEntryEnabled === enabled
                      ? "bg-[var(--surface-elevated)] text-[var(--accent)] shadow-sm"
                      : "text-[var(--text-muted)]",
                  )}
                >
                  {enabled ? "Enable" : "Disable"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </PremiumCard>

      <PremiumCard className="!p-4">
        <CardTitle title="Adaptive" />
        <div className="space-y-4">
          <div>
            <SectionLabel>Adaptive High Setting</SectionLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <FloatingField
                id="set-call-high"
                label="Adaptive Call Retrace"
                type="number"
                value={displayField(d.adaptiveCallRetraceHigh, d.bootDone)}
                placeholder="100"
                onChange={(v) => {
                  const n = parseInt(v, 10);
                  if (!v || !Number.isFinite(n) || n < 1) return;
                  d.setAdaptiveCallRetraceHigh(n);
                }}
              />
              <FloatingField
                id="set-put-high"
                label="Adaptive Put Retrace"
                type="number"
                value={displayField(d.adaptivePutRetraceHigh, d.bootDone)}
                placeholder="190"
                onChange={(v) => {
                  const n = parseInt(v, 10);
                  if (!v || !Number.isFinite(n) || n < 1) return;
                  d.setAdaptivePutRetraceHigh(n);
                }}
              />
            </div>
          </div>
          <div>
            <SectionLabel>Adaptive Low Setting</SectionLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <FloatingField
                id="set-put-low"
                label="Adaptive Put Retrace"
                type="number"
                value={displayField(d.adaptivePutRetraceLow, d.bootDone)}
                placeholder="100"
                onChange={(v) => {
                  const n = parseInt(v, 10);
                  if (!v || !Number.isFinite(n) || n < 1) return;
                  d.setAdaptivePutRetraceLow(n);
                }}
              />
              <FloatingField
                id="set-call-low"
                label="Adaptive Call Retrace"
                type="number"
                value={displayField(d.adaptiveCallRetraceLow, d.bootDone)}
                placeholder="190"
                onChange={(v) => {
                  const n = parseInt(v, 10);
                  if (!v || !Number.isFinite(n) || n < 1) return;
                  d.setAdaptiveCallRetraceLow(n);
                }}
              />
            </div>
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}
