import type { Estimate, Contract } from "./types.ts";

export const weatherPolicy = "weather-risk-v3";
export const smartEntryPolicy = "weather-entry-v4";
export const smartEntryLimits = { observationAge: 3600_000, minCost: .35, maxCost: .85, maxSpread: .06, edge: .05, maxGap: .30 } as const;

export function saleModel(estimate: Estimate | undefined, contract: Contract, token: string) {
  const outcome = estimate?.confidence ? estimate.distribution.find(row => row.condition === contract.condition) : undefined;
  if (!outcome) return null;
  return token === contract.yes
    ? { fair: outcome.p, lower: outcome.low, upper: outcome.high }
    : { fair: 1 - outcome.p, lower: 1 - outcome.high, upper: 1 - outcome.low };
}

export type ExitReason = "FAIR_VALUE_EXIT" | "FORECAST_REVERSAL_RISK" | "REPRICING_TARGET";
type ExitInput = {
  net: number;
  basisPerShare: number;
  shares: number;
  model: NonNullable<ReturnType<typeof saleModel>>;
  entryFair: number | null;
};

export function exitChecks({ net, basisPerShare, shares, model, entryFair }: ExitInput): Record<ExitReason, boolean> {
  const loss = (basisPerShare - net) * shares;
  const fairThreshold = net >= basisPerShare ? model.fair : model.upper;
  return {
    FAIR_VALUE_EXIT: net >= fairThreshold + .02,
    FORECAST_REVERSAL_RISK: entryFair != null && entryFair - model.fair >= .15
      && model.fair < basisPerShare - .15 && loss >= 2.5,
    REPRICING_TARGET: net >= basisPerShare + .04 && net >= model.fair - .01,
  };
}

export function modelExit(input: ExitInput): ExitReason | null {
  const checks = exitChecks(input);
  if (checks.FAIR_VALUE_EXIT) return "FAIR_VALUE_EXIT";
  if (checks.FORECAST_REVERSAL_RISK) return "FORECAST_REVERSAL_RISK";
  return checks.REPRICING_TARGET ? "REPRICING_TARGET" : null;
}

export function replayEntry(lower: number | null, cost: number, walletPrice: number, price: number, minEdge: number) {
  return lower != null && lower - cost > minEdge && price <= walletPrice + .04 + 1e-9;
}

export function smartEntryRejection(input: {
  at: number; start: number; end: number; observedAt?: number;
  model: ReturnType<typeof saleModel>; bid?: number; ask?: number; cost?: number;
}) {
  const {at,start,end,observedAt,model,bid,ask,cost}=input;
  const limits=smartEntryLimits;
  if(at<start||at>=end||observedAt==null||observedAt<start||observedAt>at||at-observedAt>limits.observationAge) {
    return "SMART_WAIT_FOR_STATION";
  }
  if(!model||!Number.isFinite(model.fair)||!Number.isFinite(model.lower)) return "SMART_INCOMPLETE_FORECAST";
  if(bid==null||ask==null||!Number.isFinite(bid)||!Number.isFinite(ask)||bid<=0||ask>=1||ask<=bid
    ||ask-bid>limits.maxSpread+1e-9) return "SMART_WIDE_SPREAD";
  if(cost==null||!Number.isFinite(cost)||cost<limits.minCost||cost>limits.maxCost) return "SMART_PRICE_OUT_OF_RANGE";
  if(Math.abs(model.fair-(bid+ask)/2)>limits.maxGap+1e-9) return "SMART_MARKET_DISAGREEMENT";
  if(model.lower-cost<limits.edge-1e-9) return "SMART_EDGE_TOO_SMALL";
  return null;
}
