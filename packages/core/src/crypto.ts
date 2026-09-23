/**
 * The MLS seam.
 *
 * `packages/crypto-wasm` satisfies this, and nothing in `packages/core`
 * imports that package directly. The reason is the same one that keeps the
 * network behind `Transport`: the wasm module is built per target — `nodejs`
 * glue for the test runner, `web` glue for a browser — and a core that
 * imported one of them could only ever run where that one runs.
 *
 * It also means these operations can be driven by a double in a test that is
 * about ordering rather than about cryptography, without pretending the double
 * is the real thing.
 *
 * Every method here is a thin pass-through to `nexo-crypto`. Rule 1 is
 * untouched: nothing in TypeScript computes anything cryptographic, and this
 * interface exists so that stays true by construction.
 */

/** What an envelope turns out to hold, before anything is applied to it. */
export type Peeked = "welcome" | "group_message" | "other";

/** A commit that has been created and staged, but **not** applied. */
export interface StagedCommit {
  readonly message: Uint8Array;
  /** Present when this commit added somebody. */
  readonly welcome: Uint8Array | undefined;
}

/** What came out of a decrypt. */
export interface Decrypted {
  readonly kind: string;
  readonly sender: string | undefined;
  readonly plaintext: Uint8Array | undefined;
  readonly epoch: bigint;
}

/** One member of a group: which device, and the key that signs its messages. */
export interface Member {
  readonly deviceId: string;
  readonly identityKey: Uint8Array;
}

/** One conversation's MLS group. */
export interface Group {
  readonly epoch: bigint;
  readonly memberCount: number;
  /**
   * Everyone in the group, this device included. Safety numbers are computed
   * from these keys and a changed one is noticed through them. From the wasm
   * module the entries are classes whose fields are getters: read them, never
   * spread them.
   */
  members(): Member[];
  addMember(device: Device, keyPackage: Uint8Array): StagedCommit;
  confirmCommit(device: Device, nowMs: number): bigint;
  abandonCommit(device: Device): void;
  encrypt(device: Device, plaintext: Uint8Array): Uint8Array;
  decrypt(device: Device, ciphertext: Uint8Array): Decrypted;
}

/** One device's keys and MLS storage. */
export interface Device {
  publicKey(): Uint8Array;
  exportSecret(): Uint8Array;
  safetyNumber(otherPublicKey: Uint8Array): string;
  keyPackage(): Uint8Array;
  exportState(): Uint8Array;
  importState(blob: Uint8Array): void;
}

/**
 * The module itself: the constructors that are not methods on anything.
 *
 * Named rather than passed as loose functions so a caller wires one object and
 * cannot half-supply it.
 */
export interface CryptoModule {
  peek(ciphertext: Uint8Array): Peeked;
  newDevice(deviceId: string): Device;
  deviceFromSecret(deviceId: string, secret: Uint8Array): Device;
  createGroup(device: Device, conversationId: string, nowMs: number): Group;
  joinGroup(device: Device, welcome: Uint8Array, nowMs: number): Group;
  /** `undefined` when this device is not in that conversation — an answer. */
  loadGroup(device: Device, conversationId: string, nowMs: number): Group | undefined;
}
