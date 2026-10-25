import { log } from '../util/log.js';

export interface RpcLike {
  call<T = any>(method: string, params?: unknown[]): Promise<T>;
}

export class RpcError extends Error {
  constructor(message: string, public readonly code?: number, public readonly retryable = false) {
    super(message);
  }
}

class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export interface RpcOptions {
  url: string;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  fetchFn?: typeof fetch;
}

/** Minimal JSON-RPC client: bounded concurrency, timeout, retry with backoff on 429/5xx/network errors. */
export class Rpc implements RpcLike {
  private readonly sem: Semaphore;
  private id = 1;
  readonly stats = { calls: 0, errors: 0, lastOkAt: 0, lastErrorAt: 0, lastError: '' };
  constructor(private readonly opts: RpcOptions) {
    this.sem = new Semaphore(opts.concurrency ?? 6);
  }

  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const retries = this.opts.retries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.sem.run(() => this.once<T>(method, params));
        this.stats.lastOkAt = Date.now();
        return res;
      } catch (e) {
        lastErr = e;
        this.stats.errors++;
        this.stats.lastErrorAt = Date.now();
        this.stats.lastError = (e as Error).message;
        const retryable = e instanceof RpcError ? e.retryable : true;
        if (!retryable || attempt === retries) break;
        const wait = 300 * 2 ** attempt + Math.random() * 150;
        log.debug(`rpc ${method} retry ${attempt + 1} in ${Math.round(wait)}ms: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  private async once<T>(method: string, params: unknown[]): Promise<T> {
    this.stats.calls++;
    const f = this.opts.fetchFn ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const res = await f(this.opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params }),
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) throw new RpcError(`HTTP ${res.status}`, res.status, true);
      if (!res.ok) throw new RpcError(`HTTP ${res.status}`, res.status, false);
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) {
        throw new RpcError(body.error.message, body.error.code, body.error.code === -32005 || body.error.code === -32004);
      }
      return body.result as T;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new RpcError('RPC timeout', undefined, true);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---- typed helpers over any RpcLike (so tests can inject a fake) ----

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export async function getBalanceLamports(rpc: RpcLike, address: string): Promise<bigint> {
  const r = await rpc.call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
  return BigInt(r.value);
}

export interface TokenAccountInfo {
  address: string;
  program: string;
  raw: bigint;
}

export interface TokenBalance {
  raw: bigint;
  decimals: number;
  accounts: TokenAccountInfo[];
}

/** Sum of all token accounts the owner holds for this mint (confirmed commitment). */
export async function getTokenBalance(rpc: RpcLike, owner: string, mint: string): Promise<TokenBalance> {
  const r = await rpc.call<{ value: Array<{ pubkey: string; account: { owner: string; data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } }> }>(
    'getTokenAccountsByOwner',
    [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
  );
  let raw = 0n;
  let decimals = 6;
  const accounts: TokenAccountInfo[] = [];
  for (const a of r.value) {
    const t = a.account.data.parsed.info.tokenAmount;
    raw += BigInt(t.amount);
    decimals = t.decimals;
    accounts.push({ address: a.pubkey, program: a.account.owner, raw: BigInt(t.amount) });
  }
  return { raw, decimals, accounts };
}

export interface SigStatus {
  found: boolean;
  confirmation?: 'processed' | 'confirmed' | 'finalized';
  err: unknown;
}

export async function getSignatureStatus(rpc: RpcLike, sig: string): Promise<SigStatus> {
  const r = await rpc.call<{ value: Array<null | { confirmationStatus?: string; err: unknown }> }>('getSignatureStatuses', [
    [sig],
    { searchTransactionHistory: true },
  ]);
  const v = r.value[0];
  if (!v) return { found: false, err: null };
  return { found: true, confirmation: v.confirmationStatus as SigStatus['confirmation'], err: v.err };
}

/** Net lamport change of `address` in a confirmed tx (includes network fee, priority fee and any program fees). */
export async function getTxLamportDelta(rpc: RpcLike, sig: string, address: string): Promise<{ delta: bigint; fee: bigint } | null> {
  const r = await rpc.call<null | {
    meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[] } | null;
    transaction: { message: { accountKeys: Array<string | { pubkey: string }> } };
  }>('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  if (!r || !r.meta) return null;
  const keys = r.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(address);
  if (i < 0) return null;
  return { delta: BigInt(r.meta.postBalances[i]) - BigInt(r.meta.preBalances[i]), fee: BigInt(r.meta.fee) };
}
