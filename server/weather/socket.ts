import { createWriteStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createGzip } from "node:zlib";
import WebSocket from "ws";
import { MarketFeed } from "../../lib/market-feed.ts";
import type { LiveBook, WeatherEvent } from "../../lib/weather/types.ts";
import { marketSocket } from "../polymarket.ts";

export class WeatherSocket {
  private socket: WebSocket | undefined;
  private feed: MarketFeed | undefined;
  private subscribed = new Map<string,string>();
  private target = new Map<string,string>();
  private session = "";
  private retry = 0;
  private waitUntil = 0;
  private ping = 0;
  private pong = 0;
  private archive: ReturnType<typeof createGzip> | undefined;
  private archivePath = "";
  private archiveHour = "";
  private sequence = 0;
  private archiveOk = true;
  private ticks = new Map<string, number>();
  private sessionSnapshots = 0;
  private sessionUpdates = 0;
  readonly counts = { opened: 0, snapshots: 0, updates: 0, disconnected: 0 };
  lastError = "";
  lastQuote = 0;
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  setMarkets(events: WeatherEvent[]) {
    const tokens = events.flatMap(event => event.contracts.filter(row => row.open)
      .flatMap(row => [[row.yes,row.condition],[row.no,row.condition]] as [string,string][]));
    this.target = new Map(tokens.slice(0, 480));
    this.sync();
  }

  private sync() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.feed) return;
    const removed = [...this.subscribed.keys()].filter(key => !this.target.has(key));
    const added = [...this.target.keys()].filter(key => !this.subscribed.has(key));
    if (!removed.length && !added.length) return;
    this.feed.subscribe(this.target);
    if (removed.length) this.socket.send(JSON.stringify({ assets_ids: removed, operation: "unsubscribe" }));
    if (added.length) this.socket.send(JSON.stringify(this.subscribed.size
      ? { assets_ids: added, operation: "subscribe" } : { assets_ids: added, type: "market", custom_feature_enabled: true }));
    this.record({ subscribe: added, unsubscribe: removed });
    this.subscribed = new Map(this.target);
  }

  private rotate() {
    if (!this.archive) return;
    this.archive.end();
    this.archive = undefined;
  }

  private record(data: object) {
    if (!this.archiveOk) return false;
    const hour = new Date().toISOString().slice(0, 13);
    if (!this.archive || hour !== this.archiveHour) {
      this.rotate();
      this.archiveHour = hour;
      const cutoff = Date.now() - 21 * 86400_000;
      try {
        for (const file of readdirSync(this.directory)) {
          if (!/^\d{4}-.*\.ndjson\.gz(?:\.part)?$/.test(file)) continue;
          const old = this.directory + "/" + file;
          if (statSync(old).mtimeMs < cutoff) unlinkSync(old);
        }
      } catch {
        this.archiveOk = false;
        this.disconnect("ARCHIVE_ROTATION_UNAVAILABLE");
        return false;
      }
      this.archivePath = `${this.directory}/${hour.replace(":", "-")}-${this.session}-${this.sequence}.ndjson.gz.part`;
      const path = this.archivePath;
      const output = createWriteStream(path, { mode: 0o600, flags: "wx" });
      this.archive = createGzip({ level: 3 });
      this.archive.pipe(output);
      const fault = () => { this.archiveOk = false; this.disconnect("ARCHIVE_UNAVAILABLE"); };
      output.on("error", fault);
      this.archive.on("error", fault);
      output.once("finish", () => {
        try { renameSync(path, path.slice(0,-5)); } catch { fault(); }
      });
    }
    if (!this.archive!.write(JSON.stringify({ at: Date.now(), session: this.session, sequence: ++this.sequence, ...data }) + "\n")
      && this.archive!.writableLength > 1_000_000) {
      this.disconnect("ARCHIVE_BACKPRESSURE");
      return false;
    }
    return true;
  }

  private disconnect(reason: string) {
    this.lastError = reason;
    if (this.feed) this.counts.disconnected++;
    const socket = this.socket;
    this.socket = undefined;
    this.feed = undefined;
    this.subscribed.clear();
    this.ticks.clear();
    if (this.archive && this.archiveOk) this.archive.write(JSON.stringify({ at: Date.now(), session: this.session,
      sequence: ++this.sequence, disconnect: reason }) + "\n");
    this.waitUntil = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(this.retry++, 7)) + Math.random() * 300;
    socket?.terminate();
    this.rotate();
  }

  tick(now = Date.now()) {
    const socket = this.socket;
    if (!socket) {
      if (now < this.waitUntil || !this.target.size || !this.archiveOk) return;
      const next = new WebSocket(marketSocket, { handshakeTimeout: 8000, maxPayload: 4_000_000 });
      this.socket = next;
      next.on("open", () => {
        if (this.socket !== next) return;
        this.session = randomUUID(); this.sequence = 0; this.feed = new MarketFeed();
        this.sessionSnapshots = 0; this.sessionUpdates = 0; this.lastQuote = 0;
        this.ping = 0; this.pong = Date.now(); this.counts.opened++;
        this.record({ open: true });
        this.sync();
      });
      next.on("message", (raw, binary) => {
        if (this.socket !== next || !this.feed) return;
        const frame = raw.toString();
        const now = Date.now();
        if (frame === "PONG") { this.pong = now; return; }
        if (binary) { this.disconnect("BINARY_FRAME"); return; }
        const result = this.feed.ingest(frame, now);
        if (!this.record({ receivedAt: now, frame })) return;
        if (result.fault) {
          this.disconnect(result.fault); return;
        }
        if (frame.includes('"tick_size_change"') || frame.includes('"market_resolved"')) {
          const decoded = JSON.parse(frame);
          for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
            if (message.event_type === "tick_size_change" && this.target.has(message.asset_id)) this.ticks.set(message.asset_id, Number(message.new_tick_size));
            if (message.event_type === "market_resolved") for (const [token, condition] of this.target) {
              if (condition === message.market) this.ticks.set(token, NaN);
            }
          }
        }
        this.sessionSnapshots += result.snapshots;
        this.sessionUpdates += result.quotes.length - result.snapshots;
        this.counts.snapshots += result.snapshots;
        this.counts.updates += result.quotes.length - result.snapshots;
        if (result.quotes.length) { this.lastQuote = now; this.retry = 0; }
      });
      next.on("error", error => { if (this.socket === next) this.disconnect(error.message); });
      next.on("close", code => { if (this.socket === next) this.disconnect("WebSocket " + code); });
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    if (now - this.pong > 22_000) { this.disconnect("PONG_TIMEOUT"); return; }
    if (now - this.ping >= 10_000) { this.ping = now; socket.send("PING"); }
  }

  get activeSession() {
    return this.feed && this.archiveOk && this.socket?.readyState === WebSocket.OPEN && Date.now() - this.pong < 22_000 ? this.session : null;
  }
  book(token: string): LiveBook | undefined {
    const session = this.activeSession;
    const book = this.feed?.book(token);
    return session && book && !Number.isNaN(this.ticks.get(token)) ? { session, book } : undefined;
  }
  tickSize(token: string, fallback: number) { return this.ticks.get(token) ?? fallback; }
  status() {
    return { process: true, socket: !!this.activeSession, subscribed: this.subscribed.size, ...this.counts,
      sessionSnapshots:this.sessionSnapshots, sessionUpdates:this.sessionUpdates,
      lastQuote: this.lastQuote || null, error: this.lastError || null, archive: this.archiveOk };
  }
  close() { this.disconnect("PROCESS_STOPPED"); }
}
