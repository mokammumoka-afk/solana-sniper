import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { base58Encode } from '../src/util/base58.js';
import { walletFromSecret, type Wallet } from '../src/util/keypair.js';
import type { RpcLike } from '../src/solana/rpc.js';
import { RpcError } from '../src/solana/rpc.js';
import type { PortalClient, PortalTradeParams } from '../src/exchange/pumpportal.js';
import { USDC_MINT, WSOL_MINT, type JupQuote, type JupiterLike } from '../src/exchange/jupiter.js';
import { Db } from '../src/db.js';
import { FakePostgrest } from './fake-postgrest.js';

/** Every FakePostgrest server started by freshDb() in the current test file, so the file's top-level
 *  `after()` hook (see each test file) can close them all — without this, the listening HTTP servers
 *  keep the process's event loop non-empty and the Node test runner's per-file worker process never exits,
 *  which stalls the whole `npm test` run after this file instead of moving on to the next one. */
export const openFakeServers: FakePostgrest[] = [];
export async function closeAllFakeServers(): Promise<void> {
  await Promise.all(openFakeServers.splice(0).map((s) => s.stop()));
}

/**
 * Starts a fresh in-memory fake-PostgREST backend (see fake-postgrest.ts) and returns a Db client bound
 * to it. Pass an existing `url` to point a second Db instance at the SAME backend — the way two instances
 * of the real bot would both talk to the same Supabase project across a restart (see the "restart
 * recovery" test in executor.test.ts). Every file that calls this must `after(closeAllFakeServers)`.
 */
export async function freshDb(url?: string): Promise<{ db: Db; url: string; fake: FakePostgrest | null }> {
  let target = url;
  let fake: FakePostgrest | null = null;
  if (!target) {
    fake = new FakePostgrest();
    await fake.start();
    openFakeServers.push(fake);
    target = fake.url;
  }
  return { db: new Db({ url: target, serviceRoleKey: 'test-service-role-key', retries: 1 }), url: target, fake };
}

export function makeSecret(): { secretB58: string; secretBytes: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const bytes = new Uint8Array(Buffer.concat([seed, pub]));
  return { secretB58: base58Encode(bytes), secretBytes: bytes };
}
export function makeWallet(): Wallet {
  return walletFromSecret(makeSecret().secretB58);
}
export const randAddr = () => base58Encode(randomBytes(32));

export function buildTx(feePayer: Uint8Array, o: { versioned?: boolean; signers?: number } = {}): Uint8Array {
  const signers = o.signers ?? 1;
  const keys = [feePayer, ...Array.from({ length: signers - 1 }, () => randomBytes(32)), randomBytes(32)];
  const msg = Buffer.concat([
    Buffer.from(o.versioned ? [0x80] : []), Buffer.from([signers, 0, 1]), Buffer.from([keys.length]), ...keys.map((k) => Buffer.from(k)),
    randomBytes(32), Buffer.from([1, keys.length - 1, 0, 0]), Buffer.from(o.versioned ? [0] : []),
  ]);
  return new Uint8Array(Buffer.concat([Buffer.from([signers]), Buffer.alloc(64 * signers), msg]));
}

export function sigOfBase64(b64: string): string {
  const raw = Buffer.from(b64, 'base64');
  return base58Encode(new Uint8Array(raw.subarray(1, 65)));
}

export function encodeCurve(c: { vTok: bigint; vSol: bigint; rTok: bigint; rSol: bigint; supply: bigint; complete?: boolean; creator?: Uint8Array }): Buffer {
  const b = Buffer.alloc(81);
  b.writeBigUInt64LE(c.vTok, 8); b.writeBigUInt64LE(c.vSol, 16); b.writeBigUInt64LE(c.rTok, 24); b.writeBigUInt64LE(c.rSol, 32); b.writeBigUInt64LE(c.supply, 40);
  b[48] = c.complete ? 1 : 0;
  if (c.creator) Buffer.from(c.creator).copy(b, 49);
  return b;
}
/** Curve with `realSol` lamports of real SOL on a standard pump.fun launch (30 SOL virtual, 1.073B virtual tokens). */
export function curveAt(realSol: bigint, complete = false): Buffer {
  const k = 30_000_000_000n * 1_073_000_000_000_000n;
  const vSol = 30_000_000_000n + realSol;
  const vTok = k / vSol;
  return encodeCurve({ vTok, vSol, rTok: 793_100_000_000_000n - (1_073_000_000_000_000n - vTok), rSol: realSol, supply: 1_000_000_000_000_000n, complete });
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

export class FakeRpc implements RpcLike {
  calls: Array<[string, unknown[]]> = [];
  lamports = 1_000_000_000n;
  walletAddress = '';
  balances = new Map<string, bigint>(); // `${owner}|${mint}`
  tokenAccountAddr = new Map<string, string>();
  acctExists = new Set<string>();
  curves = new Map<string, () => Buffer>();
  mints = new Map<string, { mintAuthority: string | null; freezeAuthority: string | null; decimals: number; supply: string }>();
  largest = new Map<string, Array<{ address: string; amount: string }>>();
  owners = new Map<string, string>();
  sigHistory = new Map<string, Array<{ blockTime: number | null; err: unknown }>>();
  sigStatus = new Map<string, { confirmationStatus: string; err: unknown }>();
  txMeta = new Map<string, { delta: number; fee: number }>();
  sent: string[] = [];
  sendMode: 'ok' | 'reject' | 'ambiguous' = 'ok';
  onSend?: (sig: string) => void;
  throwOn = new Map<string, Error>();

  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push([method, params]);
    const boom = this.throwOn.get(method);
    if (boom) throw boom;
    const p = params as any[];
    switch (method) {
      case 'getBalance':
        return { value: Number(this.lamports) } as T;
      case 'getTokenAccountsByOwner': {
        const key = `${p[0]}|${p[1].mint}`;
        const raw = this.balances.get(key) ?? 0n;
        if (raw === 0n && !this.acctExists.has(key)) return { value: [] } as T;
        if (!this.tokenAccountAddr.has(key)) this.tokenAccountAddr.set(key, randAddr());
        return { value: [{ pubkey: this.tokenAccountAddr.get(key), account: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { info: { tokenAmount: { amount: raw.toString(), decimals: 6 } } } } } }] } as T;
      }
      case 'getSignatureStatuses':
        return { value: [this.sigStatus.get(p[0][0]) ?? null] } as T;
      case 'getTransaction': {
        const m = this.txMeta.get(p[0]);
        if (!m) return null as T;
        return { meta: { err: null, fee: m.fee, preBalances: [1_000_000_000], postBalances: [1_000_000_000 + m.delta] }, transaction: { message: { accountKeys: [{ pubkey: this.walletAddress }] } } } as T;
      }
      case 'sendTransaction': {
        if (this.sendMode === 'reject') throw new RpcError('Transaction simulation failed: insufficient funds', -32002, false);
        const sig = sigOfBase64(p[0]);
        this.sent.push(sig);
        if (this.sendMode === 'ambiguous') throw new RpcError('fetch failed', undefined, true);
        this.onSend?.(sig);
        return sig as T;
      }
      case 'getLatestBlockhash':
        return { value: { blockhash: base58Encode(randomBytes(32)) } } as T;
      case 'getAccountInfo': {
        const addr = p[0] as string;
        const cf = this.curves.get(addr);
        if (cf) return { value: { data: [cf().toString('base64'), 'base64'] } } as T;
        const m = this.mints.get(addr);
        if (m) return { value: { data: { parsed: { type: 'mint', info: m } } } } as T;
        return { value: null } as T;
      }
      case 'getTokenLargestAccounts':
        return { value: this.largest.get(p[0]) ?? [] } as T;
      case 'getMultipleAccounts':
        return { value: (p[0] as string[]).map((a) => ({ data: { parsed: { info: { owner: this.owners.get(a) ?? 'unknown' } } } })) } as T;
      case 'getSignaturesForAddress':
        return (this.sigHistory.get(p[0]) ?? []) as T;
    }
    throw new Error(`FakeRpc: unhandled ${method}`);
  }
  /** Standard success effect for a buy/sell: update balances, mark confirmed, record tx deltas. */
  confirm(sig: string, delta: number, fee = 5000): void {
    this.sigStatus.set(sig, { confirmationStatus: 'confirmed', err: null });
    this.txMeta.set(sig, { delta, fee });
  }
}

export class FakePortal implements PortalClient {
  calls: PortalTradeParams[] = [];
  failNext = 0;
  constructor(private readonly wallet: Wallet) {}
  async buildTrade(p: PortalTradeParams): Promise<Uint8Array> {
    this.calls.push(p);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('PumpPortal 400: bad request');
    }
    return buildTx(this.wallet.publicKey, { versioned: true });
  }
}

export class FakeJupiter implements JupiterLike {
  quotes = 0;
  swaps = 0;
  solUsd = 150;
  sellOut = 20_000_000n;
  constructor(private readonly wallet: Wallet) {}
  async quote(inputMint: string, outputMint: string, amount: bigint): Promise<JupQuote> {
    this.quotes++;
    if (inputMint === WSOL_MINT && outputMint === USDC_MINT) return { inAmount: amount.toString(), outAmount: String(Math.round(this.solUsd * 1e6)), priceImpactPct: '0' };
    return { inAmount: amount.toString(), outAmount: this.sellOut.toString(), priceImpactPct: '0.1' };
  }
  async swapTx(): Promise<Uint8Array> {
    this.swaps++;
    return buildTx(this.wallet.publicKey, { versioned: true });
  }
}
