import type { Db, WithdrawalRow } from '../db.js';
import type { Settings } from '../config.js';
import type { Wallet } from '../util/keypair.js';
import { base58Decode, isValidSolanaAddress } from '../util/base58.js';
import { signSerializedTx } from '../solana/tx.js';
import { buildTransferTx, SYSTEM_PROGRAM_ID } from '../solana/system-transfer.js';
import { sendAndConfirm } from '../solana/send.js';
import { getBalanceLamports, getSignatureStatus, getTxLamportDelta, type RpcLike } from '../solana/rpc.js';
import { lamportsToSol, solToLamports } from '../solana/curve.js';
import { log } from '../util/log.js';

const BASE_FEE_LAMPORTS = 5_000n;
const DRAFT_TTL_MS = 120_000;

export interface WithdrawDeps {
  db: Db;
  rpc: RpcLike;
  wallet: Wallet | null;
  getSettings: () => Settings;
  /** The same explicit, session-scoped gate used for live trading — a withdrawal moves real funds and
   *  must never be possible just because MODE=live is set; the operator must have armed it in this run. */
  isArmed: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type PrepareResult =
  | { ok: true; draft: WithdrawalRow; amountSol: number; feeSol: number; remainingSol: number }
  | { ok: false; error: string };
export type ConfirmResult = { ok: true; status: 'confirmed' | 'submitted'; signature: string } | { ok: false; error: string };

function estimateFeeLamports(st: Settings): bigint {
  return solToLamports(st.priorityFeeSol) + BASE_FEE_LAMPORTS;
}

export class WithdrawalService {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  constructor(private readonly d: WithdrawDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = d.now ?? Date.now;
  }

  private gate(): string | null {
    if (!this.d.wallet) return 'no wallet configured';
    if (!this.d.isArmed()) return 'live trading is not armed for this session — arm it before withdrawing';
    return null;
  }

  /** Read-only: validates the request and returns an exact, time-boxed quote the operator must separately
   *  confirm. Nothing is signed or sent here. */
  async prepare(destination: string, amountSolOrMax: number | 'max'): Promise<PrepareResult> {
    const gateErr = this.gate();
    if (gateErr) return { ok: false, error: gateErr };
    const wallet = this.d.wallet!;
    if (!isValidSolanaAddress(destination)) return { ok: false, error: 'destination is not a valid Solana address' };
    if (destination === wallet.address) return { ok: false, error: 'destination is the bot’s own wallet address' };
    if (destination === SYSTEM_PROGRAM_ID) return { ok: false, error: 'destination is the System Program address (likely a mistake) — refusing' };

    let balance: bigint;
    try {
      balance = await getBalanceLamports(this.d.rpc, wallet.address);
    } catch (e) {
      return { ok: false, error: `could not read wallet balance: ${(e as Error).message}` };
    }
    const fee = estimateFeeLamports(this.d.getSettings());
    const amount = amountSolOrMax === 'max' ? balance - fee : solToLamports(amountSolOrMax);
    if (amount <= 0n) return { ok: false, error: 'amount must be greater than zero once fees are accounted for' };
    if (amount + fee > balance) return { ok: false, error: `insufficient balance: need ${lamportsToSol(amount + fee).toFixed(6)} SOL (amount + fee), have ${lamportsToSol(balance).toFixed(6)} SOL` };

    const draft = await this.d.db.insertWithdrawalDraft({ destination, amountLamports: Number(amount), feeLamports: Number(fee), expiresAt: this.now() + DRAFT_TTL_MS });
    await this.d.db.logError('warn', 'withdraw', `withdrawal draft #${draft.id} prepared: ${lamportsToSol(amount).toFixed(6)} SOL to ${destination.slice(0, 8)}…`);
    return { ok: true, draft, amountSol: lamportsToSol(amount), feeSol: lamportsToSol(fee), remainingSol: lamportsToSol(balance - amount - fee) };
  }

  /**
   * Signs and sends a previously prepared draft. The draft -> submitted transition is an atomic
   * compare-and-swap in the database (Db.tryTransitionWithdrawal): if two confirm requests race — a
   * double click, a retried HTTP call — only the first one can ever move the row out of 'draft', so at
   * most one transaction is ever built and sent for a given draft, no matter how many times confirm() is
   * called. This is the actual anti-double-withdrawal guard, not just a UI debounce.
   */
  async confirm(id: number): Promise<ConfirmResult> {
    const gateErr = this.gate();
    if (gateErr) return { ok: false, error: gateErr };
    const wallet = this.d.wallet!;
    const draft = await this.d.db.getWithdrawal(id);
    if (!draft) return { ok: false, error: 'withdrawal not found' };
    if (draft.status !== 'draft') {
      // Not an error in the "something went wrong" sense — it correctly reflects that this request was
      // already consumed (by an earlier confirm, or it expired and was reaped). Never re-send.
      return { ok: false, error: `this withdrawal is already ${draft.status}; nothing was sent` };
    }
    if (this.now() > draft.expires_at) {
      await this.d.db.tryTransitionWithdrawal(id, 'draft', { status: 'expired', error: 'confirmation window elapsed' });
      return { ok: false, error: 'the quote expired — prepare a new withdrawal' };
    }

    // Claim it. If this fails, someone/something else already claimed it: stop immediately, do not sign.
    const claimed = await this.d.db.tryTransitionWithdrawal(id, 'draft', { status: 'submitted' });
    if (!claimed) return { ok: false, error: 'this withdrawal was already confirmed by another request' };

    try {
      const balance = await getBalanceLamports(this.d.rpc, wallet.address);
      const need = BigInt(claimed.amount_lamports) + BigInt(claimed.fee_lamports);
      if (balance < need) throw new Error(`balance changed: need ${lamportsToSol(need).toFixed(6)} SOL, have ${lamportsToSol(balance).toFixed(6)} SOL`);
      const bh = await this.d.rpc.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const tx = buildTransferTx(wallet.publicKey, base58Decode(claimed.destination), BigInt(claimed.amount_lamports), base58Decode(bh.value.blockhash));
      const signed = signSerializedTx(tx, wallet);
      await this.d.db.updateWithdrawal(id, { signature: signed.signature });
      log.warn(`WITHDRAWAL submitting #${id}: ${lamportsToSol(claimed.amount_lamports).toFixed(6)} SOL -> ${claimed.destination}`);
      const outcome = await sendAndConfirm({ rpc: this.d.rpc, sleep: this.sleep, now: this.now }, signed, this.d.getSettings().txConfirmTimeoutSec * 1000);
      if (outcome.status === 'confirmed') {
        await this.finalize(id, signed.signature);
        return { ok: true, status: 'confirmed', signature: signed.signature };
      }
      if (outcome.status === 'unknown') {
        await this.d.db.logError('critical', 'withdraw', `withdrawal #${id} confirmation timed out — signature ${signed.signature} will be reconciled, NOT re-sent`);
        return { ok: true, status: 'submitted', signature: signed.signature };
      }
      await this.d.db.updateWithdrawal(id, { status: 'failed', error: outcome.error });
      await this.d.db.logError('error', 'withdraw', `withdrawal #${id} failed: ${outcome.error}`);
      return { ok: false, error: outcome.error };
    } catch (e) {
      await this.d.db.updateWithdrawal(id, { status: 'failed', error: (e as Error).message });
      await this.d.db.logError('error', 'withdraw', `withdrawal #${id} aborted: ${(e as Error).message}`);
      return { ok: false, error: (e as Error).message };
    }
  }

  private async finalize(id: number, signature: string): Promise<void> {
    const delta = await this.retry(() => getTxLamportDelta(this.d.rpc, signature, this.d.wallet!.address));
    await this.d.db.updateWithdrawal(id, { status: 'confirmed', confirmed_at: this.now(), error: delta ? null : 'proceeds unverified: tx details unavailable' });
    log.warn(`WITHDRAWAL confirmed #${id}: ${signature}`);
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

  /** Settles any withdrawal left in 'submitted' (e.g. after a crash/restart) by checking the chain —
   *  mirrors Executor.reconcile()'s rule: a signature is only ever looked up, never re-sent. */
  async reconcile(): Promise<void> {
    if (!this.d.wallet) return;
    for (const w of await this.d.db.pendingWithdrawals()) {
      if (!w.signature) {
        await this.d.db.updateWithdrawal(w.id, { status: 'failed', error: 'no signature was ever recorded' });
        continue;
      }
      try {
        const s = await getSignatureStatus(this.d.rpc, w.signature);
        if (s.found && s.err) {
          await this.d.db.updateWithdrawal(w.id, { status: 'failed', error: `transaction error: ${JSON.stringify(s.err)}` });
        } else if (s.found && (s.confirmation === 'confirmed' || s.confirmation === 'finalized')) {
          await this.finalize(w.id, w.signature);
        } else if (this.now() - w.requested_at > 180_000) {
          await this.d.db.updateWithdrawal(w.id, { status: 'failed', error: 'expired: never landed' });
        }
      } catch (e) {
        log.warn('withdrawal reconcile lookup failed', (e as Error).message);
      }
    }
  }
}
