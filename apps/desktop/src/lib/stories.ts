import { conversations as core, stories as coreStories } from "@nexo/core";

import { runtime } from "./runtime";

/**
 * Stories.
 *
 * One encrypted object in the store, and its key sent down every conversation
 * this device already has — which is why a story is visible to exactly the
 * people you already talk to and to nobody else. There is no story feed and no
 * follower list involved; the fan-out *is* the audience.
 */
export interface Story {
  id: number;
  author_handle: string;
  author_device_id: string;
  mime: string;
  created_at_ms: number;
  expires_at_ms: number;
}

/**
 * Posts one.
 *
 * Takes bytes rather than a path: a browser never learns a path, and the two
 * hosts have to agree on one shape. See `native.ts` for the same change made
 * to the picker that feeds this.
 */
export async function postStory(file: { bytes: Uint8Array; mime: string }): Promise<number> {
  return coreStories.postStory(await context(), file.bytes, file.mime);
}

/**
 * Every live story on this device, newest first.
 *
 * A local read: the keys are here and the expiry is enforced here, so this
 * costs no round trip and works with no network. Reading it is also the
 * **purge** — anything past its expiry is dropped rather than returned, and
 * the key goes with it.
 */
export async function listStories(): Promise<Story[]> {
  const rows = await coreStories.listStories(await context());
  return rows.map((row) => ({
    id: row.id,
    author_handle: row.authorHandle,
    author_device_id: row.authorDeviceId,
    mime: row.mime,
    created_at_ms: row.createdAtMs,
    expires_at_ms: row.expiresAtMs,
  }));
}

/**
 * Fetches one and hands back a URL this page can render.
 *
 * An object URL. The caller revokes it when the viewer closes — a story can be
 * a video, and holding one in memory behind a closed viewer is the sort of
 * leak nobody notices until the tab has been open an hour.
 */
export async function openStory(id: number): Promise<string> {
  const { bytes, mime } = await coreStories.openStory(await context(), id);
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
}

async function context(): Promise<coreStories.StoryContext> {
  const it = await runtime();
  const ctx = await it.context();
  return {
    transport: it.transport,
    store: it.store,
    // The same sealing the Rust client does, through the same crate. Nothing
    // in TypeScript computes anything cryptographic.
    crypto: {
      encrypt: async (plaintext) => {
        const sealed = it.objects.seal(plaintext);
        return {
          ciphertext: sealed.ciphertext,
          key: sealed.key,
          nonce: sealed.nonce,
          sha256: sealed.sha256,
        };
      },
      decrypt: async (ciphertext, key, nonce, sha256) =>
        it.objects.open(ciphertext, key, nonce, sha256),
    },
    objects: coreStories.fetchStoryObjects(),
    sendPayload: (conversationId, payload) =>
      core.sendPayload(ctx, conversationId, payload as never),
  };
}
