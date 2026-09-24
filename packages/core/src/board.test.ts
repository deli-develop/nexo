import { describe, expect, it } from "vitest";

import { buildBoard, type BoardPost } from "./board";
import { TEAM_POST_MAX_FILES, type SealedFile } from "./payload";
import type { StoredMessage, StoredReaction, StoredTeamMark } from "./store";

/**
 * The board fold, on rows alone.
 *
 * Who may do what was decided when each row arrived; these tests are about
 * what the board then shows -- order, nesting, and the three things it draws
 * rather than hides: an unreadable post, history from before joining, and an
 * admin's removal.
 */

const T = "team-1";
let next = 1;

function post(id: string, at: number, over: Partial<StoredMessage> = {}, extra: Record<string, unknown> = {}): StoredMessage {
  return {
    id: next++,
    conversationId: T,
    senderDeviceId: "ada",
    body: `post ${id}`,
    sentAtMs: at,
    clientId: id,
    payload: JSON.stringify({ kind: "team_post", id, body: `post ${id}`, ...extra }),
    ...over,
  };
}

function comment(id: string, on: string, at: number, parent?: string, over: Partial<StoredMessage> = {}): StoredMessage {
  const payload: Record<string, unknown> = { kind: "team_comment", id, post: on, body: `comment ${id}` };
  if (parent !== undefined) payload.parent = parent;
  return {
    id: next++,
    conversationId: T,
    senderDeviceId: "bo",
    body: `comment ${id}`,
    sentAtMs: at,
    clientId: id,
    payload: JSON.stringify(payload),
    ...over,
  };
}

function mark(kind: "pin" | "remove", target: string, atMs: number, on = true): StoredTeamMark {
  return { id: `${T}|${kind}|${target}`, conversationId: T, kind, target, on, byDeviceId: "admin", atMs };
}

function react(target: string, deviceId: string, emoji: string): StoredReaction {
  return { id: `${T}|${target}|${deviceId}`, conversationId: T, target, deviceId, emoji, atMs: 0 };
}

const posts = (items: ReturnType<typeof buildBoard>["items"]) =>
  items.filter((item): item is BoardPost => item.kind === "post");

describe("the team board", () => {
  it("puts the newest post first, and pinned posts above everything, once", () => {
    const board = buildBoard({
      messages: [post("a", 1), post("b", 2), post("c", 3)],
      reactions: [],
      marks: [mark("pin", "a", 10)],
    });
    expect(board.pinned.map((p) => p.id)).toEqual(["a"]);
    expect(posts(board.items).map((p) => p.id)).toEqual(["c", "b"]);
  });

  it("orders several pins by when they were pinned, and an unpin lets a post go back", () => {
    const board = buildBoard({
      messages: [post("a", 1), post("b", 2), post("c", 3)],
      reactions: [],
      marks: [mark("pin", "a", 20), mark("pin", "b", 10), mark("pin", "c", 30, false)],
    });
    expect(board.pinned.map((p) => p.id)).toEqual(["a", "b"]);
    expect(posts(board.items).map((p) => p.id)).toEqual(["c"]);
  });

  it("hangs answers one level deep and no deeper", () => {
    const board = buildBoard({
      messages: [
        post("p", 1),
        comment("c1", "p", 2),
        comment("c2", "p", 3, "c1"),
        // An answer to an answer: drawn under the post, not lost and not nested.
        comment("c3", "p", 4, "c2"),
        // A parent that names nothing on this post.
        comment("c4", "p", 5, "elsewhere"),
      ],
      reactions: [],
      marks: [],
    });
    const [only] = posts(board.items);
    expect(only!.comments.map((c) => c.id)).toEqual(["c1", "c3", "c4"]);
    expect(only!.comments[0]!.replies.map((c) => c.id)).toEqual(["c2"]);
    expect(only!.comments[1]!.replies).toEqual([]);
  });

  it("keeps a comment on a post this device does not have, apart", () => {
    const board = buildBoard({
      messages: [comment("c1", "before-i-joined", 2)],
      reactions: [],
      marks: [],
      joinedAt: 1,
    });
    expect(board.orphans.map((c) => c.id)).toEqual(["c1"]);
    expect(board.joinedLate).toBe(true);
  });

  it("says a late joiner is missing history, and a founder is not", () => {
    expect(buildBoard({ messages: [], reactions: [], marks: [], joinedAt: 42 }).joinedLate).toBe(true);
    expect(buildBoard({ messages: [], reactions: [], marks: [] }).joinedLate).toBe(false);
  });

  it("shows an edit, and a take-back as taken back with nothing left of it", () => {
    const board = buildBoard({
      messages: [
        post("e", 1, { body: "fixed wording", editedAtMs: 5 }, { title: "Title" }),
        // What `reviseMessage` leaves of a taken-back post: its skeleton.
        post("r", 2, {
          body: "",
          retractedAtMs: 6,
          payload: JSON.stringify({ kind: "team_post", id: "r", body: "" }),
        }),
      ],
      reactions: [react("r", "ada", "👍")],
      marks: [],
    });
    const [taken, edited] = posts(board.items);
    expect(edited).toMatchObject({ id: "e", body: "fixed wording", editedAtMs: 5, title: "Title", state: "live" });
    expect(taken).toMatchObject({ id: "r", body: "", state: "retracted", reactions: [] });
  });

  it("shows an admin's removal as removed, with nothing of the post left", () => {
    const board = buildBoard({
      messages: [post("x", 1, {}, { title: "Secret" }), comment("cx", "x", 2)],
      reactions: [],
      marks: [mark("remove", "x", 3), mark("pin", "x", 4)],
    });
    const [removed] = posts(board.items);
    expect(removed).toMatchObject({ id: "x", state: "removed", body: "", pinned: false });
    expect(removed!.title).toBeUndefined();
    // Its comments are still there, under the line that says it was removed.
    expect(removed!.comments.map((c) => c.id)).toEqual(["cx"]);
    expect(board.pinned).toEqual([]);
  });

  it("removes a single comment for everyone", () => {
    const board = buildBoard({
      messages: [post("p", 1), comment("c", "p", 2)],
      reactions: [],
      marks: [mark("remove", "c", 3)],
    });
    expect(posts(board.items)[0]!.comments[0]).toMatchObject({ id: "c", state: "removed", body: "" });
  });

  it("draws an unreadable post in its place instead of skipping it", () => {
    const board = buildBoard({
      messages: [
        post("a", 1),
        {
          id: 99,
          conversationId: T,
          senderDeviceId: "ada",
          body: "",
          sentAtMs: 2,
          payload: JSON.stringify({ kind: "unreadable" }),
        },
        post("b", 3),
      ],
      reactions: [],
      marks: [],
    });
    expect(board.items.map((item) => (item.kind === "post" ? item.id : item.kind))).toEqual([
      "b",
      "unreadable",
      "a",
    ]);
  });

  it("says a post from a newer build is there, rather than dropping it", () => {
    const board = buildBoard({
      messages: [{
        id: 5, conversationId: T, senderDeviceId: "ada", body: "", sentAtMs: 1,
        payload: JSON.stringify({ kind: "unsupported", unsupportedKind: "team_poll" }),
      }],
      reactions: [],
      marks: [],
    });
    expect(board.items).toEqual([{ kind: "unsupported", envelopeId: 5, sentAtMs: 1 }]);
  });

  it("counts reactions by emoji and knows which one is ours", () => {
    const board = buildBoard({
      messages: [post("p", 1)],
      reactions: [react("p", "ada", "🎉"), react("p", "self", "🎉"), react("p", "bo", "👍")],
      marks: [],
    });
    expect(posts(board.items)[0]!.reactions).toEqual([
      { emoji: "🎉", count: 2, mine: true },
      { emoji: "👍", count: 1, mine: false },
    ]);
  });

  it("draws at most the cap of files and says how many it left out", () => {
    const file = (n: number): SealedFile => ({
      s3_key: `k${n}`, key: "aa", nonce: "bb", sha256: "cc", name: `${n}.png`, mime: "image/png", size: 1,
    });
    const files = Array.from({ length: TEAM_POST_MAX_FILES + 2 }, (_, n) => file(n));
    const [only] = posts(buildBoard({ messages: [post("f", 1, {}, { files })], reactions: [], marks: [] }).items);
    expect(only!.files).toHaveLength(TEAM_POST_MAX_FILES);
    expect(only!.filesLeftOut).toBe(2);
  });

  it("draws a plain message sent into a team by an older build as a post", () => {
    const board = buildBoard({
      messages: [{ id: 7, conversationId: T, senderDeviceId: "ada", body: "hello?", sentAtMs: 1, clientId: "t1" }],
      reactions: [],
      marks: [],
    });
    expect(posts(board.items)[0]).toMatchObject({ id: "t1", body: "hello?", state: "live" });
  });
});
