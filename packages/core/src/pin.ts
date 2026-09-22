/** A local convenience lock. Browser storage cannot protect a four-digit secret. */

import type { PinRecord } from "./store";

export const MIN_PIN_LEN = 4;
export const MAX_PIN_LEN = 12;
export const MAX_ATTEMPTS = 5;
const SALT_LEN = 16;
const HASH_LEN = 32;

export type PinErrorKind = "invalid" | "locked" | "derivation" | "storage";

export class PinError extends Error {
  constructor(readonly kind: PinErrorKind, message: string) {
    super(message);
    this.name = "PinError";
  }
}

/** The attempt update must compare and write in one IndexedDB transaction. */
export interface PinStore {
  loadPin(): Promise<PinRecord | null>;
  putPin(record: PinRecord): Promise<void>;
  clearPin(): Promise<void>;
  setPinAttempts(expected: number, next: number): Promise<boolean>;
}

/**
 * `derive` must use Argon2id from the Rust/WASM crypto crate, with the same
 * 19 MiB, two-pass, single-lane parameters as `crates/client/src/pin.rs`.
 * The app must provide it; this module never substitutes a weaker hash.
 */
export interface PinContext {
  store: PinStore;
  derive(pin: string, salt: Uint8Array): Promise<Uint8Array>;
  random?: (bytes: Uint8Array) => void;
}

export interface PinStatus {
  set: boolean;
  attempts_left: number;
}

function checkShape(pin: string): void {
  if (pin.length < MIN_PIN_LEN || pin.length > MAX_PIN_LEN) {
    throw new PinError("invalid", `A PIN is between ${MIN_PIN_LEN} and ${MAX_PIN_LEN} digits.`);
  }
  if (!/^[0-9]+$/.test(pin)) {
    throw new PinError("invalid", "A PIN is digits only.");
  }
}

async function derive(ctx: PinContext, pin: string, salt: Uint8Array): Promise<Uint8Array> {
  let hash: Uint8Array;
  try {
    hash = await ctx.derive(pin, salt);
  } catch (cause) {
    throw new PinError(
      "derivation",
      `Could not derive the PIN verifier: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (hash.byteLength !== HASH_LEN) {
    throw new PinError("derivation", "The PIN verifier has the wrong length.");
  }
  return hash;
}

/** Setting a PIN resets a lockout; the caller must first authenticate the user. */
export async function set(ctx: PinContext, pin: string): Promise<void> {
  checkShape(pin);
  const salt = new Uint8Array(SALT_LEN);
  if (ctx.random) ctx.random(salt);
  else globalThis.crypto.getRandomValues(salt);
  const hash = await derive(ctx, pin, salt);
  await ctx.store.putPin({ salt, hash, attempts: 0 });
}

/** Forgetting the PIN leaves the account password as the only unlock route. */
export function clear(ctx: PinContext): Promise<void> {
  return ctx.store.clearPin();
}

export async function status(ctx: PinContext): Promise<PinStatus> {
  const record = await ctx.store.loadPin();
  return {
    set: record !== null,
    attempts_left: Math.max(0, MAX_ATTEMPTS - (record?.attempts ?? 0)),
  };
}

/**
 * Persist every failed attempt before returning false. The conditional write
 * prevents concurrent checks from each receiving a free guess; one loses the
 * race and retries against the new counter.
 */
export async function verify(ctx: PinContext, pin: string): Promise<boolean> {
  for (;;) {
    const record = await ctx.store.loadPin();
    if (!record) return false;
    if (record.attempts >= MAX_ATTEMPTS) {
      throw new PinError("locked", "Too many attempts; sign in with your password.");
    }
    if (record.salt.byteLength !== SALT_LEN || record.hash.byteLength !== HASH_LEN) {
      throw new PinError("storage", "The stored PIN verifier is unreadable.");
    }

    // As in Rust, verification does not reject a malformed guess early. A
    // wrong guess still consumes one attempt.
    const actual = await derive(ctx, pin, record.salt);
    let difference = 0;
    for (let index = 0; index < HASH_LEN; index++) {
      difference |= actual[index]! ^ record.hash[index]!;
    }
    actual.fill(0);
    const accepted = difference === 0;
    const next = accepted ? 0 : record.attempts + 1;
    if (await ctx.store.setPinAttempts(record.attempts, next)) return accepted;
  }
}
