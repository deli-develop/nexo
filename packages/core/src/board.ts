import { TEAM_POST_MAX_FILES, type SealedFile } from "./payload";
import type { StoredMessage, StoredReaction, StoredTeamMark } from "./store";

/**
 * A team's board, folded out of what this device has stored.
 *
 * A pure function over rows, the way `buildRows` and `storyGroups` are, so the
 * rules can be tested without MLS, a network or a store. Nothing here decides
 * who may do what -- that was decided as each row arrived (`conversations.ts`
 * drops a pin from somebody who does not moderate, and only the sender's own
 * device may edit or take back) -- and nothing here is told anything the rows
 * do not already say.
 *
 * Three things are drawn that an ordinary feed would hide, on purpose:
 *
 * - **A post nobody can read** is a card in its place, not a gap (rule 7).
 * - **History from before this device joined** is said to be missing, where
 *   it would have been, rather than drawn as an empty past.
 * - **A post an admin removed** stays as a line saying so, because the removal
 *   is a request other copies may not have honoured, and the board should not
 *   pretend it never existed.
 */

/** What a reaction pill needs: which emoji, how many, and whether one is ours. */
export interface BoardReaction {
  emoji: string;
  count: number;
  mine: boolean;
}

/** Whether something can still be read, and if not, who took it away. */
export type BoardState = "live" | "retracted" | "removed";

export interface BoardComment {
  id: string;
  envelopeId: number;
  /** A device id, or `null` for this device. */
  author: string | null;
  body: string;
  sentAtMs: number;
  editedAtMs?: number;
  state: BoardState;
  reactions: BoardReaction[];
  /** Answers to this comment. Always empty on an answer: one level only. */
  replies: BoardComment[];
}

export interface BoardPost {
  kind: "post";
  id: string;
  envelopeId: number;
  author: string | null;
  title?: string;
  body: string;
  /** At most `TEAM_POST_MAX_FILES`. */
  files: SealedFile[];
  /** How many files the post named past the cap, which are not drawn. */
  filesLeftOut: number;
  sentAtMs: number;
  editedAtMs?: number;
  state: BoardState;
  pinned: boolean;
  reactions: BoardReaction[];
  /** Oldest first, each with its answers. */
  comments: BoardComment[];
}

/** A post this device could not decrypt, in the place it would have been. */
export interface UnreadableCard {
  kind: "unreadable";
  envelopeId: number;
  sentAtMs: number;
}

/** A post in a shape this build does not know. Said, not dropped. */
export interface UnsupportedCard {
  kind: "unsupported";
  envelopeId: number;
  sentAtMs: number;
}

export type BoardItem = BoardPost | UnreadableCard | UnsupportedCard;

export interface Board {
  /** Pinned posts, most recently pinned first. Not repeated in `items`. */
  pinned: BoardPost[];
  /** Everything else, newest first. */
  items: BoardItem[];
  /**
   * Comments on a post this device does not have -- one from before it
   * joined, most often. Kept so what somebody said is not lost, and drawn
   * apart because there is no post to hang them on.
   */
  orphans: BoardComment[];
  /** Whether this device joined after the team began, so earlier posts are not here. */
  joinedLate: boolean;
}

export interface BoardRows {
  messages: StoredMessage[];
  reactions: StoredReaction[];
  marks: StoredTeamMark[];
  /** The conversation's `joinedAt`, when this device came in by a Welcome. */
  joinedAt?: number;
}

interface Parsed {
  kind: string;
  id?: string;
  title?: string;
  files?: SealedFile[];
  post?: string;
  parent?: string;
}

function parse(message: StoredMessage): Parsed {
  if (message.payload === undefined) return { kind: "text" };
  try {
    return JSON.parse(message.payload) as Parsed;
  } catch {
    return { kind: "unsupported" };
  }
}

function stateOf(message: StoredMessage, removed: ReadonlySet<string>, id: string | undefined): BoardState {
  if (id !== undefined && removed.has(id)) return "removed";
  if (message.retractedAtMs !== undefined) return "retracted";
  return "live";
}

function reactionsOn(target: string | undefined, all: Map<string, StoredReaction[]>): BoardReaction[] {
  if (target === undefined) return [];
  const byEmoji = new Map<string, BoardReaction>();
  for (const reaction of all.get(target) ?? []) {
    const pill = byEmoji.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false };
    pill.count += 1;
    // `self` is how this device's own reactions are stored (`applyOwn`).
    if (reaction.deviceId === "self") pill.mine = true;
    byEmoji.set(reaction.emoji, pill);
  }
  // Most used first, then by emoji, so the order does not jump around.
  return [...byEmoji.values()].sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
}

const newestFirst = (a: { sentAtMs: number; envelopeId: number }, b: { sentAtMs: number; envelopeId: number }) =>
  b.sentAtMs - a.sentAtMs || b.envelopeId - a.envelopeId;

const oldestFirst = (a: { sentAtMs: number; envelopeId: number }, b: { sentAtMs: number; envelopeId: number }) =>
  a.sentAtMs - b.sentAtMs || a.envelopeId - b.envelopeId;

/** Folds a team's stored rows into its board. */
export function buildBoard(rows: BoardRows): Board {
  const reactions = new Map<string, StoredReaction[]>();
  for (const reaction of rows.reactions) {
    const list = reactions.get(reaction.target) ?? [];
    list.push(reaction);
    reactions.set(reaction.target, list);
  }

  const removed = new Set<string>();
  const pinnedAt = new Map<string, number>();
  for (const mark of rows.marks) {
    if (mark.kind === "remove" && mark.on) removed.add(mark.target);
    if (mark.kind === "pin" && mark.on) pinnedAt.set(mark.target, mark.atMs);
  }

  const posts = new Map<string, BoardPost>();
  const items: BoardItem[] = [];
  const comments: Array<{ comment: BoardComment; post: string | undefined; parent: string | undefined }> = [];

  for (const message of rows.messages) {
    const parsed = parse(message);
    const id = message.clientId ?? parsed.id;

    switch (parsed.kind) {
      case "unreadable":
        items.push({ kind: "unreadable", envelopeId: message.id, sentAtMs: message.sentAtMs });
        break;

      case "team_comment": {
        const state = stateOf(message, removed, id);
        const comment: BoardComment = {
          id: id ?? `envelope-${message.id}`,
          envelopeId: message.id,
          author: message.senderDeviceId,
          body: state === "live" ? message.body : "",
          sentAtMs: message.sentAtMs,
          state,
          reactions: state === "live" ? reactionsOn(id, reactions) : [],
          replies: [],
        };
        if (message.editedAtMs !== undefined && state === "live") comment.editedAtMs = message.editedAtMs;
        comments.push({ comment, post: parsed.post, parent: parsed.parent });
        break;
      }

      // A post -- and anything a conversation can carry that has words or a
      // file in it, sent into a team by a build that does not know teams.
      // Drawn as a post rather than dropped: it is something somebody said.
      case "team_post":
      case "text":
      case "reply":
      case "attachment": {
        const state = stateOf(message, removed, id);
        const all =
          parsed.kind === "team_post" ? parsed.files ?? []
          : parsed.kind === "attachment" ? [parsed as unknown as SealedFile] : [];
        const post: BoardPost = {
          kind: "post",
          id: id ?? `envelope-${message.id}`,
          envelopeId: message.id,
          author: message.senderDeviceId,
          body: state === "live" ? message.body : "",
          files: state === "live" ? all.slice(0, TEAM_POST_MAX_FILES) : [],
          filesLeftOut: state === "live" ? Math.max(0, all.length - TEAM_POST_MAX_FILES) : 0,
          sentAtMs: message.sentAtMs,
          state,
          pinned: state === "live" && id !== undefined && pinnedAt.has(id),
          reactions: state === "live" ? reactionsOn(id, reactions) : [],
          comments: [],
        };
        if (parsed.kind === "team_post" && parsed.title && state === "live") post.title = parsed.title;
        if (message.editedAtMs !== undefined && state === "live") post.editedAtMs = message.editedAtMs;
        posts.set(post.id, post);
        break;
      }

      default:
        // `unsupported` -- a kind from a newer build -- and anything this
        // fold does not draw. Said, so nobody reads the board as complete.
        if (parsed.kind === "unsupported") {
          items.push({ kind: "unsupported", envelopeId: message.id, sentAtMs: message.sentAtMs });
        }
        break;
    }
  }

  // One level of answers. A comment whose parent is not a top-level comment
  // on the same post -- an answer to an answer, a name that points nowhere --
  // is drawn as a comment on the post rather than dropped: a malformed
  // reference is no reason to lose what somebody said.
  const topLevel = new Map<string, { comment: BoardComment; post: string | undefined }>();
  for (const entry of comments) {
    if (entry.parent === undefined) topLevel.set(entry.comment.id, entry);
  }
  const orphans: BoardComment[] = [];
  for (const entry of comments.sort((a, b) => oldestFirst(a.comment, b.comment))) {
    const parent = entry.parent !== undefined ? topLevel.get(entry.parent) : undefined;
    if (parent !== undefined && parent.post === entry.post && parent.comment !== entry.comment) {
      parent.comment.replies.push(entry.comment);
      continue;
    }
    const post = entry.post !== undefined ? posts.get(entry.post) : undefined;
    if (post) post.comments.push(entry.comment);
    else orphans.push(entry.comment);
  }

  const pinned: BoardPost[] = [];
  for (const post of posts.values()) {
    if (post.pinned) pinned.push(post);
    else items.push(post);
  }
  pinned.sort((a, b) => (pinnedAt.get(b.id) ?? 0) - (pinnedAt.get(a.id) ?? 0) || newestFirst(a, b));
  items.sort(newestFirst);

  return { pinned, items, orphans, joinedLate: rows.joinedAt !== undefined };
}

/** Everything the board shows about one post, found by id. */
export function findPost(board: Board, id: string): BoardPost | undefined {
  return (
    board.pinned.find((post) => post.id === id) ??
    board.items.find((item): item is BoardPost => item.kind === "post" && item.id === id)
  );
}
