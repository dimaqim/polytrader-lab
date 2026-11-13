export type ActiveStrategy = "copy" | "combo";
export type Run = {
  id: string; strategy: ActiveStrategy; mode: "auto" | "confirm"; bank: number; cash: number; stake: number;
  paused: boolean; risk_blocked: boolean; starts_at: string; ends_at: string; wallet: string | null; wallet_name: string | null;
  max_exposure: number; max_drawdown: number; slippage: number; fills: number; settled: number; pnl: number;
};
export type Trade = {
  id: string; strategy: ActiveStrategy; mode: string; label: string; status: string; reason: string | null;
  observed_at: string; opened_at: string | null; settled_at: string | null; expires_at: string;
  slug: string | null; outcome: string | null; wallet: string | null; wallet_name: string | null;
  source_at: number | null; source_side: string | null; source_price: number | null;
  price: number | null; shares: number | null; cost: number | null; fee: number | null; pnl: number | null;
  payout: number | null; unrealized_pnl: number | null;
};
export type Wallet = { address: string; name: string; source: string; public_pnl: number | null };
export type WorkspaceData = {
  runs: Run[]; wallets: Wallet[];
  health: { source: string; at: string; details: { sections?: boolean[]; gamma?: boolean; clob?: boolean; data?: boolean; bot?: boolean } }[];
  user: { name: string; alerts: boolean; linked: boolean } | null;
  bot: string | null; asOf: string;
};
