export const comboMinimum = 2000;

export const comboStates = {
  OPEN: "Открыто",
  RESOLVED_WIN: "Выиграло",
  RESOLVED_LOSS: "Проиграло",
} as const;
export type ComboStatus = keyof typeof comboStates;

export type ComboLeg = {
  leg_index: number;
  leg_outcome_label: string;
  leg_status?: string;
  market: {
    title: string; slug?: string; question?: string; group_item_title?: string;
    event?: { event_slug?: string; event_title?: string };
  };
};

export function comboMoney(entry: number, gross: number | null, fee: number | null,
  status: string, payout: number | null, received: number | null, redeemable: boolean) {
  const cost = gross != null && gross >= entry ? gross : fee != null ? entry + fee : null;
  const settled = status === "RESOLVED_WIN" || status === "RESOLVED_LOSS";
  const proceeds = !settled ? null : status === "RESOLVED_LOSS" && payout === 0 ? 0
    : payout != null && payout > 0 && !redeemable ? payout : null;
  const fullPayout = proceeds ?? (status === "RESOLVED_WIN" && !redeemable ? received : null);
  return {
    cost,
    received: settled && status === "RESOLVED_LOSS" && payout === 0 ? 0 : received,
    proceeds,
    profit: fullPayout != null && cost != null ? (Math.round(fullPayout * 100) - Math.round(cost * 100)) / 100 : null,
  };
}

export type ComboRecord = {
  id: string;
  wallet: string;
  name: string | null;
  event_at: string;
  detected_at: string;
  resolved_at: string | null;
  paid_at: string | null;
  tx_hash: string | null;
  legs: ComboLeg[];
  status: string;
  entry: number;
  fee: number | null;
  cost: number | null;
  received: number | null;
  proceeds: number | null;
  profit: number | null;
  redeemable: boolean;
};

export type ComboFeed = {
  rows: ComboRecord[];
  next: string | null;
  monitor: { ok: boolean; lastSuccess: string | null; ranked: number; checkedAt: string } | null;
};
