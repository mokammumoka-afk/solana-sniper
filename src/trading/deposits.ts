import type { RpcLike } from '../solana/rpc.js';
import { lamportsToSol } from '../solana/curve.js';

export interface DepositInfo {
  signature: string;
  amountSol: number;
  blockTime: number | null;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | 'unknown';
}

/**
 * Scans the wallet's recent transaction history for incoming SOL transfers (net balance increase), so the
 * dashboard can show "your deposit arrived" without the operator having to read a block explorer. This is
 * a read-only convenience built from the same getSignaturesForAddress / getTransaction RPC calls used
 * elsewhere in the bot — it does not track an index of "known" deposits, so the same transfer may be
 * reported again after it first appears; the dashboard keys its list by signature, which is stable.
 */
export async function recentDeposits(rpc: RpcLike, address: string, limit = 10): Promise<DepositInfo[]> {
  const sigs = await rpc.call<Array<{ signature: string; blockTime: number | null; err: unknown; confirmationStatus?: string }>>('getSignaturesForAddress', [address, { limit: Math.max(limit * 3, 20), commitment: 'confirmed' }]);
  const out: DepositInfo[] = [];
  for (const s of sigs) {
    if (s.err || out.length >= limit) continue;
    try {
      const tx = await rpc.call<null | { meta: { err: unknown; preBalances: number[]; postBalances: number[] } | null; transaction: { message: { accountKeys: Array<string | { pubkey: string }> } } }>(
        'getTransaction',
        [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
      );
      if (!tx || !tx.meta || tx.meta.err) continue;
      const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
      const i = keys.indexOf(address);
      if (i < 0) continue;
      const delta = tx.meta.postBalances[i] - tx.meta.preBalances[i];
      if (delta <= 0) continue; // only incoming transfers; our own outgoing buys/sells/withdrawals are negative here
      out.push({ signature: s.signature, amountSol: lamportsToSol(delta), blockTime: s.blockTime, confirmationStatus: (s.confirmationStatus as DepositInfo['confirmationStatus']) ?? 'unknown' });
    } catch {
      /* best-effort: skip signatures we fail to resolve */
    }
  }
  return out;
}
