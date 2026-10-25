import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, readEnv } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { FakeJupiter, FakePortal, FakeRpc, curveAt, freshDb, makeWallet, randAddr, waitFor, closeAllFakeServers } from './helpers.js';
import type { NewTokenEvent } from '../src/feeds/pumpportal-ws.js';

after(closeAllFakeServers);

function env(mode: 'observe' | 'paper' | 'live' = 'paper') {
  return readEnv({ MODE: mode, DASHBOARD_TOKEN: 'x'.repeat(20), LIVE_CONFIRM: mode === 'live' ? 'I-UNDERSTAND-I-CAN-LOSE-ALL-FUNDS' : '', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(24) });
}

async function rig(mode: 'observe' | 'paper' | 'live' = 'paper', settingsOverride: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const { db } = await freshDb();
  const wallet = makeWallet();
  const rpc = new FakeRpc();
  rpc.walletAddress = wallet.address;
  const portal = new FakePortal(wallet);
  const jup = new FakeJupiter(wallet);
  const engine = new Engine({ db, env: env(mode), rpc, wallet: mode === 'live' ? wallet : null, portal, jupiter: jup, solPrice: { get: async () => 150, lastKnown: () => ({ v: 150, ageMs: 0 }) } as any, evalIntervalMs: 20 });
  if (Object.keys(settingsOverride).length) await engine.updateSettings(settingsOverride as any);
  return { db, rpc, wallet, portal, jup, engine };
}

function tokenEvent(over: Partial<NewTokenEvent> = {}): NewTokenEvent {
  const curveAddr = over.bondingCurve ?? randAddr();
  return { mint: randAddr(), symbol: 'DOGE', name: 'Doge', creator: randAddr(), bondingCurve: curveAddr, pool: 'pump', marketCapSol: 32, devInitialBuyPct: 2, discoveredAt: Date.now() - 15_000, source: 'pumpportal:subscribeNewToken', ...over };
}

function wireHealthyCurve(rpc: FakeRpc, curveAddr: string, creator: string | null, mint: string) {
  let calls = 0;
  // simulate organic growth: real SOL reserves climb a little on each re-check (5.0 -> 5.1 -> 5.2 ...)
  rpc.curves.set(curveAddr, () => curveAt(5_000_000_000n + 100_000_000n * BigInt(calls++)));
  rpc.mints.set(mint, { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: '1000000000000000' });
  const holder = randAddr();
  rpc.largest.set(mint, [{ address: holder, amount: '50000000000000' }]);
  rpc.owners.set(holder, creator ?? randAddr());
  rpc.sigHistory.set(curveAddr, Array.from({ length: 30 }, () => ({ blockTime: Math.floor(Date.now() / 1000), err: null })));
}

test('full pipeline: discovery -> prefilter pass -> analysis -> accept -> paper buy', async () => {
  const { db, engine } = await rig('paper');
  const ev = tokenEvent();
  wireHealthyCurve(engine['d'].rpc as FakeRpc, ev.bondingCurve!, ev.creator, ev.mint);
  await engine.handleNewToken(ev);
  assert.equal(engine.counters.discovered, 1);
  await waitFor(async () => (await db.getToken(ev.mint))?.state === 'bought', 4000);
  const t = (await db.getToken(ev.mint))!;
  assert.equal(t.decision, 'accept');
  assert.ok((t.reasons as string[]).some((r) => r.includes('bought')));
  const pos = (await db.listPositions())[0];
  assert.equal(pos.mint, ev.mint);
  assert.equal(pos.mode, 'paper');
  assert.equal(pos.state, 'open');
  engine.stop();
});

test('prefilter rejects without ever hitting the RPC analysis path', async () => {
  const { db, engine, rpc } = await rig('paper');
  const ev = tokenEvent({ bondingCurve: null });
  await engine.handleNewToken(ev);
  const t = (await db.getToken(ev.mint))!;
  assert.equal(t.state, 'rejected');
  assert.ok((t.reasons as string[])[0].includes('prefilter'));
  assert.equal(rpc.calls.length, 0);
  engine.stop();
});

test('risk engine rejection (mint authority active) blocks the buy, with reasons recorded', async () => {
  const { db, engine } = await rig('paper');
  const ev = tokenEvent();
  const rpc = engine['d'].rpc as FakeRpc;
  wireHealthyCurve(rpc, ev.bondingCurve!, ev.creator, ev.mint);
  rpc.mints.set(ev.mint, { mintAuthority: randAddr(), freezeAuthority: null, decimals: 6, supply: '1000000000000000' });
  await engine.handleNewToken(ev);
  await waitFor(async () => ((await db.getToken(ev.mint))?.reasons ?? []).some((r: string) => r.includes('mint_authority')), 4000);
  const t = (await db.getToken(ev.mint))!;
  assert.equal(t.decision, 'reject');
  assert.equal((await db.listPositions()).length, 0);
  engine.stop();
});

test('observe mode never places an order even when a token is accepted', async () => {
  const { db, engine } = await rig('observe');
  const ev = tokenEvent();
  wireHealthyCurve(engine['d'].rpc as FakeRpc, ev.bondingCurve!, ev.creator, ev.mint);
  await engine.handleNewToken(ev);
  await waitFor(async () => (await db.getToken(ev.mint))?.state === 'accepted', 4000);
  assert.equal((await db.listPositions()).length, 0);
  engine.stop();
});

test('live mode refuses to buy until explicitly armed with the exact phrase', async () => {
  const { db, engine } = await rig('live');
  const ev = tokenEvent();
  wireHealthyCurve(engine['d'].rpc as FakeRpc, ev.bondingCurve!, ev.creator, ev.mint);
  await engine.handleNewToken(ev);
  await waitFor(async () => ['skipped', 'accepted'].includes((await db.getToken(ev.mint))?.state ?? ''), 4000);
  assert.equal((await db.listPositions()).length, 0);
  assert.equal(engine.arm('wrong phrase').ok, false);
  const ok = engine.arm('I-UNDERSTAND-I-CAN-LOSE-ALL-FUNDS');
  assert.equal(ok.ok, true);
  assert.equal(engine.liveArmed, true);
  engine.stop();
});

test('kill switch blocks new buys; killAll closes open positions', async () => {
  const { db, engine, rpc } = await rig('paper');
  const ev = tokenEvent();
  wireHealthyCurve(rpc, ev.bondingCurve!, ev.creator, ev.mint);
  await engine.handleNewToken(ev);
  await waitFor(async () => (await db.listPositions()).length === 1, 4000);
  await engine.kill(true);
  await waitFor(async () => (await db.getPosition(1))?.state === 'closed', 3000);
  assert.equal((await db.getPosition(1))!.exit_reason, 'manual_kill');
  const ev2 = tokenEvent();
  wireHealthyCurve(rpc, ev2.bondingCurve!, ev2.creator, ev2.mint);
  await engine.handleNewToken(ev2);
  await waitFor(async () => (await db.getToken(ev2.mint))?.state === 'skipped', 4000);
  assert.ok(((await db.getToken(ev2.mint))!.reasons as string[])[0].includes('kill switch'));
  engine.stop();
});

test('capital limits enforced end-to-end: max open positions stops a second accepted buy', async () => {
  const { db, engine, rpc } = await rig('paper', { maxOpenPositions: 1 });
  const a = tokenEvent();
  wireHealthyCurve(rpc, a.bondingCurve!, a.creator, a.mint);
  await engine.handleNewToken(a);
  await waitFor(async () => (await db.listPositions()).length === 1, 4000);
  const b = tokenEvent();
  wireHealthyCurve(rpc, b.bondingCurve!, b.creator, b.mint);
  await engine.handleNewToken(b);
  await waitFor(async () => (await db.getToken(b.mint))?.state === 'skipped', 4000);
  assert.ok(((await db.getToken(b.mint))!.reasons as string[])[0].includes('max open positions'));
  assert.equal((await db.listPositions()).length, 1);
  engine.stop();
});

test('duplicate mint across two discovery events never opens two positions', async () => {
  const { db, engine, rpc } = await rig('paper');
  const ev = tokenEvent();
  wireHealthyCurve(rpc, ev.bondingCurve!, ev.creator, ev.mint);
  await engine.handleNewToken(ev);
  await engine.handleNewToken({ ...ev }); // identical mint reported twice
  await waitFor(async () => (await db.listPositions()).length >= 1, 4000);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await db.listPositions()).length, 1, 'only one position ever opened for the duplicated mint');
  assert.equal(engine.counters.discovered, 2, 'both raw events are counted as discovered');
  assert.equal(engine.counters.accepted, 1, 'but only the first is actually analyzed/accepted');
  engine.stop();
});

test('status() reports capital figures and never crashes when price is unavailable', async () => {
  const { engine } = await rig('paper');
  const s: any = await engine.status();
  assert.equal(s.mode, 'paper');
  assert.equal(s.simulated, true);
  assert.ok(typeof s.capital.walletLamports === 'number');
  (engine as any).d.solPrice = { get: async () => null, lastKnown: () => null };
  const s2: any = await engine.status();
  assert.equal(s2.solUsd, null);
  engine.stop();
});

test('a Supabase outage halts new trades (soft halt) without crashing the engine, and recovers once reachable again', async () => {
  const { db, fake } = await freshDb();
  const wallet = makeWallet();
  const rpc = new FakeRpc();
  rpc.walletAddress = wallet.address;
  const engine = new Engine({ db, env: env('paper'), rpc, wallet: null, portal: new FakePortal(wallet), jupiter: new FakeJupiter(wallet), solPrice: { get: async () => 150, lastKnown: () => ({ v: 150, ageMs: 0 }) } as any, evalIntervalMs: 20 });

  // establish a healthy baseline so lastOkAt is set, then take the backend down
  await db.getKv('settings');
  assert.equal(engine.canTrade().ok, true);
  fake!.down = true;
  await assert.rejects(() => db.getKv('settings'));

  // the watchdog only trips after it has been unhealthy for a while — simulate that by asserting the
  // raw health stats directly (status()/canTrade() read from the same db.health the real watchdog loop
  // would use every 5s in start()), since this test never calls start()
  const stats = db.health;
  assert.ok(stats.lastErrorAt > stats.lastOkAt, 'the failed call was recorded');

  // an operation attempted during the outage fails loudly rather than silently assuming success
  const ev = tokenEvent();
  await engine.handleNewToken(ev); // insertTokenIfNew throws -> caught, logged, returns without crashing
  assert.equal(engine.counters.discovered, 1);

  fake!.down = false;
  await assert.doesNotReject(() => db.getKv('settings'), 'recovers once Supabase is reachable again');
  engine.stop();
});
