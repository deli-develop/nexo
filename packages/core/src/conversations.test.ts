import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as conversations from "./conversations";
import type { CryptoModule, Decrypted, Device, Group, Member, Peeked, StagedCommit } from "./crypto";
import { Store } from "./store";
import { Transport } from "./transport";
import type { Envelope } from "./types";

/**
 * The MLS orchestration, against doubles.
 *
 * These are not tests of cryptography — `crates/crypto` has those, and they
 * run against the real OpenMLS. These are tests of **ordering**, which is
 * where this file can lose messages: a commit confirmed before the server
 * accepted it, a Welcome never sent, a cursor that moves past a message that
 * was not stored. Every one of those is silent in production and obvious here.
 */

// ------------------------------------------------------------------- doubles

/**
 * A group that records what was asked of it.
 *
 * `confirmed` and `abandoned` are the whole point: exactly one of them must
 * happen per staged commit, and which one depends on what the server said.
 */
class FakeGroup implements Group {
  epoch = 1n;
  memberCount = 1;
  confirmed = 0;
  abandoned = 0;
  staged: StagedCommit | null = null;
  encrypted: Uint8Array[] = [];
  /** Who the group says is in it. A test sets this to change membership. */
  roster: Member[] = [];

  /** Shared with the module, so a group made mid-sync still has its answers. */
  constructor(readonly answers: Array<Decrypted | "throw">) {}

  addMember(_device: Device, _keyPackage: Uint8Array): StagedCommit {
    this.staged = { message: Uint8Array.of(0xc0), welcome: Uint8Array.of(0x11, 0x00) };
    return this.staged;
  }
  confirmCommit(): bigint {
    this.confirmed += 1;
    this.epoch += 1n;
    this.memberCount += 1;
    return this.epoch;
  }
  abandonCommit(): void {
    this.abandoned += 1;
  }
  members(): Member[] {
    return this.roster;
  }
  encrypt(_device: Device, plaintext: Uint8Array): Uint8Array {
    this.encrypted.push(plaintext);
    return Uint8Array.of(0xaa, plaintext.length & 0xff);
  }
  decrypt(): Decrypted {
    const answer = this.answers.shift();
    if (answer === undefined || answer === "throw") throw new Error("will not decrypt");
    return answer;
  }
}

class FakeDevice implements Device {
  state: Uint8Array = Uint8Array.of(1);
  publicKey(): Uint8Array {
    return Uint8Array.of(9);
  }
  exportSecret(): Uint8Array {
    return Uint8Array.of(8);
  }
  safetyNumber(): string {
    return "0000 0000";
  }
  keyPackage(): Uint8Array {
    return Uint8Array.of(0x42);
  }
  exportState(): Uint8Array {
    return this.state;
  }
  importState(blob: Uint8Array): void {
    this.state = blob;
  }
}

class FakeCrypto implements CryptoModule {
  group: FakeGroup | undefined;
  /** What `peek` answers, keyed by the first byte of the ciphertext. */
  peeks = new Map<number, Peeked>();
  /** Queued answers for `decrypt`; an empty queue throws, as MLS would. */
  answers: Array<Decrypted | "throw"> = [];
  joins = 0;
  joinThrows = false;

  peek(ciphertext: Uint8Array): Peeked {
    return this.peeks.get(ciphertext[0] ?? -1) ?? "group_message";
  }
  newDevice(): Device {
    return new FakeDevice();
  }
  deviceFromSecret(): Device {
    return new FakeDevice();
  }
  createGroup(): Group {
    this.group = new FakeGroup(this.answers);
    return this.group;
  }
  joinGroup(): Group {
    if (this.joinThrows) throw new Error("not for us");
    this.joins += 1;
    this.group ??= new FakeGroup(this.answers);
    return this.group;
  }
  loadGroup(): Group | undefined {
    return this.group;
  }
}

// --------------------------------------------------------------- the harness

/** One queued HTTP answer. */
type Answer = { status: number; body: unknown } | { throws: TypeError };

function harness(answers: Answer[]) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const answer = answers.shift();
    calls.push({
      method: init.method ?? "GET",
      path: new URL(url).pathname + new URL(url).search,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (!answer) throw new Error(`no answer queued for ${init.method} ${url}`);
    if ("throws" in answer) throw answer.throws;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  });

  const transport = new Transport({
    baseUrl: "https://api.example",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  transport.adopt({ access_token: "a", refresh_token: "r" });
  return { transport, calls };
}

async function context(answers: Answer[]) {
  const { transport, calls } = harness(answers);
  const store = await Store.open(`test-${Math.random()}`, new IDBFactory());
  const crypto = new FakeCrypto();
  const ctx: conversations.Context = {
    transport,
    store,
    crypto,
    device: new FakeDevice(),
    now: () => 1_000_000,
    uuid: (() => {
      let n = 0;
      return () => `id-${(n += 1)}`;
    })(),
  };
  return { ctx, store, crypto, calls };
}

const envelope = (over: Partial<Envelope> & Pick<Envelope, "envelope_id">): Envelope => ({
  conversation_id: "c1",
  sender_device_id: "them",
  epoch: 1,
  ciphertext: "aa00",
  server_timestamp_ms: 1_000_000,
  is_commit: false,
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------- the tests

describe("starting a conversation", () => {
  it("refuses a malformed claimed KeyPackage before creating a server row", async () => {
    const { ctx, calls } = await context([
      { status: 200, body: { device_id: "d2", key_package: "0g" } },
    ]);
    await expect(conversations.startWith(ctx, "ada")).rejects.toMatchObject({
      kind: "rejected",
    });
    expect(calls.map((call) => call.path)).toEqual(["/v1/keypackages/ada"]);
  });

  it("sends the Welcome after the commit, as an ordinary envelope", async () => {
    const { ctx, calls } = await context([
      { status: 200, body: { device_id: "d2", key_package: "beef" } },
      { status: 201, body: { conversation_id: "id-1", kind: "dm", epoch: 1, latest_envelope_id: null, members: ["me", "ada"] } },
      { status: 200, body: { envelope_id: 1, epoch: 2 } },
      { status: 200, body: { envelope_id: 2, epoch: 2 } },
    ]);

    await conversations.startWith(ctx, "ada");

    // The Welcome is the reason the other person can read anything. It travels
    // on the conversation's own stream, after the commit, not as a commit.
    const sends = calls.filter((call) => call.path.endsWith("/send"));
    expect(sends).toHaveLength(2);
    expect((sends[0]!.body as { is_commit: boolean }).is_commit).toBe(true);
    expect((sends[1]!.body as { is_commit: boolean }).is_commit).toBe(false);
  });

  it("abandons the commit when the delivery service refuses it", async () => {
    const { ctx, crypto } = await context([
      { status: 200, body: { device_id: "d2", key_package: "beef" } },
      { status: 201, body: { conversation_id: "id-1", kind: "dm", epoch: 1, latest_envelope_id: null, members: [] } },
      { status: 409, body: { error: "stale_epoch", message: "no", current_epoch: 7 } },
    ]);

    await expect(conversations.startWith(ctx, "ada")).rejects.toThrow();

    // Confirming a commit the server never took would move this device to an
    // epoch nobody else is in — and every message after it would be
    // unreadable to everyone, for ever.
    expect(crypto.group!.confirmed).toBe(0);
    expect(crypto.group!.abandoned).toBe(1);
  });

  it("adopts the conversation the server hands back instead", async () => {
    const { ctx, store, crypto } = await context([
      { status: 200, body: { device_id: "d2", key_package: "beef" } },
      { status: 200, body: { conversation_id: "theirs", kind: "dm", epoch: 3, latest_envelope_id: 4, members: ["me", "ada"] } },
    ]);

    const id = await conversations.startWith(ctx, "ada");

    expect(id).toBe("theirs");
    expect(crypto.group!.abandoned).toBe(1);
    // And the cursor starts at zero, not at the server's latest: their
    // Welcome is *in* that history and skipping to the end would skip it.
    expect((await store.conversation("theirs"))?.syncedTo).toBe(0);
  });

  it("reuses saved messages locally and adopts the server's one self conversation", async () => {
    const { ctx, store, calls } = await context([
      { status: 200, body: {
        conversation_id: "id-1", kind: "self", epoch: 1,
        latest_envelope_id: null, members: [],
      } },
    ]);

    expect(await conversations.startSelf(ctx)).toBe("id-1");
    expect(await conversations.startSelf(ctx)).toBe("id-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ conversation_id: "id-1", members: [] });
    expect(await store.conversation("id-1")).toMatchObject({
      kind: "self", title: conversations.SELF_TITLE, syncedTo: 0,
    });
    expect(await store.mlsState()).not.toBeNull();
  });

  it("claims everyone before group creation, commits each member, then sends the title", async () => {
    const { ctx, store, crypto, calls } = await context([
      { status: 200, body: { device_id: "d2", key_package: "beef" } },
      { status: 200, body: { device_id: "d3", key_package: "cafe" } },
      { status: 201, body: {
        conversation_id: "id-1", kind: "group", epoch: 1,
        latest_envelope_id: null, members: ["me", "ada", "bob"],
      } },
      { status: 200, body: { envelope_id: 1, epoch: 2 } },
      { status: 200, body: { envelope_id: 2, epoch: 2 } },
      { status: 200, body: { envelope_id: 3, epoch: 3 } },
      { status: 200, body: { envelope_id: 4, epoch: 3 } },
      { status: 200, body: { envelope_id: 5, epoch: 3 } },
    ]);

    expect(await conversations.startGroup(ctx, ["ada", "bob"], "Weekend plans"))
      .toBe("id-1");

    expect(calls.slice(0, 3).map((call) => call.path)).toEqual([
      "/v1/keypackages/ada", "/v1/keypackages/bob", "/v1/conversations",
    ]);
    expect(calls.filter((call) => call.path.endsWith("/send"))
      .map((call) => (call.body as { is_commit: boolean }).is_commit))
      .toEqual([true, false, true, false, false]);
    expect(JSON.parse(new TextDecoder().decode(crypto.group!.encrypted[0]))).toEqual({
      kind: "rename", title: "Weekend plans",
    });
    expect(crypto.group!.confirmed).toBe(2);
    expect(await store.conversation("id-1")).toMatchObject({
      kind: "group", title: "Weekend plans", epoch: 3,
    });
  });

  it("keeps an accepted group commit even when its Welcome fails", async () => {
    const { ctx, store, crypto } = await context([
      { status: 200, body: { device_id: "d2", key_package: "beef" } },
      { status: 201, body: {
        conversation_id: "id-1", kind: "dm", epoch: 1,
        latest_envelope_id: null, members: ["me", "ada"],
      } },
      { status: 200, body: { envelope_id: 1, epoch: 2 } },
      { status: 503, body: { error: "offline", message: "No reply" } },
    ]);

    await expect(conversations.startGroup(ctx, ["ada"], "Plans")).rejects.toThrow();
    expect(crypto.group!.confirmed).toBe(1);
    expect(crypto.group!.abandoned).toBe(0);
    expect(await store.mlsState()).not.toBeNull();
    expect((await store.conversation("id-1"))?.epoch).toBe(2);
  });
});

describe("adding a member", () => {
  it("creates the routing row before committing and sends Welcome last", async () => {
    const { ctx, crypto, calls, store } = await context([
      { status: 200, body: { device_id: "d3", key_package: "cafe" } },
      { status: 204, body: undefined },
      { status: 200, body: { envelope_id: 2, epoch: 2 } },
      { status: 200, body: { envelope_id: 3, epoch: 2 } },
    ]);
    crypto.createGroup();
    crypto.group!.memberCount = 2;
    await store.putConversation({
      id: "c1", title: "Ada", kind: "dm", epoch: 1, syncedTo: 1,
      lastMessage: null, updatedAtMs: 0,
    });

    await conversations.addTo(ctx, "c1", "bob");

    expect(calls.map((call) => call.path)).toEqual([
      "/v1/keypackages/bob", "/v1/conversations/c1/members",
      "/v1/conversations/c1/send", "/v1/conversations/c1/send",
    ]);
    expect((calls[2]!.body as { is_commit: boolean }).is_commit).toBe(true);
    expect((calls[3]!.body as { is_commit: boolean }).is_commit).toBe(false);
    expect(crypto.group!.confirmed).toBe(1);
    expect(await store.conversation("c1")).toMatchObject({ kind: "group", epoch: 2 });
  });

  it("abandons a refused add commit and keeps the original MLS epoch", async () => {
    const { ctx, crypto, store } = await context([
      { status: 200, body: { device_id: "d3", key_package: "cafe" } },
      { status: 204, body: undefined },
      { status: 409, body: { message: "stale", current_epoch: 3 } },
    ]);
    crypto.createGroup();
    await expect(conversations.addTo(ctx, "c1", "bob")).rejects.toThrow();
    expect(crypto.group!.confirmed).toBe(0);
    expect(crypto.group!.abandoned).toBe(1);
    expect(crypto.group!.epoch).toBe(1n);
    expect(await store.mlsState()).not.toBeNull();
  });
});

describe("opening a direct conversation", () => {
  it("syncs a pending Welcome before returning a usable conversation", async () => {
    const { ctx, crypto, store, calls } = await context([
      { status: 200, body: [{
        conversation_id: "c1", kind: "dm", epoch: 2,
        latest_envelope_id: 2, members: ["me", "ada"],
      }] },
      { status: 200, body: [envelope({ envelope_id: 2, ciphertext: "1100" })] },
    ]);
    await store.setAccount({ userId: 1, handle: "me", displayName: "Me" });
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    crypto.peeks.set(0x11, "welcome");

    expect(await conversations.openWith(ctx, " ADA ")).toBe("c1");
    expect(crypto.joins).toBe(1);
    expect((await store.conversation("c1"))?.syncedTo).toBe(2);
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/conversations", "/v1/conversations/c1/sync?since_id=0",
    ]);
  });

  it("leaves a DM with no Welcome so the server can create a usable one", async () => {
    const { ctx, store, calls } = await context([
      { status: 200, body: [{
        conversation_id: "dead", kind: "dm", epoch: 2,
        latest_envelope_id: 1, members: ["me", "ada"],
      }] },
      { status: 200, body: [envelope({ envelope_id: 1, conversation_id: "dead" })] },
      { status: 204, body: undefined },
      { status: 200, body: { device_id: "d2", key_package: "beef" } },
      { status: 201, body: {
        conversation_id: "id-1", kind: "dm", epoch: 1,
        latest_envelope_id: null, members: ["me", "ada"],
      } },
      { status: 200, body: { envelope_id: 2, epoch: 2 } },
      { status: 200, body: { envelope_id: 3, epoch: 2 } },
    ]);
    await store.setAccount({ userId: 1, handle: "me", displayName: "Me" });

    expect(await conversations.openWith(ctx, "ada")).toBe("id-1");
    expect(calls[2]).toMatchObject({
      path: "/v1/conversations/dead/members/remove", body: { handle: "me" },
    });
    expect(calls[3]!.path).toBe("/v1/keypackages/ada");
    expect(await store.conversation("dead")).toBeNull();
  });
});

describe("sending", () => {
  it("queues rather than losing a message when the network is gone", async () => {
    const { ctx, store, crypto } = await context([{ throws: new TypeError("fetch failed") }]);
    crypto.createGroup();
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0, lastMessage: null, updatedAtMs: 0,
    });

    const result = await conversations.send(ctx, "c1", "hello");

    expect(result).toBeNull();
    const queued = await store.outbox();
    expect(queued).toHaveLength(1);
    // Encrypted, because the queue holds no plaintext — a device somebody
    // picks up mid-flight must not have readable messages sitting in it.
    expect(queued[0]!.ciphertext).not.toContain("hello");
    // And the ratchet moved during that encrypt, so the state has to have
    // been written back even though nothing was sent.
    expect(await store.mlsState()).not.toBeNull();
  });

  it("keeps no key in the sender's own copy of a view-once", async () => {
    const { ctx, store, crypto } = await context([{ status: 200, body: { envelope_id: 11 } }]);
    crypto.createGroup();
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0, lastMessage: null, updatedAtMs: 0,
    });

    await conversations.sendPayload(ctx, "c1", {
      kind: "view_once", s3_key: "obj/2", key: "sender-key", nonce: "nn", sha256: "hh",
      mime: "video/mp4", size: 5, id: "once-2",
    });

    const [row] = await store.messages("c1");
    expect(row).toMatchObject({ id: 11, clientId: "once-2", senderDeviceId: null });
    expect(row!.payload).not.toContain("sender-key");
    expect(await store.viewOnce("once-2")).toBeNull();
  });

  it("writes to history only after the server has it", async () => {
    const { ctx, store, crypto } = await context([
      { status: 400, body: { error: "invalid_request", message: "no" } },
    ]);
    crypto.createGroup();
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0, lastMessage: null, updatedAtMs: 0,
    });

    await expect(conversations.send(ctx, "c1", "hello")).rejects.toThrow();

    // A message in history the server refused is a message the sender
    // believes arrived.
    expect(await store.messages("c1")).toHaveLength(0);
  });
});

describe("syncing", () => {
  it("keeps a removed conversation hidden until a newer envelope appears", async () => {
    const listed = (latest: number) => [{
      conversation_id: "c1", kind: "dm", epoch: 1,
      latest_envelope_id: latest, members: ["me", "ada"],
    }];
    const { ctx, store } = await context([
      { status: 200, body: listed(5) },
      { status: 200, body: listed(6) },
    ]);
    await store.setAccount({ userId: 1, handle: "me", displayName: "Me" });
    await store.putConversation({
      id: "c1", title: "ada", kind: "dm", epoch: 1, syncedTo: 5,
      lastMessage: null, updatedAtMs: 0,
    });
    await store.forgetConversation("c1");

    expect(await conversations.discover(ctx)).toEqual([]);
    expect(await store.conversation("c1")).toBeNull();
    expect(await conversations.discover(ctx)).toEqual(["c1"]);
    expect((await store.conversation("c1"))?.syncedTo).toBe(5);
    expect((await store.forgottenConversations()).has("c1")).toBe(false);
  });

  it("an explicit open lifts a removal without replaying deleted history", async () => {
    const { ctx, store, crypto } = await context([{ status: 200, body: [{
      conversation_id: "c1", kind: "dm", epoch: 1,
      latest_envelope_id: 5, members: ["me", "ada"],
    }] }]);
    crypto.createGroup();
    await store.setAccount({ userId: 1, handle: "me", displayName: "Me" });
    await store.putConversation({
      id: "c1", title: "ada", kind: "dm", epoch: 1, syncedTo: 5,
      lastMessage: null, updatedAtMs: 0,
    });
    await store.forgetConversation("c1");

    expect(await conversations.openWith(ctx, "ada")).toBe("c1");
    expect((await store.conversation("c1"))?.syncedTo).toBe(5);
    expect((await store.forgottenConversations()).has("c1")).toBe(false);
  });

  it("stores a story key without a chat bubble, and never stores an expired key", async () => {
    const { ctx, store, crypto } = await context([{ status: 200, body: [
      envelope({ envelope_id: 7 }), envelope({ envelope_id: 8, server_timestamp_ms: 1_000_001 }),
    ] }]);
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0,
      lastMessage: null, updatedAtMs: 0,
    });
    crypto.createGroup();
    const story = {
      kind: "story", story_id: 42, s3_key: "story/x", key: "aa", nonce: "bb",
      sha256: "cc", mime: "image/png", size: 3, expires_at_ms: 1_000_010,
    };
    crypto.answers.push(
      { kind: "message", sender: "them", plaintext: new TextEncoder().encode(JSON.stringify(story)), epoch: 1n },
      { kind: "message", sender: "them", plaintext: new TextEncoder().encode(JSON.stringify({
        ...story, story_id: 43, expires_at_ms: 1_000_000,
      })), epoch: 1n },
    );

    const outcome = await conversations.sync(ctx, "c1");

    expect(outcome.messages).toBe(0);
    expect((await store.conversation("c1"))?.syncedTo).toBe(8);
    expect(await store.messages("c1")).toEqual([]);
    expect(await store.liveStories(1_000_000)).toMatchObject([{
      id: 42, authorHandle: "", authorDeviceId: "them", s3Key: "story/x",
      encKey: "aa", expiresAtMs: 1_000_010,
    }]);
  });

  it("keeps an arriving view-once's key in its own table, never in the message", async () => {
    const { ctx, store, crypto } = await context([{ status: 200, body: [envelope({ envelope_id: 9 })] }]);
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0, lastMessage: null, updatedAtMs: 0,
    });
    crypto.createGroup();
    crypto.answers.push({
      kind: "message",
      sender: "them",
      plaintext: new TextEncoder().encode(JSON.stringify({
        kind: "view_once", s3_key: "obj/1", key: "the-key", nonce: "nn", sha256: "hh",
        mime: "image/png", size: 3, id: "once-1",
      })),
      epoch: 1n,
    });

    await conversations.sync(ctx, "c1");

    // Opening reads this table and nothing else, and burning it is what makes
    // "once" true. A key in the message row outlives the burn.
    const [row] = await store.messages("c1");
    expect(row).toMatchObject({ id: 9, clientId: "once-1", senderDeviceId: "them" });
    expect(row!.payload).not.toContain("the-key");
    expect(JSON.parse(row!.payload!)).toEqual({ kind: "view_once", id: "once-1", mime: "image/png", size: 3 });
    expect(await store.viewOnce("once-1")).toMatchObject({
      conversationId: "c1", s3Key: "obj/1", encKey: "the-key", nonce: "nn", sha256: "hh",
      mime: "image/png", size: 3, openedAtMs: null,
    });
  });

  it("records every other member's key on sync, and never this device's", async () => {
    const { ctx, store, crypto } = await context([{ status: 200, body: [envelope({ envelope_id: 3 })] }]);
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0, lastMessage: null, updatedAtMs: 0,
    });
    crypto.createGroup();
    crypto.group!.roster = [
      { deviceId: "mine", identityKey: Uint8Array.of(1) },
      { deviceId: "them", identityKey: Uint8Array.of(2) },
    ];
    crypto.answers.push({
      kind: "message", sender: "them", epoch: 1n,
      plaintext: new TextEncoder().encode(JSON.stringify({ kind: "text", body: "hi" })),
    });

    await conversations.sync(ctx, "c1");

    // The safety number is computed from this, and nothing wrote it before.
    expect(await store.peers("c1")).toMatchObject([
      { deviceId: "them", identityKey: Uint8Array.of(2), verifiedKey: null, changedAtMs: null },
    ]);
  });

  it("records a quiet conversation's keys once, with nothing new to sync", async () => {
    // A conversation that existed before keys were recorded, and has had no
    // message since: sync stopped at "nothing new" and never read membership,
    // so it showed no safety number until somebody wrote.
    const { ctx, store, crypto } = await context([
      { status: 200, body: [] },
      { status: 200, body: [] },
    ]);
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 5, lastMessage: null, updatedAtMs: 0,
    });
    crypto.createGroup();
    crypto.group!.roster = [
      { deviceId: "mine", identityKey: Uint8Array.of(1) },
      { deviceId: "them", identityKey: Uint8Array.of(2) },
    ];

    await conversations.sync(ctx, "c1");
    expect(await store.peers("c1")).toMatchObject([
      { deviceId: "them", identityKey: Uint8Array.of(2), changedAtMs: null },
    ]);

    // Once recorded, a quiet pass leaves the group alone: it runs every few
    // seconds for every conversation.
    const load = vi.spyOn(crypto, "loadGroup");
    await conversations.sync(ctx, "c1");
    expect(load).not.toHaveBeenCalled();
  });

  it("does not reload a conversation with yourself on every quiet pass", async () => {
    const { ctx, store, crypto } = await context([{ status: 200, body: [] }]);
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    await store.putConversation({
      id: "c1", title: null, kind: "self", epoch: 1, syncedTo: 5, lastMessage: null, updatedAtMs: 0,
    });
    crypto.createGroup();
    const load = vi.spyOn(crypto, "loadGroup");

    await conversations.sync(ctx, "c1");

    // Nobody else is in it, so nothing will ever be recorded, and "nothing
    // recorded yet" would otherwise be true on every pass for ever.
    expect(load).not.toHaveBeenCalled();
  });

  it("flags a changed key on a later sync, which is what the warning is for", async () => {
    const { ctx, store, crypto } = await context([
      { status: 200, body: [envelope({ envelope_id: 3 })] },
      { status: 200, body: [envelope({ envelope_id: 4 })] },
    ]);
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0, lastMessage: null, updatedAtMs: 0,
    });
    crypto.createGroup();
    const text = (body: string) => ({
      kind: "message" as const, sender: "them", epoch: 1n,
      plaintext: new TextEncoder().encode(JSON.stringify({ kind: "text", body })),
    });
    crypto.answers.push(text("first"), text("second"));

    crypto.group!.roster = [{ deviceId: "them", identityKey: Uint8Array.of(2) }];
    await conversations.sync(ctx, "c1");
    // A key a server substituted between the two passes.
    crypto.group!.roster = [{ deviceId: "them", identityKey: Uint8Array.of(9) }];
    await conversations.sync(ctx, "c1");

    const [peer] = await store.peers("c1");
    expect(peer).toMatchObject({ deviceId: "them", identityKey: Uint8Array.of(9) });
    expect(peer!.changedAtMs).not.toBeNull();
  });

  it("joins from a Welcome and skips everything at or before it", async () => {
    const { ctx, store, crypto } = await context([
      {
        status: 200,
        body: [
          envelope({ envelope_id: 1, ciphertext: "aa01" }),
          envelope({ envelope_id: 2, ciphertext: "1100" }),
          envelope({ envelope_id: 3, ciphertext: "aa03" }),
        ],
      },
    ]);
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0, lastMessage: null, updatedAtMs: 0,
    });
    // Not a member yet: `loadGroup` answers nothing until the Welcome lands.
    crypto.peeks.set(0x11, "welcome");
    crypto.answers.push({
      kind: "message",
      sender: "them",
      plaintext: new TextEncoder().encode("hi"),
      epoch: 2n,
    });

    const outcome = await conversations.sync(ctx, "c1");

    expect(outcome.joined).toBe(true);
    // Envelopes 1 and 2 are at or before the Welcome, and MLS is explicit
    // that a member added at epoch N cannot read anything before N. They are
    // skipped rather than failed — counting them would raise "a message could
    // not be read" on every single invitation.
    expect(outcome.skipped).toBe(2);
    expect(outcome.failed).toBe(0);
    expect(outcome.messages).toBe(1);
    expect((await store.conversation("c1"))?.syncedTo).toBe(3);
  });

  it("does not count our own envelopes as unreadable", async () => {
    const { ctx, store, crypto } = await context([
      { status: 200, body: [envelope({ envelope_id: 5, sender_device_id: "mine" })] },
    ]);
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0, lastMessage: null, updatedAtMs: 0,
    });
    crypto.createGroup();

    const outcome = await conversations.sync(ctx, "c1");

    // MLS cannot decrypt what this device encrypted — the ratchet moved on.
    // Handing it to `decrypt` would fail every time and be reported as a lost
    // message the sender is looking at.
    expect(outcome).toMatchObject({ failed: 0, messages: 0, skipped: 0 });
    expect((await store.conversation("c1"))?.syncedTo).toBe(5);
  });

  it("moves the cursor past envelopes that stored nothing", async () => {
    const { ctx, store, crypto } = await context([
      { status: 200, body: [envelope({ envelope_id: 7 })] },
    ]);
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0, lastMessage: null, updatedAtMs: 0,
    });
    crypto.createGroup();
    crypto.answers.push(
      {
        kind: "message",
        sender: "them",
        plaintext: new TextEncoder().encode(
          JSON.stringify({ kind: "reaction", target: "m1", emoji: "👍", on: true }),
        ),
        epoch: 1n,
      },
    );

    const outcome = await conversations.sync(ctx, "c1");

    // A reaction draws no bubble, so nothing was appended — and without the
    // cursor moving anyway, this batch would be fetched again for ever.
    expect(outcome.messages).toBe(0);
    expect((await store.conversation("c1"))?.syncedTo).toBe(7);
    expect(await store.reactions("c1")).toHaveLength(1);
  });

  it("counts a message that will not decrypt rather than hiding it", async () => {
    const { ctx, store, crypto } = await context([
      { status: 200, body: [envelope({ envelope_id: 8 })] },
    ]);
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0, lastMessage: null, updatedAtMs: 0,
    });
    crypto.createGroup();
    crypto.answers.push("throw");

    const outcome = await conversations.sync(ctx, "c1");

    expect(outcome.failed).toBe(1);
    expect(await store.messages("c1")).toHaveLength(0);
  });
});

describe("revisions", () => {
  async function withMessage() {
    const made = await context([]);
    await made.store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 1, syncedTo: 0, lastMessage: null, updatedAtMs: 0,
    });
    await made.store.appendMessage({
      id: 1,
      conversationId: "c1",
      senderDeviceId: "them",
      body: "the original",
      sentAtMs: 1_000_000,
      clientId: "m1",
    });
    return made;
  }

  it("applies an edit from the device that sent the message", async () => {
    const { store } = await withMessage();
    const { ctx, crypto } = await context([
      { status: 200, body: [envelope({ envelope_id: 2, server_timestamp_ms: 1_000_500 })] },
    ]);
    ctx.store = store;
    ctx.crypto = crypto;
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    crypto.createGroup();
    crypto.answers.push(
      {
        kind: "message",
        sender: "them",
        plaintext: new TextEncoder().encode(
          JSON.stringify({ kind: "edit", target: "m1", body: "the revision", edited_at_ms: 1_000_400 }),
        ),
        epoch: 1n,
      },
    );

    await conversations.sync(ctx, "c1");

    expect((await store.messages("c1"))[0]!.body).toBe("the revision");
  });

  it("ignores an edit from a device that did not send the message", async () => {
    const { store } = await withMessage();
    const { ctx, crypto } = await context([
      { status: 200, body: [
        envelope({ envelope_id: 2, sender_device_id: "someone-else", server_timestamp_ms: 1_000_500 }),
      ] },
    ]);
    ctx.store = store;
    ctx.crypto = crypto;
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    crypto.createGroup();
    crypto.answers.push(
      {
        kind: "message",
        sender: "someone-else",
        plaintext: new TextEncoder().encode(
          JSON.stringify({ kind: "retract", target: "m1" }),
        ),
        epoch: 1n,
      },
    );

    await conversations.sync(ctx, "c1");

    // The server never saw this payload, so the receiver is the only place
    // this rule can be applied at all.
    expect((await store.messages("c1"))[0]!.body).toBe("the original");
  });

  it("ignores a change that arrived long after the window closed", async () => {
    const { store } = await withMessage();
    const { ctx, crypto } = await context([
      { status: 200, body: [
        envelope({ envelope_id: 2, server_timestamp_ms: 1_000_000 + 60 * 60 * 1000 }),
      ] },
    ]);
    ctx.store = store;
    ctx.crypto = crypto;
    await store.setIdentity({ deviceId: "mine", secret: Uint8Array.of(1) });
    crypto.createGroup();
    crypto.answers.push(
      {
        kind: "message",
        sender: "them",
        plaintext: new TextEncoder().encode(JSON.stringify({ kind: "retract", target: "m1" })),
        epoch: 1n,
      },
    );

    await conversations.sync(ctx, "c1");

    expect((await store.messages("c1"))[0]!.body).toBe("the original");
  });

  it("allows the grace the receiver window exists for", () => {
    // A sender whose clock runs fast sends at what it thinks is 9:59 and the
    // server stamps 10:01. Without the grace, the sender applies the change
    // and every receiver refuses it — and the group disagrees for ever.
    expect(conversations.receiverMayApply(0, conversations.EDIT_WINDOW_MS + 30_000)).toBe(true);
    expect(
      conversations.receiverMayApply(
        0,
        conversations.EDIT_WINDOW_MS + conversations.RECEIVER_GRACE_MS + 1,
      ),
    ).toBe(false);
  });
});
