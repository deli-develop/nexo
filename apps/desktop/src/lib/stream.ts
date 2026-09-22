import { Stream } from "@nexo/core";

import { runtime } from "./runtime";

/**
 * The live socket, as the page sees it.
 *
 * **It adds promptness, not correctness.** The four-second sync poll continues
 * underneath and is what makes the app right; everything here is allowed to
 * fail quietly, and none of it rejects in a way anybody handles. `stream.ts`
 * in `packages/core` says the same thing from the other side, and the two have
 * to keep agreeing: the moment something here is load-bearing, a dropped
 * connection becomes a lost message.
 *
 * The subscription shape is the one Tauri's event bus had — `on…` returns an
 * unlisten function — because forty call sites were written against it and the
 * shape is a good one regardless of what is behind it.
 */

/** A typing notice. */
export interface TypingEvent {
  conversation_id: string;
  user_id: number;
}

/**
 * Something arrived for a conversation. No content — an envelope is ciphertext
 * until a sync decrypts it, so this says only "there is something to fetch".
 */
export interface EnvelopeEvent {
  conversation_id: string;
}

export type UnlistenFn = () => void;

const typingHandlers = new Set<(event: TypingEvent) => void>();
const envelopeHandlers = new Set<(event: EnvelopeEvent) => void>();
const resyncHandlers = new Set<() => void>();

let stream: Stream | null = null;

/**
 * Opens the socket if somebody is signed in, and keeps it open.
 *
 * Called from the same place the old `drain_stream` was, so signing in,
 * locking and signing out all still take care of themselves — the difference
 * is that the socket is now in this process rather than in Rust's.
 */
export async function drainStream(): Promise<void> {
  if (stream) return;
  const it = await runtime();
  stream = new Stream({
    baseUrl: it.transport.baseUrl,
    token: () => it.transport.accessToken(),
    onResync: () => {
      for (const handler of resyncHandlers) handler();
    },
    onEvent: (event) => {
      if (event.type === "typing") {
        for (const handler of typingHandlers) handler(event);
      } else if (event.type === "envelope") {
        for (const handler of envelopeHandlers) {
          handler({ conversation_id: event.conversation_id });
        }
      }
    },
  });
  stream.start();
}

/** Closes it. Sign-out, and any failure that invalidates the session. */
export function closeStream(): void {
  stream?.stop();
  stream = null;
}

/** Tells the conversation this device is typing. Fire and forget. */
export async function sendTyping(conversationId: string): Promise<void> {
  stream?.typing(conversationId);
}

/** Listens for other people typing. */
export function onTyping(handler: (event: TypingEvent) => void): Promise<UnlistenFn> {
  typingHandlers.add(handler);
  return Promise.resolve(() => typingHandlers.delete(handler));
}

/** Listens for anything arriving in a conversation. */
export function onEnvelope(handler: (event: EnvelopeEvent) => void): Promise<UnlistenFn> {
  envelopeHandlers.add(handler);
  return Promise.resolve(() => envelopeHandlers.delete(handler));
}

/**
 * Listens for "you were away; go and find out what happened".
 *
 * Fired on every connect, the first one included. The gap while the socket was
 * down is exactly the window where events were missed, and only a sync closes
 * it — so this is the one subscription that is not decoration.
 */
export function onResync(handler: () => void): Promise<UnlistenFn> {
  resyncHandlers.add(handler);
  return Promise.resolve(() => resyncHandlers.delete(handler));
}
