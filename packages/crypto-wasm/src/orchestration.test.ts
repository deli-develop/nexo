/**
 * `packages/core` driving the **real** MLS module, with nothing faked but the
 * network.
 *
 * `conversations.test.ts` in core tests ordering against doubles, and doubles
 * agree with whatever the code believes. This one does not: the wasm module
 * here is the one that ships, so a `Group.load` that answers `undefined` where
 * the seam expected a throw, a `kind` string that reads `"Message"` instead of
 * `"message"`, or an epoch that is a Number where the code compares a BigInt
 * are all caught here and nowhere else.
 *
 * It lives in this package rather than in core because it needs the built
 * `pkg/`, and core's suite has to stay runnable without a Rust toolchain.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";

import * as conversations from "../../core/src/conversations";
import { Store } from "../../core/src/store";
import { Transport } from "../../core/src/transport";
import { bindObjectWasm, bindWasm, type WasmModule } from "../../core/src/wasm";
import type { ConversationSummary, Envelope } from "../../core/src/types";

import * as wasm from "../pkg/nexo_crypto_wasm.js";

const ALICE_DEVICE = "11111111-1111-4111-8111-111111111111";
const BOB_DEVICE = "22222222-2222-4222-8222-222222222222";

/**
 * A delivery service in about forty lines.
 *
 * It does the two things the real one does and nothing else: it stores
 * envelopes in arrival order and hands back the ones after a cursor. It never
 * looks inside a ciphertext, which is the same promise `apps/server` makes,
 * and it is why this test can be honest about what the server contributes —
 * nothing but ordering.
 */
class FakeServer {
  envelopes: Envelope[] = [];
  conversations = new Map<string, ConversationSummary>();
  keyPackages = new Map<string, string[]>();
  #nextId = 1;

  handle(method: string, path: string, body: Record<string, unknown>): unknown {
    if (path === "/v1/keypackages" && method === "POST") {
      // Whoever publishes is whoever the test says; one device per handle here.
      const [handle] = [...this.keyPackages.keys()].slice(-1);
      this.keyPackages.set(handle ?? "bob", body["key_packages"] as string[]);
      return {};
    }
    if (path.startsWith("/v1/keypackages/") && method === "GET") {
      const handle = decodeURIComponent(path.slice("/v1/keypackages/".length));
      const packages = this.keyPackages.get(handle);
      const one = packages?.shift();
      if (!one) throw new Error(`no key package left for ${handle}`);
      // Single-use, and spent by the claiming. The shift above *is* the rule.
      return { device_id: BOB_DEVICE, key_package: one };
    }
    if (path === "/v1/conversations" && method === "POST") {
      const id = body["conversation_id"] as string;
      const summary: ConversationSummary = {
        conversation_id: id,
        kind: "dm",
        epoch: 0,
        latest_envelope_id: null,
        members: ["alice", "bob"],
      };
      this.conversations.set(id, summary);
      return summary;
    }
    if (path === "/v1/conversations" && method === "GET") {
      return [...this.conversations.values()];
    }
    if (path.endsWith("/send")) {
      const id = path.slice("/v1/conversations/".length, -"/send".length);
      const envelope: Envelope = {
        envelope_id: this.#nextId++,
        conversation_id: id,
        sender_device_id: body["sender"] as string,
        epoch: body["epoch"] as number,
        ciphertext: body["ciphertext"] as string,
        server_timestamp_ms: 1_700_000_000_000 + this.#nextId,
        is_commit: body["is_commit"] as boolean,
      };
      this.envelopes.push(envelope);
      const summary = this.conversations.get(id);
      if (summary) summary.latest_envelope_id = envelope.envelope_id;
      return { envelope_id: envelope.envelope_id, epoch: envelope.epoch };
    }
    if (path.includes("/sync")) {
      const [prefix, query] = path.split("?");
      const id = prefix!.slice("/v1/conversations/".length, -"/sync".length);
      const since = Number(new URLSearchParams(query).get("since_id") ?? 0);
      return this.envelopes.filter((e) => e.conversation_id === id && e.envelope_id > since);
    }
    throw new Error(`the fake server has no ${method} ${path}`);
  }
}

/** One client: its own store, its own device, its own view of the server. */
async function client(server: FakeServer, deviceId: string, handle: string) {
  const transport = new Transport({
    baseUrl: "https://api.test",
    fetch: (async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      // The sender is stamped by the server from the bearer token. Here the
      // device id stands in for it, which is the only shortcut in this file.
      const answer = server.handle(init.method ?? "GET", parsed.pathname + parsed.search, {
        ...body,
        sender: deviceId,
      });
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch,
  });
  transport.adopt({ access_token: "a", refresh_token: "r" });

  const store = await Store.open(`orchestration-${handle}`, new IDBFactory());
  await store.setIdentity({ deviceId, secret: Uint8Array.of(0) });
  await store.setAccount({ userId: 1, handle, displayName: handle });

  const crypto = bindWasm(wasm as unknown as WasmModule);
  const ctx: conversations.Context = {
    transport,
    store,
    crypto,
    device: crypto.newDevice(deviceId),
    now: () => 1_700_000_000_000,
  };
  return { ctx, store };
}

describe("core over the real MLS module", () => {
  beforeAll(() => {
    wasm.initPanicHook();
  });

  it("carries a message from one device to another and back", async () => {
    const server = new FakeServer();
    const alice = await client(server, ALICE_DEVICE, "alice");
    const bob = await client(server, BOB_DEVICE, "bob");

    // Bob publishes, so there is something for Alice to claim. Without this
    // nobody can reach him, and nothing he does would tell him so.
    server.keyPackages.set("bob", []);
    await conversations.publishKeyPackages(bob.ctx, 2);

    const id = await conversations.startWith(alice.ctx, "bob");

    // Bob learns of the conversation only through the server's list: MLS
    // credentials name devices, and he was added without being asked.
    expect(await conversations.discover(bob.ctx)).toContain(id);

    // The Welcome is in that stream, as an ordinary envelope.
    const joined = await conversations.sync(bob.ctx, id);
    expect(joined.joined).toBe(true);
    expect(joined.failed).toBe(0);

    await conversations.send(alice.ctx, id, "the mountains are out");
    const read = await conversations.sync(bob.ctx, id);

    expect(read.failed).toBe(0);
    expect(read.messages).toBe(1);
    expect((await bob.store.messages(id))[0]?.body).toBe("the mountains are out");

    // And back the other way, which is the half a one-directional test misses:
    // Bob's ratchet has to have moved into the same epoch Alice's did.
    await conversations.send(bob.ctx, id, "so they are");
    const back = await conversations.sync(alice.ctx, id);
    expect(back.failed).toBe(0);
    expect(back.messages).toBe(1);
    expect((await alice.store.messages(id)).map((m) => m.body)).toContain("so they are");
  });

  it("does not report a sender's own envelopes as unreadable", async () => {
    const server = new FakeServer();
    const alice = await client(server, ALICE_DEVICE, "alice");
    const bob = await client(server, BOB_DEVICE, "bob");
    server.keyPackages.set("bob", []);
    await conversations.publishKeyPackages(bob.ctx, 1);

    const id = await conversations.startWith(alice.ctx, "bob");
    await conversations.send(alice.ctx, id, "hello");

    // Alice syncs her own conversation. Every envelope in it is hers, and MLS
    // genuinely cannot decrypt any of them — the ratchet moved on as she
    // encrypted. Anything other than zero here is the bug that shows a sender
    // "a message could not be read" about the message they just sent.
    const outcome = await conversations.sync(alice.ctx, id);
    expect(outcome.failed).toBe(0);
  });

  it("survives a sync that arrives with nothing new", async () => {
    const server = new FakeServer();
    const alice = await client(server, ALICE_DEVICE, "alice");
    const bob = await client(server, BOB_DEVICE, "bob");
    server.keyPackages.set("bob", []);
    await conversations.publishKeyPackages(bob.ctx, 1);

    const id = await conversations.startWith(alice.ctx, "bob");
    await conversations.sync(bob.ctx, id);
    const second = await conversations.sync(bob.ctx, id);

    // The cursor held. A second pass that re-read the batch would decrypt
    // every envelope twice, and MLS refuses the second time — which is how a
    // cursor bug surfaces as "failed", not as duplicates.
    expect(second).toMatchObject({ messages: 0, failed: 0 });
  });
});

describe("sealing objects with the real module", () => {
  it("round-trips an attachment through the seam core uses", async () => {
    const crypto = bindObjectWasm(wasm as never);
    const plaintext = new TextEncoder().encode("the file nobody else may read");

    const sealed = crypto.seal(plaintext);

    // A third party holds this. The whole arrangement is that what it holds
    // is not the thing.
    expect(sealed.ciphertext).not.toEqual(plaintext);
    expect(sealed.size).toBe(plaintext.byteLength);
    // `u64` crosses the boundary as a BigInt, and one that reached a JSON
    // payload would serialise as a throw rather than a number.
    expect(typeof sealed.size).toBe("number");

    const opened = crypto.open(sealed.ciphertext, sealed.key, sealed.nonce, sealed.sha256);
    expect(new TextDecoder().decode(opened)).toBe("the file nobody else may read");
  });

  it("refuses an object that is not the one the message named", async () => {
    const crypto = bindObjectWasm(wasm as never);
    const sealed = crypto.seal(new TextEncoder().encode("the real one"));
    const otherHash = crypto.seal(new TextEncoder().encode("a different file")).sha256;

    // AES-GCM proves the object store did not alter these bytes. It does not
    // prove they are the bytes the message named — the hash, which travelled
    // inside the encrypted payload, is the only thing that does.
    expect(() =>
      crypto.open(sealed.ciphertext, sealed.key, sealed.nonce, otherHash),
    ).toThrow();
  });
});
