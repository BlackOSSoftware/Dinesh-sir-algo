"use client";

import { AppShell } from "@/components/trader/app-shell";
import { BacktestView } from "@/components/trader/backtest-view";

export default function BacktestPage() {
  return (
    <AppShell>
      <BacktestView />
    </AppShell>
  );
}
