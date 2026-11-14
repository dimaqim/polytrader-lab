export const stations = {
  seoul: { city: "Seoul", code: "RKSI", zone: "Asia/Seoul", lat: 37.46, lon: 126.44 },
  tokyo: { city: "Tokyo", code: "RJTT", zone: "Asia/Tokyo", lat: 35.55, lon: 139.78 },
  london: { city: "London", code: "EGLC", zone: "Europe/London", lat: 51.50, lon: .055 },
  munich: { city: "Munich", code: "EDDM", zone: "Europe/Berlin", lat: 48.35, lon: 11.79 },
  nyc: { city: "New York City", code: "KLGA", zone: "America/New_York", lat: 40.78, lon: -73.88 },
  dallas: { city: "Dallas", code: "KDAL", zone: "America/Chicago", lat: 32.85, lon: -96.85 },
} as const;
export type Station = typeof stations[keyof typeof stations];
export type Bucket = { low: number | null; high: number | null; unit: "C" | "F"; label: string };
export type Kind = "highest" | "lowest";

const formatters = new Map<string, Intl.DateTimeFormat>();
export function localDate(at: number, zone: string) {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone });
    formatters.set(zone, format);
  }
  return format.format(at);
}

export function dayBounds(day: string, zone: string) {
  const center = Date.parse(day + "T00:00:00Z");
  function boundary(target: string, around: number) {
    let low = around - 18 * 3600_000, high = around + 18 * 3600_000;
    while (high - low > 1) {
      const middle = Math.floor((high + low) / 2);
      if (localDate(middle, zone) < target) low = middle;
      else high = middle;
    }
    return high;
  }
  return [boundary(day, center), boundary(new Date(center + 86400_000).toISOString().slice(0, 10), center + 86400_000)] as const;
}

export function parseBucket(label: string): Bucket | null {
  const value = label.trim().replace(/[−–]/g, "-");
  const range = /^(-?\d+)\s*-\s*(-?\d+)\s*°([CF])$/i.exec(value);
  if (range && +range[1] <= +range[2]) return { low: +range[1], high: +range[2], unit: range[3].toUpperCase() as Bucket["unit"], label };
  const point = /^(-?\d+)\s*°([CF])(?:\s+or\s+(above|higher|below|lower))?$/i.exec(value);
  if (!point) return null;
  const tail = point[3]?.toLowerCase();
  return { low: tail === "below" || tail === "lower" ? null : +point[1],
    high: tail === "above" || tail === "higher" ? null : +point[1], unit: point[2].toUpperCase() as Bucket["unit"], label };
}

export function exhaustive(buckets: Bucket[]) {
  const sorted = [...buckets].sort((a, b) => (a.low ?? -Infinity) - (b.low ?? -Infinity));
  return sorted.length >= 2 && sorted[0].low == null && sorted.at(-1)!.high == null
    && sorted.every((b, i) => b.unit === sorted[0].unit && (i === sorted.length - 1 || (b.high != null && sorted[i + 1].low === b.high + 1)));
}

export function verifyRules(rules: string, source: string, station: Station, kind: Kind) {
  let url: URL;
  try { url = new URL(source); } catch { return false; }
  return url.protocol === "https:" && url.hostname === "aviationweather.gov" && url.pathname === "/api/data/metar"
    && url.searchParams.get("ids") === station.code && rules.includes("(" + station.code + ")")
    && rules.toLowerCase().includes("the " + kind + " temperature")
    && ["routine (METAR)", "exactly eight digits", "local time", "rounded up", "begins with SPECI", "correction (COR)"].every(text => rules.includes(text));
}

export function roundedTemperature(celsius: number, unit: Bucket["unit"]) {
  return Math.floor((unit === "F" ? celsius * 9 / 5 + 32 : celsius) + .5 + 1e-9);
}

export function parseMetar(raw: string) {
  const text = raw.trim();
  const correction = /\bCOR\b/.test(text);
  if (/^SPECI\b/.test(text)) return { temperature: null, precision: null, type: "SPECI", correction };
  const precise = /(?:^|\s)T([01])(\d{3})\d{4}(?=\s|$|=)/.exec(text);
  const body = /(?:^|\s)(M?\d{2})\/(?:M?\d{2}|\/\/|XX)?(?=\s|$|=)/.exec(text.split(" RMK ")[0]);
  return { temperature: precise ? (precise[1] === "1" ? -1 : 1) * +precise[2] / 10 : body ? Number(body[1].replace("M", "-")) : null,
    precision: precise ? "tenths" : body ? "whole" : null, type: "METAR", correction };
}
