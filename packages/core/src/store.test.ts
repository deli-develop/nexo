import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { Store } from "./store";

/**
 * The store, against a real IndexedDB implementation.
 *
 * `fake-indexeddb` is a full implementation of the spec, not a stub, so what
 * these exercise is the same code path a browser takes — including the
 * transaction semantics, which are the part worth testing and the part a
 * hand-written double would quietly get right by accident.
 *
 * Each test gets its own factory, so nothing leaks between them.
 */

let store: Store;

beforeEach(async () => {
  store = await Store.open("nexo-test", new IDBFactory());
});

describe("Store", () => {
  it("answers with nothing on a first run rather than throwing", async () => {
    // A fresh device has no account, and that is an ordinary answer. Throwing
    // here would make every caller wrap the first read in a try.
    expect(await store.account()).toBeNull();
    expect(await store.identity()).toBeNull();
    expect(await store.refreshToken()).toBeNull();
    expect(await store.mlsState()).toBeNull();
    expect(await store.conversations()).toEqual([]);
  });

  it("round-trips the account and overwrites rather than accumulating", async () => {
    await store.setAccount({ userId: 1, handle: "alice", displayName: "Alice" });
    await store.setAccount({ userId: 1, handle: "alice", displayName: "Alice Renamed" });

    expect(await store.account()).toEqual({
      userId: 1,
      handle: "alice",
      displayName: "Alice Renamed",
    });
  });

  it("keeps the identity secret as bytes, not as a string", async () => {
    // Round-tripping through a string would change the key material.
    const secret = new Uint8Array([0, 1, 2, 250, 251, 255]);
    await store.setIdentity({ deviceId: "11111111-1111-4111-8111-111111111111", secret });

    const back = await store.identity();
    expect(back?.secret).toBeInstanceOf(Uint8Array);
    expect(Array.from(back!.secret)).toEqual(Array.from(secret));
  });

  it("replaces the refresh token on every write", async () => {
    // Rotation means there is only ever one live token. Keeping the old one
    // would leave a spent credential on disk for the next start to replay.
    await store.setRefreshToken("first");
    await store.setRefreshToken("second");
    expect(await store.refreshToken()).toBe("second");
  });

  it("round-trips the MLS blob byte for byte", async () => {
    const blob = new Uint8Array(1024).map((_, i) => i % 256);
    await store.setMlsState(blob);
    const back = await store.mlsState();
    expect(back).toHaveLength(1024);
    expect(Array.from(back!.slice(0, 8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("orders conversations by most recently active", async () => {
    const base = { title: null, kind: "dm", epoch: 0, syncedTo: 0, lastMessage: null };
    await store.putConversation({ ...base, id: "old", updatedAtMs: 100 });
    await store.putConversation({ ...base, id: "new", updatedAtMs: 300 });
    await store.putConversation({ ...base, id: "mid", updatedAtMs: 200 });

    expect((await store.conversations()).map((c) => c.id)).toEqual(["new", "mid", "old"]);
  });

  it("returns only the messages of the conversation asked for, in order", async () => {
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 0, syncedTo: 0,
      lastMessage: null, updatedAtMs: 0,
    });
    await store.appendMessage({ id: 2, conversationId: "c1", senderDeviceId: null, body: "second", sentAtMs: 200 });
    await store.appendMessage({ id: 1, conversationId: "c1", senderDeviceId: null, body: "first", sentAtMs: 100 });
    await store.appendMessage({ id: 3, conversationId: "c2", senderDeviceId: null, body: "elsewhere", sentAtMs: 150 });

    expect((await store.messages("c1")).map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("moves the conversation cursor in the same transaction as the message", async () => {
    // The pair that must not come apart: a message without its cursor is
    // fetched again and shown twice; a cursor without its message loses it.
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 0, syncedTo: 0,
      lastMessage: null, updatedAtMs: 0,
    });
    await store.appendMessage(
      { id: 7, conversationId: "c1", senderDeviceId: "d", body: "hello", sentAtMs: 500 },
      7,
    );

    const conversation = await store.conversation("c1");
    expect(conversation?.syncedTo).toBe(7);
    expect(conversation?.lastMessage).toBe("hello");
    expect(conversation?.updatedAtMs).toBe(500);
  });

  it("never moves the cursor backwards", async () => {
    // Envelopes can arrive out of order. Taking the newest id blindly would
    // skip everything between it and where the device actually is.
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 0, syncedTo: 9,
      lastMessage: null, updatedAtMs: 900,
    });
    await store.appendMessage(
      { id: 4, conversationId: "c1", senderDeviceId: "d", body: "late arrival", sentAtMs: 400 },
      4,
    );

    const conversation = await store.conversation("c1");
    expect(conversation?.syncedTo).toBe(9);
    expect(conversation?.updatedAtMs).toBe(900);
  });

  it("keeps the outbox in the order things were queued", async () => {
    const entry = (n: number) => ({
      conversationId: "c1", ciphertext: `ff0${n}`, epoch: 1,
      isCommit: false, clientMsgId: `m${n}`, queuedAtMs: n,
    });
    await store.enqueue(entry(1));
    const second = await store.enqueue(entry(2));
    await store.enqueue(entry(3));

    expect((await store.outbox()).map((e) => e.clientMsgId)).toEqual(["m1", "m2", "m3"]);

    // A flush removes them one at a time, and the rest keep their order.
    await store.dequeue(second);
    expect((await store.outbox()).map((e) => e.clientMsgId)).toEqual(["m1", "m3"]);
  });

  it("holds ciphertext in the outbox, never plaintext", async () => {
    // The queue can sit on disk for days. What waits there is already
    // encrypted, so an unsent message is no more readable than a sent one.
    await store.enqueue({
      conversationId: "c1", ciphertext: "deadbeef", epoch: 1,
      isCommit: false, clientMsgId: "m1", queuedAtMs: 1,
    });
    const [queued] = await store.outbox();
    expect(queued).not.toHaveProperty("body");
    expect(queued!.ciphertext).toBe("deadbeef");
  });

  it("deletes an emptied draft rather than storing it blank", async () => {
    await store.setDraft("c1", "half a thought");
    expect(await store.draft("c1")).toBe("half a thought");

    await store.setDraft("c1", "   ");
    expect(await store.draft("c1")).toBeNull();
  });

  it("wipes every store at once", async () => {
    await store.setAccount({ userId: 1, handle: "alice", displayName: "Alice" });
    await store.setIdentity({ deviceId: "d", secret: new Uint8Array([1]) });
    await store.setRefreshToken("token");
    await store.setMlsState(new Uint8Array([2]));
    await store.putConversation({
      id: "c1", title: null, kind: "dm", epoch: 0, syncedTo: 0,
      lastMessage: null, updatedAtMs: 0,
    });
    await store.setDraft("c1", "unsent");

    await store.wipe();

    // Half a wipe is worse than none: an identity with no account is a state
    // nothing knows how to resume from.
    expect(await store.account()).toBeNull();
    expect(await store.identity()).toBeNull();
    expect(await store.refreshToken()).toBeNull();
    expect(await store.mlsState()).toBeNull();
    expect(await store.conversations()).toEqual([]);
    expect(await store.draft("c1")).toBeNull();
  });
});
