import type { Db, PositionRow } from './db.js';
import { DEFAULT_SETTINGS, LIVE_CONFIRM_PHRASE, validateSettings, type EnvConfig, type Mode, type Settings } from './config.js';
import type { Wallet } from './util/keypair.js';
import { log } from './util/log.js';
import { getBalanceLamports, type RpcLike } from './solana/rpc.js';
import { solToLamports } from './solana/curve.js';
import type { PortalClient } from './exchange/pumpportal.js';
import type { JupiterLike, SolUsdPrice } from './exchange/jupiter.js';
import { buildSnapshot, fetchActivity, fetchCurve, type WatchState } from './analysis/enrich.js';
import { spotPrice } from './solana/curve.js';
import { evaluate, type Decision, type Snapshot } from './analysis/risk.js';
import { Executor } from './trading/executor.js';
import { PositionManager } from './trading/manager.js';
import { planBuy } from './trading/capital.js';
import { WithdrawalService, type PrepareResult, type ConfirmResult } from './trading/withdraw.js';
import { recentDeposits, type DepositInfo } from './trading/deposits.js';
import { NewTokenFeed, type NewTokenEvent } from './feeds/pumpportal-ws.js';

export interface EngineDeps {
  db: Db;
  env: EnvConfig;
  rpc: RpcLike & { stats?: { lastOkAt: number; lastErrorAt: number; lastError: string; calls: number; errors: number } };
  wallet: Wallet | null;
  portal: PortalClient;
  jupiter: JupiterLike;
  solPrice: SolUsdPrice;
  feedFactory?: (onToken: (e: NewTokenEvent) => void) => NewTokenFeed;
  /** Re-evaluation cadence for watched tokens (default 10s; tests use a few ms). */
  evalIntervalMs?: number;
}

interface Watcher {
  ev: NewTokenEvent;
  ws: WatchState;
  timer?: ReturnType<typeof setTimeout>;
  lastReasons: string[];
}

const MAX_WATCHERS = 60;
const EVAL_INTERVAL_MS = 10_000;
const BALANCE_SNAPSHOT_INTERVAL_MS = 5 * 60_000;

class Limiter {
  private active = 0;
  private q: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.q.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.q.shift()?.();
    }
  }
}

export class Engine {
  settings: Settings = { ...DEFAULT_SETTINGS };
  hardHalt: string | null = null;
  killSwitch = false;
  liveArmed = false;
  readonly softHalts = new Map<string, string>();
  readonly executor: Executor;
  readonly manager: PositionManager;
  readonly withdrawals: WithdrawalService;
  readonly feed: NewTokenFeed | null;
  readonly counters = { discovered: 0, prefiltered: 0, analyzed: 0, accepted: 0, bought: 0, buyFailures: 0, droppedBackpressure: 0, evalErrors: 0 };
  readonly startedAt = Date.now();
  private watchers = new Map<string, Watcher>();
  private evalLimiter = new Limiter(4);
  private buyChain: Promise<unknown> = Promise.resolve();
  private consecutiveBuyFailures = 0;
  private timers: Array<ReturnType<typeof setInterval | typeof setTimeout>> = [];
  private stopped = false;
  private balance: { lamports: bigint | null; at: number; error: string } = { lamports: null, at: 0, error: 'not fetched yet' };
  private balanceFailures = 0;
  private lastSnapshotAt = 0;

  constructor(private readonly d: EngineDeps) {
    this.executor = new Executor({
      db: d.db, rpc: d.rpc, wallet: d.wallet, portal: d.portal, jupiter: d.jupiter,
      getSettings: () => this.settings, onCritical: (r) => this.critical(r),
    });
    this.manager = new PositionManager({ db: d.db, executor: this.executor, rpc: d.rpc, getSettings: () => this.settings });
    this.withdrawals = new WithdrawalService({ db: d.db, rpc: d.rpc, wallet: d.wallet, getSettings: () => this.settings, isArmed: () => this.liveArmed });
    this.feed = d.feedFactory ? d.feedFactory((e) => void this.handleNewToken(e).catch((err) => log.error('handleNewToken failed', (err as Error).message))) : null;
  }

  get mode(): Mode {
    return this.d.env.mode;
  }
  get tradeMode(): 'paper' | 'live' {
    return this.mode === 'live' ? 'live' : 'paper';
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.settings = await this.loadSettings();
    await this.executor.reconcile().catch((e) => this.d.db.logError('error', 'reconcile', (e as Error).message));
    await this.withdrawals.reconcile().catch((e) => this.d.db.logError('error', 'reconcile', (e as Error).message));
    this.feed?.start();
    const loop = (fn: () => Promise<void> | void, ms: () => number) => {
      const run = async () => {
        if (this.stopped) return;
        try {
          await fn();
        } catch (e) {
          log.error('loop error', (e as Error).message);
        }
        if (!this.stopped) this.timers.push(setTimeout(run, ms()));
      };
      this.timers.push(setTimeout(run, ms()));
    };
    loop(() => this.manager.tick(), () => this.settings.monitorIntervalMs);
    loop(() => this.executor.reconcile(), () => 15_000);
    loop(() => this.withdrawals.reconcile(), () => 20_000);
    loop(() => this.refreshBalance(), () => 15_000);
    loop(() => this.watchdog(), () => 5_000);
    loop(async () => void (await this.d.solPrice.get()), () => 30_000);
    log.info(`engine started in ${this.mode.toUpperCase()} mode${this.d.wallet ? ` (wallet ${this.d.wallet.address})` : ''}`);
  }

  stop(): void {
    this.stopped = true;
    this.feed?.stop();
    for (const t of this.timers) clearTimeout(t as any);
    for (const w of this.watchers.values()) if (w.timer) clearTimeout(w.timer);
    this.watchers.clear();
  }

  // ------------------------------------------------------------------ settings / controls

  private async loadSettings(): Promise<Settings> {
    try {
      const raw = await this.d.db.getKv('settings');
      if (!raw) return { ...DEFAULT_SETTINGS };
      const v = validateSettings(JSON.parse(raw), { ...DEFAULT_SETTINGS });
      return v.ok ? v.settings : { ...DEFAULT_SETTINGS };
    } catch (e) {
      log.warn('could not load settings from Supabase, using defaults', (e as Error).message);
      return { ...DEFAULT_SETTINGS };
    }
  }

  async updateSettings(patch: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
    const v = validateSettings(patch, this.settings);
    if (!v.ok) return v;
    this.settings = v.settings;
    try {
      await this.d.db.setKv('settings', JSON.stringify(v.settings));
    } catch (e) {
      // Keep the in-memory setting (already applied) but tell the caller persistence failed, so they know
      // it won't survive a restart until Supabase is reachable again.
      return { ok: false, error: `applied, but not saved (Supabase unreachable): ${(e as Error).message}` };
    }
    return { ok: true };
  }

  async kill(closeAll: boolean): Promise<void> {
    this.killSwitch = true;
    log.warn(`KILL SWITCH engaged (closeAll=${closeAll})`);
    await this.d.db.logError('warn', 'control', `kill switch engaged, closeAll=${closeAll}`);
    if (closeAll) for (const p of await this.d.db.listPositions(['open', 'closing', 'stuck'])) await this.executor.closePosition(p.id, 'manual_kill').catch(() => undefined);
  }

  async resume(): Promise<{ ok: boolean; error?: string }> {
    if ((await this.d.db.listPositions(['stuck'])).length) return { ok: false, error: 'a position is stuck: resolve it first (manual close)' };
    this.killSwitch = false;
    this.hardHalt = null;
    this.consecutiveBuyFailures = 0;
    return { ok: true };
  }

  arm(phrase: string): { ok: boolean; error?: string } {
    if (this.mode !== 'live') return { ok: false, error: 'MODE is not live' };
    if (!this.d.wallet) return { ok: false, error: 'no wallet configured' };
    if (this.d.env.liveConfirm !== LIVE_CONFIRM_PHRASE) return { ok: false, error: 'LIVE_CONFIRM is not set in the environment' };
    if (phrase !== LIVE_CONFIRM_PHRASE) return { ok: false, error: 'confirmation phrase does not match' };
    this.liveArmed = true;
    log.warn('LIVE TRADING ARMED via dashboard');
    void this.d.db.logError('warn', 'control', 'live trading armed');
    return { ok: true };
  }
  disarm(): void {
    this.liveArmed = false;
  }

  async manualClose(id: number): Promise<{ ok: boolean; error?: string; pending?: boolean }> {
    const p = await this.d.db.getPosition(id);
    if (!p) return { ok: false, error: 'not found' };
    if (p.state === 'stuck') await this.d.db.updatePosition(id, { state: 'closing', sell_attempts: 0 });
    return this.executor.closePosition(id, 'manual');
  }

  critical(reason: string): void {
    this.hardHalt = reason;
    log.error(`CRITICAL — new trades halted: ${reason}`);
    void this.d.db.logError('critical', 'engine', reason);
  }

  canTrade(): { ok: boolean; reason?: string } {
    if (this.hardHalt) return { ok: false, reason: `halted: ${this.hardHalt}` };
    if (this.killSwitch) return { ok: false, reason: 'kill switch engaged' };
    for (const [k, v] of this.softHalts) return { ok: false, reason: `${k}: ${v}` };
    return { ok: true };
  }

  // ------------------------------------------------------------------ discovery → analysis

  async handleNewToken(e: NewTokenEvent): Promise<void> {
    const st = this.settings;
    this.counters.discovered++;
    let fresh: boolean;
    try {
      fresh = await this.d.db.insertTokenIfNew({
        mint: e.mint, symbol: e.symbol, name: e.name, source: e.source, pool: e.pool, creator: e.creator ?? undefined,
        bondingCurve: e.bondingCurve ?? undefined, discoveredAt: e.discoveredAt, marketCapSol: e.marketCapSol ?? undefined,
      });
    } catch (err) {
      log.warn(`could not record discovered token ${e.mint.slice(0, 8)}… (Supabase unreachable?): ${(err as Error).message}`);
      return;
    }
    if (!fresh) return;

    const why: string[] = [];
    if (!e.bondingCurve) why.push('no bonding-curve address in the discovery event');
    if (e.pool !== 'pump') why.push(`pool "${e.pool}" is not a pump.fun bonding-curve token`);
    if (e.marketCapSol !== null && e.marketCapSol > st.maxMarketCapSol) why.push(`launch market cap ${e.marketCapSol.toFixed(1)} SOL above ${st.maxMarketCapSol}`);
    if (e.devInitialBuyPct !== null && e.devInitialBuyPct > st.maxDevInitialBuyPct) why.push(`creator bought ${e.devInitialBuyPct.toFixed(1)}% of supply at launch (max ${st.maxDevInitialBuyPct}%)`);
    if (why.length) {
      this.counters.prefiltered++;
      await this.d.db.setTokenState(e.mint, { state: 'rejected', decision: 'reject', reasons: why.map((w) => `prefilter: ${w}`) });
      return;
    }
    if (this.watchers.size >= MAX_WATCHERS) {
      this.counters.droppedBackpressure++;
      await this.d.db.setTokenState(e.mint, { state: 'dropped', decision: 'reject', reasons: ['analysis queue full (backpressure): token skipped'] });
      return;
    }
    const w: Watcher = { ev: e, ws: {}, lastReasons: [] };
    this.watchers.set(e.mint, w);
    await this.d.db.setTokenState(e.mint, { state: 'watching', reasons: ['observing before first evaluation'] });
    this.schedule(w, Math.max(0, st.minAgeSec * 1000 - (Date.now() - e.discoveredAt)));
  }

  private schedule(w: Watcher, delayMs: number): void {
    if (this.stopped) return;
    w.timer = setTimeout(() => {
      this.evalLimiter
        .run(() => this.evaluateToken(w))
        .catch((err) => {
          this.counters.evalErrors++;
          void this.d.db.logError('error', 'analysis', `${w.ev.mint}: ${(err as Error).message}`);
          this.reschedule(w);
        });
    }, delayMs);
    w.timer.unref?.();
  }

  private reschedule(w: Watcher): void {
    const age = Date.now() - w.ev.discoveredAt;
    const maxMs = this.settings.maxAgeSec * 1000;
    if (age >= maxMs) return void this.expire(w);
    const every = this.d.evalIntervalMs ?? EVAL_INTERVAL_MS;
    this.schedule(w, Math.min(every, Math.max(Math.min(1000, every), maxMs - age + 500)));
  }

  private expire(w: Watcher): void {
    this.watchers.delete(w.ev.mint);
    void this.d.db.setTokenState(w.ev.mint, { state: 'rejected', decision: 'reject', reasons: ['window expired without meeting entry criteria', ...w.lastReasons.slice(0, 4)] });
  }

  /** Public so tests (and the dashboard) can force one evaluation pass. */
  async evaluateToken(w: Watcher): Promise<void> {
    const { db, rpc } = this.d;
    const st = this.settings;
    const mint = w.ev.mint;
    const ageSec = (Date.now() - w.ev.discoveredAt) / 1000;
    if (ageSec > st.maxAgeSec + 5) return void this.expire(w);

    // stage 1: two cheap RPC calls decide whether the token deserves the full (expensive) analysis
    const curveAddr = w.ev.bondingCurve!;
    const [curve, activity] = await Promise.all([fetchCurve(rpc, curveAddr), fetchActivity(rpc, curveAddr, 60)]);
    if (curve.complete) {
      this.watchers.delete(mint);
      await db.setTokenState(mint, { state: 'rejected', decision: 'reject', reasons: ['bonding curve completed (migrated) before entry'] });
      return;
    }
    if (w.ws.firstPrice === undefined) w.ws.firstPrice = spotPrice(curve);
    const lightMin = Math.ceil(st.minTxInWindow / 3);
    if (activity.txCount < lightMin) {
      w.lastReasons = [`activity: only ${activity.txCount} curve transactions in 60s (need at least ${lightMin} to analyze, ${st.minTxInWindow} to buy)`];
      await db.setTokenState(mint, { state: 'watching', reasons: w.lastReasons });
      return this.reschedule(w);
    }

    // stage 2: full snapshot + risk evaluation
    const solUsd = await this.d.solPrice.get();
    if (solUsd === null) {
      w.lastReasons = ['SOL/USD price unavailable: cannot size the trade'];
      await db.setTokenState(mint, { state: 'watching', reasons: w.lastReasons });
      return this.reschedule(w);
    }
    const size = solToLamports(Math.min(st.tradeSizeUsd, st.maxTradeUsd) / solUsd);
    const { snap, errors } = await buildSnapshot(
      rpc,
      { mint, bondingCurve: curveAddr, creator: w.ev.creator, pool: w.ev.pool, name: w.ev.name, symbol: w.ev.symbol, discoveredAt: w.ev.discoveredAt, devInitialBuyPct: w.ev.devInitialBuyPct, sizeLamports: size },
      st,
      w.ws,
    );
    if (errors.length) await db.logError('warn', 'analysis', `${w.ev.symbol ?? mint}: ${errors.join('; ')}`);
    const decision = evaluate(snap, st);
    this.counters.analyzed++;
    w.lastReasons = decision.reasons;
    await db.setTokenState(mint, {
      state: decision.accept ? 'accepted' : 'watching', risk: decision.riskScore, quality: decision.qualityScore,
      decision: decision.accept ? 'accept' : 'reject', reasons: decision.reasons, checks: decision.checks, marketCapSol: snap.marketCapSol ?? undefined,
    });
    if (!decision.accept) return this.reschedule(w);

    this.watchers.delete(mint);
    this.counters.accepted++;
    await this.enqueueBuy(w, snap, decision);
  }

  // ------------------------------------------------------------------ buying

  private enqueueBuy(w: Watcher, snap: Snapshot, dec: Decision): Promise<void> {
    const job = this.buyChain.then(() => this.tryBuy(w, snap, dec)).catch((e) => {
      void this.d.db.logError('error', 'buy', `${w.ev.mint}: ${(e as Error).message}`);
    });
    this.buyChain = job;
    return job as Promise<void>;
  }

  private async tryBuy(w: Watcher, snap: Snapshot, dec: Decision): Promise<void> {
    const { db } = this.d;
    const mint = w.ev.mint;
    const skip = (why: string) => db.setTokenState(mint, { state: 'skipped', reasons: [why, ...dec.reasons] });

    if (this.mode === 'observe') return void (await db.setTokenState(mint, { state: 'accepted', reasons: ['observe mode: would buy, no order placed', ...dec.reasons] }));
    const gate = this.canTrade();
    if (!gate.ok) return void (await skip(gate.reason!));
    if (this.mode === 'live' && !this.liveArmed) return void (await skip('live trading is not armed (arm it in the dashboard)'));
    if (await db.hasEverTraded(mint)) return void (await skip('already traded this mint'));

    const solUsd = await this.d.solPrice.get();
    let wallet: bigint;
    try {
      wallet = await this.walletLamports();
    } catch (e) {
      return void (await skip(`balance unavailable: ${(e as Error).message}`));
    }
    const mode = this.tradeMode;
    const active = await db.activePositions(mode);
    const reserved = BigInt(active.reduce((s, p) => s + (p.cost_lamports || 0), 0));
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [realizedToday, realizedTotal] = await Promise.all([db.realizedLamports(mode, dayStart.getTime()), db.realizedLamports(mode)]);
    const plan = planBuy({
      st: this.settings, solUsd, walletLamports: wallet, openCount: active.length, reservedCostLamports: reserved,
      realizedTodayLamports: realizedToday, realizedTotalLamports: realizedTotal,
      estimatedCostPct: snap.roundTripCostPct ?? 100, needsAtaRent: mode === 'live',
    });
    if (!plan.ok) return void (await skip(plan.reason));

    const res = await this.executor.openPosition({
      mint, symbol: w.ev.symbol ?? mint.slice(0, 6), pool: w.ev.pool, creator: w.ev.creator, curveAddr: w.ev.bondingCurve!, sizeLamports: plan.sizeLamports, mode,
    });
    if (res.ok) {
      this.counters.bought++;
      this.consecutiveBuyFailures = 0;
      await db.setTokenState(mint, { state: 'bought', reasons: [`bought ${plan.sizeUsd.toFixed(2)} USD (${mode})`, ...dec.reasons] });
    } else {
      this.counters.buyFailures++;
      await db.setTokenState(mint, { state: res.pending ? 'bought' : 'buy_failed', reasons: [res.pending ? `buy pending confirmation: ${res.error}` : `buy failed: ${res.error}`, ...dec.reasons] });
      if (!res.pending && !String(res.error).startsWith('duplicate') && ++this.consecutiveBuyFailures >= 3) this.critical('3 consecutive buy failures: execution path needs attention');
    }
  }

  // ------------------------------------------------------------------ balances / health

  async paperStartLamports(): Promise<bigint | null> {
    const kv = await this.d.db.getKv('paper_start_lamports');
    if (kv) return BigInt(JSON.parse(kv));
    const p = await this.d.solPrice.get();
    if (p === null) return null;
    const v = solToLamports(this.settings.initialCapitalUsd / p);
    await this.d.db.setKv('paper_start_lamports', v.toString());
    return v;
  }

  async paperBalance(): Promise<bigint> {
    const start = await this.paperStartLamports();
    if (start === null) throw new Error('SOL/USD price unavailable for the paper balance');
    const active = await this.d.db.activePositions('paper');
    const reserved = active.reduce((s, p) => s + (p.cost_lamports || 0), 0);
    const realized = await this.d.db.realizedLamports('paper');
    return start + BigInt(realized) - BigInt(reserved);
  }

  async walletLamports(): Promise<bigint> {
    if (this.tradeMode === 'paper') return this.paperBalance();
    if (!this.d.wallet) throw new Error('no wallet');
    try {
      const b = await getBalanceLamports(this.d.rpc, this.d.wallet.address);
      this.balance = { lamports: b, at: Date.now(), error: '' };
      this.balanceFailures = 0;
      if (Date.now() - this.lastSnapshotAt > BALANCE_SNAPSHOT_INTERVAL_MS) {
        this.lastSnapshotAt = Date.now();
        const reserved = (await this.d.db.activePositions('live')).reduce((s, p) => s + (p.cost_lamports || 0), 0);
        void this.d.db.recordBalanceSnapshot({ mode: 'live', solLamports: Number(b), reservedLamports: reserved, source: 'periodic' }).catch(() => undefined);
      }
      return b;
    } catch (e) {
      this.balance.error = (e as Error).message;
      if (++this.balanceFailures >= 3) this.critical('wallet balance unreadable 3 times in a row');
      throw e;
    }
  }

  private async refreshBalance(): Promise<void> {
    try {
      await this.walletLamports();
    } catch {
      /* recorded in this.balance */
    }
  }

  private watchdog(): void {
    const up = Date.now() - this.startedAt;
    if (up < 20_000) return;
    if (this.feed) {
      const s = this.feed.status;
      if (!s.connected) this.softHalts.set('feed', 'discovery feed disconnected');
      else this.softHalts.delete('feed');
    }
    const rpcStats = this.d.rpc.stats;
    if (rpcStats && rpcStats.lastErrorAt > rpcStats.lastOkAt && Date.now() - rpcStats.lastOkAt > 30_000) this.softHalts.set('rpc', `RPC unhealthy: ${rpcStats.lastError}`);
    else this.softHalts.delete('rpc');
    const dbStats = this.d.db.health;
    if (dbStats.lastErrorAt > dbStats.lastOkAt && Date.now() - (dbStats.lastOkAt || this.startedAt) > 30_000) this.softHalts.set('db', `Supabase unhealthy: ${dbStats.lastError}`);
    else this.softHalts.delete('db');
  }

  // ------------------------------------------------------------------ wallet / deposits / withdrawals

  async walletInfo(): Promise<Record<string, unknown>> {
    if (!this.d.wallet) return { address: null, solLamports: null, deposits: [] as DepositInfo[] };
    let deposits: DepositInfo[] = [];
    try {
      deposits = await recentDeposits(this.d.rpc, this.d.wallet.address, 10);
    } catch (e) {
      log.warn('recentDeposits failed', (e as Error).message);
    }
    return {
      address: this.d.wallet.address,
      solLamports: this.balance.lamports !== null ? Number(this.balance.lamports) : null,
      balanceAgeMs: this.balance.at ? Date.now() - this.balance.at : null,
      balanceError: this.balance.error || null,
      deposits,
    };
  }

  prepareWithdrawal(destination: string, amountSolOrMax: number | 'max'): Promise<PrepareResult> {
    return this.withdrawals.prepare(destination, amountSolOrMax);
  }
  confirmWithdrawal(id: number): Promise<ConfirmResult> {
    return this.withdrawals.confirm(id);
  }

  // ------------------------------------------------------------------ dashboard state

  async status(): Promise<Record<string, unknown>> {
    const { db } = this.d;
    const mode = this.tradeMode;
    const solUsd = this.d.solPrice.lastKnown();
    const active = await db.activePositions(mode);
    const basisOf = (p: PositionRow) => p.cost_lamports - p.rent_lamports;
    const reserved = active.reduce((s, p) => s + p.cost_lamports, 0);
    const unrealized = active.filter((p) => p.state === 'open' && p.last_value_lamports > 0).reduce((s, p) => s + (p.last_value_lamports - basisOf(p)), 0);
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    let wallet: number | null = null;
    let walletNote = '';
    if (mode === 'paper') {
      try {
        wallet = Number(await this.paperBalance());
      } catch (e) {
        walletNote = (e as Error).message;
      }
    } else if (this.balance.lamports !== null) wallet = Number(this.balance.lamports);
    else walletNote = this.balance.error;
    const [stats, realizedTotal, realizedToday, tokenCounts] = await Promise.all([
      db.stats(mode), db.realizedLamports(mode), db.realizedLamports(mode, dayStart.getTime()), db.tokenCounts(),
    ]);
    return {
      now: Date.now(),
      mode: this.mode,
      simulated: this.mode !== 'live',
      liveArmed: this.liveArmed,
      walletAddress: this.d.wallet?.address ?? null,
      canTrade: this.canTrade(),
      hardHalt: this.hardHalt,
      killSwitch: this.killSwitch,
      softHalts: Object.fromEntries(this.softHalts),
      feed: this.feed ? this.feed.status : null,
      rpc: this.d.rpc.stats ?? null,
      db: this.d.db.health,
      solUsd: solUsd ? { price: solUsd.v, ageMs: solUsd.ageMs } : null,
      capital: {
        walletLamports: wallet, walletNote, balanceAgeMs: mode === 'live' && this.balance.at ? Date.now() - this.balance.at : null,
        reservedLamports: reserved, unrealizedLamports: unrealized,
        realizedTotalLamports: realizedTotal, realizedTodayLamports: realizedToday,
        feesLamports: stats.feesLamports, closedTrades: stats.closed, wins: stats.wins,
      },
      counters: { ...this.counters, watching: this.watchers.size, tokenStates: tokenCounts },
      settings: this.settings,
      limits: { liveConfirmPhraseRequired: this.mode === 'live' },
    };
  }
}
