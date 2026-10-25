import { base58Encode } from '../util/base58.js';
import type { Wallet } from '../util/keypair.js';

function readShortVec(buf: Uint8Array, off: number): [number, number] {
  let len = 0;
  let size = 0;
  for (;;) {
    const b = buf[off + size];
    if (b === undefined) throw new Error('Malformed transaction: truncated shortvec');
    len |= (b & 0x7f) << (7 * size);
    size++;
    if ((b & 0x80) === 0) break;
    if (size > 3) throw new Error('Malformed transaction: shortvec too long');
  }
  return [len, size];
}

export interface SignedTx {
  base64: string;
  signature: string; // base58 of the first signature = transaction id
  feePayer: string;
}

/**
 * Signs a serialized legacy or v0 transaction produced by PumpPortal / Jupiter with the bot wallet.
 * Safety rules: our key must be a required signer, must be the fee payer, and no other signer may be required
 * (we cannot provide other signatures). The message bytes themselves are never altered.
 */
export function signSerializedTx(raw: Uint8Array, wallet: Wallet): SignedTx {
  const [numSigs, sz] = readShortVec(raw, 0);
  const sigStart = sz;
  const msgStart = sigStart + numSigs * 64;
  if (numSigs < 1 || msgStart >= raw.length) throw new Error('Malformed transaction: bad signature section');
  const message = raw.slice(msgStart);

  let o = 0;
  if (message[0] & 0x80) {
    const version = message[0] & 0x7f;
    if (version !== 0) throw new Error(`Unsupported transaction version ${version}`);
    o = 1;
  }
  const numRequired = message[o];
  o += 3; // numRequired, numReadonlySigned, numReadonlyUnsigned
  const [numKeys, ksz] = readShortVec(message, o);
  o += ksz;
  if (numRequired !== numSigs) throw new Error('Malformed transaction: signature count mismatch');
  if (numRequired !== 1) throw new Error(`Transaction requires ${numRequired} signers; only the bot wallet can sign`);
  if (numKeys < 1 || o + 32 * numKeys > message.length) throw new Error('Malformed transaction: bad account keys');
  const feePayerBytes = message.slice(o, o + 32);
  if (Buffer.compare(Buffer.from(feePayerBytes), Buffer.from(wallet.publicKey)) !== 0) {
    throw new Error('Refusing to sign: transaction fee payer is not the bot wallet');
  }

  const signature = wallet.sign(message);
  const out = new Uint8Array(raw);
  out.set(signature, sigStart);
  return {
    base64: Buffer.from(out).toString('base64'),
    signature: base58Encode(signature),
    feePayer: wallet.address,
  };
}

/** Unsigned legacy tx with a single SPL `CloseAccount` instruction (works for Token and Token-2022). Rent goes back to the owner. */
export function buildCloseAccountTx(owner: Uint8Array, tokenAccount: Uint8Array, tokenProgram: Uint8Array, recentBlockhash: Uint8Array): Uint8Array {
  if (owner.length !== 32 || tokenAccount.length !== 32 || tokenProgram.length !== 32 || recentBlockhash.length !== 32) throw new Error('bad key length');
  const message = Buffer.concat([
    Buffer.from([1, 0, 1]), // 1 signer, 0 readonly signed, 1 readonly unsigned (token program)
    Buffer.from([3]), // account keys
    owner, tokenAccount, tokenProgram,
    recentBlockhash,
    Buffer.from([1]), // 1 instruction
    Buffer.from([2]), // program id index
    Buffer.from([3, 1, 0, 0]), // accounts: tokenAccount(1), destination=owner(0), authority=owner(0)
    Buffer.from([1, 9]), // data: CloseAccount = 9
  ]);
  return new Uint8Array(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]));
}
