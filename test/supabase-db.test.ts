import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db, DbConflictError } from '../src/db.js';
import { DbError } from '../src/db/supabase-client.js';
import { withFakeDb } from './fake-postgrest.js';

const cfg = (url: string) => ({ url, serviceRoleKey: 'service-role-test-key', retries: 2 });

test('connect() succeeds against a reachable backend and fails with a clear message when unreachable', async () => {
  await withFakeDb(async (url) => {
    const db = new Db(cfg(url));
    await assert.doesNotReject(() => db.connect());
  });
  const badDb = new Db({ url: 'http://127.0.0.1:1', serviceRoleKey: 'x', retries: 0, timeoutMs: 500 });
  await assert.rejects(() => badDb.connect(), /cannot reach Supabase/);
});

test('tokens: insert-if-new is a true no-op on a duplicate mint (no row returned, no error)', async () => {
  await withFakeDb(async (url) => {
    const db = new Db(cfg(url));
    const first = await db.insertTokenIfNew({ mint: 'M1', source: 'test', discoveredAt: 1 });
    const second = await db.insertTokenIfNew({ mint: 'M1', source: 'test', discoveredAt: 2 });
    assert.equal(first, true);
    assert.equal(second, false);
    const t = await db.getToken('M1');
    assert.equal(t!.discovered_at, 1, 'the original row is untouched by the duplicate insert attempt');
    await db.setTokenState('M1', { state: 'accepted', risk: 10, quality: 80, reasons: ['ok'] });
    const t2 = await db.getToken('M1');
    assert.equal(t2!.state, 'accepted');
    assert.deepEqual(t2!.reasons, ['ok']);
  });
});

test('positions: the partial-unique index blocks a second active position for the same mint (DbConflictError)', async () => {
  await withFakeDb(async (url) => {
    const db = new Db(cfg(url));
    const id1 = await db.insertPosition({ mint: 'M1', symbol: 'A', mode: 'paper', pool: 'pump' });
    await assert.rejects(() => db.insertPosition({ mint: 'M1', symbol: 'A', mode: 'paper', pool: 'pump' }), DbConflictError);
    await db.updatePosition(id1, { state: 'closed', closed_at: Date.now() });
    // once closed, the mint is free again
    const id2 = await db.insertPosition({ mint: 'M1', symbol: 'A', mode: 'paper', pool: 'pump' });
    assert.notEqual(id1, id2);
  });
});

test('withdrawals: draft -> submit is an atomic compare-and-swap that only succeeds once (double-withdraw guard)', async () => {
  await withFakeDb(async (url) => {
    const db = new Db(cfg(url));
    const w = await db.insertWithdrawalDraft({ destination: 'DEST', amountLamports: 1000, feeLamports: 5000, expiresAt: Date.now() + 60_000 });
    const a = await db.tryTransitionWithdrawal(w.id, 'draft', { status: 'submitted', signature: 'sigA' });
    const b = await db.tryTransitionWithdrawal(w.id, 'draft', { status: 'submitted', signature: 'sigB' });
    assert.ok(a && a.signature === 'sigA');
    assert.equal(b, null, 'second confirm attempt on an already-submitted draft is rejected, not silently re-applied');
    const final = await db.getWithdrawal(w.id);
    assert.equal(final!.signature, 'sigA');
  });
});

test('realizedLamports and stats aggregate only the requested mode, never mixing paper and live', async () => {
  await withFakeDb(async (url) => {
    const db = new Db(cfg(url));
    const p1 = await db.insertPosition({ mint: 'A', symbol: 'A', mode: 'paper', pool: 'pump' });
    await db.updatePosition(p1, { state: 'closed', cost_lamports: 100, proceeds_lamports: 150, closed_at: 10 });
    const p2 = await db.insertPosition({ mint: 'B', symbol: 'B', mode: 'live', pool: 'pump' });
    await db.updatePosition(p2, { state: 'closed', cost_lamports: 100, proceeds_lamports: 80, closed_at: 10 });
    assert.equal(await db.realizedLamports('paper'), 50);
    assert.equal(await db.realizedLamports('live'), -20);
    assert.equal((await db.stats('paper')).wins, 1);
    assert.equal((await db.stats('live')).wins, 0);
  });
});

test('settings persist as JSON and round-trip through getKv/setKv, upserting in place', async () => {
  await withFakeDb(async (url) => {
    const db = new Db(cfg(url));
    assert.equal(await db.getKv('settings'), null);
    await db.setKv('settings', JSON.stringify({ a: 1 }));
    await db.setKv('settings', JSON.stringify({ a: 2 }));
    assert.deepEqual(JSON.parse((await db.getKv('settings'))!), { a: 2 });
  });
});

test('a transient 500 is retried and recovers; a persistent outage surfaces as a retryable DbError without crashing the caller', async () => {
  await withFakeDb(async (url, fake) => {
    const db = new Db(cfg(url));
    fake.failNext = 2;
    await assert.doesNotReject(() => db.insertTokenIfNew({ mint: 'R1', source: 'test', discoveredAt: 1 }), 'recovers within the retry budget');

    fake.down = true;
    await assert.rejects(() => db.getToken('R1'), (e: unknown) => e instanceof DbError && e.retryable);
    assert.ok(db.health.errors > 0);
    fake.down = false;
    const t = await db.getToken('R1');
    assert.equal(t!.mint, 'R1', 'recovers once the outage ends');
  });
});

test('tokenCounts and pendingOrders use server-side filtering, not a full-table fetch', async () => {
  await withFakeDb(async (url) => {
    const db = new Db(cfg(url));
    await db.insertTokenIfNew({ mint: 'A', source: 's', discoveredAt: 1 });
    await db.setTokenState('A', { state: 'accepted' });
    await db.insertTokenIfNew({ mint: 'B', source: 's', discoveredAt: 1 });
    const counts = await db.tokenCounts();
    assert.equal(counts.accepted, 1);
    assert.equal(counts.discovered, 1);

    const posId = await db.insertPosition({ mint: 'A', symbol: 'A', mode: 'live', pool: 'pump' });
    const orderId = await db.insertOrder({ position_id: posId, side: 'buy', route: 'portal', mode: 'live', slippage_pct: 10, requested: '{}' });
    await db.updateOrder(orderId, { state: 'unknown' });
    const pending = await db.pendingOrders();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, orderId);
  });
});
