import { roundedTemperature } from "./rules.ts";
import type { Bucket } from "./rules.ts";
import type { Calibration, Estimate, Forecast, Observation, WeatherEvent } from "./types.ts";

const normal = (x: number) => {
  const a = 1 / (1 + .2316419 * Math.abs(x));
  const tail = .3989422804 * Math.exp(-x * x / 2) * a * (.31938153 + a * (-.356563782 + a * (1.781477937 + a * (-1.821255978 + 1.330274429 * a))));
  return x >= 0 ? 1 - tail : tail;
};

function interval(bucket: Bucket, mean: number, sigma: number, observed: number | null, highest: boolean) {
  const observedBucket = observed == null ? null : roundedTemperature(observed, bucket.unit);
  const cdf = (limit: number | null, direction: "low" | "high") => {
    if (limit == null) return direction === "low" ? 0 : 1;
    const last = direction === "low" ? limit - 1 : limit;
    if (observedBucket != null) {
      if (highest && last < observedBucket) return 0;
      if (!highest && last >= observedBucket) return 1;
    }
    const boundary = last + .5;
    const celsius = bucket.unit === "F" ? (boundary - 32) * 5 / 9 : boundary;
    return normal((celsius - mean) / sigma);
  };
  return Math.max(0, cdf(bucket.high, "high") - cdf(bucket.low, "low"));
}

export function estimate(event: WeatherEvent, forecasts: Forecast[], observations: Observation[], calibration: Calibration[],
  market: ReadonlyMap<string, number>, at: number): Estimate {
  const byTime = new Map<number, Observation>();
  for (const row of observations.filter(row => row.station === event.station.code && row.type === "METAR"
    && row.receivedAt <= at && row.observedAt <= at && (row.providerReceivedAt == null || row.providerReceivedAt <= at)
    && row.observedAt >= event.start && row.observedAt < event.end).sort((a, b) =>
      (a.providerReceivedAt ?? a.receivedAt) - (b.providerReceivedAt ?? b.receivedAt) || Number(a.correction) - Number(b.correction))) {
    byTime.set(row.observedAt, row);
  }
  const eligible = [...byTime.values()].filter(row => row.temperature != null);
  const highest = event.kind === "highest";
  const extreme = highest ? Math.max : Math.min;
  const observed = eligible.length && event.verified ? extreme(...eligible.map(row => row.temperature!)) : null;
  const observation = eligible.sort((a, b) => b.observedAt - a.observedAt)[0] ?? null;
  const members = new Map<string, Forecast>();
  for (const snapshot of forecasts.filter(r => r.station === event.station.code && r.receivedAt <= at && at - r.receivedAt <= 10 * 3600_000)
    .sort((a, b) => a.receivedAt - b.receivedAt)) members.set(snapshot.model + "/" + (snapshot.member ?? ""), snapshot);
  const ensembleModels = new Set([...members.values()].filter(row => row.member).map(row => row.model));
  const memberCounts = new Map<string, number>();
  for (const member of members.values()) memberCounts.set(member.model, (memberCounts.get(member.model) ?? 0) + 1);
  const usable = [...members.values()].flatMap(snapshot => {
    const remaining = snapshot.points.filter(([time, temperature]) => time >= Math.max(event.start, Math.floor(at / 3600_000) * 3600_000)
      && time < event.end && Number.isFinite(temperature));
    if (!remaining.length && observed == null) return [];
    const fit = calibration.find(row => row.model === snapshot.model);
    const ensembleWeight = ensembleModels.has(snapshot.model) && !snapshot.member ? .5 : 1;
    return [{ model: snapshot.model, value: remaining.length ? extreme(...remaining.map(([, value]) => value)) - (fit?.bias ?? 0) : observed!,
      sigma: Math.max(.45, fit?.sigma ?? 2), n: fit?.n ?? 0, expiry: snapshot.receivedAt, hash: snapshot.hash,
      weight: ensembleWeight / ((memberCounts.get(snapshot.model) ?? 1) * Math.max(.45, fit?.sigma ?? 2) ** 2) }];
  });
  const total = usable.reduce((sum, row) => sum + row.weight, 0);
  const marketSum = event.contracts.reduce((sum, c) => sum + (market.get(c.condition) ?? 0), 0);
  const marketReady = event.contracts.every(c => market.has(c.condition)) && marketSum > .7 && marketSum < 1.3;
  const distribution = event.exhaustive && total > 0 ? event.contracts.map(c => {
    const p = usable.reduce((sum, row) => sum + row.weight * interval(c.bucket, row.value, row.sigma, observed, highest), 0) / total;
    const minN = Math.min(...usable.map(row => row.n));
    const band = minN > 0 ? Math.min(.3, 1.64 * Math.sqrt(Math.max(.04, p * (1 - p)) / minN)) : .3;
    const base = marketReady ? market.get(c.condition)! / marketSum : null;
    return { condition: c.condition, p, low: Math.max(0, p - band), high: Math.min(1, p + band), market: base,
      blended: base == null ? null : .25 * p + .75 * base };
  }) : [];
  const mass = distribution.reduce((sum, row) => sum + row.p, 0);
  if (mass > 0) for (const row of distribution) {
    row.p /= mass;
    row.low = Math.min(row.p, row.low);
    row.high = Math.max(row.p, row.high);
    row.blended = row.market == null ? null : .25 * row.p + .75 * row.market;
  }
  const observedCoverage = at <= event.start || eligible.length >= Math.max(1, Math.floor((at - event.start) / 3600_000 * .65));
  return { at, distribution, forecasts: usable.map(row => ({ model: row.model, value: row.value, weight: row.weight / total,
    receivedAt: row.expiry, hash: row.hash })), observed, observation, calibration,
    confidence: event.verified && event.exhaustive && at < event.end && observedCoverage
      && (at <= event.start || (observation != null && at - observation.observedAt <= 2 * 3600_000))
      && new Set(usable.filter(x => x.n >= 5).map(x => x.model)).size >= 2 && usable.every(x => x.n >= 5) };
}
