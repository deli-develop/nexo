/** Stories are one encrypted object whose key is sent over existing MLS chats. */

import { TransportError } from "./errors";
import type { StoredStory } from "./store";
import type { Transport } from "./transport";

/** This shape mirrors `Payload::Story` in `crates/protocol`. */
export interface StoryPayload {
  kind: "story";
  story_id: number;
  s3_key: string;
  key: string;
  nonce: string;
  sha256: string;
  mime: string;
  size: number;
  expires_at_ms: number;
}

export interface SealedStory {
  ciphertext: Uint8Array;
  key: Uint8Array;
  nonce: Uint8Array;
  /** SHA-256 of plaintext, computed by the Rust crypto crate. */
  sha256: Uint8Array;
}

/** The implementation must call `nexo-crypto` through WASM, never JS crypto. */
export interface StoryCrypto {
  encrypt(plaintext: Uint8Array): Promise<SealedStory>;
  decrypt(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    sha256: Uint8Array,
  ): Promise<Uint8Array>;
}

export interface StoryObjects {
  put(url: string, bytes: Uint8Array): Promise<void>;
  get(url: string): Promise<Uint8Array>;
}

/** Exactly the local operations stories need, so IndexedDB owns expiry. */
export interface StoryStore {
  putStory(row: StoredStory): Promise<void>;
  liveStories(nowMs: number): Promise<StoredStory[]>;
  conversationIds(): Promise<string[]>;
}

export interface StoryContext {
  transport: Transport;
  store: StoryStore;
  crypto: StoryCrypto;
  objects: StoryObjects;
  /** Wired to `conversations.sendPayload` by the session layer. */
  sendPayload(conversationId: string, payload: StoryPayload): Promise<number | null>;
  now?: () => number;
  onFanoutError?: (conversationId: string, error: unknown) => void;
}

interface UploadGrant {
  url: string;
  key: string;
}

/** The server's JSON response has no object key or size. */
interface StoryReceipt {
  id: number;
  author_handle: string;
  created_at_ms: number;
  expires_at_ms: number;
}

interface StoryUrl {
  url: string;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function unhex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new TransportError("rejected", "That story is unreadable.");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Upload, record, save our own key, then fan out. A failed upload never creates
 * a server row or gives somebody a key for an object that does not exist.
 */
export async function postStory(
  ctx: StoryContext,
  contents: Uint8Array,
  mime: string,
): Promise<number> {
  const sealed = await ctx.crypto.encrypt(contents);
  const grant = await ctx.transport.postAuth<UploadGrant>("/v1/media/upload", {
    bucket: "story",
    size: sealed.ciphertext.byteLength,
  });
  await ctx.objects.put(grant.url, sealed.ciphertext);
  const receipt = await ctx.transport.postAuth<StoryReceipt>("/v1/stories", {
    s3_key: grant.key,
    size: sealed.ciphertext.byteLength,
  });

  const payload: StoryPayload = {
    kind: "story",
    story_id: receipt.id,
    s3_key: grant.key,
    key: hex(sealed.key),
    nonce: hex(sealed.nonce),
    sha256: hex(sealed.sha256),
    mime,
    size: contents.byteLength,
    expires_at_ms: receipt.expires_at_ms,
  };

  // Own copy first: a contact refusing a send cannot erase the author's story.
  await ctx.store.putStory({
    id: receipt.id,
    authorHandle: receipt.author_handle,
    authorDeviceId: "",
    s3Key: grant.key,
    encKey: payload.key,
    nonce: payload.nonce,
    sha256: payload.sha256,
    mime,
    size: contents.byteLength,
    createdAtMs: receipt.created_at_ms,
    expiresAtMs: receipt.expires_at_ms,
  });

  for (const conversationId of await ctx.store.conversationIds()) {
    try {
      await ctx.sendPayload(conversationId, payload);
    } catch (error) {
      // One unreachable contact must not take the story away from the rest.
      ctx.onFanoutError?.(conversationId, error);
    }
  }
  return receipt.id;
}

/**
 * Purges expired keys even offline, then resolves incoming device ids using
 * the server's story-id listing when it is reachable.
 */
export async function listStories(ctx: StoryContext): Promise<StoredStory[]> {
  const stories = await ctx.store.liveStories((ctx.now ?? Date.now)());
  let listed: StoryReceipt[];
  try {
    listed = await ctx.transport.getAuth<StoryReceipt[]>("/v1/stories");
  } catch {
    return stories;
  }
  const handles = new Map(listed.map((story) => [story.id, story.author_handle]));
  return stories.map((story) => {
    if (story.authorHandle !== "") return story;
    const handle = handles.get(story.id);
    return handle === undefined ? story : { ...story, authorHandle: handle };
  });
}

/** Expiry is checked locally before requesting a presigned download URL. */
export async function openStory(
  ctx: StoryContext,
  id: number,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const story = (await ctx.store.liveStories((ctx.now ?? Date.now)()))
    .find((candidate) => candidate.id === id);
  if (!story) throw new TransportError("not_found", "That story is gone.");

  const grant = await ctx.transport.postAuth<StoryUrl>(`/v1/stories/${id}/url`, null);
  const ciphertext = await ctx.objects.get(grant.url);
  const bytes = await ctx.crypto.decrypt(
    ciphertext,
    unhex(story.encKey),
    unhex(story.nonce),
    unhex(story.sha256),
  );
  return { bytes, mime: story.mime };
}

/** Presigned requests carry their permission in the URL, not an API token. */
export function fetchStoryObjects(fetcher: typeof fetch = globalThis.fetch): StoryObjects {
  async function request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetcher(url, { ...init, credentials: "omit" });
    } catch (cause) {
      throw TransportError.unreachable(cause instanceof Error ? cause.message : String(cause));
    }
    if (!response.ok) {
      throw new TransportError("rejected", `The storage provider returned ${response.status}.`);
    }
    return response;
  }
  return {
    put: async (url, bytes) => {
      await request(url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(bytes),
      });
    },
    get: async (url) => new Uint8Array(await (await request(url, { method: "GET" })).arrayBuffer()),
  };
}
