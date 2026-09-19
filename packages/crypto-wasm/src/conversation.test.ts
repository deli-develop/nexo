/**
 * The spike, as a test: two devices hold a real MLS conversation in wasm.
 *
 * This is the go/no-go for [`REWORK.md`](../../../docs/REWORK.md) wave 3. If
 * it passes, "one TypeScript app that keeps end-to-end encryption" is an
 * available shape for this product. If it does not, the plan changes before
 * anything is built on top of it.
 *
 * What it is really testing is not the API — that is thin and obvious — but
 * three things the compiler could not answer:
 *
 *  - **Randomness works.** Key generation, KeyPackages and every nonce come
 *    from `getrandom`, which needs a browser backend on `wasm32`. A build with
 *    the wrong backend links and then throws on the first key.
 *  - **`rayon` does not panic.** OpenMLS uses parallel iterators in
 *    `treesync`, and a single-threaded wasm target has no threads to give it.
 *    `addMember` is the call that reaches that code, which is why this test
 *    adds a member rather than only encrypting to itself.
 *  - **The tree is really moving.** Epochs advance, the Welcome opens, and
 *    what Bob decrypts is byte-for-byte what Alice encrypted.
 */

import { beforeAll, describe, expect, it } from "vitest";

// wasm-bindgen's `nodejs` target emits CommonJS and loads the module
// synchronously at require time, so there is no init step to await.
import * as wasm from "../pkg/nexo_crypto_wasm.js";

const ALICE_DEVICE = "11111111-1111-4111-8111-111111111111";
const BOB_DEVICE = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";

const NOW = 1_760_000_000_000;

const text = (value: string) => new TextEncoder().encode(value);
const read = (value: Uint8Array) => new TextDecoder().decode(value);

describe("MLS in WebAssembly", () => {
  beforeAll(() => {
    wasm.initPanicHook();
  });

  it("generates an identity without a platform under it", () => {
    const alice = new wasm.Device(ALICE_DEVICE);
    const key = alice.publicKey();

    // Ed25519. A wrong `getrandom` backend does not produce a short key, it
    // throws — so the assertion that matters is that we got here at all.
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);

    const second = new wasm.Device(BOB_DEVICE);
    expect(Array.from(second.publicKey())).not.toEqual(Array.from(key));
  });

  it("agrees on a safety number from both sides", () => {
    const alice = new wasm.Device(ALICE_DEVICE);
    const bob = new wasm.Device(BOB_DEVICE);

    const fromAlice = alice.safetyNumber(bob.publicKey());
    const fromBob = bob.safetyNumber(alice.publicKey());

    expect(fromAlice).toBe(fromBob);
    // Twelve groups of five digits, as the Security screen draws it.
    expect(fromAlice.replace(/\s/g, "")).toMatch(/^\d{60}$/);
  });

  it("carries a message from one device to the other", () => {
    const alice = new wasm.Device(ALICE_DEVICE);
    const bob = new wasm.Device(BOB_DEVICE);

    // Bob publishes a KeyPackage; Alice spends it to add him.
    const bobPackage = bob.keyPackage();
    expect(bobPackage.length).toBeGreaterThan(0);

    const group = wasm.Group.create(alice, CONVERSATION, NOW);
    expect(group.epoch).toBe(0n);
    expect(group.memberCount).toBe(1);

    // This is the call that reaches OpenMLS's rayon paths.
    const staged = group.addMember(alice, bobPackage);
    expect(staged.welcome).toBeInstanceOf(Uint8Array);

    // A commit can lose, so it is confirmed only after the server accepts it.
    // There is no server here; confirming is what a successful send means.
    const epoch = group.confirmCommit(alice, NOW);
    expect(epoch).toBe(1n);
    expect(group.memberCount).toBe(2);

    const bobGroup = wasm.Group.join(bob, staged.welcome!, NOW);
    expect(bobGroup.epoch).toBe(1n);
    expect(bobGroup.memberCount).toBe(2);

    const ciphertext = group.encrypt(alice, text("the mountains are out"));
    // Whatever else is true, the plaintext must not be sitting in it.
    expect(read(ciphertext)).not.toContain("mountains");

    const received = bobGroup.decrypt(bob, ciphertext);
    expect(received.kind).toBe("message");
    expect(read(received.plaintext!)).toBe("the mountains are out");

    // And back the other way, which proves Bob's own ratchet advanced rather
    // than only his copy of Alice's.
    const reply = bobGroup.encrypt(bob, text("so is the lake"));
    const back = group.decrypt(alice, reply);
    expect(back.kind).toBe("message");
    expect(read(back.plaintext!)).toBe("so is the lake");
  });

  it("refuses ciphertext it cannot read rather than guessing", () => {
    const alice = new wasm.Device(ALICE_DEVICE);
    const group = wasm.Group.create(alice, CONVERSATION, NOW);

    // Rule 7 reaching JavaScript: this throws, and there is no plaintext
    // fallback for it to return instead.
    expect(() => group.decrypt(alice, text("not a message"))).toThrow();
  });

  it("survives being put away and taken out again", () => {
    const alice = new wasm.Device(ALICE_DEVICE);
    const bob = new wasm.Device(BOB_DEVICE);

    const group = wasm.Group.create(alice, CONVERSATION, NOW);
    const staged = group.addMember(alice, bob.keyPackage());
    group.confirmCommit(alice, NOW);
    const bobGroup = wasm.Group.join(bob, staged.welcome!, NOW);

    // What a page would write to IndexedDB, and read back on the next visit.
    const secret = alice.exportSecret();
    const state = alice.exportState();
    expect(state.length).toBeGreaterThan(9);

    const restored = wasm.Device.fromSecret(ALICE_DEVICE, secret);
    expect(Array.from(restored.publicKey())).toEqual(Array.from(alice.publicKey()));
    restored.importState(state);

    const reopened = wasm.Group.load(restored, CONVERSATION, NOW);
    expect(reopened).toBeDefined();
    expect(reopened!.epoch).toBe(group.epoch);

    // The real proof: the restored ratchet can still talk to the other side.
    const ciphertext = reopened!.encrypt(restored, text("still here"));
    const received = bobGroup.decrypt(bob, ciphertext);
    expect(read(received.plaintext!)).toBe("still here");
  });

  it("says so when the stored state is not something it can read", () => {
    const alice = new wasm.Device(ALICE_DEVICE);
    expect(() => alice.importState(new Uint8Array([9, 9, 9]))).toThrow();
  });
});
