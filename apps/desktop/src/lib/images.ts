import { imageObjectUrl } from "./feed";

/**
 * Pictures from object storage, as `blob:` URLs — one per key, shared, and
 * given back.
 *
 * Shared because the same picture is drawn many times at once: one person's
 * face in a conversation list, a thread and a header is one key, and fetching
 * it once per place would be the same download repeated.
 *
 * Given back because a `blob:` URL keeps its bytes until it is revoked, and
 * the desktop app runs for days in the tray. A memo that never let go would
 * hold every picture anybody scrolled past.
 *
 * So each key is counted. A URL that anything on screen still uses is never
 * revoked — the element drawing it would lose it on its next repaint. Once
 * nothing uses it, it waits among the `idleLimit` most recently released, so
 * scrolling back does not fetch again, and is revoked when it falls off the
 * end. A failed load is not kept: the next image to ask tries again.
 */

export interface ImageHandle {
  /** The `blob:` URL, once the bytes are here. */
  url: Promise<string>;
  /** Done with it. Call once; later calls do nothing. */
  release(): void;
}

export interface ImageCache {
  acquire(key: string): ImageHandle;
}

interface Entry {
  url: Promise<string>;
  users: number;
}

export function createImageCache(options: {
  load: (key: string) => Promise<string>;
  revoke: (url: string) => void;
  idleLimit: number;
}): ImageCache {
  // Insertion order is recency: a released entry is moved to the end, so the
  // first idle entries in the map are the ones released longest ago.
  const entries = new Map<string, Entry>();

  function trim(): void {
    let idle = 0;
    for (const entry of entries.values()) if (entry.users === 0) idle += 1;
    for (const [key, entry] of entries) {
      if (idle <= options.idleLimit) return;
      if (entry.users > 0) continue;
      entries.delete(key);
      idle -= 1;
      entry.url.then(options.revoke, () => {});
    }
  }

  return {
    acquire(key) {
      let entry = entries.get(key);
      if (!entry) {
        const created: Entry = { url: options.load(key), users: 0 };
        created.url.catch(() => {
          if (entries.get(key) === created) entries.delete(key);
        });
        entries.set(key, created);
        entry = created;
      }
      entry.users += 1;

      // Bound to this entry, not to the key: if the load failed and a later
      // acquire made a new one, this release must not count against it.
      const held = entry;
      let released = false;
      return {
        url: held.url,
        release() {
          if (released) return;
          released = true;
          held.users -= 1;
          if (held.users > 0 || entries.get(key) !== held) return;
          entries.delete(key);
          entries.set(key, held);
          trim();
        },
      };
    },
  };
}

const shared = createImageCache({
  load: imageObjectUrl,
  revoke: (url) => URL.revokeObjectURL(url),
  // A screenful of avatars and a few posts either side of it.
  idleLimit: 64,
});

/** A picture from object storage, for as long as the handle is held. */
export function acquireImage(key: string): ImageHandle {
  return shared.acquire(key);
}
