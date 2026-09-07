/**
 * The shapes the UI renders.
 *
 * These are *view* types, not wire types. `crates/protocol` owns what crosses
 * the network, and an `Envelope` there carries a ciphertext and nothing else
 * (§4.2). What arrives here has already been decrypted in Rust and handed over
 * IPC as plain values (rule 2), which is why a `Message` has a `body` and an
 * `Envelope` never could.
 *
 * M1 filled these from `src/mock`; M4 onwards fills them from the core, and
 * nothing about the components changed when it did — which was the point of
 * writing them as view types in the first place. The fixtures are still here
 * for the component tests and for a browser preview with no Tauri runtime.
 */

export type PresenceState = "online" | "away" | "offline";

export interface Person {
  id: string;
  /** 3–20 chars, [a-z0-9_], unique. Discovery is by handle only (§4.1). */
  handle: string;
  displayName: string;
  /** The in-app numeric ID from §4.1. Never a phone number. */
  userId: number;
  bio: string;
  location: string;
  links: string[];
  joinedAt: Date;
  presence: PresenceState;
  lastSeen: Date;
}

/** Where a message got to. `failed` is a real state, not an edge case (§6.1). */
export type DeliveryState =
  "sending" | "sent" | "delivered" | "read" | "failed";

export interface Attachment {
  id: string;
  name: string;
  /** Bytes. Rendered in the mono face so a column of them lines up. */
  size: number;
  mime: string;
  /**
   * How the bubble draws it.
   *
   * `voice` is not a MIME type. When `voice` below is set the sender recorded
   * this and said so, which settles it. Without that flag it is still a
   * reading: a `.wav` or a `.flac` is what a recorder writes before anything
   * has compressed it, so a message-length one is more often somebody talking
   * than not — and that guess is all a message sent before v0.1.21 left us.
   */
  kind: "image" | "video" | "audio" | "voice" | "file";
  /**
   * Set when the sender recorded this in the app.
   *
   * Carried in the payload rather than inferred, so the bubble knows instead of
   * supposing. Absent on every file picked from disk and on everything sent
   * before recording existed.
   */
  voice?: VoiceMeta;
  /**
   * Whether it can be played a segment at a time rather than fetched whole.
   *
   * When true the bubble points a player at the streaming URL, which fetches
   * only what it needs — so the first frame and the duration appear without
   * the whole file moving. False for everything sent before segmenting.
   */
  streamable?: boolean;
}

/**
 * The message a reply answers.
 *
 * `found` false is ordinary rather than an error: somebody can join a
 * conversation after the message they are being answered about. The bubble says
 * so instead of drawing an empty quote.
 */
export interface QuotedMessage {
  target: string;
  found: boolean;
  /** What a jump-to scrolls by. Absent when the message is not here. */
  envelopeId?: number;
  /** Whether this device sent the message being answered. */
  outgoing: boolean;
  retracted: boolean;
  /** Already shortened in Rust. Empty when retracted or not found. */
  excerpt: string;
}

/** What a bubble may know about a view-once message. Never a key. */
export interface ViewOnceState {
  openable: boolean;
  outgoing: boolean;
  openedAtMs?: number;
  kind: "image" | "video";
}

/** What the bubble needs to draw a recording before it has decoded one. */
export interface VoiceMeta {
  /** As the recorder measured it. The player's own figure wins once it has one. */
  durationMs: number;
  /**
   * A coarse amplitude envelope, `0`–`255` per bar, already capped in Rust.
   *
   * Drawn and nothing else. It exists so a four-second note looks different
   * from a forty-second one before anybody presses play.
   */
  peaks: number[];
}

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  /** §4.5: previews are generated client-side and are off by default. */
  source: string;
}

/** One emoji on a message, and how many used it. */
export interface MessageReaction {
  emoji: string;
  count: number;
  mine: boolean;
}

/**
 * How a call ended, as the conversation records it.
 *
 * `reason` is spelled the way the wire spells it, so the UI switches on the
 * same word the protocol uses and neither side invents a synonym for the
 * other. `seconds` is zero for a call that never connected — which is not the
 * same statement as the reason makes, since a call can end after two seconds
 * or after an hour.
 */
export interface CallRecord {
  reason: "cancelled" | "declined" | "ended" | "failed";
  seconds: number;
  video: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  authorId: string;
  body: string;
  at: Date;
  state: DeliveryState;
  attachments?: Attachment[];
  preview?: LinkPreview;
  /**
   * Rule 7: decryption failure is shown as a failure. There is no plaintext
   * fallback and no silent skip, so the UI needs a way to say "this one did
   * not open" — and that means carrying it in the model from the start.
   */
  undecryptable?: boolean;
  /**
   * The sender's name for this message, when it has one.
   *
   * Absent for anything sent before names existed. The actions that need one —
   * reacting, editing, taking back — are simply not offered on those.
   */
  clientId?: string;
  /**
   * What this message answers, when it answers something.
   *
   * Resolved in Rust against what this device holds — the page cannot know
   * whether the quoted message ever arrived here.
   */
  replyTo?: QuotedMessage;
  /**
   * Who this was originally from, when it was passed on from elsewhere.
   *
   * The forwarder's claim, not a fact anyone can check — nobody else was
   * there. Absent both when the message is not a forward and when the
   * forwarding device could not name the author, and the bubble tells those
   * two apart by `forwarded` below.
   */
  forwardedFrom?: string;
  /** Whether this arrived as a forward at all, named author or not. */
  forwarded?: boolean;
  /**
   * Set when this is a picture or clip meant to be opened once.
   *
   * `openable` false means the key is gone from this device — a fact about the
   * disk rather than a rule the UI is enforcing.
   */
  viewOnce?: ViewOnceState;
  /**
   * Set when this message is a sticker.
   *
   * Names the art rather than carrying it — the pack is bundled. A pair this
   * build does not recognise draws a placeholder rather than nothing.
   */
  sticker?: { pack: string; id: string };
  /**
   * Pinned **on this device**.
   *
   * Local by design — the server may not read a payload, so it cannot count
   * pins and a shared cap could not be enforced. Anything drawing this says
   * "on this device"; "Pinned" alone would claim something untrue.
   */
  pinned?: boolean;
  /** Reactions on this message, most-used first. */
  reactions?: MessageReaction[];
  /** The sender took it back. The bubble says so; it does not vanish. */
  retracted?: boolean;
  /** The sender changed it. A quiet mark beside the time, nothing louder. */
  edited?: boolean;
  /**
   * Set when the payload decrypted but this build does not know its shape.
   *
   * Distinct from `undecryptable`: the message opened, and the remedy is an
   * update rather than asking the sender to try again. The bytes are kept in
   * the store, so a later build reads what arrived today.
   */
  unsupported?: string;
  /**
   * Set when this message is the record a finished call left behind.
   *
   * A call stores exactly one row — the hangup — and this is what "Missed
   * call" and the duration beside it are drawn from. Absent on every ordinary
   * message, which is almost all of them.
   */
  call?: CallRecord;
}

export interface Conversation {
  id: string;
  kind: "dm" | "group";
  /** A DM's title is the other person's display name; a group has its own. */
  title: string;
  memberIds: string[];
  unread: number;
  /** §4.1: safety numbers verified by hand. Unverified is not "insecure". */
  verified: boolean;
  /**
   * Somebody's key changed under a device this conversation already knew.
   *
   * Either they reinstalled or the server substituted a key. Nothing here can
   * tell those apart, which is why it is shown rather than resolved.
   */
  keyChanged?: boolean;
  keyChangedAtMs?: number | null;
  /** 60 digits, rendered as 12 groups of 5 (§4.1). */
  safetyDigits: string;
  /** Whether the conversation has a picture of its own. */
  hasAvatar?: boolean;
  /**
   * The newest message, as the core already computed it.
   *
   * The list needs this because only the *open* conversation's history is
   * loaded — every other row has no messages in memory to look at. Without it
   * the sidebar said "No messages yet" about conversations full of messages,
   * which reads as data loss rather than as a missing preview.
   */
  lastMessage?: string | null;
  /** Whether that message was ours, so the row can say who spoke last. */
  lastMessageOutgoing?: boolean | null;
  /**
   * @deprecated Muting lives in `conversationOverrides`, where it is a
   * deadline rather than a flag and survives a restart. Kept only because the
   * mock fixtures still set it; read `isMuted` from the store instead.
   */
  muted: boolean;
  /**
   * When the newest message in this conversation was sent.
   *
   * Comes from the store, not from whatever history happens to be loaded, so
   * ordering the list does not depend on which conversation is open. That
   * distinction is the whole point: opening a conversation must not reorder
   * it, only writing in it or being written to.
   */
  lastMessageAt?: Date;
}

export interface SharedLink {
  id: string;
  url: string;
  title: string;
  source: string;
  at: Date;
}

export interface Post {
  id: string;
  authorId: string;
  body: string;
  /** Media ids, not URLs: the tiles are generated, nothing is fetched. */
  media: string[];
  at: Date;
  reactions: { emoji: string; count: number; mine: boolean }[];
  comments: number;
}
