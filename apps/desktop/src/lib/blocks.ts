import { blocks as core } from "@nexo/core";

import { confirm } from "./native";
import { runtime } from "./runtime";

/**
 * Blocking (§6.1).
 *
 * Every one of these is a round trip to the server, and that is the point.
 * A block applied in here would change nothing: the other person would go on
 * sending, the server would go on accepting, and only this one app would look
 * away. The server drops their posts from the feed and refuses to open a
 * conversation between you — which is a thing the word can honestly mean.
 *
 * What it cannot do is stop somebody making a second account. The UI says so
 * where blocking is offered, because a security promise that overstates itself
 * is worse than none (rule 5).
 */
export interface Block {
  handle: string;
  display_name: string;
  blocked_at_ms: number;
}

/** Everyone you are blocking, newest first. */
export async function listBlocks(): Promise<Block[]> {
  return core.blocks((await runtime()).transport);
}

/** Blocks somebody. Doing it twice is not an error. */
export async function block(handle: string): Promise<void> {
  return core.block((await runtime()).transport, handle);
}

/**
 * Asks before blocking somebody, in the one wording every place that offers
 * it shares: a profile, and a post's menu in the feed. The last sentence is
 * the limit this header describes, and it stays in front of the decision.
 */
export function confirmBlock(name: string): Promise<boolean> {
  return confirm(
    `Block ${name}?`,
    "Their posts leave your feed, yours leave theirs, and neither of you can start a " +
      "conversation with the other. Messages already delivered stay where they are — they " +
      "are on each other's machines and the server never had the keys. Blocking also " +
      "cannot stop somebody making a second account.",
  );
}

/** Unblocks somebody. Doing it twice is not an error. */
export async function unblock(handle: string): Promise<void> {
  return core.unblock((await runtime()).transport, handle);
}
