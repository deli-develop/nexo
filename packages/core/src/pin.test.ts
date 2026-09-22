import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { MAX_ATTEMPTS, clear, set, status, verify } from "./pin";
import type { PinContext } from "./pin";
import { Store } from "./store";

async function setup(factory = new IDBFactory()): Promise<PinContext> {
  const store = await Store.open("pin-test", factory);
  return {
    store,
    random: (salt) => salt.fill(7),
    // A deterministic test double for Argon2id. Production must inject the
    // Rust/WASM implementation; no cryptographic primitive ships in this file.
    derive: async (pin, salt) => {
      const input = new TextEncoder().encode(pin);
      const hash = new Uint8Array(32);
      for (let index = 0; index < hash.length; index++) {
        hash[index] = input[index % input.length]! ^ salt[index % salt.length]!;
      }
      return hash;
    },
  };
}

describe("PIN state machine", () => {
  it("validates the shape before storing and treats an unset PIN as no unlock", async () => {
    const ctx = await setup();
    await expect(verify(ctx, "1234")).resolves.toBe(false);
    await expect(set(ctx, "123")).rejects.toMatchObject({ kind: "invalid" });
    await expect(set(ctx, "abcd")).rejects.toMatchObject({ kind: "invalid" });
    expect(await status(ctx)).toEqual({ set: false, attempts_left: MAX_ATTEMPTS });

    await set(ctx, "1234");
    expect(await status(ctx)).toEqual({ set: true, attempts_left: MAX_ATTEMPTS });
    await expect(verify(ctx, "1234")).resolves.toBe(true);
  });

  it("persists every wrong guess, resets after success, and locks after five", async () => {
    const factory = new IDBFactory();
    const ctx = await setup(factory);
    await set(ctx, "2468");
    await expect(verify(ctx, "0000")).resolves.toBe(false);
    await expect(verify(ctx, "1111")).resolves.toBe(false);
    expect(await status(ctx)).toEqual({ set: true, attempts_left: 3 });

    // Reopening the database sees the count, rather than an in-memory counter.
    (ctx.store as Store).close();
    const reopened = { ...ctx, store: await Store.open("pin-test", factory) };
    await expect(verify(reopened, "2468")).resolves.toBe(true);
    expect(await status(reopened)).toEqual({ set: true, attempts_left: 5 });

    for (let index = 0; index < 5; index++) {
      await expect(verify(reopened, "0000")).resolves.toBe(false);
    }
    expect(await status(reopened)).toEqual({ set: true, attempts_left: 0 });
    await expect(verify(reopened, "2468")).rejects.toMatchObject({ kind: "locked" });

    await set(reopened, "1357");
    expect(await status(reopened)).toEqual({ set: true, attempts_left: 5 });
    await clear(reopened);
    expect(await status(reopened)).toEqual({ set: false, attempts_left: 5 });
  });

  it("does not grant extra guesses when checks race", async () => {
    const ctx = await setup();
    await set(ctx, "2468");
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => verify(ctx, "0000")),
    );
    expect(outcomes.filter((result) => result.status === "fulfilled" && result.value === false))
      .toHaveLength(5);
    expect(outcomes.filter((result) => result.status === "rejected"))
      .toHaveLength(3);
    expect(await status(ctx)).toEqual({ set: true, attempts_left: 0 });
  });
});
