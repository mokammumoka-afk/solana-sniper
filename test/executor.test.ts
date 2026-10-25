import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/config.js';
import { Executor, type OpenArgs } from '../src/trading/executor.js';
import { FakeJupiter, FakePortal, FakeRpc, curveAt, freshDb, makeWallet, randAddr, closeAllFakeServers } from './helpers.js';
import type { Db } from '../src/db.js';

after(closeAllFakeServers);

const SIZE = 26_666_667n;
async function setup(over: Partial<typeof DEFAULT_SETTINGS> = {}, dbArg?: Db, wallet = makeWallet()) {
  const db = dbArg ?? (await freshDb()).db;
  const rpc = new FakeRpc();
  rpc.walletAddress = wallet.address;
  const portal = new FakePortal(wallet);
  const jup = new FakeJupiter(wallet);
  const settings = { ...DEFAULT_SETTINGS, ...over };
  const critical: string[] = [];
  let clock = Date.now();
  const mk = (r = rpc, d = db) => new Executor({ db: d, rpc: r, wallet, portal, jupiter: jup, getSettings: () => settings, onCritical: (x) => critical.push(x), sleep: async () => void (clock += 1000), now: () => clock });
  const ex = mk();
  const mint = randAddr();
  const curveAddr = randAddr();
  rpc.curves.set(curveAddr, () => curveAt(5_000_000_000n));
  const args = (mode: 'live' | 'paper' = 'live'): OpenArgs => ({ mint, symbol: 'DOGE', pool: 'pump', creator: null, curveAddr, sizeLamports: SIZE, mode });
  const key = `${wallet.address}|${mint}`;
  const tokens = (n: bigint) => { rpc.balances.set(key, n); rpc.acctExists.add(key); };
  return { db, wallet, rpc, portal, jup, ex, mint, curveAddr, args, tokens, key, critical, settings, mk, advance: (ms: number) => void (clock += ms) };
}
const buyOk = (s: Awaited<ReturnType<typeof setup>>, tokens = 900_000_000_000n, delta = -29_000_000) => {
  s.rpc.onSend = (sig) => { s.rpc.confirm(sig, delta); s.tokens(tokens); };
};

test('live buy: signature is stored BEFORE sending, tokens and cost are verified from chain', async () => {
  const s = await setup();
  let seen: { state: string; signature: string | null } | undefined;
  s.rpc.onSend = (sig) => {
    s.db.listOrders(0, 1).then((os) => { seen = { state: os[0].state, signature: os[0].signature }; });
    s.rpc.confirm(sig, -29_000_000); s.tokens(900_000_000_000n);
  };
  const r = await s.ex.openPosition(s.args());
  assert.ok(r.ok);
  assert.equal(seen?.state, 'submitted');
  assert.equal(seen?.signature, s.rpc.sent[0]);
  const p = (await s.db.getPosition(1))!;
  assert.equal(p.state, 'open');
  assert.equal(p.token_raw, '900000000000');
  assert.equal(p.cost_lamports, 29_000_000);
  assert.equal(p.rent_lamports, 2_039_280, 'new token account rent tracked separately');
  assert.ok(p.entry_price > 0);
  assert.equal(p.buy_sig, s.rpc.sent[0]);
  const call = s.portal.calls[0];
  assert.deepEqual([call.action, call.denominatedInSol, call.pool, call.slippage], ['buy', true, 'pump', 15]);
});

test('a sent transaction is NOT a success: rejected by RPC => position failed, no tokens assumed', async () => {
  const s = await setup();
  s.rpc.sendMode = 'reject';
  const r = await s.ex.openPosition(s.args());
  assert.equal(r.ok, false);
  assert.match((r as any).error, /rejected by RPC/);
  assert.equal((await s.db.getPosition(1))!.state, 'failed');
  assert.equal((await s.db.listOrders(0, 1))[0].state, 'failed');
});

test('on-chain failure (tx error) => failed; portal error => failed without ever sending', async () => {
  const s = await setup();
  s.rpc.onSend = (sig) => s.rpc.sigStatus.set(sig, { confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } });
  const r = await s.ex.openPosition(s.args());
  assert.match((r as any).error, /transaction error/);
  const s2 = await setup();
  s2.portal.failNext = 1;
  const r2 = await s2.ex.openPosition(s2.args());
  assert.equal(r2.ok, false);
  assert.equal(s2.rpc.sent.length, 0);
  assert.equal((await s2.db.getPosition(1))!.state, 'failed');
});

test('duplicate protection: concurrent and sequential buys of the same mint send exactly one transaction', async () => {
  const s = await setup();
  buyOk(s);
  const [a, b] = await Promise.all([s.ex.openPosition(s.args()), s.ex.openPosition(s.args())]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  assert.match(((a.ok ? b : a) as any).error, /duplicate/);
  const again = await s.ex.openPosition(s.args());
  assert.match((again as any).error, /duplicate/);
  assert.equal(s.rpc.sent.length, 1);
});

test('confirmation timeout: position stays pending, nothing is re-sent, reconcile settles it later', async () => {
  const s = await setup();
  const r = await s.ex.openPosition(s.args());
  assert.equal(r.ok, false);
  assert.equal((r as any).pending, true);
  assert.equal((await s.db.getPosition(1))!.state, 'opening');
  assert.equal((await s.db.listOrders(0, 1))[0].state, 'unknown');
  assert.match(((await s.ex.openPosition(s.args())) as any).error, /duplicate/);
  // the late confirmation arrives
  s.rpc.confirm(s.rpc.sent[0], -29_000_000); s.tokens(900_000_000_000n);
  await s.ex.reconcile();
  assert.equal((await s.db.getPosition(1))!.state, 'open');
  assert.equal(s.rpc.sent.length, 1);
});

test('confirmed buy but no tokens in wallet => failed + critical alert', async () => {
  const s = await setup();
  s.rpc.onSend = (sig) => s.rpc.confirm(sig, -29_000_000);
  await s.ex.openPosition(s.args());
  assert.equal((await s.db.getPosition(1))!.state, 'failed');
  assert.equal(s.critical.length, 1);
});

test('insufficient balance at execution time aborts before signing', async () => {
  const s = await setup();
  s.rpc.lamports = 10_000_000n;
  const r = await s.ex.openPosition(s.args());
  assert.match((r as any).error, /insufficient balance/);
  assert.equal(s.rpc.sent.length, 0);
  assert.equal(s.portal.calls.length, 0);
});

test('live sell: verifies proceeds from chain, then reclaims the token-account rent into PnL', async () => {
  const s = await setup();
  buyOk(s);
  await s.ex.openPosition(s.args());
  const queue: Array<(sig: string) => void> = [
    (sig) => { s.rpc.confirm(sig, 30_000_000); s.tokens(0n); },
    (sig) => s.rpc.confirm(sig, 2_034_280),
  ];
  s.rpc.onSend = (sig) => queue.shift()!(sig);
  const r = await s.ex.closePosition(1, 'take_profit');
  assert.ok(r.ok);
  const p = (await s.db.getPosition(1))!;
  assert.equal(p.state, 'closed');
  assert.equal(p.exit_reason, 'take_profit');
  assert.equal(p.proceeds_lamports, 32_034_280);
  assert.equal(p.note, 'ata_closed');
  assert.deepEqual((await s.db.listOrders(0, 1)).map((o) => o.route).sort(), ['close_account', 'portal', 'portal']);
  const sell = s.portal.calls[1];
  assert.deepEqual([sell.action, sell.amount, sell.denominatedInSol, sell.pool], ['sell', '100%', false, 'auto']);
  assert.equal(await s.db.realizedLamports('live'), 32_034_280 - 29_000_000);
});

test('failed sells retry with higher slippage, then fall back to Jupiter; one success closes it', async () => {
  const s = await setup();
  buyOk(s);
  await s.ex.openPosition(s.args());
  const fail = (sig: string) => s.rpc.sigStatus.set(sig, { confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } });
  const queue = [fail, fail, (sig: string) => { s.rpc.confirm(sig, 25_000_000); s.tokens(0n); }, (sig: string) => s.rpc.confirm(sig, 2_000_000)];
  s.rpc.onSend = (sig) => queue.shift()!(sig);
  assert.equal((await s.ex.closePosition(1, 'stop_loss')).ok, false);
  assert.equal((await s.ex.closePosition(1, 'stop_loss')).ok, false);
  assert.equal((await s.ex.closePosition(1, 'stop_loss')).ok, true);
  const sells = (await s.db.listOrders(0, 1)).filter((o) => o.side === 'sell' && o.route !== 'close_account').reverse();
  assert.deepEqual(sells.map((o) => [o.route, o.slippage_pct, o.state]), [['portal', 25, 'failed'], ['portal', 37.5, 'failed'], ['jupiter', 50, 'confirmed']]);
  assert.equal(s.jup.swaps, 1);
  assert.equal((await s.db.getPosition(1))!.state, 'closed');
});

test('a sell with unknown outcome is never duplicated; it is settled once the chain answers', async () => {
  const s = await setup();
  buyOk(s);
  await s.ex.openPosition(s.args());
  s.rpc.onSend = undefined;
  const sentBefore = s.rpc.sent.length;
  const r1 = await s.ex.closePosition(1, 'take_profit');
  assert.equal(r1.pending, true);
  const r2 = await s.ex.closePosition(1, 'take_profit');
  assert.equal(r2.pending, true);
  assert.equal(s.rpc.sent.length, sentBefore + 1, 'exactly one sell transaction was ever sent');
  s.rpc.confirm(s.rpc.sent[sentBefore], 30_000_000); s.tokens(0n);
  s.rpc.onSend = (sig) => s.rpc.confirm(sig, 2_000_000);
  const r3 = await s.ex.closePosition(1, 'take_profit');
  assert.ok(r3.ok);
  assert.equal((await s.db.getPosition(1))!.state, 'closed');
  assert.equal((await s.db.listOrders(0, 1)).filter((o) => o.route === 'portal' && o.side === 'sell').length, 1);
});

test('exhausted sell attempts mark the position stuck and raise a critical alert', async () => {
  const s = await setup({ maxSellAttempts: 2 });
  buyOk(s);
  await s.ex.openPosition(s.args());
  s.rpc.onSend = (sig) => s.rpc.sigStatus.set(sig, { confirmationStatus: 'confirmed', err: { InstructionError: [0, 'X'] } });
  await s.ex.closePosition(1, 'stop_loss'); await s.ex.closePosition(1, 'stop_loss');
  const r = await s.ex.closePosition(1, 'stop_loss');
  assert.equal(r.ok, false);
  assert.equal((await s.db.getPosition(1))!.state, 'stuck');
  assert.equal(s.critical.length, 1);
});

test('tokens gone from the wallet without a recorded sell => closed with a critical alert (never silently ignored)', async () => {
  const s = await setup();
  buyOk(s);
  await s.ex.openPosition(s.args());
  s.tokens(0n);
  const r = await s.ex.closePosition(1, 'manual');
  assert.ok(r.ok);
  assert.equal((await s.db.getPosition(1))!.state, 'closed');
  assert.equal(s.critical.length, 1);
});

test('paper mode uses real curve data, charges modeled fees and never touches the chain', async () => {
  const s = await setup();
  const r = await s.ex.openPosition(s.args('paper'));
  assert.ok(r.ok);
  const p = (await s.db.getPosition(1))!;
  assert.equal(p.mode, 'paper');
  assert.ok(p.cost_lamports > Number(SIZE), 'cost includes fees');
  const sell = await s.ex.closePosition(1, 'take_profit');
  assert.ok(sell.ok);
  const c = (await s.db.getPosition(1))!;
  assert.ok(c.proceeds_lamports < c.cost_lamports, 'flat price round trip loses fees');
  assert.equal(s.rpc.calls.filter(([m]) => m === 'sendTransaction').length, 0);
  assert.equal(await s.db.realizedLamports('live'), 0);
  assert.ok((await s.db.realizedLamports('paper')) < 0);
});

test('restart recovery: open positions persist; pending buys are reconciled; crashes before submit are cleaned up', async () => {
  // Two separate Db client instances pointed at the SAME backend, exactly like two runs of the bot process
  // both talking to the same Supabase project — this is what "survives a restart" means once state lives
  // in an external database rather than a local file.
  const wallet = makeWallet();
  const { db, url } = await freshDb();
  const s = await setup({}, db, wallet);
  buyOk(s);
  await s.ex.openPosition(s.args());
  // second token: buy sent, confirmation unknown
  const mint2 = randAddr();
  s.rpc.onSend = undefined;
  const a2 = { ...s.args(), mint: mint2, symbol: 'PEPE' };
  const pend = await s.ex.openPosition(a2);
  assert.equal((pend as any).pending, true);
  // third: crashed between insert and submit
  await s.db.insertPosition({ mint: randAddr(), symbol: 'CRASH', mode: 'live', pool: 'pump' });
  s.db.close();

  const { db: db2 } = await freshDb(url);
  const ex2 = s.mk(s.rpc, db2);
  assert.equal((await db2.activePositions('live')).filter((p) => p.state === 'open').length, 1, 'open position survived restart');
  s.rpc.confirm(s.rpc.sent[1], -29_000_000);
  s.rpc.balances.set(`${wallet.address}|${mint2}`, 500_000_000_000n);
  await ex2.reconcile();
  const rows = await db2.listPositions();
  assert.deepEqual(rows.map((p) => [p.symbol, p.state]).sort(), [['CRASH', 'failed'], ['DOGE', 'open'], ['PEPE', 'open']]);
  const q = await ex2.quoteExit((await db2.getPosition(1))!);
  assert.ok(q.netLamports > 0n && q.source === 'curve');
});
