import { setTimeout as sleep } from "node:timers/promises";
import { database, date, log } from "../db.ts";
import { takerFee } from "../../lib/simulator.ts";
import { estimate } from "../../lib/weather/probability.ts";
import { executable, payoffTable, takeDepth } from "../../lib/weather/execution.ts";
import { candidates, risk, weatherStrategies, type Candidate, type WeatherStrategy } from "../../lib/weather/strategies.ts";
import type { Contract, Estimate, Forecast, Observation, WalletEvent, WeatherEvent } from "../../lib/weather/types.ts";
import { archiveEvents, archiveInputs, audit, markBank, postFill, state } from "./ledger.ts";
import { calibrations, discover, ensemble, forecasts, hash, observations, verifyWallet, walletActivity, walletNames } from "./sources.ts";
import { WeatherSocket } from "./socket.ts";
import { enqueueWeather, weatherReport } from "./notifications.ts";
import { sampleForecasts } from "./scoring.ts";
import baseline from "../../lib/weather/calibration.json" with { type: "json" };

type Bank = { experiment: string; strategy: WeatherStrategy; cash: number; exposure: number; running: boolean; risk_blocked: boolean };
type Position = { experiment: string; strategy: WeatherStrategy; event: string; token: string; condition: string;
  outcome: string; shares: number; basis: number; opened_at: string; source_wallet: string | null };
type SourceHealth = { ok: boolean; at: number; count?: number; error?: string };
type Pending = { bank: Bank; event: WeatherEvent; contract: Contract; token: string; outcome: string; side: "BUY" | "SELL";
  reference: number; reason: string; estimate: Estimate; readyAt: number; session: string; evidence: object; shares?: number;
  wallet?: WalletEvent; stake?: number };

const configuredAge = Number(process.env.WEATHER_BOOK_AGE_MS ?? risk.maxAge);
const maximumAge = Number.isFinite(configuredAge) ? Math.min(5000, Math.max(250, configuredAge)) : risk.maxAge;
const minute = 60_000;

export class WeatherEngine {
  private readonly ws: WeatherSocket;
  private readonly sources: Record<string, SourceHealth> = {};
  private readonly readings = new Map<string, Observation>();
  private readonly snapshots = new Map<string, Forecast>();
  private readonly walletTrades = new Map<string, WalletEvent>();
  private readonly verifiedWallets = new Map<string, { name: string; address: string }>();
  private readonly data = new Map<string, WeatherEvent>();
  private readonly estimates = new Map<string, Estimate>();
  private readonly pending = new Map<string, Pending>();
  private readonly acted = new Set<string>();
  private positions: Position[] = [];
  private running = true;
  private readonly persist: boolean;
  constructor(persist: boolean, directory: string) {
    this.persist = persist;
    this.ws = new WeatherSocket(directory);
  }

  async run(deadline = Infinity) {
    if (this.persist) await this.restoreInputs();
    const tasks = [
      this.periodic("catalog", 5 * minute, () => this.catalog(), deadline),
      this.periodic("metar", minute, () => this.readMetar(), deadline),
      this.periodic("forecast", 15 * minute, () => this.readForecast(false), deadline),
      this.periodic("ensemble", 2 * 3600_000, () => this.readForecast(true), deadline),
      this.periodic("wallets", 2 * minute, () => this.readWallets(), deadline),
      this.periodic("engine", 250, () => this.engine(), deadline),
      this.periodic("heartbeat", 10_000, () => this.heartbeat(), deadline),
      this.periodic("notifications", minute, async () => {
        if (this.persist) await weatherReport(Date.now(), !this.ws.activeSession || Date.now()-this.ws.lastQuote>maximumAge);
        return 0;
      }, deadline),
    ];
    try {
      while (this.running && Date.now() < deadline) { this.ws.tick(); await sleep(250); }
    } finally {
      this.running = false;
      this.ws.close();
      await Promise.allSettled(tasks);
      await this.heartbeat();
    }
  }

  private async restoreInputs() {
    const rows = await database()`select kind,payload from weather.inputs where received_at>now()-interval '30 hours'
      and kind in ('metar','wallet') order by received_at`;
    for (const row of rows) {
      if (row.kind === "metar") {
        const observation = row.payload as Observation;
        this.readings.set(hash([observation.station,observation.observedAt,observation.raw]), observation);
      } else {
        const trade = row.payload as WalletEvent;
        this.walletTrades.set(trade.id, trade);
      }
    }
  }

  stop() { this.running = false; }

  private async periodic(name: string, interval: number, action: () => Promise<number>, deadline: number) {
    let next = 0, failures = 0;
    while (this.running && Date.now() < deadline) {
      if (Date.now() < next) { await sleep(Math.min(500, next - Date.now())); continue; }
      try {
        const count = await action();
        this.sources[name] = { ok: true, at: Date.now(), count };
        failures = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : "upstream error";
        if (this.sources[name]?.error !== message) {
          this.report(name, { error: message });
          if (this.persist) await log("weather_" + name, error);
        }
        this.sources[name] = { ok: false, at: Date.now(), error: message };
        failures++;
      }
      next = Date.now() + (failures ? Math.min(interval, 5000 * 2 ** Math.min(failures, 6)) : interval);
    }
  }

  private report(source: string, detail: object) { console.log(JSON.stringify({ at: new Date().toISOString(), source, ...detail })); }

  private async catalog() {
    const held = this.persist ? await database()`select m.payload from weather.markets m where
      exists(select 1 from weather.positions p where p.event=m.id and p.shares>0)
      or (exists(select 1 from weather.probability_samples s where s.event=m.id and s.observed_at>now()-interval '7 days')
        and exists(select 1 from jsonb_array_elements(m.payload->'contracts') c where c->>'payout' is null))` : [];
    const events = await discover(Date.now(), held.map(row => row.payload as WeatherEvent));
    if (this.persist) await archiveEvents(events);
    const cutoff = Date.now() - 3 * 86400_000;
    for (const [id, event] of this.data) if (event.end < cutoff && !held.some(x => x.payload.id === id)) this.data.delete(id);
    for (const event of events) this.data.set(event.id, event);
    const heldIds = new Set([...this.positions.map(p => p.event), ...held.map(row => row.payload.id)]);
    const open = [...this.data.values()].filter(event => event.verified && Date.now() - event.receivedAt < 15 * minute
      && (heldIds.has(event.id) || event.end > Date.now()) && event.contracts.some(c => c.open))
      .sort((a, b) => Number(heldIds.has(b.id)) - Number(heldIds.has(a.id)) || a.end - b.end);
    this.ws.setMarkets(open);
    this.report("catalog", { discovered: events.length, verified: events.filter(e => e.verified).length,
      cities: [...new Set(events.map(e => e.station.city))], feeSchedules: [...new Set(events.flatMap(e => e.contracts.map(c => c.fee?.rate ?? null)))] });
    return events.length;
  }

  private async readMetar() {
    const rows = await observations();
    const added = rows.filter(row => !this.readings.has(hash([row.station,row.observedAt,row.raw])));
    if (this.persist) await archiveInputs("metar", added.map(row => ({ ...row, id: hash([row.station,row.observedAt,row.raw]), payload: row })));
    for (const row of added) this.readings.set(hash([row.station,row.observedAt,row.raw]), row);
    for (const [key,row] of this.readings) if (Date.now() - row.observedAt > 72 * 3600_000) this.readings.delete(key);
    this.report("metar", { reports: rows.length, new: added.length, stations: [...new Set(rows.map(r => r.station))] });
    return rows.length;
  }

  private async readForecast(members: boolean) {
    const rows = await (members ? ensemble() : forecasts());
    if (!rows.length) throw new Error("No usable temperature series");
    const changed = rows.filter(row => this.snapshots.get([row.station,row.model,row.member ?? ""].join("/"))?.hash !== row.hash);
    if (this.persist) await archiveInputs(members ? "ensemble" : "forecast", changed.map(row => ({
      ...row, id: hash([row.station,row.model,row.member,row.hash,row.receivedAt]), payload: row,
    })));
    for (const row of rows) this.snapshots.set([row.station,row.model,row.member ?? ""].join("/"), row);
    this.report(members ? "ensemble" : "forecast", { series: rows.length, changed: changed.length, models: [...new Set(rows.map(row => row.model))] });
    return rows.length;
  }

  private async readWallets() {
    const at = Date.now();
    if (at - this.walletProfilesAt > 60 * minute) {
      this.walletProfilesAt = at;
      const result = await Promise.allSettled(walletNames.map(verifyWallet));
      for (const row of result) if (row.status === "fulfilled" && row.value) this.verifiedWallets.set(row.value.address, row.value);
    }
    if (!this.verifiedWallets.size) throw new Error("No wallet identity verified from the public Polymarket API");
    const conditions = new Set([...this.data.values()].flatMap(event => event.contracts.map(contract => contract.condition)));
    if (!conditions.size) return 0;
    const results = await Promise.allSettled([...this.verifiedWallets.values()].map(wallet => walletActivity(wallet, conditions, at - 10 * minute)));
    const fresh = results.flatMap(result => result.status === "fulfilled" ? result.value : []).filter(row => !this.walletTrades.has(row.id));
    if (this.persist) await archiveInputs("wallet", fresh.map(row => ({ ...row, station: row.wallet, payload: row })));
    for (const row of fresh) this.walletTrades.set(row.id,row);
    for (const [key,row] of this.walletTrades) if (at - row.receivedAt > 24 * 3600_000) this.walletTrades.delete(key);
    if (results.every(row => row.status === "rejected")) throw new Error("All verified wallet activity requests failed");
    return fresh.length;
  }

  private walletProfilesAt = 0;
  private reportAt = 0;
  private evaluateAt = 0;
  private persistAt = 0;

  private async engine() {
    if (this.persist) await this.drain();
    const now = Date.now();
    if (now < this.evaluateAt || !this.data.size) return 0;
    this.evaluateAt = now + 5000;
    const sql = this.persist ? database() : null;
    const [bankRows, positionRows] = sql ? await sql.transaction([
      sql`select b.experiment,b.strategy,b.cash::float8,b.risk_blocked,
        (e.status='running' and e.ends_at>now()) running, coalesce(p.exposure,0)::float8 as exposure
        from weather.banks b join weather.experiments e on e.id=b.experiment
        left join lateral(select sum(basis) as exposure from weather.positions where experiment=b.experiment
          and strategy=b.strategy and shares>0) p on true
        where (e.ends_at>now() and e.status<>'stopped') or p.exposure>0`,
      sql`select p.experiment,p.strategy,p.event,p.token,p.condition,p.outcome,p.shares::float8,p.basis::float8,p.opened_at,
        source.source_wallet from weather.positions p left join lateral (
          select f.evidence->'candidate'->'wallet'->>'wallet' source_wallet from weather.fills f
          where f.experiment=p.experiment and f.strategy=p.strategy and f.token=p.token and f.side='BUY' limit 1
        ) source on true where p.shares>0`,
    ]) : [[],[]];
    const banks = bankRows as Bank[];
    this.positions = positionRows as Position[];
    const at = Date.now();
    const session = this.ws.activeSession;
    const quotes = new Map<string,{ bid: number; ask: number }>();
    const marketViews: object[] = [];
    const scoreSamples: Parameters<typeof sampleForecasts>[0] = [];
    let skipped = 0;
    for (const event of this.data.values()) {
      const eventPositions = this.positions.filter(p => p.event === event.id);
      if (!eventPositions.length && (event.end <= at || event.start > at + 2 * 86400_000)) continue;
      const mids = new Map<string,number>();
      for (const c of event.contracts) {
        for (const token of [c.yes,c.no]) {
          const entry = this.ws.book(token);
          if (!executable(entry,session,token,at,maximumAge)) continue;
          const bid = entry.book.bids[0]?.price, ask = entry.book.asks[0]?.price;
          if (bid > 0 && ask < 1 && ask > bid) quotes.set(token,{ bid,ask });
        }
        const yes = quotes.get(c.yes);
        if (yes) mids.set(c.condition,(yes.bid+yes.ask)/2);
      }
      const prior = this.estimates.get(event.id);
      const cur = estimate(event,[...this.snapshots.values()],[...this.readings.values()],calibrations(baseline,event,at),mids,at);
      if (!prior || cur.forecasts.map(x=>x.hash).join() !== prior.forecasts.map(x=>x.hash).join() || at - prior.at > 15 * minute) {
        this.estimates.set(event.id,cur);
      }
      marketViews.push({ event: event.id, at, distribution: cur.distribution, observed: cur.observed, observation: cur.observation,
        confidence: cur.confidence, forecasts: cur.forecasts, calibration: cur.calibration,
        books: event.contracts.map(c => ({ condition: c.condition, yes: quotes.get(c.yes), no: quotes.get(c.no) })) });
      if (cur.confidence) scoreSamples.push({event:event.id,end:event.end,at,distribution:cur.distribution});
      skipped++;
      const wallet = [...this.walletTrades.values()].filter(row => event.contracts.some(c => c.condition === row.condition))
        .sort((a,b) => b.receivedAt-a.receivedAt);
      const options = session && event.receivedAt >= at-15*minute ? candidates(event,cur,prior,quotes,wallet,at) : [];
      const reason = !event.verified ? "RULES_UNVERIFIED" : !session || !mids.size ? "STALE_BOOK"
        : !cur.confidence ? "INSUFFICIENT_MODEL_CONFIDENCE" : "NO_CONSERVATIVE_EDGE";
      if (!options.length && at >= this.persistAt && this.persist) await audit({ strategy:"system",event:event.id,action:"SKIP",reason,
        evidence:{ estimate:cur, session, lastQuote:this.ws.lastQuote },key:String(Math.floor(at/(5*minute))) });
      if (!this.persist) continue;
      await this.managePositions(event,eventPositions,cur,wallet,quotes,session,at);
      if (session && event.receivedAt >= at - 15 * minute) {
        await this.consider(event,cur,options,banks,session,at);
        await this.monitorComplete(event,banks,session,at);
      }
    }
    if (at >= this.persistAt && this.persist) {
      await state("markets", { data: marketViews, walletEvents: [...this.walletTrades.values()].slice(-100), wallets: [...this.verifiedWallets.values()] });
      await sampleForecasts(scoreSamples);
      await this.mark(banks, session, at);
      this.persistAt = at + minute;
    }
    if (at >= this.reportAt) {
      this.report("engine", { evaluated: skipped, marketEstimates: marketViews.filter(x => (x as { distribution: unknown[] }).distribution.length).length,
        pending: this.pending.size });
      this.reportAt = at + minute;
    }
    return skipped;
  }

  private async consider(event: WeatherEvent, current: Estimate, options: Candidate[], banks: Bank[], session: string, at: number) {
    for (const bank of banks.filter(row => row.running && !row.risk_blocked && row.cash > 0 && row.exposure < risk.exposure)) {
      const choices = options.filter(row => row.strategy === bank.strategy);
      for (const candidate of choices.slice(0, bank.strategy === "distribution" ? 3 : 1)) {
        if (this.positions.some(position => position.experiment === bank.experiment && position.strategy === bank.strategy && position.token === candidate.token)) continue;
        const id = [bank.experiment,bank.strategy,candidate.token,"BUY"].join("/");
        if (this.pending.has(id) || this.acted.has(id)) continue;
        await this.queue(id,bank,event,candidate,current,session,at);
      }
    }
  }

  private async queue(id: string, bank: Bank, event: WeatherEvent, c: Candidate, current: Estimate, session: string, at: number) {
    const signalBook = this.ws.book(c.token);
    if (!executable(signalBook,session,c.token,at,maximumAge)) return;
    const delay = c.strategy.startsWith("replay_") ? Number(c.strategy.split("_")[1]) * 1000 : risk.delay;
    const evidence = { signalBook, candidate: c, estimate: current, delay, at };
    await audit({ experiment:bank.experiment,strategy:bank.strategy,event:event.id,token:c.token,action:"BUY",
      reason:c.reason,evidence,key:String(Math.floor(at/minute)) });
    this.pending.set(id,{ bank,event,contract:c.contract,token:c.token,outcome:(c.yes ? "YES " : "NO ") + c.contract.bucket.label,
      side:"BUY",reference:c.reference,reason:c.reason,estimate:current,readyAt:at+delay, session,evidence,wallet:c.wallet });
    if ((c.ev ?? 0) >= .05) {
      const text = "Weather Lab · Сигнал " + event.station.city + " · " + (c.yes ? "YES " : "NO ") + c.contract.bucket.label
        + "\n" + weatherStrategies[c.strategy] + " · цена " + (c.reference*100).toFixed(1) + "¢"
        + (c.probability == null ? "" : " · вероятность " + (c.probability*100).toFixed(1) + "%")
        + " · EV после комиссии " + ((c.ev ?? 0)*100).toFixed(1) + "%\nВход после повторной проверки стакана.";
      void enqueueWeather(bank.experiment,"signals",hash([c.strategy,c.token,Math.floor(at/3600_000)]),text)
        .catch(error=>log("weather_notifications",error));
    }
  }

  private async managePositions(event: WeatherEvent, positions: Position[], cur: Estimate, wallet: WalletEvent[],
    quotes: Map<string,{ bid:number; ask:number }>, session: string | null, at: number) {
    for (const position of positions) {
      const c = event.contracts.find(c => c.condition === position.condition);
      if (!c) continue;
      const yes = position.token === c.yes;
      const payout = c.payout?.[yes ? 0 : 1];
      if (payout != null) {
        await postFill({ ...position, event, side:"SETTLE", fill:{ shares:position.shares,gross:position.shares*payout,fee:0,price:payout,partial:false },
          evidence:{ payout, source:"Polymarket resolved payout", checkedAt:event.receivedAt },key:"settlement" });
        continue;
      }
      const quote = quotes.get(position.token), book = this.ws.book(position.token);
      if (!session || !c.open || !c.fee || !quote || !executable(book,session,position.token,at,maximumAge)) continue;
      const p = cur.distribution.find(x => x.condition === c.condition);
      const fair = p && cur.confidence ? (yes ? p.p : 1-p.p) : null;
      const afterFees = quote.bid - takerFee(1,quote.bid,c.fee);
      const walletSell = position.strategy.startsWith("replay_") ? wallet.find(row => row.type === "TRADE" && row.side === "SELL"
        && row.wallet === position.source_wallet && row.token === position.token && row.receivedAt > +new Date(position.opened_at) && at - row.receivedAt < 120_000) : undefined;
      const riskCash = position.basis - position.shares * afterFees;
      const reason = walletSell ? "PUBLIC_WALLET_SELL" : fair != null && afterFees >= fair + .02 ? "FAIR_VALUE_EXIT"
        : fair != null && riskCash >= 2.5 && fair < position.basis / position.shares - .15 ? "FORECAST_REVERSAL_RISK"
        : fair != null && afterFees >= position.basis / position.shares + .04 && afterFees >= fair - .01 ? "REPRICING_TARGET" : null;
      const bank = { ...position, cash:0, exposure:0, running:false, risk_blocked:false };
      const id = [position.experiment,position.strategy,position.token,"SELL"].join("/");
      if (!reason) {
        if (at >= this.persistAt) await audit({ experiment:position.experiment,strategy:position.strategy,event:event.id,token:position.token,
          action:"HOLD",reason:"SETTLEMENT_HOLD",evidence:{ fair,afterFees },key:String(Math.floor(at/(5*minute))) });
        continue;
      }
      if (this.pending.has(id) || (walletSell && this.acted.has(walletSell.id + id))) continue;
      const evidence = { signalBook:book, estimate:cur,fair, priorBasis:position.basis, walletSell, at };
      const delay = walletSell ? Number(position.strategy.split("_")[1])*1000 : risk.delay;
      const walletInventory = walletSell ? wallet.filter(r => r.wallet === walletSell.wallet && r.token === position.token && r.receivedAt < walletSell.receivedAt) : [];
      const knownInventory = walletInventory.reduce((sum, row) => sum + (row.side === "BUY" ? row.shares : row.side === "SELL" ? -row.shares : 0),0);
      if (walletSell && (!(knownInventory >= walletSell.shares) || walletInventory.some(row => row.type !== "TRADE"))) {
        await audit({ experiment:position.experiment,strategy:position.strategy,event:event.id,token:position.token,
          action:"SKIP",reason:"PUBLIC_INVENTORY_UNVERIFIED",evidence,key:walletSell.id });
        this.acted.add(walletSell.id + id);
        continue;
      }
      await audit({ experiment:position.experiment,strategy:position.strategy,event:event.id,token:position.token,
        action:"SELL",reason,evidence,key:walletSell?.id ?? String(Math.floor(at/minute)) });
      this.pending.set(id,{ bank,event,contract:c,token:position.token,outcome:position.outcome,side:"SELL",reference:quote.bid,reason,
        estimate:cur,readyAt:at+delay,session,evidence,shares:walletSell ? position.shares * Math.min(1,walletSell.shares/knownInventory) : position.shares,wallet:walletSell });
    }
  }

  private async monitorComplete(event: WeatherEvent, banks: Bank[], session: string, at: number) {
    if (!event.verified || !event.exhaustive || at < event.start || at >= event.end || at < this.persistAt) return;
    for (const bank of banks.filter(b => b.strategy === "complete" && b.running)) {
      const bundles = [event.contracts.map((c,i) => ({ c,token:c.yes,bucket:i,yes:true })),
        ...event.contracts.map((c,i) => [{ c,token:c.yes,bucket:i,yes:true },{ c,token:c.no,bucket:i,yes:false }])];
      for (const legs of bundles) {
        const amount = Math.max(...legs.map(leg=>leg.c.minimum));
        const fills = legs.map(leg => {
          const book = this.ws.book(leg.token);
          const ask = book?.book.asks[0];
          return leg.c.open && leg.c.fee && executable(book,session,leg.token,at,maximumAge) && ask && ask.size >= amount
            ? amount * ask.price + takerFee(amount,ask.price,leg.c.fee) : null;
        });
        const payoffs = payoffTable(event.contracts.length,legs.map(leg=>({...leg,shares:amount})));
        if (fills.some(fill=>fill===null)) continue;
        const cost = fills.reduce<number>((total,fill)=>total+(fill ?? 0),0);
        const minimum = Math.min(...payoffs);
        if (minimum > cost) await audit({ experiment:bank.experiment,strategy:"complete",event:event.id,action:"HOLD",
          reason:"COMPLETE_SET_MONITOR_ONLY",evidence:{ cost,payoffs,minimum,tokenIds:legs.map(x=>x.token) },
          key:hash([Math.floor(at/minute),legs.map(x=>x.token)]) });
      }
    }
  }

  private async drain() {
    for (const [id,row] of this.pending) {
      const at = Date.now();
      if (at < row.readyAt) continue;
      const quote = this.ws.book(row.token);
      const session = this.ws.activeSession;
      const c = this.data.get(row.event.id)?.contracts.find(current => current.condition === row.contract.condition);
      const begin = { experiment:row.bank.experiment,strategy:row.bank.strategy,event:row.event.id,token:row.token,
        action:row.side,key:row.wallet?.id ?? String(row.readyAt) };
      if (row.session !== session || !executable(quote,session,row.token,at,maximumAge,row.readyAt) || !c?.open || !c.fee
        || (row.side === "BUY" && (at >= row.event.end || !this.data.get(row.event.id)?.verified))) {
        if (row.session === session && c?.open && at < row.readyAt + maximumAge) continue;
        this.pending.delete(id);
        await audit({ ...begin,action:"SKIP",reason:"STALE_BOOK",evidence:row.evidence });
        continue;
      }
      this.pending.delete(id);
      const fee = c.fee;
      const target = row.side === "BUY" ? Math.min(.999,row.reference+.015) : Math.max(.001,row.reference-.015);
      const budget = row.side === "BUY" ? Math.min(risk.cost,row.bank.cash,risk.exposure-row.bank.exposure) : row.shares!;
      const fill = takeDepth(quote,{...c,tick:this.ws.tickSize(row.token,c.tick)},row.side,budget,target,fee);
      const edge = row.side === "BUY" && row.bank.strategy !== "favorite" && !row.bank.strategy.startsWith("replay_")
        ? (row.evidence as { candidate?: Candidate }).candidate?.conservative : null;
      const evidence = { ...row.evidence, reason:row.reason, executionBook:quote, fill, fee, readyAt:row.readyAt,
        expiresAt:quote.book.sourceAt+maximumAge, delayMs:quote.book.receivedAt - (row.evidence as { at?:number }).at! };
      if (!fill || (edge != null && edge - (fill.gross+fill.fee)/fill.shares < risk.edge)) {
        await audit({ ...begin,action:"SKIP",reason:fill ? "PRICE_MOVED" : "NO_LIQUIDITY_OR_MINIMUM",evidence });
        continue;
      }
      const status = await postFill({ experiment:row.bank.experiment,strategy:row.bank.strategy,token:row.token,
        condition:c.condition,outcome:row.outcome,event:row.event,side:row.side,fill,evidence,key:begin.key });
      if (row.side === "BUY" && ["PAPER_FILLED","DUPLICATE","DUPLICATE_POSITION"].includes(status)) this.acted.add(id);
      if (row.side === "SELL" && row.wallet) this.acted.add(row.wallet.id + id);
      const partial = fill.partial && (status === "PAPER_FILLED" || status === "PAPER_SELL_FILLED");
      await audit({ ...begin,reason:partial ? "PAPER_PARTIAL" : status,evidence });
    }
  }

  private async mark(banks: Bank[], session: string | null, at: number) {
    for (const bank of banks) {
      const positions = this.positions.filter(p=>p.experiment===bank.experiment && p.strategy===bank.strategy);
      const values = positions.map(p=>{
        const event = this.data.get(p.event);
        const contract = event?.contracts.find(c=>c.condition===p.condition);
        const book = this.ws.book(p.token);
        if (!contract?.fee || !executable(book,session,p.token,at,maximumAge)) return null;
        const fill = takeDepth(book,{...contract,tick:this.ws.tickSize(p.token,contract.tick)},"SELL",p.shares,.000001,contract.fee);
        return !fill || fill.partial ? null : fill.gross-fill.fee;
      });
      await markBank(bank.experiment,bank.strategy,bank.cash,values.some(v=>v==null)?null:values.reduce<number>((s,v)=>s+(v??0),0),at);
    }
  }

  private async heartbeat() {
    const ws = this.ws.status();
    const markets = [...this.data.values()];
    const at = Date.now();
    const ready = this.running && ws.socket && ws.sessionSnapshots>0 && ws.sessionUpdates>0 && at-ws.lastQuote!<maximumAge
      && [["catalog",15*minute],["metar",3*minute],["forecast",25*minute],["engine",minute]].every(([key,age])=>
        this.sources[String(key)]?.ok && at-this.sources[String(key)].at<Number(age)) && markets.some(event=>event.verified && event.contracts.some(c=>c.open));
    const details = { ready, process:this.running, ws, sources:this.sources, cities:[...new Set(markets.map(e=>e.station.city))] };
    this.report("heartbeat", { ...details, observedAt: at });
    if (this.persist) await state("readiness",details);
    return markets.length;
  }
}
