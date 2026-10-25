import type { Settings } from '../config.js';
import { solToLamports } from '../solana/curve.js';

/** Never deploy more than this share of total equity at once: the bot cannot "all-in" or auto-compound the whole balance. */
export const MAX_DEPLOYED_FRACTION = 0.8;
export const BASE_FEE_LAMPORTS = 5_000;
export const ATA_RENT_LAMPORTS = 2_039_280; // legacy SPL token account; Token-2022 accounts are slightly larger

export interface BuyPlanInput {
  st: Settings;
  solUsd: number | null;
  walletLamports: bigint; // spendable balance (real or paper)
  openCount: number;
  reservedCostLamports: bigint; // cost basis currently locked in open positions
  realizedTodayLamports: number;
  realizedTotalLamports: number;
  estimatedCostPct: number;
  needsAtaRent: boolean;
}

export type BuyPlan = { ok: true; sizeLamports: bigint; sizeUsd: number; overheadLamports: bigint } | { ok: false; reason: string };

export function planBuy(i: BuyPlanInput): BuyPlan {
  const { st } = i;
  if (i.solUsd === null || !(i.solUsd > 0)) return { ok: false, reason: 'SOL/USD price unavailable: refusing USD-sized trades' };
  if (i.openCount >= st.maxOpenPositions) return { ok: false, reason: `max open positions reached (${st.maxOpenPositions})` };

  const usdPerLamport = i.solUsd / 1e9;
  const todayUsd = i.realizedTodayLamports * usdPerLamport;
  const totalUsd = i.realizedTotalLamports * usdPerLamport;
  if (todayUsd <= -st.dailyLossLimitUsd) return { ok: false, reason: `daily loss limit reached (${todayUsd.toFixed(2)} USD)` };
  if (totalUsd <= -st.totalLossLimitUsd) return { ok: false, reason: `total loss limit reached (${totalUsd.toFixed(2)} USD)` };

  const equityLamports = i.walletLamports + i.reservedCostLamports;
  const equityUsd = Number(equityLamports) * usdPerLamport;
  if (equityUsd <= st.stopBalanceUsd) return { ok: false, reason: `equity ${equityUsd.toFixed(2)} USD at or below stop-balance ${st.stopBalanceUsd}` };

  const sizeUsd = Math.min(st.tradeSizeUsd, st.maxTradeUsd);
  const size = solToLamports(sizeUsd / i.solUsd);
  if (size <= 0n) return { ok: false, reason: 'trade size rounds to zero' };

  if (i.estimatedCostPct > st.maxCostPctOfTrade) return { ok: false, reason: `expected round-trip cost ${i.estimatedCostPct.toFixed(1)}% exceeds ${st.maxCostPctOfTrade}% of the trade` };

  const portalFee = (size * BigInt(Math.round(st.portalFeePct * 100))) / 10_000n;
  const priority = solToLamports(st.priorityFeeSol);
  const overhead = portalFee + priority + BigInt(BASE_FEE_LAMPORTS) + (i.needsAtaRent ? BigInt(ATA_RENT_LAMPORTS) : 0n);

  // The fixed costs of a buy (network fee, priority fee, PumpPortal fee and — on the very first buy of a
  // token — the ~0.002 SOL rent for a new token account) don't scale down with a small trade size. At $1
  // this fixed overhead alone can be a third of the trade; refuse rather than execute something where fees
  // eat most of the capital. This is what makes "$1 minimum" actually safe instead of just technically allowed.
  const overheadPct = (Number(overhead) / Number(size)) * 100;
  if (overheadPct > st.maxOverheadPctOfTrade) {
    return { ok: false, reason: `fixed fees${i.needsAtaRent ? '/rent' : ''} are ${overheadPct.toFixed(1)}% of this ${sizeUsd.toFixed(2)} USD trade (max ${st.maxOverheadPctOfTrade}%) — not viable at this size` };
  }

  const reserve = solToLamports(st.feeReserveSol); // kept back for exit fees / failures
  if (i.walletLamports < size + overhead + reserve) return { ok: false, reason: 'insufficient balance after fee reserve' };

  const deployedAfter = i.reservedCostLamports + size + overhead;
  if (Number(deployedAfter) > MAX_DEPLOYED_FRACTION * Number(equityLamports)) return { ok: false, reason: `would deploy more than ${MAX_DEPLOYED_FRACTION * 100}% of equity` };

  return { ok: true, sizeLamports: size, sizeUsd, overheadLamports: overhead };
}
