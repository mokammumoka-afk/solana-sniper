import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseNewToken, NewTokenFeed } from '../src/feeds/pumpportal-ws.js';
import { randAddr } from './helpers.js';

const mint = randAddr();
const trader = randAddr();
const curve = randAddr();

test('parseNewToken: valid creation event parsed, with discovery time/address/source recorded', () => {
  const e = parseNewToken({ txType: 'create', mint, symbol: 'DOGE', name: 'Doge', traderPublicKey: trader, bondingCurveKey: curve, pool: 'pump', marketCapSol: 28, initialBuy: 5_000_000 }, 12345);
  assert.ok(e && e !== 'invalid');
  if (e && typeof e !== 'string') {
    assert.equal(e.mint, mint);
    assert.equal(e.creator, trader);
    assert.equal(e.bondingCurve, curve);
    assert.equal(e.discoveredAt, 12345);
    assert.equal(e.source, 'pumpportal:subscribeNewToken');
    assert.equal(e.devInitialBuyPct, 0.5);
  }
});

test('parseNewToken: non-creation messages ignored, malformed mint flagged invalid, missing fields degrade gracefully', () => {
  assert.equal(parseNewToken({ txType: 'trade', mint }), null);
  assert.equal(parseNewToken({ message: 'subscribed' }), null);
  assert.equal(parseNewToken(null), null);
  assert.equal(parseNewToken({ txType: 'create', mint: 'not-an-address' }), 'invalid');
  const e = parseNewToken({ txType: 'create', mint });
  assert.ok(e && e !== 'invalid' && e.creator === null && e.bondingCurve === null && e.devInitialBuyPct === null);
});

class FakeWS extends EventEmitter {
  static instances: FakeWS[] = [];
  readyState = 0;
  constructor(public url: string) { super(); FakeWS.instances.push(this); }
  send(_d: string) {}
  close() { this.emit('close'); }
  addEventListener(ev: string, fn: (...a: any[]) => void) { this.on(ev, fn); }
}

test('feed: deduplicates by mint, counts invalid and reconnects with backoff after a close', async () => {
  FakeWS.instances.length = 0;
  const received: string[] = [];
  const feed = new NewTokenFeed('wss://x', (e) => received.push(e.mint), { wsCtor: FakeWS as any, staleMs: 999999 });
  feed.start();
  const ws = FakeWS.instances[0];
  ws.emit('open');
  const m1 = randAddr();
  ws.emit('message', { data: JSON.stringify({ txType: 'create', mint: m1 }) });
  ws.emit('message', { data: JSON.stringify({ txType: 'create', mint: m1 }) }); // duplicate
  ws.emit('message', { data: 'not json{{' }); // invalid
  assert.deepEqual(received, [m1]);
  assert.equal(feed.status.duplicates, 1);
  assert.equal(feed.status.invalid, 1);
  assert.equal(feed.status.received, 1);
  ws.emit('close');
  assert.equal(feed.status.connected, false);
  await new Promise((r) => setTimeout(r, 1800));
  assert.ok(FakeWS.instances.length >= 2, 'reconnected');
  feed.stop();
});
