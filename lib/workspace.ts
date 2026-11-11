import type { Strategy } from "./strategies.ts";
export type Run = {
  id: string; strategy: Strategy; version: number; mode: "auto" | "confirm"; bank: number; cash: number; equity: number | null;
  paused: boolean; risk_blocked: boolean; starts_at: string; ends_at: string; stake: number; fills: number; settled: number; wins: number;
  pnl: number; fees: number; slippage: number | null; drawdown: number; missed: number; winRate: number | null;
  interval95: [number, number] | null; roi: number; timing_p95: number | null; timing_missing: number;
  weekly_pnl: number; weekly_settled: number; weekly_wins: number; weeklyInterval95: [number, number] | null;
};
export type Trade = {
  id: string; strategy: Strategy; mode: string; label: string; status: string; reason: string | null;
  observed_at: string; target_at: string; shares: number | null; price: number | null; cost: number | null; fee: number | null;
  pnl: number | null; settled_at: string | null; execution?: { delayMs: number | null };
  evidence?: { timingErrorMs?: number; detectionDelayMs?: number };
};
export type WorkspaceData = {
  runs: Run[]; trades: Trade[]; equity: { experiment: string; at: string; value: number | null }[];
  markets: { condition: string; slug: string; title: string; ends_at: string; interval_minutes: number;
    outcomes: string[]; prices: (number | null)[]; seen_at: string; fee: { rate: number } | null }[];
  wallets: { address: string; name: string; source: string; public_pnl: number | null; volume_shares: number | null;
    history_complete: boolean; records: number }[];
  combos: { id: string; name: string | null; wallet: string; stake: number; event_at: string; detected_at: string; author_pnl: number | null;
    payload: { status: string; legs: { leg_outcome_label: string; market: { title: string } }[] } }[];
  health: { source: string; at: string; details: { sections?: boolean[]; connected?: boolean } }[];
  errors: { area: string; count: number; at: string }[];
  user: { name: string; alerts: boolean; linked: boolean } | null;
  bot: string | null; asOf: string;
};
