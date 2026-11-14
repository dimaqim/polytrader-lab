import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Agent, request } from "node:https";

type Address = { address: string; family: 4 | 6 };
const allowed = new Set(["polymarket.com", "clob.polymarket.com", "gamma-api.polymarket.com",
  "data-api.polymarket.com", "ws-subscriptions-clob.polymarket.com"]);
const cache = new Map<string, { until: number; pending: Promise<Address[]> }>();
const resolver = "https://dns.google/resolve";

async function publicLookup(host: string) {
  const hits = cache.get(host);
  if (hits && Date.now() < hits.until) return hits.pending;
  const entry = { until: Date.now() + 6000, pending: Promise.resolve().then(async () => {
    const response = await fetch(resolver + "?" + new URLSearchParams({ name: host, type: "A" }), { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error("Resolver HTTP " + response.status);
    const body = await response.json() as { Status: number; Answer?: { type: number; data: string; TTL: number }[] };
    const answer = (body.Answer ?? []).filter(row => row.type === 1 && /^\d{1,3}(\.\d{1,3}){3}$/.test(row.data));
    if (body.Status !== 0 || !answer.length) throw new Error("Public DNS supplied no IPv4 address");
    entry.until = Date.now() + Math.max(1000, Math.min(60_000, ...answer.map(row => row.TTL * 1000)));
    return answer.map(row => ({ address: row.data, family: 4 as const }));
  }) };
  cache.set(host, entry);
  return entry.pending;
}

export async function weatherAddresses(host: string, diagnostic?: (source: string, addresses: Address[]) => void): Promise<Address[]> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("System DNS timeout")), 1500); }),
    ]) as Address[];
    if (!addresses.length) throw new Error("System DNS supplied no address");
    diagnostic?.("system", addresses);
    return addresses;
  } catch (error) {
    if (!allowed.has(host) || process.env.WEATHER_DNS_FALLBACK === "0") throw error;
    try {
      const addresses = await publicLookup(host);
      diagnostic?.("public_https", addresses);
      return addresses;
    } catch (fallback) {
      throw Object.assign(new Error("System and public DNS failed for " + host + ": " + (fallback as Error).message), { code: "ENOTFOUND" });
    }
  } finally { clearTimeout(deadline); }
}

export function weatherLookup(diagnostic?: (source: string, addresses: Address[]) => void): LookupFunction {
  return (host, options, callback) => {
    void weatherAddresses(host, diagnostic).then(addresses => {
      const matching = addresses.filter(row => !options.family || row.family === options.family);
      if (!matching.length) { callback(Object.assign(new Error("DNS address family unavailable"), { code: "ENOTFOUND" }), "", 0); return; }
      if (options.all) callback(null, matching);
      else callback(null, matching[0].address, matching[0].family);
    }, error => callback(error, "", 0));
  };
}

const agent = new Agent({ keepAlive: true, lookup: weatherLookup(), autoSelectFamily: true, maxSockets: 16 });

export const weatherFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.protocol !== "https:" || !allowed.has(url.hostname)) throw new Error("Unsupported Weather HTTP origin");
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { agent, method: init?.method, signal: init?.signal ?? undefined,
      headers: Object.fromEntries(new Headers(init?.headers)) }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= 8_000_000) chunks.push(chunk);
        else response.destroy(new Error("Weather HTTP response too large"));
      });
      response.once("error", reject);
      response.once("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value != null) headers.set(key, String(value));
        const status = response.statusCode ?? 502;
        resolve(new Response([204,205,304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks)), { status, headers }));
      });
    });
    req.once("error", reject);
    req.end(typeof init?.body === "string" ? init.body : undefined);
  });
};

export function socketOptions(report: (stage: string, details: object) => void): import("ws").ClientOptions & { lookup: LookupFunction } {
  return {
    handshakeTimeout: 30_000,
    maxPayload: 4_000_000,
    lookup: weatherLookup((source, addresses) => report("dns", { source, addresses })),
    finishRequest(req) {
      req.once("socket", socket => {
        socket.once("connect", () => report("tcp", { address: socket.remoteAddress, family: socket.remoteFamily }));
        socket.once("secureConnect", () => report("tls", { verified: (socket as import("node:tls").TLSSocket).authorized }));
      });
      req.end();
    },
  };
}
