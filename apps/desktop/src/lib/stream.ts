import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The live socket, as the page sees it.
 *
 * The connection itself lives in Rust: the access token never crosses this
 * boundary (rule 2), and a socket opened from here would need it — or would
 * need it in the URL, where every proxy on the way logs it.
 *
 * **It adds promptness, not correctness.** The four-second sync poll continues
 * underneath and is what makes the app right; everything here is allowed to
 * fail quietly. That is why none of these reject in a way anybody handles.
 */

/** A typing notice, as Rust emits it. */
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

const TYPING_EVENT = "nexo://typing";
const ENVELOPE_EVENT = "nexo://envelope";

/**
 * Moves whatever the socket has received into Tauri events.
 *
 * Also what opens and closes the connection: Rust connects when there is a
 * session and disconnects when there is not, so signing in, locking and signing
 * out all take care of themselves.
 */
export function drainStream(): Promise<void> {
  return invoke<void>("drain_stream");
}

/** Tells the conversation this device is typing. Fire and forget. */
export function sendTyping(conversationId: string): Promise<void> {
  return invoke<void>("typing", { conversationId });
}

/** Listens for other people typing. */
export function onTyping(
  handler: (event: TypingEvent) => void,
): Promise<UnlistenFn> {
  return listen<TypingEvent>(TYPING_EVENT, (event) => handler(event.payload));
}

/**
 * Listens for anything arriving in a conversation.
 *
 * What makes a call ring promptly: signalling travels as an ordinary envelope,
 * so without this the gap between pressing *call* and the other side ringing
 * was however much of the four-second poll was left.
 */
export function onEnvelope(
  handler: (event: EnvelopeEvent) => void,
): Promise<UnlistenFn> {
  return listen<EnvelopeEvent>(ENVELOPE_EVENT, (event) =>
    handler(event.payload),
  );
}
