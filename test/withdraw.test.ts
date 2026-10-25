import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WithdrawalService } from '../src/trading/withdraw.js';
import { SYSTEM_PROGRAM_ID } from '../src/solana/system-transfer.js';
import { FakeRpc, freshDb, makeWallet, randAddr, closeAllFakeServers } from './helpers.js';
import { DEFAULT_SETTINGS } from '../src/config.js';

after(closeAllFakeServers);

async function setup(armed = true) {
  const { db } = await freshDb();
  const wallet = makeWallet();
  const rpc = new FakeRpc();
  rpc.walletAddress = wallet.address;
  rpc.lamports = 200_000_000n; // 0.2 SOL
  let clock = Date.now();
  const svc = new WithdrawalService({ db, rpc, wallet, getSettings: () => DEFAULT_SETTINGS, isArmed: () => armed, sleep: async () => void (clock += 1000), now: () => clock });
  return { db, wallet, rpc, svc, advance: (ms: number) => (clock += ms) };
}

test('prepare: rejects an invalid address, the bot’s own address, and the System Program address', async () => {
  const { svc, wallet } = await setup();
  assert.match((await svc.prepare('not-a-valid-address', 0.01) as any).error, /not a valid Solana address/);
  assert.match((await svc.prepare(wallet.address, 0.01) as any).error, /own wallet address/);
  assert.match((await svc.prepare(SYSTEM_PROGRAM_ID, 0.01) as any).error, /System Program/);
});

test('prepare: refuses to run without a wallet or while not armed — withdrawal is gated exactly like live trading', async () => {
  const { rpc } = await setup();
  const { db } = await freshDb();
  const noWallet = new WithdrawalService({ db, rpc, wallet: null, getSettings: () => DEFAULT_SETTINGS, isArmed: () => true });
  assert.match((await noWallet.prepare(randAddr(), 0.01) as any).error, /no wallet configured/);
  const notArmed = new WithdrawalService({ db, rpc, wallet: makeWallet(), getSettings: () => DEFAULT_SETTINGS, isArmed: () => false });
  assert.match((await notArmed.prepare(randAddr(), 0.01) as any).error, /not armed/);
});

test('prepare: computes an exact quote (amount + fee), including "max" draining to the fee-adjusted balance', async () => {
  const { svc } = await setup();
  const dest = randAddr();
  const r = await svc.prepare(dest, 0.1);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.amountSol, 0.1);
    assert.ok(r.feeSol > 0 && r.feeSol < 0.001);
    assert.ok(Math.abs(r.remainingSol - (0.2 - 0.1 - r.feeSol)) < 1e-9);
    assert.equal(r.draft.status, 'draft');
  }
  const max = await svc.prepare(dest, 'max');
  assert.ok(max.ok);
  if (max.ok) assert.ok(max.amountSol < 0.2 && max.amountSol > 0.199, 'max leaves exactly the fee behind');
});

test('prepare: refuses when the amount plus fee exceeds the balance', async () => {
  const { svc } = await setup();
  const r = await svc.prepare(randAddr(), 1); // only have 0.2 SOL
  assert.equal(r.ok, false);
  assert.match((r as any).error, /insufficient balance/);
});

test('confirm: signs, sends, verifies the proceeds from chain, and records the signature', async () => {
  const { svc, rpc, db } = await setup();
  const dest = randAddr();
  const prep = await svc.prepare(dest, 0.05);
  assert.ok(prep.ok);
  const id = (prep as any).draft.id;
  rpc.onSend = (sig) => rpc.confirm(sig, -(50_000_000 + 5205));
  const r = await svc.confirm(id);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.status, 'confirmed');
  const row = await db.getWithdrawal(id);
  assert.equal(row!.status, 'confirmed');
  assert.equal(row!.signature, rpc.sent[0]);
  assert.ok(row!.confirmed_at! > 0);
});

test('confirm: double-confirming the SAME draft sends at most one transaction — the atomic DB transition is the real guard', async () => {
  const { svc, rpc } = await setup();
  const prep = await svc.prepare(randAddr(), 0.02);
  const id = (prep as any).draft.id;
  rpc.onSend = (sig) => rpc.confirm(sig, -20_005_000);
  const [a, b] = await Promise.all([svc.confirm(id), svc.confirm(id)]);
  const results = [a, b];
  assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one of the two concurrent confirms succeeds');
  assert.match((results.find((r) => !r.ok) as any).error, /already (confirmed|submitted|draft)/i);
  assert.equal(rpc.sent.length, 1, 'only one transaction was ever sent for this draft');
  // a third, later confirm attempt is also refused, not re-sent
  const again = await svc.confirm(id);
  assert.equal(again.ok, false);
  assert.equal(rpc.sent.length, 1);
});

test('confirm: an expired draft is refused and never signed', async () => {
  const { svc, rpc, advance } = await setup();
  const prep = await svc.prepare(randAddr(), 0.01);
  const id = (prep as any).draft.id;
  advance(130_000); // past the draft's expiry window
  const r = await svc.confirm(id);
  assert.equal(r.ok, false);
  assert.match((r as any).error, /expired/);
  assert.equal(rpc.sent.length, 0);
});

test('confirm: a rejected-by-RPC send fails cleanly, the draft is marked failed, and nothing is re-sent on retry', async () => {
  const { svc, rpc } = await setup();
  const prep = await svc.prepare(randAddr(), 0.01);
  const id = (prep as any).draft.id;
  rpc.sendMode = 'reject';
  const r = await svc.confirm(id);
  assert.equal(r.ok, false);
  const again = await svc.confirm(id);
  assert.equal(again.ok, false);
  assert.match((again as any).error, /already failed/);
});

test('confirm: an unknown (timed-out) outcome is reported as submitted, not re-sent, and reconcile() settles it later without a duplicate', async () => {
  const { svc, rpc, db } = await setup();
  const prep = await svc.prepare(randAddr(), 0.01);
  const id = (prep as any).draft.id;
  rpc.onSend = undefined; // never confirms -> sendAndConfirm times out -> 'unknown'
  const r = await svc.confirm(id);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.status, 'submitted');
  assert.equal(rpc.sent.length, 1);
  assert.equal((await db.getWithdrawal(id))!.status, 'submitted');
  rpc.confirm(rpc.sent[0], -10_005_000);
  await svc.reconcile();
  assert.equal((await db.getWithdrawal(id))!.status, 'confirmed');
  assert.equal(rpc.sent.length, 1, 'reconcile never re-sends — it only looks the signature up');
});

test('reconcile: a pending withdrawal whose signature never landed within the window is marked failed, not retried forever', async () => {
  const { svc, rpc, db, advance } = await setup();
  const prep = await svc.prepare(randAddr(), 0.01);
  const id = (prep as any).draft.id;
  rpc.onSend = undefined;
  await svc.confirm(id);
  advance(200_000);
  await svc.reconcile();
  assert.equal((await db.getWithdrawal(id))!.status, 'failed');
});
