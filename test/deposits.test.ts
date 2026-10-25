import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentDeposits } from '../src/trading/deposits.js';
import { FakeRpc, randAddr } from './helpers.js';

function wireTx(rpc: FakeRpc, sig: string, address: string, deltaLamports: number, blockTime: number, err: unknown = null) {
  const hist = rpc.sigHistory.get(address) ?? [];
  hist.push({ blockTime, err });
  rpc.sigHistory.set(address, hist);
  rpc.txMeta.set(sig, { delta: deltaLamports, fee: 0 });
  // getSignaturesForAddress in FakeRpc ignores signature strings themselves, so patch getTransaction lookup directly:
  (rpc as any)._sigList = (rpc as any)._sigList ?? new Map<string, any[]>();
  const list = (rpc as any)._sigList.get(address) ?? [];
  list.push({ signature: sig, blockTime, err });
  (rpc as any)._sigList.set(address, list);
}

/** FakeRpc's getSignaturesForAddress only returns blockTime/err (no signature field) by default, since
 *  nothing in the trading code needed it before. deposits.ts needs real signature strings, so this test
 *  uses a small local RPC shim instead of extending the shared fake for one consumer. */
class DepositRpc {
  calls: Array<[string, unknown[]]> = [];
  sigs: Array<{ signature: string; blockTime: number | null; err: unknown }> = [];
  txs = new Map<string, { meta: { err: unknown; preBalances: number[]; postBalances: number[] } | null; transaction: { message: { accountKeys: string[] } } }>();
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push([method, params]);
    if (method === 'getSignaturesForAddress') return this.sigs as T;
    if (method === 'getTransaction') return (this.txs.get(params[0] as string) ?? null) as T;
    throw new Error(`unexpected ${method}`);
  }
  addIncoming(address: string, signature: string, lamports: number, blockTime: number) {
    this.sigs.unshift({ signature, blockTime, err: null });
    this.txs.set(signature, { meta: { err: null, preBalances: [1_000_000_000], postBalances: [1_000_000_000 + lamports] }, transaction: { message: { accountKeys: [address] } } });
  }
  addOutgoing(address: string, signature: string, lamports: number, blockTime: number) {
    this.sigs.unshift({ signature, blockTime, err: null });
    this.txs.set(signature, { meta: { err: null, preBalances: [1_000_000_000], postBalances: [1_000_000_000 - lamports] }, transaction: { message: { accountKeys: [address] } } });
  }
  addFailed(address: string, signature: string, blockTime: number) {
    this.sigs.unshift({ signature, blockTime, err: { InstructionError: [0, 'x'] } });
  }
}

test('recentDeposits reports only incoming SOL transfers, in order, with the right amount', async () => {
  const rpc = new DepositRpc();
  const addr = randAddr();
  rpc.addIncoming(addr, 'sig1', 50_000_000, 100);
  rpc.addOutgoing(addr, 'sig2', 10_000_000, 200); // our own buy/sell/withdrawal — must be excluded
  rpc.addIncoming(addr, 'sig3', 25_000_000, 300);
  const deposits = await recentDeposits(rpc as any, addr, 10);
  assert.equal(deposits.length, 2);
  assert.deepEqual(deposits.map((d) => d.signature), ['sig3', 'sig1']);
  assert.ok(Math.abs(deposits[0].amountSol - 0.025) < 1e-9);
  assert.ok(Math.abs(deposits[1].amountSol - 0.05) < 1e-9);
});

test('recentDeposits skips failed transactions and respects the limit', async () => {
  const rpc = new DepositRpc();
  const addr = randAddr();
  rpc.addFailed(addr, 'bad', 50);
  for (let i = 0; i < 5; i++) rpc.addIncoming(addr, `ok${i}`, 1_000_000 * (i + 1), 100 + i);
  const deposits = await recentDeposits(rpc as any, addr, 3);
  assert.equal(deposits.length, 3);
  assert.ok(deposits.every((d) => d.signature !== 'bad'));
});

test('recentDeposits returns an empty list rather than throwing when the wallet has no history', async () => {
  const rpc = new DepositRpc();
  const deposits = await recentDeposits(rpc as any, randAddr(), 10);
  assert.deepEqual(deposits, []);
});

test('recentDeposits is resilient to a single bad transaction lookup (skips it, keeps the rest)', async () => {
  const rpc = new DepositRpc();
  const addr = randAddr();
  rpc.addIncoming(addr, 'good1', 1_000_000, 10);
  rpc.sigs.unshift({ signature: 'missing-tx', blockTime: 20, err: null }); // getTransaction will return null for this one
  rpc.addIncoming(addr, 'good2', 2_000_000, 30);
  const deposits = await recentDeposits(rpc as any, addr, 10);
  assert.deepEqual(deposits.map((d) => d.signature).sort(), ['good1', 'good2']);
});
