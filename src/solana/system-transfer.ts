/**
 * Native SOL transfer via the Solana System Program, built and verified against the official worked
 * example in https://solana.com/docs/core/transactions/transaction-structure (fetched and cross-checked
 * during development): a 0.01 SOL transfer whose instruction data decodes to the exact byte sequence
 * [2,0,0,0,128,150,152,0,0,0,0,0] — a 4-byte little-endian u32 discriminant (2 = Transfer) followed by
 * an 8-byte little-endian u64 lamport amount. See test/sol-transfer-vector.test.ts for the reproduced vector.
 */
import { base58Decode } from '../util/base58.js';

/** All-zero 32-byte pubkey; base58Encode(new Uint8Array(32)) === '1'.repeat(32), confirmed against the
 *  docs example's accountKeys entry "11111111111111111111111111111111". */
export const SYSTEM_PROGRAM_ID = '1'.repeat(32);
export const SYSTEM_PROGRAM_BYTES = base58Decode(SYSTEM_PROGRAM_ID);

export function transferInstructionData(lamports: bigint): Uint8Array {
  if (lamports < 0n || lamports > 0xffffffffffffffffn) throw new Error('lamports out of range');
  const b = Buffer.alloc(12);
  b.writeUInt32LE(2, 0); // System Program instruction index 2 = Transfer
  b.writeBigUInt64LE(lamports, 4);
  return new Uint8Array(b);
}

/**
 * Unsigned legacy transaction: one System Program Transfer instruction, sender is both fee payer and
 * the only required signer. Account order follows the mandated strict ordering (signer+writable, then
 * non-signer+writable, then non-signer+readonly), matching the docs example exactly: header
 * {numRequiredSignatures:1, numReadonlySigned:0, numReadonlyUnsigned:1}, accounts [0,1], programIdIndex 2.
 */
export function buildTransferTx(from: Uint8Array, to: Uint8Array, lamports: bigint, recentBlockhash: Uint8Array): Uint8Array {
  if (from.length !== 32 || to.length !== 32 || recentBlockhash.length !== 32) throw new Error('bad key length');
  const data = transferInstructionData(lamports);
  const message = Buffer.concat([
    Buffer.from([1, 0, 1]), // 1 required signer, 0 readonly-signed, 1 readonly-unsigned (the system program)
    Buffer.from([3]), // 3 account keys
    from, to, SYSTEM_PROGRAM_BYTES,
    recentBlockhash,
    Buffer.from([1]), // 1 instruction
    Buffer.from([2]), // program_id_index = 2 (system program, last key)
    Buffer.from([2, 0, 1]), // 2 account indices: from(0), to(1)
    Buffer.from([data.length]), // data_len (12, fits in one compact-u16 byte)
    data,
  ]);
  return new Uint8Array(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]));
}
