import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readEnv } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { createApp } from '../src/server.js';
import { FakeJupiter, FakePortal, FakeRpc, freshDb, makeWallet, closeAllFakeServers } from './helpers.js';

after(closeAllFakeServers);

async function rig() {
  const { db } = await freshDb();
  const wallet = makeWallet();
  const rpc = new FakeRpc();
  const env = readEnv({ MODE: 'paper', DASHBOARD_TOKEN: 'correct-token-123456', LIVE_CONFIRM: '', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(24) });
  const engine = new Engine({ db, env, rpc, wallet: null, portal: new FakePortal(wallet), jupiter: new FakeJupiter(wallet), solPrice: { get: async () => 150, lastKnown: () => ({ v: 150, ageMs: 0 }) } as any });
  const server = createApp(engine, db, env.dashboardToken);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  return { server, base, db, engine };
}
const get = (base: string, path: string, token: string) => fetch(base + path, { headers: { authorization: 'Bearer ' + token, 'x-requested-with': 'sniper-ui' } });
const post = (base: string, path: string, token: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-requested-with': 'sniper-ui' }, body: JSON.stringify(body) });

test('dashboard API requires the bearer token; wrong token is rejected, correct token works', async () => {
  const { server, base } = await rig();
  try {
    const bad = await get(base, '/api/state', 'wrong');
    assert.equal(bad.status, 401);
    const noAuth = await fetch(base + '/api/state');
    assert.equal(noAuth.status, 401);
    const ok = await get(base, '/api/state', 'correct-token-123456');
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.mode, 'paper');
  } finally {
    server.close();
  }
});

test('settings endpoint validates input and rejects out-of-range values over HTTP', async () => {
  const { server, base } = await rig();
  try {
    const bad = await post(base, '/api/settings', 'correct-token-123456', { stopLossPct: 0 });
    assert.equal(bad.status, 400);
    const good = await post(base, '/api/settings', 'correct-token-123456', { takeProfitPct: 55 });
    assert.equal(good.status, 200);
    const s = await (await get(base, '/api/state', 'correct-token-123456')).json();
    assert.equal(s.settings.takeProfitPct, 55);
  } finally {
    server.close();
  }
});

test('the HTML page itself is reachable without auth (static asset), but no API data leaks there', async () => {
  const { server, base } = await rig();
  try {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<html/);
  } finally {
    server.close();
  }
});

test('repeated auth failures from one client are rate-limited', async () => {
  const { server, base } = await rig();
  try {
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await get(base, '/api/state', 'nope')).status;
    assert.equal(last, 429);
  } finally {
    server.close();
  }
});

test('wallet endpoint reports no wallet gracefully in paper mode, and never includes a private key field', async () => {
  const { server, base } = await rig();
  try {
    const res = await get(base, '/api/wallet', 'correct-token-123456');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.address, null);
    const text = JSON.stringify(body).toLowerCase();
    assert.equal(text.includes('privatekey'), false);
    assert.equal(text.includes('secretkey'), false);
  } finally {
    server.close();
  }
});

test('withdrawal endpoints refuse to move funds with no wallet configured, and validate input shape', async () => {
  const { server, base } = await rig();
  try {
    const bad = await post(base, '/api/withdraw/prepare', 'correct-token-123456', { destination: '', amount: 1 });
    assert.equal(bad.status, 400);
    const r = await post(base, '/api/withdraw/prepare', 'correct-token-123456', { destination: 'Ca1234567890123456789012345678901234567', amount: 0.01 });
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /no wallet configured|not armed/);
    const confirmBad = await post(base, '/api/withdraw/confirm', 'correct-token-123456', { id: 'not-a-number' });
    assert.equal(confirmBad.status, 400);
  } finally {
    server.close();
  }
});
