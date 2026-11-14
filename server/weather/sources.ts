import { createHash } from "node:crypto";
import { dayBounds, exhaustive, localDate, parseBucket, parseMetar, stations, verifyRules } from "../../lib/weather/rules.ts";
import type { Calibration, Forecast, Observation, WalletEvent, WeatherEvent } from "../../lib/weather/types.ts";
import { numeric, page, parseMarket, request, timestamp, type Activity, type Page } from "../polymarket.ts";

export const models = ["ecmwf_ifs025", "gfs_global", "icon_global"] as const;
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const month = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });

export function eventSlugs(at: number) {
  return Object.entries(stations).flatMap(([city, station]) => {
    const noon = Date.parse(localDate(at, station.zone) + "T12:00:00Z");
    return [-1, 0, 1].flatMap(offset => {
      const day = new Date(noon + offset * 86400_000);
      const slugDate = month.format(day).toLowerCase() + "-" + day.getUTCDate() + "-" + day.getUTCFullYear();
      return (["highest", "lowest"] as const).map(kind => ({ station, kind, date: day.toISOString().slice(0,10),
        slug: kind + "-temperature-in-" + city + "-on-" + slugDate }));
    });
  });
}

type Raw = Record<string, unknown>;

function flightData(html: string) {
  return [...html.matchAll(/<script>self\.__next_f\.push\((\[.*?\])\)<\/script>/g)].flatMap(match => {
    try { const [kind, data] = JSON.parse(match[1]); return kind === 1 && typeof data === "string" ? [data] : []; }
    catch { return []; }
  }).join("");
}

function flightEvent(html: string, slug: string): Raw | null {
  const chunks = flightData(html);
  const prefix = /"data":\{"id":(?:"\d+"|\d+),"slug":"([^"]+)"/g;
  for (const match of chunks.matchAll(prefix)) {
    if (match[1] !== slug) continue;
    const start = match.index! + 7;
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < chunks.length; index++) {
      const char = chunks[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        const event = JSON.parse(chunks.slice(start, index + 1)) as Raw;
        if (!Array.isArray(event.markets)) break;
        if (typeof event.description === "string" && /^\$[a-f0-9]+$/i.test(event.description)) {
          const marker = new RegExp("\\n" + event.description.slice(1) + ":T([a-f0-9]+),", "g");
          const entry = marker.exec(chunks);
          if (entry) {
            const bytes = Buffer.from(chunks.slice(marker.lastIndex));
            event.description = bytes.subarray(0, parseInt(entry[1], 16)).toString("utf8");
          }
        }
        return event;
      }
    }
  }
  return null;
}

async function getEvent(slug: string): Promise<Raw | null> {
  try {
    return await request<Raw>("https://gamma-api.polymarket.com/events/slug/" + slug, fetch, 1);
  } catch {
    // The public event page carries the same catalog fields. Execution still requires a live CLOB session.
    const response = await fetch("https://polymarket.com/event/" + slug, { signal: AbortSignal.timeout(8_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Polymarket event HTTP " + response.status);
    return flightEvent(await response.text(), slug);
  }
}

export async function discover(at: number, held: WeatherEvent[] = []): Promise<WeatherEvent[]> {
  const found: WeatherEvent[] = [];
  const targets = [...new Map([...eventSlugs(at), ...held].map(item => [item.slug, { station:item.station, kind:item.kind, date:item.date, slug:item.slug }])).values()];
  for (let start = 0; start < targets.length; start += 8) {
    const results = await Promise.allSettled(targets.slice(start, start + 8).map(async item => {
      const raw = await getEvent(item.slug);
      const receivedAt = Date.now();
      if (!raw?.id || raw.slug !== item.slug || !Array.isArray(raw.markets) || !raw.markets.length) return;
      const rules = String(raw.description ?? "");
      const first = raw.markets[0] as Raw;
      const source = String(raw.resolutionSource ?? first.resolutionSource ?? first.resolution_source ?? "");
      const contracts = raw.markets.flatMap((row: Raw) => {
        const market = parseMarket(row, receivedAt);
        const bucket = parseBucket(String(row.groupItemTitle ?? ""));
        if (!market || !bucket || market.outcomes.join("/") !== "Yes/No") return [];
        return [{ id: String(row.id), condition: market.condition, slug: market.slug, bucket, yes: market.tokens[0], no: market.tokens[1],
          open: market.open, fee: market.fee, tick: numeric(row.orderPriceMinTickSize), minimum: numeric(row.orderMinSize), payout: market.payout }];
      });
      const [start, end] = dayBounds(item.date, item.station.zone);
      const verified = verifyRules(rules, source, item.station, item.kind)
        && raw.markets.every((market: Raw) => (market.resolutionSource ?? market.resolution_source ?? source) === source);
      const allBuckets = contracts.length === raw.markets.length && exhaustive(contracts.map(row => row.bucket));
      found.push({ ...item, id: String(raw.id), title: String(raw.title), start, end, rules, source,
        verified: verified && allBuckets, exhaustive: allBuckets, contracts, receivedAt });
    }));
    if (results.every(row => row.status === "rejected") && !found.length && start + 8 >= targets.length) throw new Error("Weather market discovery failed");
  }
  if (!found.length) throw new Error("No daily weather events discovered");
  return found;
}

type RawMetar = { icaoId: string; obsTime: number; reportTime?: string; receiptTime?: string; rawOb: string; metarType?: string };
export async function observations(): Promise<Observation[]> {
  const query = new URLSearchParams({ ids: Object.values(stations).map(row => row.code).join(","), format: "json", hours: "30" });
  const rows = await request<RawMetar[]>("https://aviationweather.gov/api/data/metar?" + query, fetch, 2);
  const receivedAt = Date.now();
  return rows.flatMap(row => {
    if (!row.rawOb || !Number.isSafeInteger(row.obsTime) || row.obsTime <= 0 || row.obsTime * 1000 > receivedAt) return [];
    const parsed = parseMetar(row.rawOb);
    const provider = Date.parse(row.receiptTime ?? "");
    const published = Date.parse(row.reportTime ?? "");
    return [{ ...parsed, type: row.metarType === "SPECI" ? "SPECI" : parsed.type, raw: row.rawOb,
      station: row.icaoId, observedAt: row.obsTime * 1000, receivedAt,
      publishedAt: Number.isFinite(published) ? published : null, providerReceivedAt: Number.isFinite(provider) ? provider : null }];
  });
}

type RawForecast = { hourly: Record<string, (number | null)[]> };
export async function forecasts(): Promise<Forecast[]> {
  const locations = Object.values(stations);
  const query = new URLSearchParams({
    latitude: locations.map(s => s.lat).join(","), longitude: locations.map(s => s.lon).join(","),
    hourly: "temperature_2m", models: models.join(","), timeformat: "unixtime", forecast_days: "3", past_days: "1",
  });
  const result = await request<RawForecast[]>("https://api.open-meteo.com/v1/forecast?" + query, fetch, 2);
  if (result.length !== locations.length) throw new Error("Open-Meteo station count mismatch");
  const receivedAt = Date.now();
  return result.flatMap(({ hourly }, index) => models.flatMap(model => {
    const points = hourly["temperature_2m_" + model]?.flatMap((value, i): [number, number][] =>
      value != null && Number.isFinite(value) && Number.isFinite(hourly.time[i]) ? [[hourly.time[i]! * 1000, value]] : []) ?? [];
    return points.length ? [{ station: locations[index].code, model, runAt: null, receivedAt, points, hash: hash(points) }] : [];
  }));
}

export async function ensemble(): Promise<Forecast[]> {
  const locations = Object.values(stations);
  const query = new URLSearchParams({
    latitude: locations.map(s => s.lat).join(","), longitude: locations.map(s => s.lon).join(","),
    hourly: "temperature_2m", models: "ecmwf_ifs025", timeformat: "unixtime", forecast_days: "3",
  });
  const result = await request<RawForecast[]>("https://ensemble-api.open-meteo.com/v1/ensemble?" + query, fetch, 1);
  const receivedAt = Date.now();
  return result.flatMap(({ hourly }, index) => Object.entries(hourly).flatMap(([key, series]) => {
    if (!/^temperature_2m_member\d+$/.test(key) || !locations[index]) return [];
    const points = series.flatMap((value, i): [number, number][] =>
      value != null && Number.isFinite(value) && Number.isFinite(hourly.time[i]) ? [[hourly.time[i]! * 1000, value]] : []);
    return points.length ? [{ station: locations[index].code, model: "ecmwf_ifs025", member: key, runAt: null, receivedAt, points, hash: hash(points) }] : [];
  }));
}

type Profile = { proxyWallet?: string; name?: string; pseudonym?: string };
export const walletNames = ["HighTempTation","gghff","BeefSlayer","241532532432","Weatherstappen","OnlyLuckNoBrain","Poligarch",
  "russell110320","hello.67","balthazar","0xyahn","mashuuuu","Alcaraz2026"];
const knownWallets: Record<string, string> = {
  "hello.67": "0x2e3ecedec4b004c61670f0dcda382ec0da1f0f92", balthazar: "0x5a218c7ad04135830a45c41aaed7294df7809318",
  "0xyahn": "0x33c8f2e65c1ffc09a7af6ad0bfc6987a4db1de24", mashuuuu: "0x72da12d9e58123844505c82448a172018386a89e",
  Alcaraz2026: "0x0172d9aea5b523c33955c0e9841d9a6af82d4e84",
};
export async function verifyWallet(name: string) {
  const known = knownWallets[name];
  let candidate: string | undefined = known;
  const base = "https://gamma-api.polymarket.com";
  try {
    candidate ??= (await request<{ profiles?: Profile[] }>(base + "/public-search?" + new URLSearchParams({
      q: name, search_profiles: "true", limit_per_type: "10",
    }), fetch, 1)).profiles?.find(row => [row.name, row.pseudonym].some(label => label?.toLowerCase() === name.toLowerCase()))?.proxyWallet;
    if (!candidate || !/^0x[a-f\d]{40}$/i.test(candidate)) throw new Error("Profile address missing");
    const profile = await request<Profile>(base + "/public-profile?address=" + candidate, fetch, 1);
    if (profile.proxyWallet?.toLowerCase() === candidate.toLowerCase()
      && [profile.name, profile.pseudonym].some(label => label?.toLowerCase() === name.toLowerCase())) {
      return { name, address: candidate.toLowerCase() };
    }
  } catch {}
  const response = await fetch("https://polymarket.com/@" + encodeURIComponent(name), { signal: AbortSignal.timeout(7_000) });
  if (!response.ok) return null;
  const data = flightData(await response.text());
  const exact = [...data.matchAll(/"username":("(?:[^"\\]|\\.)*"),"primaryAddress":"(0x[a-f\d]{40})","proxyAddress":"(0x[a-f\d]{40})"/ig)]
    .filter(match => String(JSON.parse(match[1])).toLowerCase() === name.toLowerCase() && match[2].toLowerCase() === match[3].toLowerCase());
  const addresses = [...new Set(exact.map(match => match[3].toLowerCase()))];
  if (addresses.length !== 1 || (known && known !== addresses[0])) return null;
  const address = addresses[0];
  const verify = await page<Activity>("/activity",{user:address,limit:"1"});
  return Array.isArray(verify.data) ? { name,address } : null;
}

export async function walletActivity(wallet: { name: string; address: string }, conditions: Set<string>, after: number): Promise<WalletEvent[]> {
  const params = { user: wallet.address, start: String(Math.floor(after / 1000)), limit: "100" };
  let cursor: string | null = null;
  const found: WalletEvent[] = [];
  for (let i = 0; i < 3; i++) {
    const result: Page<Activity> = await page<Activity>("/activity", { ...params, ...(cursor ? { cursor } : {}) });
    const receivedAt = Date.now();
    found.push(...result.data.flatMap(row => {
      const at = timestamp(row.timestamp);
      if (!conditions.has(row.condition_id?.toLowerCase()) || !Number.isFinite(at) || at > receivedAt || !row.transaction_hash) return [];
      return [{ id: wallet.address + ":" + (row.id ?? row.sequence_id ?? hash(row)), wallet: wallet.address, name: wallet.name,
        condition: row.condition_id.toLowerCase(), token: row.token_id ?? row.asset ?? "", type: row.type, side: row.side ?? "",
        at, receivedAt, price: row.price, shares: row.size, value: row.usdc_size }];
    }));
    cursor = result.pagination.next_cursor;
    if (!result.pagination.has_more || !cursor) return found;
  }
  throw new Error("Incomplete weather wallet activity page coverage");
}

export function calibrations(data: Record<string, { day: string; error: number }[]>, event: WeatherEvent, at: number): Calibration[] {
  const horizon = event.end - at < 8 * 3600_000 ? "6" : event.end - at < 18 * 3600_000 ? "12" : "24";
  return models.map(model => {
    const series = data[[event.station.code, event.kind, model, horizon].join("/")] ?? [];
    const past = new Date(Math.min(event.start, at)).toISOString().slice(0,10);
    const windows = Object.fromEntries([7,14,30].map(days => {
      const from = new Date(Date.parse(past) - days * 86400_000).toISOString().slice(0,10);
      const values = series.filter(row => row.day < past && row.day >= from).map(row => row.error);
      return [String(days), { n: values.length, bias: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null }];
    }));
    const bias = windows["14"].n >= 5 ? windows["14"].bias! : windows["30"].bias ?? 0;
    const from = new Date(Date.parse(past) - 30 * 86400_000).toISOString().slice(0,10);
    const values = series.filter(row => row.day < past && row.day >= from);
    return { model, bias, n: values.length, sigma: values.length ? Math.sqrt(values.reduce((sum, row) => sum + (row.error - bias) ** 2, 0) / values.length) : 2, windows };
  });
}
