import { base58Encode } from '../util/base58.js';
import type { RpcLike } from '../solana/rpc.js';
import { decodeCurve, marketCapSol, spotPrice, type CurveState } from '../solana/curve.js';
import type { Settings } from '../config.js';
import type { Snapshot } from './risk.js';
import { estimateRoundTrip } from './costs.js';

export async function fetchCurve(rpc: RpcLike, curveAddr: string): Promise<CurveState> {
  const r = await rpc.call<{ value: null | { data: [string, string] } }>('getAccountInfo', [curveAddr, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!r.value) throw new Error('bonding curve account not found');
  return decodeCurve(new Uint8Array(Buffer.from(r.value.data[0], 'base64')), base58Encode);
}

export interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supply: bigint;
}

export async function fetchMintInfo(rpc: RpcLike, mint: string): Promise<MintInfo> {
  const r = await rpc.call<{ value: null | { data: { parsed?: { type: string; info: any } } } }>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const p = r.value?.data?.parsed;
  if (!p || p.type !== 'mint') throw new Error('account is not an SPL mint');
  return {
    mintAuthority: p.info.mintAuthority ?? null,
    freezeAuthority: p.info.freezeAuthority ?? null,
    decimals: p.info.decimals,
    supply: BigInt(p.info.supply),
  };
}

export interface HolderStats {
  top10Pct: number;
  topHolderPct: number;
  creatorPct: number | null;
  sample: number;
}

/** Top-20 token accounts → owners; the bonding curve's own account is excluded because it is not a holder who can dump. */
export async function fetchHolders(rpc: RpcLike, mint: string, curveAddr: string, creator: string | null, totalSupplyRaw: bigint): Promise<HolderStats> {
  const largest = await rpc.call<{ value: Array<{ address: string; amount: string }> }>('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
  const accts = largest.value;
  if (!accts.length) throw new Error('no token accounts');
  const multi = await rpc.call<{ value: Array<null | { data: { parsed?: { info?: { owner?: string } } } }> }>('getMultipleAccounts', [accts.map((a) => a.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const rows = accts.map((a, i) => ({ owner: multi.value[i]?.data?.parsed?.info?.owner ?? null, amount: BigInt(a.amount) }));
  if (rows.some((r) => r.owner === null)) throw new Error('could not resolve token account owners');
  const holders = rows.filter((r) => r.owner !== curveAddr);
  const pct = (n: bigint) => (totalSupplyRaw > 0n ? Number((n * 1_000_000n) / totalSupplyRaw) / 10_000 : 0);
  const top10 = holders.slice(0, 10).reduce((s, r) => s + r.amount, 0n);
  let creatorPct: number | null = null;
  if (creator) {
    const mine = holders.filter((r) => r.owner === creator).reduce((s, r) => s + r.amount, 0n);
    if (mine > 0n) creatorPct = pct(mine);
    else creatorPct = accts.length >= 20 ? pct(rows[rows.length - 1].amount) : 0; // conservative upper bound when beyond the sample
  }
  return { top10Pct: pct(top10), topHolderPct: holders.length ? pct(holders[0].amount) : 0, creatorPct, sample: holders.length };
}

export async function fetchActivity(rpc: RpcLike, curveAddr: string, windowSec: number, nowSec = Math.floor(Date.now() / 1000)): Promise<{ txCount: number; windowSec: number }> {
  const sigs = await rpc.call<Array<{ blockTime: number | null; err: unknown }>>('getSignaturesForAddress', [curveAddr, { limit: 100, commitment: 'confirmed' }]);
  const n = sigs.filter((s) => !s.err && s.blockTime !== null && s.blockTime >= nowSec - windowSec).length;
  return { txCount: n, windowSec };
}

export interface WatchState {
  firstPrice?: number;
  lastPrice?: number;
  mintInfo?: MintInfo;
}

export interface SnapshotInput {
  mint: string;
  bondingCurve: string | null;
  creator: string | null;
  pool: string;
  name?: string;
  symbol?: string;
  discoveredAt: number;
  devInitialBuyPct: number | null;
  sizeLamports: bigint;
}

/** Collects all available facts. Any lookup that fails leaves its field null so the risk engine treats it as UNKNOWN (never as safe). */
export async function buildSnapshot(rpc: RpcLike, inp: SnapshotInput, st: Settings, ws: WatchState, now = Date.now()): Promise<{ snap: Snapshot; errors: string[] }> {
  const errors: string[] = [];
  const snap: Snapshot = {
    mint: inp.mint, ageSec: (now - inp.discoveredAt) / 1000, pool: inp.pool, name: inp.name, symbol: inp.symbol,
    curve: null, marketCapSol: null, mintInfo: null, holders: null, devInitialBuyPct: inp.devInitialBuyPct,
    activity: null, growthPct: null, buyImpactPct: null, roundTripCostPct: null, sellQuoteOk: null,
  };
  if (!inp.bondingCurve) {
    errors.push('no bonding curve address in discovery event');
    return { snap, errors };
  }
  const curveAddr = inp.bondingCurve;
  const run = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
      return null;
    }
  };

  const [curve, mintInfo, activity] = await Promise.all([
    run('curve', () => fetchCurve(rpc, curveAddr)),
    ws.mintInfo ? Promise.resolve(ws.mintInfo) : run('mint', () => fetchMintInfo(rpc, inp.mint)),
    run('activity', () => fetchActivity(rpc, curveAddr, 60)),
  ]);
  if (mintInfo) {
    ws.mintInfo = mintInfo;
    snap.mintInfo = { mintAuthority: mintInfo.mintAuthority, freezeAuthority: mintInfo.freezeAuthority, decimals: mintInfo.decimals };
  }
  snap.activity = activity;
  if (curve) {
    snap.curve = curve;
    snap.marketCapSol = marketCapSol(curve);
    const price = spotPrice(curve);
    if (ws.firstPrice === undefined) ws.firstPrice = price;
    else snap.growthPct = (price / ws.firstPrice - 1) * 100;
    ws.lastPrice = price;
    const est = estimateRoundTrip(curve, inp.sizeLamports, st);
    snap.buyImpactPct = est.impactPct;
    snap.roundTripCostPct = est.roundTripCostPct;
    snap.sellQuoteOk = est.sellQuoteOk;
    const supply = mintInfo?.supply ?? curve.tokenTotalSupply;
    snap.holders = await run('holders', () => fetchHolders(rpc, inp.mint, curveAddr, inp.creator, supply));
  }
  return { snap, errors };
}
