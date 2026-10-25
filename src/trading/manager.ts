import type { Db, PositionRow } from '../db.js';
import type { Settings } from '../config.js';
import { log } from '../util/log.js';
import { getTokenBalance, type RpcLike } from '../solana/rpc.js';
import type { Executor } from './executor.js';

export interface ExitInput {
  pnlPct: number;
  peakPnlPct: number;
  breachTicks: number;
  heldSec: number;
  realSol: number | null;
  peakRealSol: number;
  creatorDropPct: number | null;
}
export interface ExitDecision {
  reason: string | null;
  breachTicks: number;
}

/**
 * Pure exit rules. Immediate: hard stop, take profit, creator dump, max hold.
 * Confirmed over `confirmTicks` consecutive checks (so one noisy tick cannot trigger a sale): stop loss, trailing stop, liquidity drop.
 */
export function decideExit(i: ExitInput, st: Settings): ExitDecision {
  if (i.pnlPct <= -st.hardStopPct) return { reason: 'hard_stop', breachTicks: i.breachTicks };
  if (i.pnlPct >= st.takeProfitPct) return { reason: 'take_profit', breachTicks: 0 };
  if (i.creatorDropPct !== null && i.creatorDropPct >= st.creatorSellExitPct) return { reason: 'creator_sell', breachTicks: i.breachTicks };
  if (i.heldSec >= st.maxHoldSec) return { reason: 'max_hold', breachTicks: i.breachTicks };

  let breach: string | null = null;
  if (i.pnlPct <= -st.stopLossPct) breach = 'stop_loss';
  else if (i.peakPnlPct >= st.trailingActivatePct && 1 + i.pnlPct / 100 <= (1 + i.peakPnlPct / 100) * (1 - st.trailingDropPct / 100)) breach = 'trailing_stop';
  else if (i.realSol !== null && i.peakRealSol > 0 && i.realSol <= i.peakRealSol * (1 - st.liquidityDropExitPct / 100)) breach = 'liquidity_drop';

  if (!breach) return { reason: null, breachTicks: 0 };
  const ticks = i.breachTicks + 1;
  return { reason: ticks >= st.confirmTicks ? breach : null, breachTicks: ticks };
}

export interface ManagerDeps {
  db: Db;
  executor: Executor;
  rpc: RpcLike;
  getSettings: () => Settings;
  now?: () => number;
}

export class PositionManager {
  private running = false;
  private creatorCheckedAt = new Map<number, number>();
  constructor(private readonly d: ManagerDeps) {}

  /** One pass over every active position. Safe to call concurrently (the second call returns immediately). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const p of await this.d.db.listPositions(['open', 'closing'])) {
        try {
          await this.handle(p);
        } catch (e) {
          log.error(`manager error for ${p.symbol}`, (e as Error).message);
          await this.d.db.logError('error', 'manager', `${p.symbol}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async handle(p: PositionRow): Promise<void> {
    const { db, executor } = this.d;
    const st = this.d.getSettings();
    const now = (this.d.now ?? Date.now)();

    if (p.state === 'closing') {
      const last = (await db.listOrders(0, p.id)).find((o) => o.side === 'sell');
      const wait = 3000 * Math.max(1, p.sell_attempts);
      if (!last || now - last.created_at >= wait) await executor.closePosition(p.id, p.exit_reason ?? 'retry');
      return;
    }

    let q;
    try {
      q = await executor.quoteExit(p);
    } catch (e) {
      const since = p.blind_since || now;
      await db.updatePosition(p.id, { blind_since: since });
      if (now - since > 30_000) {
        log.warn(`${p.symbol}: no price data for 30s → exiting (${(e as Error).message})`);
        await executor.closePosition(p.id, 'data_blind');
      }
      return;
    }

    const basis = p.cost_lamports - p.rent_lamports;
    if (basis <= 0) return; // cost not known yet (reconciliation pending)
    const value = Number(q.netLamports);
    const pnlPct = ((value - basis) / basis) * 100;
    const peak = Math.max(p.peak_pnl_pct, pnlPct);
    const peakReal = Math.max(p.peak_real_sol, q.realSol ?? 0);

    // creator dump detection (needs creator address; checked every ~5s to spare the RPC)
    let creatorDrop: number | null = null;
    if (p.creator) {
      const lastChk = this.creatorCheckedAt.get(p.id) ?? 0;
      if (now - lastChk >= 5000) {
        this.creatorCheckedAt.set(p.id, now);
        try {
          const bal = (await getTokenBalance(this.d.rpc, p.creator!, p.mint)).raw;
          if (p.creator_token_raw === null) await db.updatePosition(p.id, { creator_token_raw: bal.toString() });
          else {
            const init = BigInt(p.creator_token_raw);
            if (init > 0n) creatorDrop = Number(((init - (bal > init ? init : bal)) * 10_000n) / init) / 100;
          }
        } catch {
          /* creator check is best-effort */
        }
      }
    }

    const dec = decideExit(
      { pnlPct, peakPnlPct: peak, breachTicks: p.breach_ticks, heldSec: (now - p.opened_at) / 1000, realSol: q.realSol, peakRealSol: peakReal, creatorDropPct: creatorDrop },
      st,
    );
    await db.updatePosition(p.id, {
      last_value_lamports: value, last_pnl_pct: pnlPct, peak_pnl_pct: peak, peak_real_sol: peakReal, breach_ticks: dec.breachTicks, blind_since: 0,
      entry_value_lamports: p.entry_value_lamports || value,
      entry_real_sol: p.entry_real_sol || (q.realSol ?? 0),
    });
    if (dec.reason) {
      log.info(`EXIT ${p.symbol}: ${dec.reason} (pnl ${pnlPct.toFixed(1)}%, peak ${peak.toFixed(1)}%)`);
      await executor.closePosition(p.id, dec.reason);
    }
  }
}
