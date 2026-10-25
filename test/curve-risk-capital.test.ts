import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCurve, quoteBuy, quoteSell, marketCapSol } from '../src/solana/curve.js';
import { estimateRoundTrip } from '../src/analysis/costs.js';
import { evaluate, type Snapshot } from '../src/analysis/risk.js';
import { planBuy, type BuyPlanInput } from '../src/trading/capital.js';
import { DEFAULT_SETTINGS, validateSettings } from '../src/config.js';
import { curveAt, encodeCurve } from './helpers.js';

const st = { ...DEFAULT_SETTINGS };
const curve = (sol: bigint) => decodeCurve(new Uint8Array(curveAt(sol)));

test('bonding curve decoding and constant-product math', () => {
  const c = curve(5_000_000_000n);
  assert.equal(c.complete, false);
  assert.ok(marketCapSol(c) > 30 && marketCapSol(c) < 40);
  const size = 30_000_000n;
  const buy = quoteBuy(c, size, 125);
  assert.ok(buy.tokensOut > 0n && buy.impactPct > 0 && buy.impactPct < 5);
  const back = quoteSell(c, buy.tokensOut, 125);
  assert.ok(back < size, 'round trip at flat reserves must lose fees');
  assert.ok(quoteBuy(c, 10n * size, 125).impactPct > buy.impactPct, 'bigger trades have more impact');
  assert.throws(() => decodeCurve(new Uint8Array(10)), /too short/);
  assert.throws(() => decodeCurve(new Uint8Array(encodeCurve({ vTok: 0n, vSol: 0n, rTok: 0n, rSol: 0n, supply: 1n }))), /empty virtual reserves/);
});

test('round-trip cost model includes every fee and flags impossible exits', () => {
  const est = estimateRoundTrip(curve(5_000_000_000n), 26_000_000n, st);
  assert.ok(est.roundTripCostPct > 3 && est.roundTripCostPct < 12, `cost ${est.roundTripCostPct}`);
  assert.equal(est.sellQuoteOk, true);
  const tiny = estimateRoundTrip(curve(5_000_000_000n), 26_000_000n, { ...st, priorityFeeSol: 0, portalFeePct: 0, pumpFeeBps: 0 });
  assert.ok(tiny.roundTripCostPct < est.roundTripCostPct);
});

const good = (): Snapshot => ({
  mint: 'M', ageSec: 20, pool: 'pump', name: 'Doge', symbol: 'DOGE', curve: curve(5_000_000_000n), marketCapSol: 34,
  mintInfo: { mintAuthority: null, freezeAuthority: null, decimals: 6 },
  holders: { top10Pct: 15, topHolderPct: 3, creatorPct: 2, sample: 12 }, devInitialBuyPct: 2,
  activity: { txCount: 40, windowSec: 60 }, growthPct: 12, buyImpactPct: 1, roundTripCostPct: 6, sellQuoteOk: true,
});

test('risk engine accepts a clean token and explains why', () => {
  const d = evaluate(good(), st);
  assert.equal(d.accept, true, d.reasons.join('; '));
  assert.ok(d.riskScore <= st.maxRisk && d.qualityScore >= st.minQuality);
  assert.ok(d.checks.every((c) => c.status === 'pass'));
});

test('risk engine rejects on each failed hard check with a specific reason', () => {
  const cases: Array<[string, (s: Snapshot) => void]> = [
    ['mint_authority', (s) => (s.mintInfo!.mintAuthority = 'SomeAuthority1111111111111111111111111111')],
    ['freeze_authority', (s) => (s.mintInfo!.freezeAuthority = 'SomeFreezer11111111111111111111111111111')],
    ['top10', (s) => (s.holders!.top10Pct = 70)],
    ['top_holder', (s) => (s.holders!.topHolderPct = 35)],
    ['creator_share', (s) => (s.holders!.creatorPct = 30)],
    ['activity', (s) => (s.activity!.txCount = 3)],
    ['costs', (s) => (s.roundTripCostPct = 30)],
    ['sellable', (s) => (s.sellQuoteOk = false)],
    ['growth', (s) => (s.growthPct = 400)],
    ['market_cap', (s) => (s.marketCapSol = 500)],
    ['age', (s) => (s.ageSec = 500)],
    ['curve_state', (s) => (s.curve = { ...s.curve!, complete: true })],
  ];
  for (const [id, mutate] of cases) {
    const s = good(); mutate(s);
    const d = evaluate(s, st);
    assert.equal(d.accept, false, id);
    assert.ok(d.reasons.some((r) => r.startsWith(id)), `${id} missing from: ${d.reasons.join(' | ')}`);
  }
});

test('missing data is NEVER treated as safe', () => {
  for (const field of ['mintInfo', 'holders', 'activity', 'curve', 'sellQuoteOk', 'growthPct', 'roundTripCostPct'] as const) {
    const s = good(); (s as any)[field] = null;
    const d = evaluate(s, st);
    assert.equal(d.accept, false, field);
    assert.ok(d.checks.some((c) => c.status === 'unknown' && c.evidence === 'unavailable'), field);
  }
});

test('thresholds are configurable', () => {
  const s = good(); s.holders!.top10Pct = 45;
  assert.equal(evaluate(s, st).accept, false);
  assert.equal(evaluate(s, { ...st, maxTop10Pct: 60 }).accept, true);
});

const plan = (o: Partial<BuyPlanInput> = {}) => planBuy({
  st, solUsd: 150, walletLamports: 166_000_000n, openCount: 0, reservedCostLamports: 0n, realizedTodayLamports: 0, realizedTotalLamports: 0, estimatedCostPct: 6, needsAtaRent: true, ...o,
});

test('capital: 25 USD account sizes a 4 USD trade, converts at the live price and keeps a fee reserve', () => {
  const p = plan();
  assert.ok(p.ok);
  if (p.ok) {
    assert.equal(p.sizeUsd, 4);
    assert.equal(p.sizeLamports, 26_666_667n);
    assert.ok(p.overheadLamports > 2_000_000n, 'ATA rent counted');
  }
});

test('capital limits: price, positions, daily/total loss, stop balance, deployment cap, reserve, cost sanity', () => {
  assert.match((plan({ solUsd: null }) as any).reason, /price unavailable/);
  assert.match((plan({ openCount: 2 }) as any).reason, /max open positions/);
  assert.match((plan({ realizedTodayLamports: -45_000_000 }) as any).reason, /daily loss/);
  assert.match((plan({ realizedTotalLamports: -90_000_000 }) as any).reason, /total loss/);
  assert.match((plan({ walletLamports: 60_000_000n }) as any).reason, /stop-balance/);
  assert.match((plan({ walletLamports: 38_000_000n, st: { ...st, stopBalanceUsd: 0 } }) as any).reason, /insufficient balance/);
  assert.match((plan({ estimatedCostPct: 20 }) as any).reason, /round-trip cost/);
  assert.match((plan({ reservedCostLamports: 120_000_000n, walletLamports: 60_000_000n }) as any).reason, /deploy more than 80%/);
});

test('capital: trade size can never exceed maxTradeUsd, even if settings are inconsistent', () => {
  const p = plan({ st: { ...st, tradeSizeUsd: 50, maxTradeUsd: 5 }, walletLamports: 10_000_000_000n });
  assert.ok(p.ok && p.sizeUsd === 5);
  assert.equal(validateSettings({ tradeSizeUsd: 9 }, st).ok, false);
  assert.equal(validateSettings({ stopLossPct: 0 }, st).ok, false);
  assert.equal(validateSettings({ foo: 1 }, st).ok, false);
  assert.equal(validateSettings({ takeProfitPct: NaN }, st).ok, false);
  assert.equal(validateSettings({ takeProfitPct: 60 }, st).ok, true);
});

// ---- $1-scale capital: no hardcoded $25 floor, but fixed costs must still be checked before every trade

test('capital: there is no hardcoded minimum — settings accept an initial capital and trade size down to $1/$0.5', () => {
  assert.equal(validateSettings({ initialCapitalUsd: 1 }, st).ok, true);
  assert.equal(validateSettings({ initialCapitalUsd: 0.5 }, st).ok, false, 'below the documented floor of $1');
  assert.equal(validateSettings({ tradeSizeUsd: 0.5, maxTradeUsd: 0.5 }, st).ok, true);
  assert.equal(validateSettings({ tradeSizeUsd: 0.1 }, st).ok, false, 'below the documented floor of $0.5');
});

test('capital: a $1 trade that needs a brand-new token account is correctly refused as not viable — rent alone would eat over a third of it', () => {
  const tiny = { ...st, tradeSizeUsd: 1, maxTradeUsd: 1, stopBalanceUsd: 0, dailyLossLimitUsd: 100, totalLossLimitUsd: 100 };
  const p = planBuy({ st: tiny, solUsd: 150, walletLamports: 1_000_000_000n, openCount: 0, reservedCostLamports: 0n, realizedTodayLamports: 0, realizedTotalLamports: 0, estimatedCostPct: 6, needsAtaRent: true });
  assert.equal(p.ok, false);
  if (!p.ok) {
    assert.match(p.reason, /fixed fees\/rent are \d+\.\d% of this 1\.00 USD trade/);
    assert.match(p.reason, /not viable at this size/);
  }
});

test('capital: the SAME $1 trade is viable once no new token account is needed (overhead is just network + Portal fees)', () => {
  const tiny = { ...st, tradeSizeUsd: 1, maxTradeUsd: 1, stopBalanceUsd: 0, dailyLossLimitUsd: 100, totalLossLimitUsd: 100 };
  const p = planBuy({ st: tiny, solUsd: 150, walletLamports: 1_000_000_000n, openCount: 0, reservedCostLamports: 0n, realizedTodayLamports: 0, realizedTotalLamports: 0, estimatedCostPct: 6, needsAtaRent: false });
  assert.ok(p.ok, !p.ok ? p.reason : '');
  if (p.ok) assert.equal(p.sizeUsd, 1);
});

test('capital: raising the overhead tolerance (an explicit, operator-set choice) allows an otherwise-refused tiny trade through', () => {
  const tiny = { ...st, tradeSizeUsd: 1, maxTradeUsd: 1, stopBalanceUsd: 0, dailyLossLimitUsd: 100, totalLossLimitUsd: 100, maxOverheadPctOfTrade: 60 };
  const p = planBuy({ st: tiny, solUsd: 150, walletLamports: 1_000_000_000n, openCount: 0, reservedCostLamports: 0n, realizedTodayLamports: 0, realizedTotalLamports: 0, estimatedCostPct: 6, needsAtaRent: true });
  assert.ok(p.ok, !p.ok ? p.reason : '');
});
