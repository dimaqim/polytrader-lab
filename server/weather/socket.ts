import { createWriteStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createGzip } from "node:zlib";
import WebSocket from "ws";
import { MarketFeed } from "../../lib/market-feed.ts";
import type { LiveBook, WeatherEvent } from "../../lib/weather/types.ts";
import { socketOptions } from "./network.ts";
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
  private transport = { stage:"idle", at:0, details:{} as object };
  private pendingSubscriptions: string[] = [];
  private subscribeAt = 0;
  private repair = new Map<string,number>();
  private invalidated=0;

  private report(stage: string, details: object) {
    this.transport = { stage,at:Date.now(),details };
    console.log(JSON.stringify({at:new Date().toISOString(),...details,source:"weather_ws",stage}));
  }
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
    if (removed.length) {
      this.socket.send(JSON.stringify({ assets_ids:removed, operation:"unsubscribe" }));
      for (const key of removed) { this.subscribed.delete(key); this.ticks.delete(key); }
      this.feed.subscribe(this.subscribed);
      this.record({ unsubscribe:removed });
    }
    this.pendingSubscriptions = [...this.target.keys()].filter(key=>!this.subscribed.has(key) && !this.repair.has(key));
    if (this.pendingSubscriptions.length && !this.subscribed.size) this.subscribe(true);
  }

  private subscribe(initial = false) {
    if (!this.feed || this.socket?.readyState !== WebSocket.OPEN || !this.pendingSubscriptions.length) return;
    const added = this.pendingSubscriptions.splice(0, initial ? 1 : 32);
    for (const key of added) this.subscribed.set(key,this.target.get(key)!);
    this.feed.subscribe(this.subscribed);
    this.socket.send(JSON.stringify(initial ? {assets_ids:added,type:"market",custom_feature_enabled:true}
      : {assets_ids:added,operation:"subscribe",custom_feature_enabled:true}));
    this.subscribeAt = Date.now() + (initial ? 750 : 250);
    this.record({subscribe:added});
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
    this.pendingSubscriptions = [];
    this.repair.clear();
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
      const started = Date.now();
      this.report("connecting",{ attempt:this.retry+1, timeoutMs:30000 });
      const next = new WebSocket(marketSocket, socketOptions((stage,details)=>this.report(stage,details)));
      this.socket = next;
      next.on("upgrade",res=>this.report("upgrade",{ status:res.statusCode,tookMs:Date.now()-started }));
      next.on("unexpected-response",(_req,res)=>{
        res.resume();
        if (this.socket !== next) return;
        this.report("unexpected-response",{status:res.statusCode,tookMs:Date.now()-started});
        this.disconnect("HTTP_UPGRADE_"+res.statusCode);
      });
      next.on("open", () => {
        if (this.socket !== next) return;
        this.session = randomUUID(); this.sequence = 0; this.feed = new MarketFeed(true);
        this.sessionSnapshots = 0; this.sessionUpdates = 0; this.lastQuote = 0;
        this.ping = 0; this.pong = Date.now(); this.counts.opened++; this.lastError = "";
        this.report("open",{ tookMs:Date.now()-started });
        this.record({ open: true });
        this.sync();
      });
      next.on("message", (raw, binary) => {
        if (this.socket !== next || !this.feed) return;
        const frame = raw.toString();
        const now = Date.now();
        if (frame === "PONG") { this.pong = now; this.retry = 0; return; }
        if (binary) { this.disconnect("BINARY_FRAME"); return; }
        const result = this.feed.ingest(frame, now);
        if (!this.record({ receivedAt: now, frame })) return;
        if (result.fault) {
          this.report("resync",{ reason:result.fault });
          this.disconnect(result.fault); return;
        }
        if (result.invalidated?.length) {
          const assets=[...new Set(result.invalidated.map(row=>row.asset))];
          this.invalidated+=assets.length;
          this.socket.send(JSON.stringify({assets_ids:assets,operation:"unsubscribe"}));
          for(const asset of assets) {
            this.subscribed.delete(asset);
            this.repair.set(asset,now+750);
          }
          this.feed.subscribe(this.subscribed);
          this.record({ resync:result.invalidated });
          if (this.invalidated<=5 || this.invalidated%50===0) this.report("resync_tokens",{count:assets.length,total:this.invalidated});
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
      next.on("error", error => {
        if (this.socket !== next) return;
        const failedAfter = this.transport.stage;
        this.report("error",{ error:error.message, code:(error as NodeJS.ErrnoException).code, failedAfter,tookMs:Date.now()-started });
        this.disconnect(error.message);
      });
      next.on("close", (code, reason) => {
        if (this.socket !== next) return;
        this.report("close",{ code,reason:reason.toString().slice(0,160) });
        this.disconnect("WebSocket " + code);
      });
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    for(const [asset,after] of this.repair) if(after<=now) {
      this.repair.delete(asset);
      if(this.target.has(asset)) this.pendingSubscriptions.push(asset);
    }
    if (now >= this.subscribeAt) this.subscribe();
    if (now - this.pong > 22_000) { this.report("heartbeat_timeout",{lastPong:this.pong}); this.disconnect("PONG_TIMEOUT"); return; }
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
      sessionSnapshots:this.sessionSnapshots, sessionUpdates:this.sessionUpdates, invalidated:this.invalidated,
      transport:this.transport,lastPong:this.pong || null,lastQuote: this.lastQuote || null, error: this.lastError || null, archive: this.archiveOk };
  }
  close() { this.disconnect("PROCESS_STOPPED"); }
}
