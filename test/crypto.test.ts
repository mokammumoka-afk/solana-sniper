import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify, randomBytes } from 'node:crypto';
import { base58Decode, base58Encode, isValidSolanaAddress } from '../src/util/base58.js';
import { parseSecretKey, walletFromSecret } from '../src/util/keypair.js';
import { signSerializedTx, buildCloseAccountTx } from '../src/solana/tx.js';
import { buildTx, makeSecret, makeWallet, randAddr } from './helpers.js';

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const verifyWith = (pub: Uint8Array, msg: Uint8Array, sig: Uint8Array) =>
  verify(null, Buffer.from(msg), createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pub)]), format: 'der', type: 'spki' }), Buffer.from(sig));

test('base58 round-trips, keeps leading zeros and rejects bad characters', () => {
  for (const len of [0, 1, 5, 32, 64]) {
    const b = randomBytes(len);
    assert.deepEqual(base58Decode(base58Encode(b)), new Uint8Array(b));
  }
  const z = new Uint8Array([0, 0, 1, 2]);
  assert.deepEqual(base58Decode(base58Encode(z)), z);
  assert.throws(() => base58Decode('0OIl'), /Invalid base58/);
  assert.equal(base58Encode(new Uint8Array(32)), '1'.repeat(32));
});

test('address validation: valid mint accepted, malformed addresses rejected', () => {
  assert.equal(isValidSolanaAddress('So11111111111111111111111111111111111111112'), true);
  assert.equal(isValidSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), true);
  assert.equal(isValidSolanaAddress(randAddr()), true);
  for (const bad of ['', 'abc', 'So1111111111111111111111111111111111111111O', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1vEXTRA', null, 42, undefined, '0x' + 'a'.repeat(40)])
    assert.equal(isValidSolanaAddress(bad), false, String(bad));
});

test('wallet loads from base58 and JSON array, signs verifiably, rejects inconsistent keys', () => {
  const { secretB58, secretBytes } = makeSecret();
  const a = walletFromSecret(secretB58);
  const b = walletFromSecret(JSON.stringify([...secretBytes]));
  assert.equal(a.address, b.address);
  const msg = randomBytes(100);
  assert.ok(verifyWith(a.publicKey, msg, a.sign(msg)));
  assert.ok(!verifyWith(a.publicKey, randomBytes(100), a.sign(msg)));
  const tampered = Uint8Array.from(secretBytes); tampered[40] ^= 1;
  assert.throws(() => walletFromSecret(base58Encode(tampered)), /inconsistent/);
  assert.throws(() => parseSecretKey('abc'), /Invalid|64 bytes/);
  assert.throws(() => parseSecretKey('[1,2,3]'), /64 bytes/);
});

for (const versioned of [true, false]) {
  test(`signSerializedTx signs a ${versioned ? 'v0' : 'legacy'} transaction in the right slot without touching the message`, () => {
    const w = makeWallet();
    const raw = buildTx(w.publicKey, { versioned });
    const out = signSerializedTx(raw, w);
    const bytes = Buffer.from(out.base64, 'base64');
    assert.deepEqual(new Uint8Array(bytes.subarray(65)), raw.slice(65), 'message untouched');
    assert.ok(verifyWith(w.publicKey, bytes.subarray(65), bytes.subarray(1, 65)));
    assert.equal(out.signature, base58Encode(new Uint8Array(bytes.subarray(1, 65))));
  });
}

test('signSerializedTx refuses foreign fee payers, extra signers and malformed input', () => {
  const w = makeWallet();
  assert.throws(() => signSerializedTx(buildTx(makeWallet().publicKey), w), /fee payer is not the bot wallet/);
  assert.throws(() => signSerializedTx(buildTx(w.publicKey, { signers: 2 }), w), /requires 2 signers/);
  assert.throws(() => signSerializedTx(new Uint8Array([1, 0, 0]), w), /Malformed/);
  assert.throws(() => signSerializedTx(new Uint8Array(0), w), /Malformed/);
});

test('close-account transaction is well formed and signable by the owner only', () => {
  const w = makeWallet();
  const tx = buildCloseAccountTx(w.publicKey, base58Decode(randAddr()), base58Decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), randomBytes(32));
  const s = signSerializedTx(tx, w);
  assert.equal(Buffer.from(s.base64, 'base64').length, tx.length);
  assert.throws(() => signSerializedTx(tx, makeWallet()), /fee payer/);
});
