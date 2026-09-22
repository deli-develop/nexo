import {
  Store,
  TransportError,
  attachments as coreAttachments,
  conversations as core,
  decodePayload,
  type Payload,
  type StoredMessage,
} from "@nexo/core";

import { saveFile } from "./native";
import { runtime } from "./runtime";

/**
 * Conversations, as the page sees them.
 *
 * Everything here is already decrypted. There is no ciphertext in any of these
 * types, no epoch and no key: what a screen needs to draw a conversation is a
 * title, some messages and who sent them, and giving it more would mean every
 * component became a place MLS could be got wrong.
 *
 * Wave 7 changed what is *behind* this file — `packages/core` rather than
 * `invoke()` — and deliberately not the shapes above it. That is the whole
 * reason this directory exists.
 */
export interface Conversation {
  conversation_id: string;
  kind: string;
  /**
   * What to call it. `null` for a conversation joined from a Welcome, which
   * this device has no name for until a profile fetch supplies one.
   */
  title: string | null;
  members: string[];
  last_message: string | null;
  last_message_at_ms: number | null;
  /**
   * Whether this device sent the most recent message. What decides that a
   * conversation whose newest message is our own never toasts and never
   * counts as unread.
   */
  last_message_outgoing: boolean | null;
  /** Whether a picture has been set. */
  has_avatar: boolean;
  /** Whether every current key here was confirmed out of band. */
  verified: boolean;
  /** Whether somebody's key changed since it was last acknowledged. */
  key_changed: boolean;
  key_changed_at_ms: number | null;
}

export interface Message {
  envelope_id: number;
  sender_device_id: string | null;
  body: string;
  sent_at_ms: number;
  outgoing: boolean;
  pending: boolean;
  attachment: Attachment | null;
  client_id: string | null;
  unsupported: string | null;
  forwarded_from: string | null;
  forwarded: boolean;
  pinned: boolean;
  reactions: MessageReaction[];
  retracted_at_ms: number | null;
  edited_at_ms: number | null;
  reply?: Reply;
  view_once?: ViewOnce;
  sticker?: { pack: string; id: string };
}

export interface ViewOnce {
  openable: boolean;
  outgoing: boolean;
  opened_at_ms?: number;
  kind: "image" | "video";
}

export interface Reply {
  target: string;
  found: boolean;
  envelope_id?: number;
  body?: string;
  outgoing: boolean;
  /** Whether the quoted message has since been taken back. */
  retracted: boolean;
  /** A short piece of it, for the quote line. Empty when not found. */
  excerpt: string;
}

export interface Attachment {
  name: string;
  mime: string;
  size: number;
  voice?: VoiceMeta;
  streamable: boolean;
}

export interface VoiceMeta {
  duration_ms: number;
  peaks: number[];
}

export interface MessageReaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface SearchHit {
  envelope_id: number;
  conversation_id: string;
  body: string;
  sent_at_ms: number;
  outgoing: boolean;
}

export interface Folder {
  id: number;
  name: string;
  conversations: string[];
}

export interface AttachmentEntry {
  /** All the page sends to ask for the bytes. */
  envelope_id: number;
  kind: "image" | "video" | "file";
  name: string;
  mime: string;
  size: number;
  sent_at_ms: number;
  outgoing: boolean;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface SyncResult {
  messages: number;
  commits: number;
  failed: number;
  arrivals: { conversation_id: string; messages: number }[];
}

export interface FlushResult {
  sent: number;
  already_sent: number;
  still_queued: number;
  failed: number;
}

export interface ConversationError {
  kind:
    | "unreachable"
    | "signed_out"
    | "not_found"
    | "rejected"
    | "stale_epoch"
    | "internal";
  message: string;
}

/** Narrows an unknown rejection to something renderable. */
export function asConversationError(error: unknown): ConversationError {
  if (error instanceof TransportError) {
    return {
      kind: error.kind === "invalid_credentials" ? "signed_out" : error.kind,
      message: error.message,
    };
  }
  if (typeof error === "object" && error !== null && "kind" in error && "message" in error) {
    return error as ConversationError;
  }
  return { kind: "internal", message: "Something went wrong. Try again." };
}

/** How often the app catches up regardless of what the socket is doing. */
export const SYNC_INTERVAL_MS = 4000;

// ------------------------------------------------------------------- reading

export async function listConversations(): Promise<Conversation[]> {
  const { store } = await runtime();
  const rows = await store.conversations();
  return Promise.all(
    rows.map(async (row) => {
      const peers = await store.peers(row.id);
      const changed = peers.filter((peer) => peer.changedAtMs !== null);
      return {
        conversation_id: row.id,
        kind: row.kind,
        title: row.title,
        // Handles, from the server's list. The peers below are *devices* —
        // MLS names leaves, not accounts — so they cannot answer this.
        members: row.members ?? [],
        last_message: row.lastMessage,
        last_message_at_ms: row.updatedAtMs === 0 ? null : row.updatedAtMs,
        last_message_outgoing: row.lastMessageOutgoing ?? null,
        has_avatar: row.avatar !== undefined,
        // Verified means the key confirmed out of band is still the key in
        // use. A stale confirmation is not a confirmation, which is the whole
        // point of keeping both.
        verified:
          peers.length > 0 &&
          peers.every(
            (peer) =>
              peer.verifiedKey !== null && sameKey(peer.verifiedKey, peer.identityKey),
          ),
        key_changed: changed.length > 0,
        key_changed_at_ms: changed[0]?.changedAtMs ?? null,
      } satisfies Conversation;
    }),
  );
}

export async function conversationMessages(conversationId: string): Promise<Message[]> {
  const { store } = await runtime();
  const [rows, reactions, pinned] = await Promise.all([
    store.messages(conversationId),
    store.reactions(conversationId),
    store.pinnedMessages(conversationId),
  ]);
  const pins = new Set(pinned.map((row) => row.id));
  const byTarget = new Map<string, MessageReaction[]>();
  for (const reaction of reactions) {
    const list = byTarget.get(reaction.target) ?? [];
    const existing = list.find((entry) => entry.emoji === reaction.emoji);
    const mine = reaction.deviceId === "self";
    if (existing) {
      existing.count += 1;
      existing.mine ||= mine;
    } else {
      list.push({ emoji: reaction.emoji, count: 1, mine });
    }
    byTarget.set(reaction.target, list);
  }
  return rows.map((row) => toMessage(row, byTarget, pins, rows));
}

/**
 * Turns one stored row into what a bubble needs.
 *
 * The payload is parsed here and nowhere else. A component that parsed it
 * would be a component holding an attachment's key, and there would be one
 * more of those every time somebody added a screen.
 */
function toMessage(
  row: StoredMessage,
  reactions: Map<string, MessageReaction[]>,
  pins: Set<number>,
  all: StoredMessage[],
): Message {
  const payload: Payload | null = row.payload ? decodePayload(row.payload) : null;
  const outgoing = row.senderDeviceId === null;

  const message: Message = {
    envelope_id: row.id,
    sender_device_id: row.senderDeviceId,
    body: row.body,
    sent_at_ms: row.sentAtMs,
    outgoing,
    // A negative id is a local one: the row exists, the server has not
    // numbered it yet, and the bubble shows a clock rather than a tick.
    pending: row.id < 0,
    attachment: null,
    client_id: row.clientId ?? null,
    unsupported: null,
    forwarded_from: null,
    forwarded: false,
    pinned: pins.has(row.id),
    reactions: (row.clientId && reactions.get(row.clientId)) || [],
    retracted_at_ms: row.retractedAtMs ?? null,
    edited_at_ms: row.editedAtMs ?? null,
  };

  if (row.replyTo !== undefined) {
    const target = all.find((candidate) => candidate.clientId === row.replyTo);
    message.reply = target
      ? {
          target: row.replyTo,
          found: true,
          envelope_id: target.id,
          body: target.body,
          outgoing: target.senderDeviceId === null,
          retracted: target.retractedAtMs !== undefined,
          // Short: a quote line is one line, and a quoted essay would push
          // the message that answers it off the screen.
          excerpt: target.body.slice(0, 120),
        }
      : // A quote of something this device never received. The bubble says
        // "message unavailable" rather than drawing an empty quote, which
        // reads as a message that said nothing.
        { target: row.replyTo, found: false, outgoing: false, retracted: false, excerpt: "" };
  }

  if (!payload) return message;

  switch (payload.kind) {
    case "attachment":
      message.attachment = {
        name: payload.name,
        mime: payload.mime,
        size: payload.size,
        streamable: payload.segmented === true,
      };
      if (payload.voice) message.attachment.voice = payload.voice;
      break;
    case "view_once":
      message.view_once = {
        openable: true,
        outgoing,
        kind: payload.mime.startsWith("video/") ? "video" : "image",
      };
      break;
    case "sticker":
      message.sticker = { pack: payload.pack, id: payload.id };
      break;
    case "text":
      if (payload.forwarded_from) message.forwarded_from = payload.forwarded_from;
      message.forwarded = payload.forwarded === true;
      break;
    case "unsupported":
      // Kept verbatim. This build cannot draw it, and a later one reads these
      // bytes from the store or never sees the message at all — MLS will not
      // decrypt that envelope a second time.
      message.unsupported = payload.unsupportedKind;
      break;
    default:
      break;
  }
  return message;
}

export async function searchMessages(
  term: string,
  options?: { conversationId?: string; limit?: number },
): Promise<SearchHit[]> {
  const { store } = await runtime();
  const hits = await store.searchMessages(
    term,
    options?.conversationId ?? null,
    options?.limit ?? 50,
  );
  return hits.map((hit) => ({
    envelope_id: hit.id,
    conversation_id: hit.conversationId,
    body: hit.body,
    sent_at_ms: hit.sentAtMs,
    outgoing: hit.outgoing,
  }));
}

export async function conversationAttachments(
  conversationId: string,
): Promise<AttachmentEntry[]> {
  const { store } = await runtime();
  const rows = await store.messages(conversationId);
  const entries: AttachmentEntry[] = [];
  for (const row of rows) {
    if (!row.payload) continue;
    const payload = decodePayload(row.payload);
    if (payload.kind !== "attachment") continue;
    entries.push({
      envelope_id: row.id,
      kind: payload.mime.startsWith("image/")
        ? "image"
        : payload.mime.startsWith("video/")
          ? "video"
          : "file",
      name: payload.name,
      mime: payload.mime,
      size: payload.size,
      sent_at_ms: row.sentAtMs,
      outgoing: row.senderDeviceId === null,
    });
  }
  return entries;
}

// ------------------------------------------------------------------ starting

export async function startConversation(handle: string): Promise<string> {
  return core.openWith(await (await runtime()).context(), handle);
}

export async function startGroup(handles: string[], title: string): Promise<string> {
  return core.startGroup(await (await runtime()).context(), handles, title);
}

export async function openSelfConversation(): Promise<string> {
  return core.startSelf(await (await runtime()).context());
}

export async function addToConversation(
  conversationId: string,
  handle: string,
): Promise<void> {
  return core.addTo(await (await runtime()).context(), conversationId, handle);
}

/**
 * Forgets a conversation on this device.
 *
 * Local only, and the UI says so: the other person keeps their copy, because
 * it is on their disk and the server never had the keys to reach into it.
 */
export async function deleteConversation(conversationId: string): Promise<void> {
  const { store } = await runtime();
  await store.forgetConversation(conversationId);
}

// ------------------------------------------------------------------- sending

export async function sendMessage(conversationId: string, body: string): Promise<Message> {
  const it = await runtime();
  const id = await core.send(await it.context(), conversationId, body);
  return lastMessage(it.store, conversationId, id);
}

export async function sendReply(
  conversationId: string,
  body: string,
  target: string,
): Promise<Message> {
  const it = await runtime();
  const id = await core.reply(await it.context(), conversationId, target, body);
  return lastMessage(it.store, conversationId, id);
}

export async function sendAttachment(
  conversationId: string,
  file: { name: string; mime: string; bytes: Uint8Array },
  body?: string,
): Promise<Message> {
  const it = await runtime();
  const meta = { name: file.name, mime: file.mime } as coreAttachments.AttachmentMeta;
  if (body?.trim()) meta.body = body.trim();
  const id = await coreAttachments.sendAttachment(
    await it.attachments(),
    conversationId,
    file.bytes,
    meta,
  );
  return lastMessage(it.store, conversationId, id);
}

export async function sendVoiceMessage(
  conversationId: string,
  audio: Blob,
  durationMs: number,
  peaks: number[],
): Promise<Message> {
  const it = await runtime();
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const id = await coreAttachments.sendAttachment(
    await it.attachments(),
    conversationId,
    bytes,
    {
      name: "voice-message.webm",
      mime: audio.type || "audio/webm",
      voice: { duration_ms: Math.max(0, Math.round(durationMs)), peaks },
    },
  );
  return lastMessage(it.store, conversationId, id);
}

export async function sendViewOnce(
  conversationId: string,
  file: { mime: string; bytes: Uint8Array },
): Promise<Message> {
  const it = await runtime();
  const clientId = globalThis.crypto.randomUUID();
  const id = await coreAttachments.sendViewOnce(
    await it.attachments(),
    conversationId,
    file.bytes,
    file.mime,
    clientId,
  );
  return lastMessage(it.store, conversationId, id);
}

export async function sendSticker(
  conversationId: string,
  pack: string,
  stickerId: string,
): Promise<Message> {
  const it = await runtime();
  const id = await coreAttachments.sendSticker(
    await it.attachments(),
    conversationId,
    pack,
    stickerId,
  );
  return lastMessage(it.store, conversationId, id);
}

/**
 * Sends somebody else's message on, marked as a forward.
 *
 * Re-sent rather than relayed: a message is encrypted to the group it was sent
 * to, so there is no way to hand the original ciphertext to a different set of
 * people. The mark is what keeps that honest — the new readers are told this
 * is not something the sender wrote.
 */
export async function forwardMessage(
  _conversationId: string,
  envelopeId: number,
  toConversationId: string,
  forwardedFrom?: string,
): Promise<void> {
  const it = await runtime();
  const row = await it.store.message(envelopeId);
  if (!row) throw new TransportError("not_found", "That message is gone.");

  const payload: Payload = row.payload
    ? decodePayload(row.payload)
    : { kind: "text", body: row.body };
  if (payload.kind !== "text" && payload.kind !== "attachment") {
    throw new TransportError("rejected", "That cannot be forwarded.");
  }
  const forwarded = { ...payload, forwarded: true } as typeof payload & {
    forwarded_from?: string;
  };
  if (forwardedFrom !== undefined) forwarded.forwarded_from = forwardedFrom;
  await core.sendPayload(await it.context(), toConversationId, forwarded);
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<void> {
  return core.rename(await (await runtime()).context(), conversationId, title);
}

export async function setConversationAvatar(
  conversationId: string,
  file: { mime: string; bytes: Uint8Array },
): Promise<void> {
  const it = await runtime();
  await coreAttachments.setGroupAvatar(
    await it.attachments(),
    conversationId,
    file.bytes,
    file.mime,
  );
}

export async function reactToMessage(
  conversationId: string,
  target: string,
  emoji: string,
  on: boolean,
): Promise<void> {
  return core.react(await (await runtime()).context(), conversationId, target, emoji, on);
}

export async function reviseMessage(
  conversationId: string,
  target: string,
  body?: string,
): Promise<void> {
  return core.revise(
    await (await runtime()).context(),
    conversationId,
    target,
    body ?? null,
  );
}

// ------------------------------------------------------------------- objects

/**
 * Fetches an attachment and hands back a URL this page can render.
 *
 * An **object URL**, not a data URL. A data URL of a forty-megabyte video is
 * fifty-four megabytes of base64 in a string, copied again every time it is
 * assigned; an object URL is a handle. The caller revokes it.
 */
export async function attachmentUrl(envelopeId: number): Promise<string> {
  const { bytes, mime } = await attachmentBytes(envelopeId);
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
}

/** The decrypted bytes, for saving rather than rendering. */
export async function attachmentBytes(
  envelopeId: number,
): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
  const it = await runtime();
  const row = await it.store.message(envelopeId);
  if (!row?.payload) throw new TransportError("not_found", "That attachment is gone.");
  const payload = decodePayload(row.payload);
  if (payload.kind !== "attachment" && payload.kind !== "view_once") {
    throw new TransportError("not_found", "That message has no attachment.");
  }
  const bytes = await coreAttachments.open(await it.attachments(), payload);
  return {
    bytes,
    mime: payload.mime,
    name: payload.kind === "attachment" ? payload.name : "view-once",
  };
}

/**
 * Opens a view-once, and burns it.
 *
 * The key is destroyed as part of opening, not afterwards and not on a timer:
 * a crash between the two would leave something that can be opened again, and
 * the promise this makes is that it cannot be.
 */
export async function openViewOnce(clientId: string): Promise<string> {
  const it = await runtime();
  const record = await it.store.viewOnce(clientId);
  if (!record || !record.encKey) {
    throw new TransportError("not_found", "That has already been opened.");
  }
  const bytes = await coreAttachments.open(await it.attachments(), {
    s3_key: record.s3Key,
    key: record.encKey,
    nonce: record.nonce ?? "",
    sha256: record.sha256 ?? "",
  });
  await it.store.burnViewOnce(clientId, Date.now());
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: record.mime }));
}

export async function conversationAvatar(conversationId: string): Promise<string | null> {
  const it = await runtime();
  const conversation = await it.store.conversation(conversationId);
  if (!conversation?.avatar) return null;
  const payload = decodePayload(conversation.avatar);
  if (payload.kind !== "group_avatar") return null;
  const bytes = await coreAttachments.open(await it.attachments(), payload);
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: payload.mime }));
}

/**
 * Saves an attachment wherever the person chooses.
 *
 * Fetch, decrypt, then hand the bytes to the host: Tauri asks where and
 * writes, a browser hands it to the download mechanism. Answers whether it
 * was saved, because a path is a thing only one of those two can give.
 */
export async function saveAttachment(envelopeId: number): Promise<boolean> {
  const { bytes, name } = await attachmentBytes(envelopeId);
  return saveFile(name, bytes);
}

// --------------------------------------------------------------- local state

export async function draft(conversationId: string): Promise<string | null> {
  return (await runtime()).store.draft(conversationId);
}

export async function setDraft(conversationId: string, body: string): Promise<void> {
  return (await runtime()).store.setDraft(conversationId, body);
}

export async function conversationsWithDrafts(): Promise<string[]> {
  return (await runtime()).store.conversationsWithDrafts();
}

export async function listFolders(): Promise<Folder[]> {
  const folders = await (await runtime()).store.folders();
  return folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    conversations: folder.conversations,
  }));
}

export async function createFolder(name: string): Promise<number> {
  return (await runtime()).store.createFolder(name, Date.now());
}

export async function renameFolder(folderId: number, name: string): Promise<void> {
  return (await runtime()).store.renameFolder(folderId, name);
}

export async function deleteFolder(folderId: number): Promise<void> {
  return (await runtime()).store.deleteFolder(folderId);
}

export async function setFolderMember(
  folderId: number,
  conversationId: string,
  member: boolean,
): Promise<void> {
  return (await runtime()).store.setFolderMember(folderId, conversationId, member);
}

export async function setMessagePinned(
  conversationId: string,
  envelopeId: number,
  pinned: boolean,
): Promise<void> {
  return (await runtime()).store.setPinned(conversationId, envelopeId, pinned, Date.now());
}

export async function deleteMessageForMe(
  conversationId: string,
  envelopeId: number,
): Promise<void> {
  return (await runtime()).store.deleteMessage(conversationId, envelopeId);
}

export async function markVerified(conversationId: string): Promise<void> {
  return (await runtime()).store.markVerified(conversationId);
}

export async function acknowledgeKeyChange(conversationId: string): Promise<void> {
  return (await runtime()).store.acknowledgeKeyChange(conversationId);
}

/**
 * The number both sides read out loud to check nobody is in between.
 *
 * `null` when there is nobody to compare with — a conversation with yourself,
 * or one whose other member's key this device has not seen yet. A screen that
 * showed a number in that case would be showing a number of one party, which
 * confirms nothing at all.
 */
export async function safetyNumber(conversationId: string): Promise<string | null> {
  const it = await runtime();
  const peers = await it.store.peers(conversationId);
  const other = peers[0];
  if (!other) return null;
  const device = await it.session.device();
  return device.safetyNumber(other.identityKey);
}

// ------------------------------------------------------------------- syncing

export async function syncConversation(conversationId: string): Promise<SyncResult> {
  const outcome = await core.sync(await (await runtime()).context(), conversationId);
  return {
    messages: outcome.messages,
    commits: outcome.commits,
    failed: outcome.failed,
    arrivals:
      outcome.messages > 0
        ? [{ conversation_id: conversationId, messages: outcome.messages }]
        : [],
  };
}

export async function syncAll(): Promise<SyncResult> {
  const before = await countsByConversation();
  const outcome = await (await runtime()).session.sync();
  const after = await countsByConversation();

  // Per-conversation arrivals, worked out from the counts either side rather
  // than reported by `syncAll`: what the notification layer needs is which
  // conversation woke up, and a total cannot say.
  const arrivals: SyncResult["arrivals"] = [];
  for (const [id, count] of after) {
    const grew = count - (before.get(id) ?? 0);
    if (grew > 0) arrivals.push({ conversation_id: id, messages: grew });
  }
  return {
    messages: outcome.messages,
    commits: outcome.commits,
    failed: outcome.failed,
    arrivals,
  };
}

export async function flushOutbox(): Promise<FlushResult> {
  const it = await runtime();
  const queued = (await it.store.outbox()).length;
  const sent = await core.flushOutbox(await it.context());
  const left = (await it.store.outbox()).length;
  return {
    sent,
    // Dropped because the server refused them outright. Retrying for ever
    // would block everything behind them in the queue.
    already_sent: Math.max(0, queued - sent - left),
    still_queued: left,
    failed: 0,
  };
}

export async function outboxCount(): Promise<number> {
  return (await (await runtime()).store.outbox()).length;
}

// ------------------------------------------------------------------ internals

async function countsByConversation(): Promise<Map<string, number>> {
  const { store } = await runtime();
  const counts = new Map<string, number>();
  for (const conversation of await store.conversations()) {
    counts.set(conversation.id, (await store.messages(conversation.id)).length);
  }
  return counts;
}

/**
 * The row a send just wrote, for a caller that wants to draw it immediately.
 *
 * Read back rather than constructed: the store decides what a message is, and
 * a second construction here would drift from it the first time either changed.
 */
async function lastMessage(
  store: Store,
  conversationId: string,
  envelopeId: number | null,
): Promise<Message> {
  const rows = await store.messages(conversationId);
  const row =
    envelopeId === null
      ? rows[rows.length - 1]
      : rows.find((candidate) => candidate.id === envelopeId) ?? rows[rows.length - 1];
  if (!row) throw new TransportError("rejected", "The message was not written down.");
  return toMessage(row, new Map(), new Set(), rows);
}

/** Two keys, byte for byte. A `===` on `Uint8Array` compares identity. */
function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
