/** Pump.fun bonding-curve account decoding and constant-product math (virtual reserves). All amounts are BigInt raw units. */

export const PUMP_TOKEN_DECIMALS = 6;

export interface CurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator?: string;
}

/** Layout: 8-byte discriminator, then 5 x u64 LE, then bool `complete`, then (newer versions) creator pubkey. */
export function decodeCurve(data: Uint8Array, encodeCreator?: (b: Uint8Array) => string): CurveState {
  if (data.length < 49) throw new Error(`Bonding curve account too short (${data.length} bytes)`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (off: number) => dv.getBigUint64(off, true);
  const s: CurveState = {
    virtualTokenReserves: u64(8),
    virtualSolReserves: u64(16),
    realTokenReserves: u64(24),
    realSolReserves: u64(32),
    tokenTotalSupply: u64(40),
    complete: data[48] !== 0,
  };
  if (data.length >= 81 && encodeCreator) s.creator = encodeCreator(data.slice(49, 81));
  if (s.virtualTokenReserves <= 0n || s.virtualSolReserves <= 0n) throw new Error('Bonding curve has empty virtual reserves');
  return s;
}

/** SOL per whole token. */
export function spotPrice(c: CurveState): number {
  return Number(c.virtualSolReserves) / 1e9 / (Number(c.virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS);
}

export function marketCapSol(c: CurveState): number {
  return spotPrice(c) * (Number(c.tokenTotalSupply) / 10 ** PUMP_TOKEN_DECIMALS);
}

/** Tokens received for `solInLamports` (fee estimated on top of the net amount). */
export function quoteBuy(c: CurveState, solInLamports: bigint, feeBps: number): { tokensOut: bigint; impactPct: number } {
  const net = (solInLamports * 10_000n) / (10_000n + BigInt(feeBps));
  const k = c.virtualSolReserves * c.virtualTokenReserves;
  let tokensOut = c.virtualTokenReserves - k / (c.virtualSolReserves + net);
  if (tokensOut > c.realTokenReserves) tokensOut = c.realTokenReserves;
  if (tokensOut <= 0n) return { tokensOut: 0n, impactPct: 100 };
  const execPrice = Number(net) / Number(tokensOut);
  const spot = Number(c.virtualSolReserves) / Number(c.virtualTokenReserves);
  return { tokensOut, impactPct: Math.max(0, (execPrice / spot - 1) * 100) };
}

/** SOL (lamports) received for selling `tokens`, net of the estimated fee. */
export function quoteSell(c: CurveState, tokens: bigint, feeBps: number): bigint {
  if (tokens <= 0n) return 0n;
  const gross = (c.virtualSolReserves * tokens) / (c.virtualTokenReserves + tokens);
  const net = gross - (gross * BigInt(feeBps)) / 10_000n;
  return net > c.realSolReserves ? c.realSolReserves : net;
}

export function lamportsToSol(l: bigint | number): number {
  return Number(l) / 1e9;
}
export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}
