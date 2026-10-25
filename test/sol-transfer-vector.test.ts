import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base58Decode, base58Encode } from '../src/util/base58.js';
import { buildTransferTx, transferInstructionData, SYSTEM_PROGRAM_ID } from '../src/solana/system-transfer.js';
import { signSerializedTx } from '../src/solana/tx.js';
import { makeWallet, randAddr } from './helpers.js';
import { createPublicKey, verify } from 'node:crypto';

// Exact vector published by Solana's own documentation
// (https://solana.com/docs/core/transactions/transaction-structure, "Example: SOL transfer transaction" /
// "Fetching transaction details"), fetched and cross-checked during development:
//   - instruction data for a 0.01 SOL (10,000,000 lamport) transfer, base58: "3Bxs4NN8M2Yn4TLb"
//   - decodes to the raw bytes [2,0,0,0,128,150,152,0,0,0,0,0]
//   - account layout: accountKeys = [sender, recipient, "111...111" (system program)],
//     header = {numRequiredSignatures:1, numReadonlySignedAccounts:0, numReadonlyUnsignedAccounts:1},
//     instruction = {programIdIndex:2, accounts:[0,1]}
const REAL_DOCS_INSTRUCTION_DATA_B58 = '3Bxs4NN8M2Yn4TLb';
const REAL_DOCS_INSTRUCTION_DATA_BYTES = [2, 0, 0, 0, 128, 150, 152, 0, 0, 0, 0, 0];
const REAL_DOCS_LAMPORTS = 10_000_000n; // 0.01 SOL

test('base58 decode of the real docs instruction-data string matches the documented raw bytes exactly', () => {
  // This does not depend on our own encoder being self-consistent: these are bytes Solana itself published.
  assert.deepEqual([...base58Decode(REAL_DOCS_INSTRUCTION_DATA_B58)], REAL_DOCS_INSTRUCTION_DATA_BYTES);
});

test('our Transfer instruction-data builder reproduces the real on-chain vector byte-for-byte', () => {
  const data = transferInstructionData(REAL_DOCS_LAMPORTS);
  assert.deepEqual([...data], REAL_DOCS_INSTRUCTION_DATA_BYTES);
  assert.equal(base58Encode(data), REAL_DOCS_INSTRUCTION_DATA_B58, 'also matches the documented base58 string');
});

test('system program id matches the documented "111...111" address', () => {
  assert.equal(SYSTEM_PROGRAM_ID, '11111111111111111111111111111111111111111'.slice(0, 32).padEnd(32, '1'));
  assert.equal(SYSTEM_PROGRAM_ID.length, 32);
  // The docs example shows it padded to 34 chars in base58 text, but it always decodes to 32 zero bytes.
  assert.deepEqual([...base58Decode(SYSTEM_PROGRAM_ID)], new Array(32).fill(0));
});

test('buildTransferTx matches the documented message structure: header, key order and instruction shape', () => {
  const from = randAddr();
  const to = randAddr();
  const bh = randAddr();
  const tx = buildTransferTx(base58Decode(from), base58Decode(to), REAL_DOCS_LAMPORTS, base58Decode(bh));
  // 1 empty signature slot (1 + 64 bytes) then the message
  assert.equal(tx[0], 1);
  const message = tx.slice(65);
  // header: numRequiredSignatures=1, numReadonlySigned=0, numReadonlyUnsigned=1 (matches the docs example header)
  assert.deepEqual([...message.slice(0, 3)], [1, 0, 1]);
  // 3 account keys
  assert.equal(message[3], 3);
  const keys = message.slice(4, 4 + 96);
  assert.deepEqual([...keys.slice(0, 32)], [...base58Decode(from)], 'account 0 = sender (signer+writable)');
  assert.deepEqual([...keys.slice(32, 64)], [...base58Decode(to)], 'account 1 = recipient (writable)');
  assert.deepEqual([...keys.slice(64, 96)], [...base58Decode(SYSTEM_PROGRAM_ID)], 'account 2 = system program (readonly)');
  const afterBlockhash = message.slice(4 + 96 + 32);
  assert.equal(afterBlockhash[0], 1, '1 instruction');
  assert.equal(afterBlockhash[1], 2, 'programIdIndex = 2 (matches the docs example)');
  assert.deepEqual([...afterBlockhash.slice(2, 5)], [2, 0, 1], '2 account indices: [0,1] (matches the docs example)');
  assert.equal(afterBlockhash[5], 12, 'data_len = 12');
  assert.deepEqual([...afterBlockhash.slice(6, 18)], REAL_DOCS_INSTRUCTION_DATA_BYTES, 'instruction data byte-for-byte matches Solana’s own published vector');
});

test('a built transfer transaction signs, verifies independently, and round-trips through our own signer unchanged', () => {
  const wallet = makeWallet();
  const to = randAddr();
  const bh = randAddr();
  const tx = buildTransferTx(wallet.publicKey, base58Decode(to), 5_000_000n, base58Decode(bh));
  const signed = signSerializedTx(tx, wallet);
  const bytes = Buffer.from(signed.base64, 'base64');
  const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
  const pub = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(wallet.publicKey)]), format: 'der', type: 'spki' });
  assert.ok(verify(null, bytes.subarray(65), pub, bytes.subarray(1, 65)), 'signature verifies independently with node:crypto');
  assert.deepEqual(new Uint8Array(bytes.subarray(65)), tx.slice(65), 'signing never alters the message bytes');
});

test('buildTransferTx rejects malformed keys and out-of-range amounts', () => {
  assert.throws(() => buildTransferTx(new Uint8Array(31), base58Decode(randAddr()), 1n, base58Decode(randAddr())), /bad key length/);
  assert.throws(() => transferInstructionData(-1n), /out of range/);
  assert.throws(() => transferInstructionData(2n ** 64n), /out of range/);
});
