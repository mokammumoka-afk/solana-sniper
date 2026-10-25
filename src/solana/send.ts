import { RpcError, getSignatureStatus, type RpcLike } from './rpc.js';
import type { SignedTx } from './tx.js';
import { log } from '../util/log.js';

export type SendOutcome = { status: 'confirmed' } | { status: 'failed'; error: string } | { status: 'unknown' };

export interface SendDeps {
  rpc: RpcLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Submits a signed transaction and waits for an on-chain confirmation. Shared by the trading executor
 * and the withdrawal flow so both honor the exact same "a send is not a success" rule: a JSON-RPC error
 * means the node rejected it outright (failed); anything else is polled via getSignatureStatus until a
 * definitive confirmed/err outcome or the timeout — a timeout is reported as 'unknown', never as success
 * or failure, so the caller never re-sends a transaction whose fate is still unknown.
 */
export async function sendAndConfirm(d: SendDeps, signed: SignedTx, timeoutMs: number): Promise<SendOutcome> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  try {
    await d.rpc.call('sendTransaction', [signed.base64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
  } catch (e) {
    if (e instanceof RpcError && e.code !== undefined && e.code < 0 && !e.retryable) return { status: 'failed', error: `rejected by RPC: ${e.message}` };
    log.warn(`sendTransaction ambiguous (${(e as Error).message}); polling status for ${signed.signature.slice(0, 8)}…`);
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const s = await getSignatureStatus(d.rpc, signed.signature);
      if (s.found) {
        if (s.err) return { status: 'failed', error: `transaction error: ${JSON.stringify(s.err)}` };
        if (s.confirmation === 'confirmed' || s.confirmation === 'finalized') return { status: 'confirmed' };
      }
    } catch {
      /* keep polling */
    }
    await sleep(1000);
  }
  return { status: 'unknown' };
}
