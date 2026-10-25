import type { Db, PositionRow, OrderRow } from '../db.js';
import { DbConflictError } from '../db/supabase-client.js';
import type { Settings } from '../config.js';
import type { Wallet } from '../util/keypair.js';
import { base58Decode } from '../util/base58.js';
import { log } from '../util/log.js';
import { getBalanceLamports, getSignatureStatus, getTokenBalance, getTxLamportDelta, type RpcLike } from '../solana/rpc.js';
import { sendAndConfirm, type SendOutcome } from '../solana/send.js';
import { buildCloseAccountTx, signSerializedTx, type SignedTx } from '../solana/tx.js';
import { lamportsToSol, quoteBuy, quoteSell, solToLamports } from '../solana/curve.js';
import { fetchCurve } from '../analysis/enrich.js';
import type { PortalClient } from '../exchange/pumpportal.js';
import { WSOL_MINT, type JupiterLike } from '../exchange/jupiter.js';
import { ATA_RENT_LAMPORTS, BASE_FEE_LAMPORTS } from './capital.js';

export interface ExecDeps {
  db: Db;
  rpc: RpcLike;
  wallet: Wallet | null;
  portal: PortalClient;
  jupiter: JupiterLike;
  getSettings: () => Settings;
  onCritical: (reason: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface OpenArgs {
  mint: string;
  symbol: string;
  pool: string;
  creator: string | null;
  curveAddr: string;
  sizeLamports: bigint;
  mode: 'paper' | 'live';
}
export type OpenResult = { ok: true; positionId: number } | { ok: false; error: string; positionId?: number; pending?: boolean };
export type CloseResult = { ok: boolean; pending?: boolean; error?: string };

export interface ExitQuote {
  netLamports: bigint;
  realSol: number | null;
  complete: boolean;
  source: 'curve' | 'jupiter';
}

export class Executor {
  private readonly busyPositions = new Set<number>();
  private readonly buyingMints = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly d: ExecDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = d.now ?? Date.now;
  }

  // ------------------------------------------------------------------ pricing

  private fixedExitFees(st: Settings, grossLamports: bigint): bigint {
    const portal = (grossLamports * BigInt(Math.round(st.portalFeePct * 100))) / 10_000n;
    return portal + solToLamports(st.priorityFeeSol) + BigInt(BASE_FEE_LAMPORTS);
  }

  /** Expected SOL back if the position were sold now, net of curve fee, PumpPortal fee, priority and base fees. */
  async quoteExit(pos: PositionRow): Promise<ExitQuote> {
    const st = this.d.getSettings();
    const tokens = BigInt(pos.token_raw);
    let complete = false;
    let realSol: number | null = null;
    if (pos.curve) {
      const c = await fetchCurve(this.d.rpc, pos.curve);
      realSol = Number(c.realSolReserves) / 1e9;
      if (!c.complete) {
        const gross = quoteSell(c, tokens, st.pumpFeeBps);
        const net = gross - this.fixedExitFees(st, gross);
        return { netLamports: net > 0n ? net : 0n, realSol, complete: false, source: 'curve' };
      }
      complete = true;
    }
    const q = await this.d.jupiter.quote(pos.mint, WSOL_MINT, tokens, Math.round(st.slippageSellPct * 100));
    const gross = BigInt(q.outAmount);
    const net = gross - solToLamports(st.priorityFeeSol) - BigInt(BASE_FEE_LAMPORTS);
    return { netLamports: net > 0n ? net : 0n, realSol, complete, source: 'jupiter' };
  }

  // ------------------------------------------------------------------ BUY

  async openPosition(a: OpenArgs): Promise<OpenResult> {
    if (this.buyingMints.has(a.mint)) return { ok: false, error: 'duplicate: buy already in flight for this mint' };
    this.buyingMints.add(a.mint);
    try {
      let id: number;
      try {
        id = await this.d.db.insertPosition({ mint: a.mint, symbol: a.symbol, mode: a.mode, pool: a.pool, creator: a.creator, curve: a.curveAddr });
      } catch (e) {
        if (e instanceof DbConflictError) return { ok: false, error: 'duplicate: an active position already exists for this mint' };
        // A real database failure (outage, timeout) is NOT the same as "already bought" — surface it distinctly
        // so the engine treats it as a skipped opportunity rather than silently assuming safety.
        return { ok: false, error: `could not record the position (database unavailable): ${(e as Error).message}` };
      }
      return a.mode === 'paper' ? await this.paperBuy(id, a) : await this.liveBuy(id, a);
    } catch (e) {
      log.error('openPosition unexpected error', e);
      return { ok: false, error: (e as Error).message };
    } finally {
      this.buyingMints.delete(a.mint);
    }
  }

  private async failPosition(id: number, note: string): Promise<void> {
    await this.d.db.updatePosition(id, { state: 'failed', closed_at: this.now(), note });
  }

  private async paperBuy(id: number, a: OpenArgs): Promise<OpenResult> {
    const st = this.d.getSettings();
    try {
      const c = await fetchCurve(this.d.rpc, a.curveAddr);
      if (c.complete) throw new Error('curve completed');
      const q = quoteBuy(c, a.sizeLamports, st.pumpFeeBps);
      if (q.tokensOut <= 0n) throw new Error('no tokens obtainable');
      const portal = (a.sizeLamports * BigInt(Math.round(st.portalFeePct * 100))) / 10_000n;
      const cost = a.sizeLamports + portal + solToLamports(st.priorityFeeSol) + BigInt(BASE_FEE_LAMPORTS);
      const oid = await this.d.db.insertOrder({ position_id: id, side: 'buy', route: 'paper', mode: 'paper', slippage_pct: st.slippageBuyPct, requested: JSON.stringify({ sol: lamportsToSol(a.sizeLamports) }) });
      await this.d.db.updateOrder(oid, { state: 'confirmed', sol_delta_lamports: -Number(cost), fee_lamports: Number(cost - a.sizeLamports) });
      const net = (a.sizeLamports * 10_000n) / (10_000n + BigInt(st.pumpFeeBps));
      const after = { ...c, virtualSolReserves: c.virtualSolReserves + net, virtualTokenReserves: c.virtualTokenReserves - q.tokensOut, realSolReserves: c.realSolReserves + net, realTokenReserves: c.realTokenReserves - q.tokensOut };
      const exit = quoteSell(after, q.tokensOut, st.pumpFeeBps);
      await this.d.db.updatePosition(id, {
        state: 'open', token_raw: q.tokensOut.toString(), decimals: 6, cost_lamports: Number(cost),
        entry_price: lamportsToSol(cost) / (Number(q.tokensOut) / 1e6), entry_value_lamports: Number(exit),
        entry_real_sol: Number(after.realSolReserves) / 1e9, peak_real_sol: Number(after.realSolReserves) / 1e9,
      });
      return { ok: true, positionId: id };
    } catch (e) {
      await this.failPosition(id, `paper buy failed: ${(e as Error).message}`);
      return { ok: false, error: (e as Error).message, positionId: id };
    }
  }

  private async liveBuy(id: number, a: OpenArgs): Promise<OpenResult> {
    const { db, rpc, wallet, portal } = this.d;
    const st = this.d.getSettings();
    if (!wallet) {
      await this.failPosition(id, 'no wallet configured');
      return { ok: false, error: 'no wallet configured', positionId: id };
    }
    let orderId = 0;
    try {
      const bal = await getBalanceLamports(rpc, wallet.address);
      const before = await getTokenBalance(rpc, wallet.address, a.mint);
      const rent = before.accounts.length === 0 ? ATA_RENT_LAMPORTS : 0;
      const need = a.sizeLamports + BigInt(rent) + solToLamports(st.priorityFeeSol) + BigInt(BASE_FEE_LAMPORTS) + solToLamports(st.feeReserveSol);
      if (bal < need) throw new Error('insufficient balance at execution time');
      await db.updatePosition(id, { rent_lamports: rent });

      orderId = await db.insertOrder({ position_id: id, side: 'buy', route: 'portal', mode: 'live', slippage_pct: st.slippageBuyPct, requested: JSON.stringify({ sol: lamportsToSol(a.sizeLamports), pool: a.pool }) });
      const raw = await portal.buildTrade({
        publicKey: wallet.address, action: 'buy', mint: a.mint, amount: lamportsToSol(a.sizeLamports), denominatedInSol: true,
        slippage: st.slippageBuyPct, priorityFee: st.priorityFeeSol, pool: a.pool || 'auto',
      });
      const signed = signSerializedTx(raw, wallet);
      // Persist the signature BEFORE sending: whatever happens next (crash, timeout), we can always look this tx up.
      await db.updateOrder(orderId, { state: 'submitted', signature: signed.signature });
      await db.updatePosition(id, { buy_sig: signed.signature });
      const outcome = await this.sendAndConfirm(signed, st.txConfirmTimeoutSec * 1000);
      if (outcome.status === 'failed') {
        await db.updateOrder(orderId, { state: 'failed', error: outcome.error });
        await this.failPosition(id, `buy failed: ${outcome.error}`);
        return { ok: false, error: outcome.error, positionId: id };
      }
      if (outcome.status === 'unknown') {
        await db.updateOrder(orderId, { state: 'unknown', error: 'confirmation timeout' });
        await db.updatePosition(id, { note: 'buy confirmation pending: will be reconciled' });
        return { ok: false, pending: true, error: 'confirmation timeout (reconciling in background)', positionId: id };
      }
      await this.finalizeBuy(id, orderId, signed.signature);
      return { ok: true, positionId: id };
    } catch (e) {
      const msg = (e as Error).message;
      if (orderId) await db.updateOrder(orderId, { state: 'failed', error: msg }).catch(() => undefined);
      // If a signature was already persisted, the tx may still exist: leave to reconcile unless we never submitted.
      const o = orderId ? (await db.listOrders(1, id))[0] : undefined;
      if (o && o.state === 'submitted') return { ok: false, pending: true, error: msg, positionId: id };
      await this.failPosition(id, `buy aborted: ${msg}`);
      return { ok: false, error: msg, positionId: id };
    }
  }

  private async retry<T>(fn: () => Promise<T | null>, tries = 6, delayMs = 1000): Promise<T | null> {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fn();
        if (r) return r;
      } catch {
        /* retry */
      }
      if (i < tries - 1) await this.sleep(delayMs);
    }
    return null;
  }

  /** A sent transaction is only a success once the chain reports it AND the tokens are really in the wallet. */
  async finalizeBuy(id: number, orderId: number, sig: string): Promise<void> {
    const { db, rpc, wallet } = this.d;
    const pos = (await db.getPosition(id))!;
    const delta = await this.retry(() => getTxLamportDelta(rpc, sig, wallet!.address));
    const tb = await this.retry(async () => {
      const t = await getTokenBalance(rpc, wallet!.address, pos.mint);
      return t.raw > 0n ? t : null;
    });
    if (!tb) {
      await db.updateOrder(orderId, { state: 'confirmed' });
      await db.updatePosition(id, { state: 'failed', closed_at: this.now(), note: 'tx confirmed but no tokens found in wallet' });
      this.d.onCritical(`buy ${sig.slice(0, 8)}… confirmed but wallet holds no ${pos.symbol} — check the transaction manually`);
      return;
    }
    const cost = delta ? Number(-delta.delta) : 0;
    const basis = cost - pos.rent_lamports;
    await db.updateOrder(orderId, { state: 'confirmed', sol_delta_lamports: delta ? Number(delta.delta) : null, fee_lamports: delta ? Number(delta.fee) : null });
    await db.updatePosition(id, {
      state: 'open', token_raw: tb.raw.toString(), decimals: tb.decimals, cost_lamports: cost,
      entry_price: basis > 0 ? basis / 1e9 / (Number(tb.raw) / 10 ** tb.decimals) : 0,
      note: delta ? null : 'cost unknown: tx details unavailable',
    });
    log.info(`BUY confirmed ${pos.symbol} ${sig.slice(0, 8)}… tokens=${tb.raw} cost=${lamportsToSol(cost).toFixed(5)} SOL`);
  }

  // ------------------------------------------------------------------ SELL

  async closePosition(id: number, reason: string): Promise<CloseResult> {
    if (this.busyPositions.has(id)) return { ok: false, pending: true, error: 'operation already in flight' };
    this.busyPositions.add(id);
    try {
      const pos = await this.d.db.getPosition(id);
      if (!pos) return { ok: false, error: 'position not found' };
      if (!['open', 'closing', 'stuck'].includes(pos.state)) return { ok: false, error: `position is ${pos.state}` };
      return pos.mode === 'paper' ? await this.paperSell(pos, reason) : await this.liveSell(pos, reason);
    } catch (e) {
      log.error('closePosition unexpected error', e);
      return { ok: false, error: (e as Error).message };
    } finally {
      this.busyPositions.delete(id);
    }
  }

  private async paperSell(pos: PositionRow, reason: string): Promise<CloseResult> {
    try {
      const q = await this.quoteExit(pos);
      const oid = await this.d.db.insertOrder({ position_id: pos.id, side: 'sell', route: 'paper', mode: 'paper', slippage_pct: 0, requested: '100%' });
      await this.d.db.updateOrder(oid, { state: 'confirmed', sol_delta_lamports: Number(q.netLamports) });
      await this.d.db.updatePosition(pos.id, { state: 'closed', proceeds_lamports: Number(q.netLamports), closed_at: this.now(), exit_reason: pos.exit_reason ?? reason });
      return { ok: true };
    } catch (e) {
      await this.d.db.updatePosition(pos.id, { state: 'closing', exit_reason: pos.exit_reason ?? reason, sell_attempts: pos.sell_attempts + 1 });
      return { ok: false, error: (e as Error).message };
    }
  }

  private async liveSell(pos: PositionRow, reason: string): Promise<CloseResult> {
    const { db, rpc, wallet, portal, jupiter } = this.d;
    const st = this.d.getSettings();
    if (!wallet) return { ok: false, error: 'no wallet configured' };
    await db.updatePosition(pos.id, { state: 'closing', exit_reason: pos.exit_reason ?? reason });

    // 1) never create a second sell while an earlier one might still land
    const existingSells = (await db.listOrders(0, pos.id)).filter((x) => x.side === 'sell' && (x.state === 'submitted' || x.state === 'unknown'));
    for (const o of existingSells) {
      const r = await this.resolveOrder(o);
      if (r === 'confirmed') {
        await this.finalizeSell(pos.id, o.id, o.signature!);
        return { ok: true };
      }
      if (r === 'pending') return { ok: false, pending: true, error: 'previous sell still pending' };
    }

    // 2) what do we really hold?
    const tb = await getTokenBalance(rpc, wallet.address, pos.mint);
    if (tb.raw === 0n) {
      const done = (await db.listOrders(0, pos.id)).find((x) => x.side === 'sell' && x.state === 'confirmed' && x.signature);
      if (done) {
        await this.finalizeSell(pos.id, done.id, done.signature!);
      } else {
        await db.updatePosition(pos.id, { state: 'closed', closed_at: this.now(), note: 'wallet balance is zero and no sell was recorded (tokens moved or sold outside the bot)' });
        this.d.onCritical(`position ${pos.symbol}: wallet balance is zero but no sell was recorded`);
      }
      return { ok: true };
    }

    // 3) attempt a sell with escalating slippage and a route fallback
    const attempts = pos.sell_attempts + 1;
    if (attempts > st.maxSellAttempts) {
      await db.updatePosition(pos.id, { state: 'stuck', note: `sell failed ${pos.sell_attempts} times` });
      this.d.onCritical(`position ${pos.symbol} is stuck: ${pos.sell_attempts} failed sells`);
      return { ok: false, error: 'max sell attempts reached' };
    }
    const slippage = Math.min(90, st.slippageSellPct * (attempts === 1 ? 1 : attempts === 2 ? 1.5 : 2));
    const route = attempts >= 3 ? 'jupiter' : 'portal';
    await db.updatePosition(pos.id, { sell_attempts: attempts, token_raw: tb.raw.toString() });
    const orderId = await db.insertOrder({ position_id: pos.id, side: 'sell', route, mode: 'live', slippage_pct: slippage, requested: tb.raw.toString() });
    try {
      let raw: Uint8Array;
      if (route === 'portal') {
        raw = await portal.buildTrade({ publicKey: wallet.address, action: 'sell', mint: pos.mint, amount: '100%', denominatedInSol: false, slippage, priorityFee: st.priorityFeeSol, pool: 'auto' });
      } else {
        const q = await jupiter.quote(pos.mint, WSOL_MINT, tb.raw, Math.round(slippage * 100));
        raw = await jupiter.swapTx(q, wallet.address, Number(solToLamports(st.priorityFeeSol)));
      }
      const signed = signSerializedTx(raw, wallet);
      await db.updateOrder(orderId, { state: 'submitted', signature: signed.signature });
      await db.updatePosition(pos.id, { sell_sig: signed.signature });
      const outcome = await this.sendAndConfirm(signed, st.txConfirmTimeoutSec * 1000);
      if (outcome.status === 'confirmed') {
        await this.finalizeSell(pos.id, orderId, signed.signature);
        return { ok: true };
      }
      if (outcome.status === 'unknown') {
        await db.updateOrder(orderId, { state: 'unknown', error: 'confirmation timeout' });
        return { ok: false, pending: true, error: 'sell confirmation timeout (will be re-checked, no duplicate is sent)' };
      }
      await db.updateOrder(orderId, { state: 'failed', error: outcome.error });
      return { ok: false, error: outcome.error };
    } catch (e) {
      const cur = (await db.listOrders(0, pos.id)).find((o) => o.id === orderId);
      if (cur && cur.state === 'submitted') return { ok: false, pending: true, error: (e as Error).message };
      await db.updateOrder(orderId, { state: 'failed', error: (e as Error).message });
      return { ok: false, error: (e as Error).message };
    }
  }

  async finalizeSell(id: number, orderId: number, sig: string): Promise<void> {
    const { db, rpc, wallet } = this.d;
    const pos = (await db.getPosition(id))!;
    const delta = await this.retry(() => getTxLamportDelta(rpc, sig, wallet!.address));
    const proceeds = delta ? Number(delta.delta) : Math.max(0, pos.last_value_lamports);
    await db.updateOrder(orderId, { state: 'confirmed', sol_delta_lamports: delta ? Number(delta.delta) : null, fee_lamports: delta ? Number(delta.fee) : null });
    await db.updatePosition(id, {
      state: 'closed', proceeds_lamports: proceeds, sell_sig: sig, closed_at: this.now(),
      note: delta ? pos.note : 'proceeds estimated: tx details unavailable',
    });
    log.info(`SELL confirmed ${pos.symbol} ${sig.slice(0, 8)}… proceeds=${lamportsToSol(proceeds).toFixed(5)} SOL (${pos.exit_reason})`);
    await this.reclaimRent(id).catch((e) => log.warn('rent reclaim failed', (e as Error).message));
  }

  /** Closes the now-empty token account(s) so the ~0.002 SOL rent paid at entry returns to the wallet and to the PnL. */
  async reclaimRent(id: number): Promise<void> {
    const { db, rpc, wallet } = this.d;
    const pos = await db.getPosition(id);
    if (!pos || pos.mode !== 'live' || !wallet || pos.note === 'ata_closed') return;
    const tb = await getTokenBalance(rpc, wallet.address, pos.mint);
    if (tb.raw > 0n) return;
    let refunded = 0;
    for (const acc of tb.accounts) {
      const bh = await rpc.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const unsigned = buildCloseAccountTx(wallet.publicKey, base58Decode(acc.address), base58Decode(acc.program), base58Decode(bh.value.blockhash));
      const signed = signSerializedTx(unsigned, wallet);
      const oid = await db.insertOrder({ position_id: id, side: 'sell', route: 'close_account', mode: 'live', slippage_pct: 0, requested: acc.address });
      await db.updateOrder(oid, { state: 'submitted', signature: signed.signature });
      const out = await this.sendAndConfirm(signed, 30_000);
      if (out.status !== 'confirmed') {
        await db.updateOrder(oid, { state: out.status === 'failed' ? 'failed' : 'unknown', error: out.status === 'failed' ? out.error : 'timeout' });
        continue;
      }
      const delta = await this.retry(() => getTxLamportDelta(rpc, signed.signature, wallet.address));
      await db.updateOrder(oid, { state: 'confirmed', sol_delta_lamports: delta ? Number(delta.delta) : null, fee_lamports: delta ? Number(delta.fee) : null });
      if (delta) refunded += Number(delta.delta);
    }
    const cur = (await db.getPosition(id))!;
    await db.updatePosition(id, { proceeds_lamports: cur.proceeds_lamports + refunded, note: tb.accounts.length && refunded > 0 ? 'ata_closed' : cur.note });
  }

  // ------------------------------------------------------------------ transaction plumbing

  private async sendAndConfirm(signed: SignedTx, timeoutMs: number): Promise<SendOutcome> {
    return sendAndConfirm({ rpc: this.d.rpc, sleep: this.sleep, now: this.now }, signed, timeoutMs);
  }

  /** Looks up an earlier, unresolved order without ever re-sending it. */
  async resolveOrder(o: OrderRow): Promise<'confirmed' | 'failed' | 'pending'> {
    if (!o.signature) {
      await this.d.db.updateOrder(o.id, { state: 'failed', error: 'never signed' });
      return 'failed';
    }
    const s = await getSignatureStatus(this.d.rpc, o.signature);
    if (s.found && s.err) {
      await this.d.db.updateOrder(o.id, { state: 'failed', error: `transaction error: ${JSON.stringify(s.err)}` });
      return 'failed';
    }
    if (s.found && (s.confirmation === 'confirmed' || s.confirmation === 'finalized')) return 'confirmed';
    if (s.found) return 'pending';
    // not found: a blockhash is valid for ~60-90s; after 2 minutes the tx can no longer land
    if (this.now() - o.created_at > 120_000) {
      await this.d.db.updateOrder(o.id, { state: 'failed', error: 'expired: never landed' });
      return 'failed';
    }
    return 'pending';
  }

  /** Called at startup and periodically: settles every live order whose outcome was unknown. If Supabase
   *  itself is unreachable, this throws and the caller (engine) treats it as a health-check failure rather
   *  than silently skipping reconciliation. */
  async reconcile(): Promise<void> {
    const { db, wallet } = this.d;
    if (!wallet) return;
    for (const o of await db.pendingOrders()) {
      const pos = await db.getPosition(o.position_id);
      if (!pos) continue;
      let r: 'confirmed' | 'failed' | 'pending';
      try {
        r = await this.resolveOrder(o);
      } catch (e) {
        log.warn('reconcile lookup failed', (e as Error).message);
        continue;
      }
      if (r === 'pending') continue;
      if (o.side === 'buy' && pos.state === 'opening') {
        if (r === 'confirmed') await this.finalizeBuy(pos.id, o.id, o.signature!);
        else await this.failPosition(pos.id, 'buy never landed (reconciled)');
      } else if (o.side === 'sell' && r === 'confirmed' && pos.state !== 'closed' && o.route !== 'close_account') {
        await this.finalizeSell(pos.id, o.id, o.signature!);
      } else if (r === 'confirmed') {
        await db.updateOrder(o.id, { state: 'confirmed' });
      }
    }
    // live positions stuck in 'opening' with no order at all (crash between insert and submit)
    for (const pos of (await db.listPositions(['opening'])).filter((p) => p.mode === 'live')) {
      const orders = await db.listOrders(0, pos.id);
      if (orders.some((o) => o.state === 'submitted' || o.state === 'unknown')) continue;
      if (orders.some((o) => o.state === 'confirmed')) continue;
      await this.failPosition(pos.id, 'interrupted before submission (reconciled at startup)');
    }
    // paper positions cannot be mid-flight across a restart
    for (const pos of (await db.listPositions(['opening'])).filter((p) => p.mode === 'paper')) await this.failPosition(pos.id, 'interrupted (paper)');
  }
}
