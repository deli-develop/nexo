import { voiceMeta, type Payload } from "./payload";
import { TransportError } from "./errors";
import type { Transport } from "./transport";

/**
 * Files, pictures, voice notes, stickers and view-once.
 *
 * All of them are the same act with different labels: seal the bytes, put the
 * ciphertext somewhere the server can hold but not read, and send the **key**
 * inside an MLS message. The object store — a third party's, in production —
 * gets ciphertext and a size and nothing else.
 *
 * Three rules, and none of them is optional:
 *
 * 1. **Upload before you announce.** A payload naming an object that was never
 *    stored is a permanent broken attachment for everybody in the
 *    conversation, and there is no repair: MLS will not let that message be
 *    sent again.
 * 2. **A fresh key per object.** The key travels with the message, so the same
 *    file shared into two conversations is sealed twice. Sharing a key across
 *    them would mean one conversation's members could read the other's copy.
 * 3. **Check the hash on the way out.** AES-GCM proves the object store did
 *    not alter the bytes; it does not prove these are the bytes the message
 *    named. The SHA-256 inside the encrypted payload is what does, and
 *    `openObject` in the Rust facade refuses without it.
 */

/** What `sealObject` gives back. Mirrors `Sealed` in `crates/crypto-wasm`. */
export interface SealedObject {
  ciphertext: Uint8Array;
  key: Uint8Array;
  nonce: Uint8Array;
  sha256: Uint8Array;
  size: number;
}

/**
 * The sealing seam.
 *
 * Nothing in TypeScript computes anything cryptographic — rule 1 — so this is
 * satisfied by `bindObjectWasm`, which is a pass-through to Rust.
 */
export interface ObjectCrypto {
  seal(plaintext: Uint8Array): SealedObject;
  open(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    sha256: Uint8Array,
  ): Uint8Array;
  /**
   * Opens an object sealed in 256 KiB segments, whole. Only the Rust client
   * sealed this way (video, so it could play a range early); `size` is the
   * sender's declared length and must match the ciphertext's.
   */
  openSegmented(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    sha256: Uint8Array,
    size: number,
  ): Uint8Array;
}

/** Getting bytes to and from the object store, which is not `apps/server`. */
export interface ObjectStore {
  put(url: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(url: string): Promise<Uint8Array>;
}

export interface AttachmentContext {
  transport: Transport;
  crypto: ObjectCrypto;
  objects: ObjectStore;
  /** Injectable so a test can pin names. Defaults to `crypto.randomUUID`. */
  uuid?: () => string;
  /** Wired to `conversations.sendPayload` by the session layer. */
  sendPayload(conversationId: string, payload: Payload): Promise<number | null>;
}

interface UploadGrant {
  url: string;
  key: string;
}

/** What to send, beyond the bytes themselves. */
export interface AttachmentMeta {
  name: string;
  mime: string;
  /** A caption. The filename is what a bubble falls back to. */
  body?: string;
  /** Present on a voice note: the waveform and the length, for the player. */
  voice?: { duration_ms: number; peaks: number[] };
}

/**
 * Sends a file into a conversation.
 *
 * The ordering is rule 1 above, spelled out: seal, ask for somewhere to put
 * it, put it, and only then send the message that names it.
 */
export async function sendAttachment(
  ctx: AttachmentContext,
  conversationId: string,
  bytes: Uint8Array,
  meta: AttachmentMeta,
): Promise<number | null> {
  const sealed = ctx.crypto.seal(bytes);
  const key = await upload(ctx, sealed, conversationId);

  const payload: Payload = {
    kind: "attachment",
    s3_key: key,
    key: hex(sealed.key),
    nonce: hex(sealed.nonce),
    sha256: hex(sealed.sha256),
    name: meta.name,
    mime: meta.mime,
    size: sealed.size,
    // The name Reply, React and Edit refer to. The Rust client always set it;
    // the port did not, so no file sent from the page could be answered.
    id: uuid(ctx),
  };
  // Absent rather than empty: adding a field must not change a byte of what a
  // message without it puts on the wire.
  if (meta.body !== undefined && meta.body !== "") payload.body = meta.body;
  // Dropped here once, so every voice note arrived as a plain audio file:
  // the recorder measured the length and the waveform and they never left.
  const voice = voiceMeta(meta.voice);
  if (voice) payload.voice = voice;
  return ctx.sendPayload(conversationId, payload);
}

/**
 * Sends something that can be opened once.
 *
 * The difference from an ordinary attachment is entirely on the receiving
 * side — `openViewOnce` destroys the key after handing over the bytes — which
 * is why this is a separate `kind` rather than a flag: a build that did not
 * know about view-once would otherwise treat one as an ordinary file and keep
 * it for ever.
 */
export async function sendViewOnce(
  ctx: AttachmentContext,
  conversationId: string,
  bytes: Uint8Array,
  mime: string,
  clientId: string,
): Promise<number | null> {
  const sealed = ctx.crypto.seal(bytes);
  const key = await upload(ctx, sealed, conversationId);
  return ctx.sendPayload(conversationId, {
    kind: "view_once",
    s3_key: key,
    key: hex(sealed.key),
    nonce: hex(sealed.nonce),
    sha256: hex(sealed.sha256),
    mime,
    size: sealed.size,
    id: clientId,
  });
}

/**
 * Fetches and opens one object named by a payload.
 *
 * Nothing is cached here. The bytes are handed to the caller and forgotten:
 * where they are kept — a blob URL, a file the person chose, a canvas — is a
 * platform decision, and this file runs on three platforms.
 */
export async function open(
  ctx: AttachmentContext,
  payload: {
    s3_key: string;
    key: string;
    nonce: string;
    sha256: string;
    /** Set by a sender that sealed in segments; only attachments carry it. */
    segmented?: boolean;
    size?: number;
  },
): Promise<Uint8Array> {
  const grant = await ctx.transport.postAuth<{ url: string }>("/v1/media/download", {
    bucket: "encrypted",
    key: payload.s3_key,
  });
  const ciphertext = await ctx.objects.get(grant.url);
  const [key, nonce, sha256] = [unhex(payload.key), unhex(payload.nonce), unhex(payload.sha256)];
  // The two encodings are indistinguishable from the ciphertext, so the
  // payload's word is the only way to pick. Opening a segmented object as a
  // whole one fails its tag, which is how every video an old client sent read
  // as "can't decrypt".
  if (payload.segmented === true) {
    if (typeof payload.size !== "number") {
      throw new TransportError("rejected", "That attachment does not say how large it is.");
    }
    return ctx.crypto.openSegmented(ciphertext, key, nonce, sha256, payload.size);
  }
  return ctx.crypto.open(ciphertext, key, nonce, sha256);
}

/**
 * A sticker, which carries no object at all.
 *
 * Stickers ship with the app, so what travels is which one — a pack and an id.
 * Sending the picture would be sending the same fifty kilobytes every time
 * anybody used it.
 */
export function sendSticker(
  ctx: AttachmentContext,
  conversationId: string,
  pack: string,
  id: string,
  messageId?: string,
): Promise<number | null> {
  // `message_id` is the message's name, as `id` is on text — `id` here
  // already means which sticker. Without it nothing can refer to the message.
  const payload: Payload = { kind: "sticker", pack, id, message_id: messageId ?? uuid(ctx) };
  return ctx.sendPayload(conversationId, payload);
}

/** Sets the picture on a group, for everyone in it. */
export async function setGroupAvatar(
  ctx: AttachmentContext,
  conversationId: string,
  bytes: Uint8Array,
  mime: string,
): Promise<number | null> {
  const sealed = ctx.crypto.seal(bytes);
  const key = await upload(ctx, sealed, conversationId);
  return ctx.sendPayload(conversationId, {
    kind: "group_avatar",
    s3_key: key,
    key: hex(sealed.key),
    nonce: hex(sealed.nonce),
    sha256: hex(sealed.sha256),
    mime,
    size: sealed.size,
  });
}

// ------------------------------------------------------------------ internals

const uuid = (ctx: AttachmentContext): string =>
  (ctx.uuid ?? (() => globalThis.crypto.randomUUID()))();

async function upload(
  ctx: AttachmentContext,
  sealed: SealedObject,
  conversationId: string,
): Promise<string> {
  const grant = await ctx.transport.postAuth<UploadGrant>("/v1/media/upload", {
    bucket: "encrypted",
    conversation_id: conversationId,
    size: sealed.ciphertext.byteLength,
  });
  await ctx.objects.put(grant.url, sealed.ciphertext, "application/octet-stream");
  return grant.key;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function unhex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new TransportError("rejected", "That attachment is unreadable.");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
