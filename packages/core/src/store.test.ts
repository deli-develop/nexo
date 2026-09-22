import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { idb, openDatabase, transact } from "./idb";
import { Store, type StoredStory, type StoredViewOnce } from "./store";

const conversation = (id: string, syncedTo = 0) => ({
  id, title: null, kind: "dm", epoch: 0, syncedTo,
  lastMessage: null, updatedAtMs: 0,
});

const story = (id: number, expiresAtMs: number): StoredStory => ({
  id, authorHandle: "alice", authorDeviceId: "device-a", s3Key: `story-${id}`,
  encKey: `secret-${id}`, nonce: "nonce", sha256: "digest", mime: "image/png",
  size: 42, createdAtMs: id, expiresAtMs,
});

const viewOnce = (clientId: string): StoredViewOnce => ({
  clientId, conversationId: "c1", s3Key: `object-${clientId}`,
  encKey: "secret", nonce: "nonce", sha256: "digest", mime: "image/png",
  size: 42, receivedAtMs: 10, openedAtMs: null,
});

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

  it("persists sign-in as one unit and refuses to overwrite another account", async () => {
    const account = { userId: 1, handle: "alice", displayName: "Alice" };
    const identity = { deviceId: "device-a", secret: Uint8Array.of(1, 2) };
    await store.persistSignIn(account, identity, "refresh-a", Uint8Array.of(3, 4));
    expect(await store.account()).toEqual(account);
    expect(await store.identity()).toEqual(identity);
    expect(await store.refreshToken()).toBe("refresh-a");
    expect(await store.mlsState()).toEqual(Uint8Array.of(3, 4));

    await expect(store.persistSignIn(
      { userId: 2, handle: "bob", displayName: "Bob" },
      { deviceId: "device-b", secret: Uint8Array.of(5) },
      "refresh-b", Uint8Array.of(6),
    )).rejects.toThrow("alice");
    expect(await store.account()).toEqual(account);
    expect(await store.refreshToken()).toBe("refresh-a");
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
    await store.clearRefreshToken();
    expect(await store.refreshToken()).toBeNull();
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
    await store.putConversation(conversation("c1"));
    await store.appendMessage({
      id: 1, conversationId: "c1", senderDeviceId: null,
      body: "find me", sentAtMs: 1, clientId: "m1",
    });
    await store.setReaction({
      id: "c1|m1|device-a", conversationId: "c1", target: "m1",
      deviceId: "device-a", emoji: "👍", atMs: 1,
    }, true);
    await store.enqueue({
      conversationId: "c1", ciphertext: "beef", epoch: 0,
      isCommit: false, clientMsgId: "m1", queuedAtMs: 1,
    });
    await store.setDraft("c1", "unsent");
    await store.putStory(story(1, 100));
    await store.putViewOnce(viewOnce("once"));
    const folder = await store.createFolder("Friends", 1);
    await store.setFolderMember(folder, "c1", true);
    await store.setPinned("c1", 1, true, 1);
    await store.recordPeers("c1", [{ deviceId: "device-a", identityKey: Uint8Array.of(1) }], 1);
    await store.putPin({ salt: Uint8Array.of(2), hash: Uint8Array.of(3), attempts: 1 });
    await store.forgetConversation("c2");

    await store.wipe();

    // Half a wipe is worse than none: an identity with no account is a state
    // nothing knows how to resume from.
    expect(await store.account()).toBeNull();
    expect(await store.identity()).toBeNull();
    expect(await store.refreshToken()).toBeNull();
    expect(await store.mlsState()).toBeNull();
    expect(await store.conversations()).toEqual([]);
    expect(await store.draft("c1")).toBeNull();
    expect(await store.messages("c1")).toEqual([]);
    expect(await store.reactions("c1")).toEqual([]);
    expect(await store.outbox()).toEqual([]);
    expect(await store.liveStories(0)).toEqual([]);
    expect(await store.viewOnce("once")).toBeNull();
    expect(await store.folders()).toEqual([]);
    expect(await store.pinnedMessages("c1")).toEqual([]);
    expect(await store.forgottenConversations()).toEqual(new Map());
    expect(await store.peers("c1")).toEqual([]);
    expect(await store.searchMessages("find")).toEqual([]);
    expect(await store.loadPin()).toBeNull();
  });
});

describe("remaining local domains", () => {
  it("aborts earlier writes when work in a transaction throws", async () => {
    const db = await openDatabase("rollback", new IDBFactory());
    await expect(transact(db, "account", "readwrite", async (tx) => {
      await idb.put(tx, "account", {
        id: "one", userId: 1, handle: "alice", displayName: "Alice",
      });
      throw new Error("later validation failed");
    })).rejects.toThrow("later validation failed");
    const row = await transact(db, "account", "readonly", (tx) =>
      idb.get(tx, "account", "one"),
    );
    expect(row).toBeUndefined();
    db.close();
  });

  it("backfills the search index when a version-one database is upgraded", async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const opening = factory.open("upgrade", 1);
      opening.onupgradeneeded = () => {
        const oldMessages = opening.result.createObjectStore("messages", { keyPath: "id" });
        oldMessages.put({
          id: 7, conversationId: "c1", senderDeviceId: null,
          body: "Before upgrade", sentAtMs: 7,
        });
      };
      opening.onsuccess = () => {
        opening.result.close();
        resolve();
      };
      opening.onerror = () => reject(opening.error);
    });
    const upgraded = await Store.open("upgrade", factory);
    expect((await upgraded.searchMessages("before")).map((hit) => hit.id)).toEqual([7]);
    upgraded.close();
  });

  it("deduplicates stories and removes expired keys on read", async () => {
    await store.putStory(story(1, 100));
    await store.putStory({ ...story(1, 100), encKey: "second-copy" });
    await store.putStory(story(2, 200));

    expect((await store.liveStories(100)).map((item) => item.id)).toEqual([2]);
    expect(await store.liveStories(0)).toEqual([story(2, 200)]);
  });

  it("burns view-once keys without deleting the row or resurrecting it on replay", async () => {
    await store.putViewOnce(viewOnce("once"));
    await store.burnViewOnce("once", 25);
    await store.putViewOnce(viewOnce("once"));

    expect(await store.viewOnce("once")).toMatchObject({
      encKey: null, nonce: null, sha256: null, openedAtMs: 25,
    });
    expect(await store.viewOnceIn("c1")).toHaveLength(1);
    await store.burnViewOnce("once", 30);
    expect((await store.viewOnce("once"))?.openedAtMs).toBe(25);
  });

  it("keeps folder memberships local, unique, and removes them with the folder", async () => {
    await store.putConversation(conversation("c1"));
    const first = await store.createFolder("Friends", 1);
    const second = await store.createFolder("Family", 2);
    await store.setFolderMember(first, "c1", true);
    await store.setFolderMember(first, "c1", true);
    await store.setFolderMember(second, "c1", true);
    await store.renameFolder(first, "Close friends");

    expect(await store.folders()).toEqual([
      { id: first, name: "Close friends", conversations: ["c1"] },
      { id: second, name: "Family", conversations: ["c1"] },
    ]);
    await store.deleteFolder(first);
    expect(await store.folders()).toEqual([
      { id: second, name: "Family", conversations: ["c1"] },
    ]);
    expect(await store.conversation("c1")).not.toBeNull();
  });

  it("orders local pins by pin time and excludes missing messages", async () => {
    await store.putConversation(conversation("c1"));
    for (const id of [1, 2]) {
      await store.appendMessage({
        id, conversationId: "c1", senderDeviceId: null,
        body: `body ${id}`, sentAtMs: id,
      });
    }
    await store.setPinned("c1", 1, true, 10);
    await store.setPinned("c1", 2, true, 20);
    await store.setPinned("c1", 1, true, 30);
    await store.setPinned("c1", 3, true, 40);
    expect((await store.pinnedMessages("c1")).map((message) => message.id)).toEqual([2, 1]);
    await store.setPinned("c1", 2, false, 50);
    expect((await store.pinnedMessages("c1")).map((message) => message.id)).toEqual([1]);
  });

  it("deletes a local message with its search term, pin, and queued send", async () => {
    await store.putConversation(conversation("c1"));
    await store.appendMessage({
      id: 1, conversationId: "c1", senderDeviceId: null,
      body: "Private phrase", sentAtMs: 1, clientId: "m1",
    });
    await store.setPinned("c1", 1, true, 2);
    await store.enqueue({
      conversationId: "c1", ciphertext: "beef", epoch: 1,
      isCommit: false, clientMsgId: "m1", queuedAtMs: 2,
    });
    await store.deleteMessage("c1", 1);
    expect(await store.messages("c1")).toEqual([]);
    expect(await store.searchMessages("private")).toEqual([]);
    expect(await store.pinnedMessages("c1")).toEqual([]);
    expect(await store.outbox()).toEqual([]);
    expect((await store.conversation("c1"))?.lastMessage).toBeNull();
  });

  it("searches literal words and updates the index with edits and retractions", async () => {
    await store.putConversation(conversation("c1"));
    await store.putConversation(conversation("c2"));
    await store.appendMessage({
      id: 1, conversationId: "c1", senderDeviceId: null,
      body: "Mountain sunrise", sentAtMs: 10, clientId: "m1",
    });
    await store.appendMessage({
      id: 2, conversationId: "c2", senderDeviceId: "them",
      body: "Mountain sunset", sentAtMs: 20, clientId: "m2",
    });

    expect((await store.searchMessages("mountain sun")).map((hit) => hit.id)).toEqual([2, 1]);
    expect((await store.searchMessages("mountain sun", "c1")).map((hit) => hit.id)).toEqual([1]);
    expect((await store.searchMessages("mount", null, 1)).map((hit) => hit.id)).toEqual([2]);
    await store.reviseMessage("c1", "m1", { body: "Clouds", editedAtMs: 30 });
    expect((await store.searchMessages("mount")).map((hit) => hit.id)).toEqual([2]);
    await store.reviseMessage("c2", "m2", { body: "", retractedAtMs: 40 });
    expect(await store.searchMessages("mount")).toEqual([]);
  });

  it("removes a local conversation atomically and keeps a monotonic tombstone", async () => {
    await store.putConversation(conversation("c1", 10));
    await store.appendMessage({
      id: 1, conversationId: "c1", senderDeviceId: null,
      body: "Find me", sentAtMs: 1,
    });
    await store.enqueue({
      conversationId: "c1", ciphertext: "beef", epoch: 0,
      isCommit: false, clientMsgId: "m1", queuedAtMs: 1,
    });
    await store.putViewOnce(viewOnce("once"));
    await store.setDraft("c1", "words");
    const folder = await store.createFolder("Friends", 1);
    await store.setFolderMember(folder, "c1", true);
    await store.forgetConversation("c1");

    expect(await store.conversation("c1")).toBeNull();
    expect(await store.messages("c1")).toEqual([]);
    expect(await store.outbox()).toEqual([]);
    expect(await store.viewOnce("once")).toBeNull();
    expect(await store.draft("c1")).toBeNull();
    expect(await store.searchMessages("find")).toEqual([]);
    expect(await store.folders()).toEqual([{ id: folder, name: "Friends", conversations: [] }]);
    expect(await store.forgottenConversations()).toEqual(new Map([["c1", 10]]));

    await store.putConversation(conversation("c1", 5));
    await store.forgetConversation("c1");
    expect(await store.forgottenConversations()).toEqual(new Map([["c1", 10]]));
    await store.rememberConversation("c1");
    expect(await store.forgottenConversations()).toEqual(new Map());
  });

  it("distinguishes a new peer from a changed key and never carries verification across", async () => {
    const first = { deviceId: "device-a", identityKey: Uint8Array.of(1) };
    expect(await store.recordPeers("c1", [first], 10)).toEqual([]);
    await store.markVerified("c1");
    expect((await store.peers("c1"))[0]?.verifiedKey).toEqual(Uint8Array.of(1));

    expect(await store.recordPeers("c1", [first], 20)).toEqual([]);
    expect(await store.recordPeers("c1", [{ ...first, identityKey: Uint8Array.of(2) }], 30))
      .toEqual(["device-a"]);
    expect((await store.peers("c1"))[0]).toMatchObject({
      firstSeenMs: 10, verifiedKey: null, changedAtMs: 30,
    });
    await store.acknowledgeKeyChange("c1");
    expect((await store.peers("c1"))[0]).toMatchObject({ verifiedKey: null, changedAtMs: null });
  });

  it("spends each PIN attempt once and clears the verifier on wipe", async () => {
    expect(await store.setPinAttempts(0, 1)).toBe(false);
    await store.putPin({ salt: Uint8Array.of(1), hash: Uint8Array.of(2), attempts: 0 });
    expect(await store.setPinAttempts(0, 1)).toBe(true);
    expect(await store.setPinAttempts(0, 2)).toBe(false);
    expect((await store.loadPin())?.attempts).toBe(1);
    await store.clearPin();
    expect(await store.loadPin()).toBeNull();
  });
});
