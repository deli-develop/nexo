/**
 * What is actually inside an MLS ciphertext.
 *
 * Mirrors `Payload` in `crates/protocol/src/lib.rs`, which stays the
 * authority: the server never sees any of this, so the only thing keeping the
 * two ends in agreement is that they were written from the same shape.
 *
 * Tagged by `kind`, and **JSON rather than a compact codec**. A few bytes buy
 * nothing inside an already-encrypted message, and being able to read one in a
 * debugger without a decoder is worth real money at three in the morning.
 */

export interface TextPayload {
  kind: "text";
  body: string;
  /**
   * This sender's name for this message.
   *
   * Not the envelope id — that is the server's number, and a message still in
   * the outbox has none, which is exactly the window in which somebody wants
   * to take one back. Absent on anything sent before names existed, which is
   * why it is optional rather than a defaulted nil.
   */
  id?: string;
  forwarded_from?: string;
  forwarded?: boolean;
}

export interface RenamePayload {
  kind: "rename";
  title: string;
}

export interface ReactionPayload {
  kind: "reaction";
  target: string;
  emoji: string;
  on: boolean;
}

export interface RetractPayload {
  kind: "retract";
  target: string;
}

export interface EditPayload {
  kind: "edit";
  target: string;
  body: string;
  /**
   * When the sender made the change, by their clock.
   *
   * Not the envelope's timestamp: an edit can sit in an offline queue, and the
   * receiver's window check compares this against when the *target* was sent.
   */
  edited_at_ms: number;
}

export interface ReplyPayload {
  kind: "reply";
  body: string;
  /** The `id` of the message being answered. Named `target`, as on the wire. */
  target: string;
  id?: string;
}

/**
 * A file, a picture, a voice note — anything whose bytes live in object
 * storage under a key only the people in this conversation hold.
 *
 * Carried here in full rather than narrowed: this build does not yet draw
 * attachments, and a client that dropped the fields it cannot render would be
 * destroying the only copy. MLS will not decrypt this envelope twice.
 */
export interface AttachmentPayload {
  kind: "attachment";
  s3_key: string;
  key: string;
  nonce: string;
  sha256: string;
  name: string;
  mime: string;
  size: number;
  body?: string;
  segmented?: boolean;
  id?: string;
}

export interface StickerPayload {
  kind: "sticker";
  pack: string;
  id: string;
  message_id?: string;
}

export interface ViewOncePayload {
  kind: "view_once";
  s3_key: string;
  key: string;
  nonce: string;
  sha256: string;
  mime: string;
  size: number;
  id?: string;
}

export interface GroupAvatarPayload {
  kind: "group_avatar";
  s3_key: string;
  key: string;
  nonce: string;
  sha256: string;
  mime: string;
  size: number;
}

/**
 * A payload this build cannot read.
 *
 * Produced only by [`decodePayload`] and never sent — it is what a client does
 * *instead of* guessing. The alternative is what this used to do in Rust:
 * render the raw JSON as though somebody had typed it, which turns every
 * future variant into a bubble full of punctuation on every installation that
 * has not updated yet.
 */
export interface UnsupportedPayload {
  kind: "unsupported";
  /** The `kind` the sender used, so the UI can say which thing is missing. */
  unsupportedKind: string;
}

export type Payload =
  | TextPayload
  | RenamePayload
  | ReactionPayload
  | RetractPayload
  | EditPayload
  | ReplyPayload
  | AttachmentPayload
  | StickerPayload
  | ViewOncePayload
  | GroupAvatarPayload
  | UnsupportedPayload;

/**
 * The kinds this build knows how to read.
 *
 * Snake_case, because `Payload` in `crates/protocol` is
 * `#[serde(tag = "kind", rename_all = "snake_case")]` — `view_once`, not
 * `viewOnce`. Getting this list wrong is not a small bug: a kind missing from
 * it renders as "this message needs a newer version of Nexo" to somebody
 * looking at a perfectly ordinary message.
 */
const KNOWN = new Set([
  "text",
  "rename",
  "reaction",
  "retract",
  "edit",
  "reply",
  "attachment",
  "sticker",
  "view_once",
  "group_avatar",
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodePayload(payload: Payload): Uint8Array {
  return encoder.encode(encodePayloadString(payload));
}

export function encodePayloadString(payload: Payload): string {
  if (payload.kind === "unsupported") {
    // Never sent. Encoding one would mean claiming to speak a variant this
    // build does not understand, which is worse than the gap it describes.
    throw new Error("an unsupported payload is something received, never sent");
  }
  return JSON.stringify(payload);
}

/**
 * Decodes what came out of an MLS message. Three outcomes, and the distinction
 * between the last two is the point:
 *
 * - a payload this build knows;
 * - a JSON object naming a `kind` it cannot read — `unsupported`, which draws
 *   no bubble and says so;
 * - anything else — **text**, because the very first messages this project
 *   ever sent were bare UTF-8 with no envelope, and refusing to read them now
 *   would be self-inflicted data loss.
 */
export function decodePayload(bytes: Uint8Array | string): Payload {
  const text = typeof bytes === "string" ? bytes : decoder.decode(bytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "text", body: text };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // Valid JSON, but not an object: a bare number or string was somebody's
    // message, not a payload.
    return { kind: "text", body: text };
  }

  const kind = (parsed as { kind?: unknown }).kind;
  if (typeof kind !== "string") return { kind: "text", body: text };
  if (!KNOWN.has(kind)) return { kind: "unsupported", unsupportedKind: kind };

  return parsed as Payload;
}

/**
 * What a conversation list shows for this payload.
 *
 * Empty for everything that is not something somebody said. A row whose
 * preview changed to an emoji every time anyone reacted would be unreadable,
 * and a row that named the *kind* of a thing it could not read would be
 * leaking structure into prose.
 */
export function preview(payload: Payload): string {
  switch (payload.kind) {
    case "text":
    case "reply":
      return payload.body;
    // A caption if there is one, the filename otherwise — never nothing, or
    // the row reads as an empty message rather than as a file.
    case "attachment":
      return payload.body && payload.body !== "" ? payload.body : payload.name;
    default:
      return "";
  }
}

/**
 * Whether a string is acceptable as a reaction.
 *
 * The same rule as `is_reaction_emoji` in `crates/protocol`, and it has to be
 * applied **here, on the receiver**: the server never sees a message payload,
 * so it cannot refuse anything about one. A rule the server cannot enforce is
 * enforced where the bytes are read, or not at all — and this string is
 * rendered as-is in a pill.
 *
 * A length in code points *and* in bytes, because either alone lets something
 * through: four code points can be sixteen bytes of nothing useful, and
 * sixteen bytes can be sixteen separate glyphs.
 */
export function isReactionEmoji(value: string): boolean {
  if (value === "") return false;
  if ([...value].length > 4) return false;
  if (encoder.encode(value).length > 16) return false;
  // \p{White_Space} and the control categories, which together are everything
  // that would render as a hole in the pill.
  return !/[\p{White_Space}\p{Cc}\p{Cf}]/u.test(value);
}

/**
 * The sender's own name for this message, when they gave one.
 *
 * Not the envelope id — that is the server's number, and an edit or a retract
 * has to name its target before any envelope id exists for it. This is what
 * `target` in those payloads refers to.
 */
export function payloadId(payload: Payload): string | undefined {
  switch (payload.kind) {
    case "text":
    case "reply":
    case "attachment":
    case "view_once":
      return payload.id;
    case "sticker":
      return payload.message_id;
    default:
      return undefined;
  }
}
