/**
 * Stories, as the page sees them.
 *
 * These lived in `meet.ts` until the map was removed, which was never where
 * they belonged: a story is encrypted media sent through the conversation
 * layer, exactly as an attachment is.
 *
 * The errors these calls throw come from the conversation shell, so they
 * narrow with `asConversationError` from `./conversations` rather than with
 * anything of their own.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * One story this device holds.
 *
 * The key that opens it is **not** here and never crosses the IPC seam — the
 * page asks for a story by id and Rust hands back bytes, exactly as with an
 * attachment (rule 2).
 */
export interface Story {
  id: number;
  /**
   * Who posted it.
   *
   * A received story arrives over MLS, which names a device rather than an
   * account, so Rust starts this blank and fills it in from the server's own
   * `GET /v1/stories` listing, matched by id — never invented from the device
   * id, which would put a UUID under somebody's story. It stays blank only
   * when that reconciliation could not run (offline) or found nothing to
   * match (a story arrived and the listing has not caught up yet); either is
   * rare and both are honestly unresolved rather than guessed.
   */
  author_handle: string;
  /** The device that sent it. Empty for this device's own stories. */
  author_device_id: string;
  mime: string;
  created_at_ms: number;
  /** When it stops being available. At most 24 hours after it was posted. */
  expires_at_ms: number;
}

/**
 * Post a story.
 *
 * Encrypted once and uploaded once; the key is then sent down every
 * conversation you already have. Your contacts are whoever you share a
 * conversation with, which is the same definition the server uses, and
 * blocking therefore takes effect without any story-specific code.
 */
export function postStory(path: string): Promise<number> {
  return invoke<number>("story_post", { path });
}

/**
 * Stories this device holds.
 *
 * Reading is also what ends the expired ones: the call deletes them and their
 * keys as it goes. That is the layer that actually makes a story disappear —
 * ciphertext without its key is nothing — and it works offline.
 */
export function listStories(): Promise<Story[]> {
  return invoke<Story[]>("story_list");
}

/**
 * A story's bytes, as a `data:` URL.
 *
 * The key that opens it stays in Rust — the page asks by id and gets pixels,
 * never what decrypted them.
 */
export function openStory(id: number): Promise<string> {
  return invoke<string>("story_open", { id });
}
