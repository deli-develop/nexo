import { profile as profileCall, type Profile } from "./feed";

/**
 * Profiles by handle, fetched once and remembered.
 *
 * The thing the messages surfaces kept saying they did not have. A conversation
 * knows handles — the server lists its members — but MLS credentials name
 * devices, not accounts, so a handle is as far as the crypto goes. Everything
 * human about a person (their display name, their picture) lives behind
 * `/v1/users/{handle}`, and without somewhere to keep the answer every avatar
 * in a message list would be its own request on every render.
 *
 * Memoised per process, like the pictures in `lib/images.ts` and for the same
 * reason: a list that scrolls would otherwise ask for the same profile over
 * and over. Not persisted — a display name or a picture can change, and a
 * stale one on disk outlives the session that would have corrected it.
 */

const cache = new Map<string, Promise<Profile>>();
const listeners = new Set<() => void>();
/** Resolved profiles, for the synchronous read a render needs. */
const resolved = new Map<string, Profile>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Starts a lookup if one is not already in flight, and returns it.
 *
 * A failure is not cached: the next render should try again rather than
 * inherit a rejected promise for the life of the process.
 */
export function loadProfile(handle: string): Promise<Profile> {
  const key = handle.toLowerCase();
  const existing = cache.get(key);
  if (existing) return existing;

  const pending = profileCall(key);
  cache.set(key, pending);
  void pending
    .then((p) => {
      resolved.set(key, p);
      emit();
    })
    .catch(() => {
      cache.delete(key);
    });
  return pending;
}

/** What is already known about a handle, or `undefined` until it arrives. */
export function knownProfile(handle: string): Profile | undefined {
  return resolved.get(handle.toLowerCase());
}

/** Forgets one handle, so the next read fetches it again. */
export function forgetProfile(handle: string): void {
  const key = handle.toLowerCase();
  cache.delete(key);
  resolved.delete(key);
  emit();
}

export function subscribeProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
