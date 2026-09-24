import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CryptoModule, Device, Group, Peeked } from "./crypto";
import { Session } from "./session";
import { Store } from "./store";
import { Transport } from "./transport";
import type { Argon2Params, SessionTokens } from "./types";

const params: Argon2Params = { memory_kib: 65536, iterations: 3, parallelism: 1 };
const tokens = (n: number): SessionTokens => ({
  access_token: `access-${n}`, refresh_token: `refresh-${n}`,
  expires_in: 900, user_id: 7, device_id: "11111111-1111-4111-8111-111111111111",
});
const answer = (status: number, body?: unknown): Response => new Response(
  body === undefined ? null : JSON.stringify(body), { status },
);

class FakeDevice implements Device {
  state = Uint8Array.of(1);
  constructor(readonly secret: Uint8Array) {}
  publicKey(): Uint8Array { return Uint8Array.of(this.secret[0] ?? 0); }
  exportSecret(): Uint8Array { return this.secret.slice(); }
  safetyNumber(): string { return "0000"; }
  keyPackage(): Uint8Array { return Uint8Array.of(42); }
  exportState(): Uint8Array { return this.state.slice(); }
  importState(blob: Uint8Array): void { this.state = blob.slice(); }
}

class FakeCrypto implements CryptoModule {
  restored: FakeDevice | null = null;
  peek(): Peeked { return "other"; }
  newDevice(): Device { return new FakeDevice(Uint8Array.of(9)); }
  deviceFromSecret(_id: string, secret: Uint8Array): Device {
    this.restored = new FakeDevice(secret.slice());
    return this.restored;
  }
  createGroup(): Group { throw new Error("unused"); }
  joinGroup(): Group { throw new Error("unused"); }
  loadGroup(): Group | undefined { return undefined; }
}

let store: Store;
let crypto: FakeCrypto;
const password = { deriveVerifier: vi.fn((_value: string, _salt: Uint8Array, _params: Argon2Params) => Uint8Array.of(10, 11)) };

beforeEach(async () => {
  store = await Store.open("session-test", new IDBFactory());
  crypto = new FakeCrypto();
  password.deriveVerifier.mockClear();
});

function create(
  fetch: typeof globalThis.fetch,
  onEnded?: () => void,
): { session: Session; transport: Transport } {
  const transport = new Transport({ baseUrl: "https://api.example", fetch });
  const session = new Session({
    transport, store, crypto, password,
    ...(onEnded ? { onEnded } : {}),
    uuid: () => "22222222-2222-4222-8222-222222222222",
    randomBytes: (length) => new Uint8Array(length).fill(3),
  });
  return { session, transport };
}

describe("Session", () => {
  it("registers with a local verifier, then atomically stores account, key and refresh token", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: init?.body && JSON.parse(String(init.body)) });
      if (url.endsWith("/salt")) return answer(200, { salt: "00".repeat(16), argon2: params });
      if (url.endsWith("/register")) return answer(201, tokens(1));
      if (url.endsWith("/keypackages")) return answer(204);
      throw new Error(url);
    }) as typeof globalThis.fetch;
    const { session, transport } = create(fetch);

    await expect(session.register("alice", "Alice", "password"))
      .resolves.toEqual({ userId: 7, handle: "alice", displayName: "Alice" });
    expect(password.deriveVerifier).toHaveBeenCalledWith("password", new Uint8Array(16).fill(3), params);
    expect(requests[1]?.body).toMatchObject({
      handle: "alice", pw_salt: "03".repeat(16), pw_verifier: "0a0b", identity_pubkey: "09",
    });
    expect(JSON.stringify(requests)).not.toContain("password");
    expect(await store.account()).toMatchObject({ handle: "alice" });
    expect(await store.identity()).toEqual({ deviceId: tokens(1).device_id, secret: Uint8Array.of(9) });
    expect(await store.refreshToken()).toBe("refresh-1");
    expect(await store.mlsState()).toEqual(Uint8Array.of(1));
    expect(transport.signedIn).toBe(true);
    expect(session.keyPackagesPending).toBe(false);
  });

  it("reuses the identity and MLS state when signing in again", async () => {
    await store.persistSignIn(
      { userId: 7, handle: "alice", displayName: "Alice Original" },
      { deviceId: tokens(1).device_id, secret: Uint8Array.of(17) },
      "old", Uint8Array.of(8, 9),
    );
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/salt")) return answer(200, { salt: "01".repeat(16), argon2: params });
      if (url.endsWith("/login")) return answer(200, tokens(2));
      throw new Error(url);
    }) as typeof globalThis.fetch;
    const { session } = create(fetch);
    expect(await session.login("alice", "password")).toMatchObject({ displayName: "Alice Original" });
    expect(await store.identity()).toEqual({ deviceId: tokens(2).device_id, secret: Uint8Array.of(17) });
    expect(await store.mlsState()).toEqual(Uint8Array.of(8, 9));
  });

  it("restores offline and resumes with a freshly persisted rotated token", async () => {
    await store.persistSignIn(
      { userId: 7, handle: "alice", displayName: "Alice" },
      { deviceId: tokens(1).device_id, secret: Uint8Array.of(9) },
      "refresh-1", Uint8Array.of(5),
    );
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/refresh")) return answer(200, tokens(2));
      if (url.endsWith("/v1/me")) return answer(200, { ok: true });
      throw new Error(url);
    }) as typeof globalThis.fetch;
    const { session, transport } = create(fetch);
    expect(await session.restore()).toMatchObject({ handle: "alice" });
    expect(fetch).not.toHaveBeenCalled();
    expect(crypto.restored?.state).toEqual(Uint8Array.of(5));
    expect(await session.resume()).toMatchObject({ handle: "alice" });
    expect(await store.refreshToken()).toBe("refresh-2");
    await transport.getAuth("/v1/me");
    const authHeader = (vi.mocked(fetch).mock.calls[1]?.[1]?.headers as Record<string, string>).authorization;
    expect(authHeader).toBe("Bearer access-2");
  });

  it("clears a rejected refresh token but preserves offline history", async () => {
    await store.persistSignIn(
      { userId: 7, handle: "alice", displayName: "Alice" },
      { deviceId: tokens(1).device_id, secret: Uint8Array.of(9) },
      "spent", Uint8Array.of(5),
    );
    const fetch = vi.fn().mockResolvedValue(answer(401, { message: "expired" })) as typeof globalThis.fetch;
    const { session } = create(fetch);
    expect(await session.resume()).toBeNull();
    expect(await store.refreshToken()).toBeNull();
    expect(await store.account()).toMatchObject({ handle: "alice" });
  });

  it("hears when the server ends a session in use, and keeps what is on the device", async () => {
    await store.persistSignIn(
      { userId: 7, handle: "alice", displayName: "Alice" },
      { deviceId: tokens(1).device_id, secret: Uint8Array.of(9) },
      "refresh-1", Uint8Array.of(5),
    );
    // Signed in elsewhere since: the refresh this session holds is revoked.
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/refresh") && vi.mocked(fetch).mock.calls.length === 1) {
        return answer(200, tokens(2));
      }
      return answer(401, { message: "revoked" });
    }) as typeof globalThis.fetch;
    const onEnded = vi.fn(async () => {
      // After the dead token is gone, so a restart does not spend it again.
      expect(await store.refreshToken()).toBeNull();
    });
    const { session, transport } = create(fetch, onEnded);
    await session.resume();

    await expect(transport.getAuth("/v1/me")).rejects.toMatchObject({ kind: "invalid_credentials" });

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(await store.refreshToken()).toBeNull();
    // Signing in here again picks this device back up, history and all.
    expect(await store.account()).toMatchObject({ handle: "alice" });
    expect(await store.identity()).not.toBeNull();
    expect(await store.mlsState()).toEqual(Uint8Array.of(5));
  });

  it("wipes locally even when server logout fails", async () => {
    await store.persistSignIn(
      { userId: 7, handle: "alice", displayName: "Alice" },
      { deviceId: tokens(1).device_id, secret: Uint8Array.of(9) },
      "refresh-1", Uint8Array.of(5),
    );
    const fetch = vi.fn().mockRejectedValue(new TypeError("offline")) as typeof globalThis.fetch;
    const { session, transport } = create(fetch);
    transport.adopt(tokens(1));
    await expect(session.logout()).rejects.toMatchObject({ kind: "unreachable" });
    expect(await store.account()).toBeNull();
    expect(await store.identity()).toBeNull();
    expect(await store.refreshToken()).toBeNull();
    expect(transport.signedIn).toBe(false);
  });
});
