import type { CryptoModule, Device, Group, Peeked } from "./crypto";
import type { PasswordCrypto } from "./session";

/**
 * Binds `@nexo/crypto-wasm` to the [`CryptoModule`] seam.
 *
 * The facade exposes `Group.create` / `Group.join` / `Group.load` as static
 * constructors, because that is what reads well in Rust and what wasm-bindgen
 * can express. The seam wants plain functions, because a caller wiring an
 * object cannot half-supply one. This is the twenty lines between them.
 *
 * It takes the module rather than importing it: the glue is generated per
 * target — `nodejs` for the test runner, `web` for a browser — and a core that
 * imported one could only ever run where that one runs. The caller does the
 * import, in the one file that knows which target it is.
 */

/** The shape of the generated module, named structurally rather than imported. */
export interface WasmModule {
  peek(ciphertext: Uint8Array): string;
  Device: {
    new (deviceId: string): Device;
    fromSecret(deviceId: string, secret: Uint8Array): Device;
  };
  Group: {
    create(device: Device, conversationId: string, nowMs: number): Group;
    join(device: Device, welcome: Uint8Array, nowMs: number): Group;
    load(device: Device, conversationId: string, nowMs: number): Group | undefined;
  };
}

export function bindWasm(module: WasmModule): CryptoModule {
  return {
    peek: (ciphertext) => {
      const kind = module.peek(ciphertext);
      // Narrowed here rather than trusted: the facade returns a string, and a
      // variant added on the Rust side would otherwise arrive as a `Peeked`
      // this build believes it understands.
      return kind === "welcome" || kind === "group_message" ? (kind as Peeked) : "other";
    },
    newDevice: (deviceId) => new module.Device(deviceId),
    deviceFromSecret: (deviceId, secret) => module.Device.fromSecret(deviceId, secret),
    createGroup: (device, conversationId, nowMs) =>
      module.Group.create(device, conversationId, nowMs),
    joinGroup: (device, welcome, nowMs) => module.Group.join(device, welcome, nowMs),
    loadGroup: (device, conversationId, nowMs) =>
      module.Group.load(device, conversationId, nowMs) ?? undefined,
  };
}

/** The password path stays in the same pinned Rust/WASM build as MLS. */
export function bindPasswordWasm(module: {
  deriveVerifier(
    password: string,
    salt: Uint8Array,
    memoryKiB: number,
    iterations: number,
    parallelism: number,
  ): Uint8Array;
}): PasswordCrypto {
  return {
    deriveVerifier: (password, salt, params) => module.deriveVerifier(
      password, salt, params.memory_kib, params.iterations, params.parallelism,
    ),
  };
}
