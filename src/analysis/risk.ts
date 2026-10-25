import type { Settings } from '../config.js';
import type { CurveState } from '../solana/curve.js';

export type Evidence = 'confirmed' | 'probabilistic' | 'unavailable';
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown';

export interface Check {
  id: string;
  status: CheckStatus;
  evidence: Evidence;
  critical: boolean;
  detail: string;
}

export interface Snapshot {
  mint: string;
  ageSec: number;
  pool: string;
  name?: string;
  symbol?: string;
  curve: CurveState | null;
  marketCapSol: number | null;
  mintInfo: { mintAuthority: string | null; freezeAuthority: string | null; decimals: number } | null;
  holders: { top10Pct: number; topHolderPct: number; creatorPct: number | null; sample: number } | null;
  devInitialBuyPct: number | null;
  activity: { txCount: number; windowSec: number } | null;
  growthPct: number | null;
  buyImpactPct: number | null;
  roundTripCostPct: number | null;
  sellQuoteOk: boolean | null;
}

export interface Decision {
  accept: boolean;
  riskScore: number; // 0 (safe) .. 100 (very risky)
  qualityScore: number; // 0 (poor) .. 100 (strong)
  checks: Check[];
  reasons: string[];
}

const fmt = (n: number, d = 1) => n.toFixed(d);

export function evaluate(s: Snapshot, st: Settings): Decision {
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, evidence: Evidence, critical: boolean, detail: string) => checks.push({ id, status, evidence, critical, detail });
  const unknown = (id: string, why: string, critical = true) => add(id, 'unknown', 'unavailable', critical, `data unavailable: ${why}`);

  // 1-2 authorities (on-chain facts)
  if (!s.mintInfo) {
    unknown('mint_authority', 'mint account not readable');
    unknown('freeze_authority', 'mint account not readable');
  } else {
    add('mint_authority', s.mintInfo.mintAuthority === null ? 'pass' : 'fail', 'confirmed', true, s.mintInfo.mintAuthority === null ? 'mint authority revoked' : `mint authority active (${s.mintInfo.mintAuthority.slice(0, 6)}…): supply can be inflated`);
    add('freeze_authority', s.mintInfo.freezeAuthority === null ? 'pass' : 'fail', 'confirmed', true, s.mintInfo.freezeAuthority === null ? 'freeze authority revoked' : 'freeze authority active: accounts can be frozen');
  }

  // 3 curve / route
  if (!s.curve) unknown('curve_state', 'bonding curve account not readable');
  else if (s.curve.complete) add('curve_state', 'fail', 'confirmed', true, 'bonding curve already completed (migrated): outside the bot’s entry route');
  else add('curve_state', 'pass', 'confirmed', true, `curve active, real SOL reserves ${fmt(Number(s.curve.realSolReserves) / 1e9, 2)}`);

  // 4 age
  if (s.ageSec < st.minAgeSec) add('age', 'fail', 'confirmed', true, `too young (${fmt(s.ageSec, 0)}s < ${st.minAgeSec}s): still observing`);
  else if (s.ageSec > st.maxAgeSec) add('age', 'fail', 'confirmed', true, `too old for the sniping window (${fmt(s.ageSec, 0)}s > ${st.maxAgeSec}s)`);
  else add('age', 'pass', 'confirmed', true, `age ${fmt(s.ageSec, 0)}s inside window`);

  // 5 market cap
  if (s.marketCapSol === null) unknown('market_cap', 'no curve data');
  else if (s.marketCapSol < st.minMarketCapSol || s.marketCapSol > st.maxMarketCapSol)
    add('market_cap', 'fail', 'confirmed', true, `market cap ${fmt(s.marketCapSol)} SOL outside ${st.minMarketCapSol}–${st.maxMarketCapSol}`);
  else add('market_cap', 'pass', 'confirmed', true, `market cap ${fmt(s.marketCapSol)} SOL`);

  // 6-7 holder distribution (balances are on-chain facts; what they imply is probabilistic)
  if (!s.holders) {
    unknown('top10', 'holder list unavailable');
    unknown('top_holder', 'holder list unavailable');
  } else {
    add('top10', s.holders.top10Pct <= st.maxTop10Pct ? 'pass' : 'fail', 'probabilistic', true, `top-10 wallets (excluding the curve) hold ${fmt(s.holders.top10Pct)}% (max ${st.maxTop10Pct}%)`);
    add('top_holder', s.holders.topHolderPct <= st.maxTopHolderPct ? 'pass' : 'fail', 'probabilistic', true, `largest wallet holds ${fmt(s.holders.topHolderPct)}% (max ${st.maxTopHolderPct}%)`);
  }

  // 8 creator share
  const creatorPct = s.holders?.creatorPct ?? s.devInitialBuyPct;
  if (creatorPct === null || creatorPct === undefined) unknown('creator_share', 'creator holding unknown');
  else {
    const limit = s.holders?.creatorPct != null ? st.maxCreatorPct : st.maxDevInitialBuyPct;
    add('creator_share', creatorPct <= limit ? 'pass' : 'fail', s.holders?.creatorPct != null ? 'confirmed' : 'probabilistic', true, `creator holds ${fmt(creatorPct)}% (max ${limit}%)`);
  }

  // 9 activity
  if (!s.activity) unknown('activity', 'transaction history unavailable');
  else
    add('activity', s.activity.txCount >= st.minTxInWindow ? 'pass' : 'fail', 'confirmed', true, `${s.activity.txCount} curve transactions in the last ${s.activity.windowSec}s (min ${st.minTxInWindow})`);

  // 10 momentum (price change between our own observations)
  if (s.growthPct === null) unknown('growth', 'no earlier observation to compare against');
  else if (s.growthPct < st.minGrowthPct) add('growth', 'fail', 'confirmed', true, `price change ${fmt(s.growthPct)}% below ${st.minGrowthPct}%`);
  else if (s.growthPct > st.maxGrowthPct) add('growth', 'fail', 'confirmed', true, `price already +${fmt(s.growthPct)}% (> ${st.maxGrowthPct}%): chasing`);
  else add('growth', 'pass', 'confirmed', true, `price change ${fmt(s.growthPct)}% since last observation`);

  // 11 costs
  if (s.buyImpactPct === null || s.roundTripCostPct === null) unknown('costs', 'cannot price the trade');
  else {
    const ok = s.buyImpactPct <= st.maxBuyImpactPct && s.roundTripCostPct <= st.maxRoundTripCostPct;
    add('costs', ok ? 'pass' : 'fail', 'confirmed', true, `buy impact ${fmt(s.buyImpactPct)}% (max ${st.maxBuyImpactPct}%), round-trip cost ≈ ${fmt(s.roundTripCostPct)}% (max ${st.maxRoundTripCostPct}%)`);
  }

  // 12 sellability — structural (curve math), not a test sell
  if (s.sellQuoteOk === null) unknown('sellable', 'no exit quote');
  else add('sellable', s.sellQuoteOk ? 'pass' : 'fail', 'probabilistic', true, s.sellQuoteOk ? 'curve can absorb an exit of the position (not a test sell)' : 'curve cannot pay out the expected exit');

  // 13 name sanity
  const name = `${s.name ?? ''} ${s.symbol ?? ''}`;
  if (!s.name && !s.symbol) add('name', 'warn', 'unavailable', false, 'no name/symbol metadata');
  else if (/[\u0000-\u001f]/.test(name) || name.length > 80) add('name', 'warn', 'confirmed', false, 'suspicious name/symbol');
  else add('name', 'pass', 'confirmed', false, 'name/symbol look normal');

  // ---- scoring
  const weight: Record<string, number> = { mint_authority: 25, freeze_authority: 20, curve_state: 15, top10: 12, top_holder: 12, creator_share: 14, activity: 10, growth: 6, costs: 10, sellable: 18, market_cap: 6, age: 3, name: 3 };
  let risk = 0;
  let total = 0;
  for (const c of checks) {
    const w = weight[c.id] ?? 5;
    total += w;
    if (c.status === 'fail') risk += w;
    else if (c.status === 'unknown') risk += w * 0.8; // missing data is never evidence of safety
    else if (c.status === 'warn') risk += w * 0.4;
  }
  const riskScore = Math.round((risk / total) * 100);

  let quality = 0;
  if (s.activity) quality += 35 * Math.min(1, s.activity.txCount / Math.max(1, st.minTxInWindow * 3));
  if (s.growthPct !== null && s.growthPct >= st.minGrowthPct && s.growthPct <= st.maxGrowthPct) {
    // sweet spot: a steady climb (~20%) scores best; flat or vertical spikes score lower
    quality += 25 * Math.max(0, 1 - Math.abs(s.growthPct - 20) / Math.max(20, st.maxGrowthPct / 2));
  }
  if (s.holders) quality += 20 * Math.max(0, 1 - s.holders.top10Pct / Math.max(1, st.maxTop10Pct));
  if (s.roundTripCostPct !== null) quality += 20 * Math.max(0, 1 - s.roundTripCostPct / Math.max(1, st.maxRoundTripCostPct));
  const qualityScore = Math.round(Math.min(100, quality));

  const failing = checks.filter((c) => c.status === 'fail' || (c.status === 'unknown' && c.critical));
  const reasons: string[] = failing.map((c) => `${c.id}: ${c.detail}`);
  if (riskScore > st.maxRisk) reasons.push(`risk score ${riskScore} above limit ${st.maxRisk}`);
  if (qualityScore < st.minQuality) reasons.push(`quality score ${qualityScore} below minimum ${st.minQuality}`);
  const accept = failing.length === 0 && riskScore <= st.maxRisk && qualityScore >= st.minQuality;
  if (accept) reasons.push(`all checks passed (risk ${riskScore}, quality ${qualityScore})`);
  return { accept, riskScore, qualityScore, checks, reasons };
}
