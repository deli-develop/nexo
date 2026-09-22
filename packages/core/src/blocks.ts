import type { Transport } from "./transport";

/**
 * Blocking.
 *
 * Three calls, and this file is thin on purpose: **the effects live on the
 * server**, because a block the client applies is a promise the product cannot
 * keep. The blocked person goes on sending, the server goes on accepting, and
 * the only thing that changes is whether one app draws it — which is worse
 * than offering nothing, given what the word means to the person who used it.
 *
 * So there is nothing here to hide a message with, and there must not be.
 * Everything the server does about a block is in `apps/server/src/blocks.rs`,
 * and what it deliberately does *not* do is worth repeating wherever the UI
 * quotes it: it does not stop a second account, and it does not reach
 * backwards — messages already delivered are on the other person's disk, and
 * the server never had the keys.
 */

export interface Block {
  handle: string;
  display_name: string;
  blocked_at_ms: number;
}

/**
 * Everyone this account is blocking.
 *
 * Only the caller's own list. There is no call for "who is blocking me", and
 * adding one would hand the blocked person the very confirmation the whole
 * design withholds.
 */
export function blocks(transport: Transport): Promise<Block[]> {
  return transport.getAuth<Block[]>("/v1/blocks");
}

export function block(transport: Transport, handle: string): Promise<void> {
  return transport.postAuth<void>(`/v1/blocks/${encodeURIComponent(handle)}`, {});
}

export function unblock(transport: Transport, handle: string): Promise<void> {
  return transport.deleteAuth(`/v1/blocks/${encodeURIComponent(handle)}`);
}
