import { createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from 'node:crypto';
import { base58Decode, base58Encode } from './base58.js';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface Wallet {
  publicKey: Uint8Array;
  address: string;
  sign(message: Uint8Array): Uint8Array;
}

/** Accepts a base58 64-byte secret key (Phantom/Solflare export) or a JSON array of 64 numbers (solana-keygen). */
export function parseSecretKey(raw: string): Uint8Array {
  const s = raw.trim();
  let bytes: Uint8Array;
  if (s.startsWith('[')) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error('Secret key JSON must be an array of bytes');
    }
    bytes = Uint8Array.from(arr);
  } else {
    bytes = base58Decode(s);
  }
  if (bytes.length !== 64) throw new Error(`Secret key must be 64 bytes (got ${bytes.length})`);
  return bytes;
}

export function walletFromSecret(raw: string): Wallet {
  const secret = parseSecretKey(raw);
  const seed = Buffer.from(secret.slice(0, 32));
  const keyObj: KeyObject = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(keyObj).export({ format: 'der', type: 'spki' });
  const derived = new Uint8Array(spki.subarray(spki.length - 32));
  const embedded = secret.slice(32);
  if (Buffer.compare(Buffer.from(derived), Buffer.from(embedded)) !== 0) {
    throw new Error('Secret key is inconsistent: embedded public key does not match the seed');
  }
  return {
    publicKey: derived,
    address: base58Encode(derived),
    sign: (message) => new Uint8Array(edSign(null, Buffer.from(message), keyObj)),
  };
}
