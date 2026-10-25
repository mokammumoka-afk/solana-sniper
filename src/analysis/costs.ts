import type { Settings } from '../config.js';
import { quoteBuy, quoteSell, type CurveState } from '../solana/curve.js';

export interface CostEstimate {
  tokensOut: bigint;
  impactPct: number;
  exitLamports: bigint;
  /** (money in − expected money back at flat price) / money in, including curve fee, PumpPortal fee, priority fees and base fees, both legs. */
  roundTripCostPct: number;
  sellQuoteOk: boolean;
}

const BASE_FEE_LAMPORTS = 5_000n;

export function estimateRoundTrip(curve: CurveState, sizeLamports: bigint, st: Settings): CostEstimate {
  const buy = quoteBuy(curve, sizeLamports, st.pumpFeeBps);
  if (buy.tokensOut <= 0n) return { tokensOut: 0n, impactPct: 100, exitLamports: 0n, roundTripCostPct: 100, sellQuoteOk: false };
  const net = (sizeLamports * 10_000n) / (10_000n + BigInt(st.pumpFeeBps));
  const after: CurveState = {
    ...curve,
    virtualSolReserves: curve.virtualSolReserves + net,
    virtualTokenReserves: curve.virtualTokenReserves - buy.tokensOut,
    realSolReserves: curve.realSolReserves + net,
    realTokenReserves: curve.realTokenReserves - buy.tokensOut,
  };
  const exit = quoteSell(after, buy.tokensOut, st.pumpFeeBps);
  const prio = BigInt(Math.round(st.priorityFeeSol * 1e9));
  const portalIn = (sizeLamports * BigInt(Math.round(st.portalFeePct * 100))) / 10_000n;
  const portalOut = (exit * BigInt(Math.round(st.portalFeePct * 100))) / 10_000n;
  const moneyIn = sizeLamports + portalIn + prio + BASE_FEE_LAMPORTS;
  const moneyBack = exit - portalOut - prio - BASE_FEE_LAMPORTS;
  const pct = Number(moneyIn - moneyBack) / Number(moneyIn) * 100;
  return { tokensOut: buy.tokensOut, impactPct: buy.impactPct, exitLamports: exit, roundTripCostPct: Math.max(0, pct), sellQuoteOk: exit > 0n && exit <= after.realSolReserves };
}
