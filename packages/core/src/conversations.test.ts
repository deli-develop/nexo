import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as conversations from "./conversations";
import type { CryptoModule, Decrypted, Device, Group, Peeked, StagedCommit } from "./crypto";
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

  /** Shared with the module, so a group made mid-sync still has its answers. */
  constructor(readonly answers: Array<Decrypted | "throw">) {}

  addMember(_device: Device, _keyPackage: Uint8Array): StagedCommit {
    this.staged = { message: Uint8Array.of(0xc0), welcome: Uint8Array.of(0x11, 0x00) };
    return this.staged;
  }
  confirmCommit(): bigint {
    this.confirmed += 1;
    this.epoch += 1n;
    return this.epoch;
  }
  abandonCommit(): void {
    this.abandoned += 1;
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
