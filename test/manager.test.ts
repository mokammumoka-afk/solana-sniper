import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/config.js';
import { Executor } from '../src/trading/executor.js';
import { PositionManager, decideExit, type ExitInput } from '../src/trading/manager.js';
import { FakeJupiter, FakePortal, FakeRpc, curveAt, freshDb, makeWallet, randAddr, closeAllFakeServers } from './helpers.js';

after(closeAllFakeServers);

const st = { ...DEFAULT_SETTINGS };
const base: ExitInput = { pnlPct: 5, peakPnlPct: 5, breachTicks: 0, heldSec: 30, realSol: 10, peakRealSol: 10, creatorDropPct: null };

test('exit rules: immediate triggers', () => {
  assert.equal(decideExit({ ...base, pnlPct: 45 }, st).reason, 'take_profit');
  assert.equal(decideExit({ ...base, pnlPct: -35 }, st).reason, 'hard_stop');
  assert.equal(decideExit({ ...base, creatorDropPct: 80 }, st).reason, 'creator_sell');
  assert.equal(decideExit({ ...base, heldSec: 601 }, st).reason, 'max_hold');
  assert.equal(decideExit(base, st).reason, null);
});

test('exit rules: a single noisy tick never triggers a stop; confirmation over consecutive ticks does', () => {
  const a = decideExit({ ...base, pnlPct: -22 }, st);
  assert.deepEqual(a, { reason: null, breachTicks: 1 });
  assert.equal(decideExit({ ...base, pnlPct: -22, breachTicks: 1 }, st).reason, 'stop_loss');
  assert.deepEqual(decideExit({ ...base, pnlPct: -5, breachTicks: 1 }, st), { reason: null, breachTicks: 0 }, 'recovery resets the counter');
});

test('exit rules: trailing stop only after activation; liquidity drop is confirmed', () => {
  assert.equal(decideExit({ ...base, peakPnlPct: 10, pnlPct: -2, breachTicks: 1 }, st).reason, null, 'not activated below +25% peak');
  assert.equal(decideExit({ ...base, peakPnlPct: 35, pnlPct: 12, breachTicks: 1 }, st).reason, 'trailing_stop');
  assert.equal(decideExit({ ...base, peakPnlPct: 35, pnlPct: 30, breachTicks: 1 }, st).reason, null, 'small pullback tolerated');
  assert.equal(decideExit({ ...base, realSol: 5, peakRealSol: 10, breachTicks: 1 }, st).reason, 'liquidity_drop');
  assert.equal(decideExit({ ...base, realSol: 5, peakRealSol: 10 }, st).reason, null);
});

async function rig() {
  const { db } = await freshDb();
  const wallet = makeWallet();
  const rpc = new FakeRpc();
  const curveAddr = randAddr();
  let real = 5_000_000_000n;
  rpc.curves.set(curveAddr, () => curveAt(real));
  let clock = Date.now();
  const ex = new Executor({ db, rpc, wallet, portal: new FakePortal(wallet), jupiter: new FakeJupiter(wallet), getSettings: () => st, onCritical: () => {}, sleep: async () => {}, now: () => clock });
  const mgr = new PositionManager({ db, executor: ex, rpc, getSettings: () => st, now: () => clock });
  return { db, rpc, ex, mgr, curveAddr, setReal: (v: bigint) => (real = v), tick: (ms = 2000) => { clock += ms; return mgr.tick(); }, advance: (ms: number) => (clock += ms) };
}
const open = (r: Awaited<ReturnType<typeof rig>>) => r.ex.openPosition({ mint: randAddr(), symbol: 'T', pool: 'pump', creator: null, curveAddr: r.curveAddr, sizeLamports: 26_666_667n, mode: 'paper' });

test('manager: take profit sells at once; PnL is measured on net exit value, not theoretical price', async () => {
  const r = await rig();
  await open(r);
  await r.tick();
  const p0 = (await r.db.getPosition(1))!;
  assert.ok(p0.last_pnl_pct < 0, `fees make a flat position negative (${p0.last_pnl_pct})`);
  assert.equal(p0.state, 'open');
  r.setReal(14_000_000_000n);
  await r.tick();
  const p = (await r.db.getPosition(1))!;
  assert.equal(p.state, 'closed');
  assert.equal(p.exit_reason, 'take_profit');
  assert.ok(p.proceeds_lamports > p.cost_lamports);
});

test('manager: stop loss needs two consecutive confirmations', async () => {
  const r = await rig();
  await open(r);
  r.setReal(1_000_000_000n);
  await r.tick();
  let p = (await r.db.getPosition(1))!;
  assert.equal(p.state, 'open', `first breach only counted (pnl ${p.last_pnl_pct.toFixed(1)}%)`);
  assert.equal(p.breach_ticks, 1);
  await r.tick();
  p = (await r.db.getPosition(1))!;
  assert.equal(p.state, 'closed');
  assert.ok(['stop_loss', 'hard_stop'].includes(p.exit_reason!), p.exit_reason!);
});

test('manager: a one-tick dip that recovers does not sell', async () => {
  const r = await rig();
  await open(r);
  r.setReal(1_000_000_000n); await r.tick();
  r.setReal(5_000_000_000n); await r.tick();
  const p = (await r.db.getPosition(1))!;
  assert.equal(p.state, 'open');
  assert.equal(p.breach_ticks, 0);
});

test('manager: max hold time forces an exit (never held indefinitely)', async () => {
  const r = await rig();
  await open(r);
  await r.tick();
  await r.tick(601_000);
  assert.equal((await r.db.getPosition(1))!.exit_reason, 'max_hold');
  assert.equal((await r.db.getPosition(1))!.state, 'closed');
});

test('manager: losing price data for 30s triggers an exit attempt; short outages do not', async () => {
  const r = await rig();
  await open(r);
  r.rpc.throwOn.set('getAccountInfo', new Error('rpc down'));
  await r.tick(); await r.tick(10_000);
  assert.equal((await r.db.getPosition(1))!.state, 'open');
  assert.ok((await r.db.getPosition(1))!.blind_since > 0);
  await r.tick(25_000);
  assert.equal((await r.db.getPosition(1))!.exit_reason, 'data_blind');
});

test('manager: creator dumping their tokens triggers an exit', async () => {
  const r = await rig();
  const creator = randAddr();
  const mint = randAddr();
  await r.ex.openPosition({ mint, symbol: 'C', pool: 'pump', creator, curveAddr: r.curveAddr, sizeLamports: 26_666_667n, mode: 'paper' });
  r.rpc.balances.set(`${creator}|${mint}`, 80_000_000_000n); r.rpc.acctExists.add(`${creator}|${mint}`);
  await r.tick();
  assert.equal((await r.db.getPosition(1))!.creator_token_raw, '80000000000');
  r.rpc.balances.set(`${creator}|${mint}`, 10_000_000_000n);
  await r.tick(6000);
  assert.equal((await r.db.getPosition(1))!.exit_reason, 'creator_sell');
});
