import { invoke } from "@tauri-apps/api/core";

/**
 * Calls, as the page sees them.
 *
 * Signalling only. The media stack lives in the WebView — `RTCPeerConnection`
 * is what carries sound and pictures — and everything here is the part that has
 * to be end-to-end encrypted: who is being called, the offer, the answer, and
 * how it ended.
 *
 * **Signalling rides the conversation, not a route of its own.** Each of these
 * sends an ordinary encrypted payload down the conversation the call belongs
 * to, which is why the server never reads an SDP (rule 4) and why none of it
 * needed a new endpoint. Signals arrive on the other side inside the ordinary
 * sync result, as `SyncResult.calls`.
 *
 * **Nothing here is queued.** A call is a live thing: a signal that cannot be
 * sent now is an error to show, never work to retry, because an offer that left
 * an outbox ten minutes late would ring somebody about a call that is long
 * over.
 */

/** Why a call ended. Mirrors `nexo_protocol::HangupReason`. */
export type HangupReason =
  /** The caller gave up before it was answered. The callee missed it. */
  | "cancelled"
  /** The callee refused it. */
  | "declined"
  /** It connected, and then somebody hung up. The ordinary ending. */
  | "ended"
  /** The media path never came up — nobody's decision, and the UI may say so. */
  | "failed";

/**
 * One step of a call, exactly as it travels on the wire.
 *
 * Tagged by `signal` rather than flattened, so a `switch` reaches every case
 * and TypeScript can tell which fields exist in each.
 */
export type CallSignal =
  | { signal: "offer"; video: boolean; sdp: string }
  | { signal: "answer"; video: boolean; sdp: string }
  | { signal: "hangup"; reason: HangupReason; seconds: number };

/** A signal that arrived, with the context needed to answer it. */
export interface IncomingCall {
  conversation_id: string;
  /**
   * The device that sent it, when MLS could name one. `null` is not a failure:
   * it is an envelope whose sender could not be resolved, and the UI is
   * entitled to describe the call that way rather than drop it.
   */
  sender_device_id: string | null;
  call_id: string;
  signal: CallSignal;
}

/**
 * One relay or STUN server, in WebRTC's own vocabulary.
 *
 * Shaped to match `RTCIceServer`, so it goes into `new RTCPeerConnection({
 * iceServers })` unchanged rather than through a translation nobody would
 * remember to keep in step.
 */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Where a call's media goes, and the credential that opens the relay. */
export interface IceServers {
  servers: IceServer[];
  /** When the credential stops working, ms since the epoch. */
  expires_at_ms: number;
  /**
   * Whether every call must go through the relay instead of peer to peer.
   *
   * The server decides, so the policy can change without a release. It is
   * `true` today, and not for bandwidth: a direct connection puts your home IP
   * address in the ICE candidates the other side receives. When this is set,
   * the page must pass `iceTransportPolicy: "relay"` — reading it and ignoring
   * it would leak exactly what it exists to prevent.
   */
  relay_only: boolean;
}

/**
 * Asks where to send this call's media.
 *
 * Called once per call, right before offering or answering — never cached
 * across calls, because the credential expires and a stale one fails deep
 * inside ICE where there is nothing useful to show anybody.
 *
 * Rejects when the server has no relay configured, which is how the app learns
 * that calls are unavailable rather than broken.
 */
export function callIceServers(): Promise<IceServers> {
  return invoke<IceServers>("call_ice_servers");
}

/**
 * Rings somebody, and returns the id of the call that just started.
 *
 * The id is minted in Rust, not here — it is the one value both sides must
 * agree on, and the page addresses the call with what it gets back.
 *
 * `sdp` must be a *gathered* offer. Waiting for ICE gathering to finish keeps
 * the whole exchange to two messages; trickling would send one per candidate,
 * and an installation that predates calls draws every one of them as a bubble
 * it cannot read.
 */
export function callOffer(
  conversationId: string,
  video: boolean,
  sdp: string,
): Promise<string> {
  return invoke<string>("call_offer", { conversationId, video, sdp });
}

/** Accepts a call that is ringing, with the gathered answer. */
export function callAnswer(
  conversationId: string,
  callId: string,
  video: boolean,
  sdp: string,
): Promise<void> {
  return invoke<void>("call_answer", { conversationId, callId, video, sdp });
}

/**
 * Ends a call — declined, cancelled, or finished.
 *
 * `seconds` is how long the two were actually connected, and zero for a call
 * that never was. The reason says which kind of nothing that was, which is why
 * both are sent rather than one inferred from the other.
 */
export function callHangup(
  conversationId: string,
  callId: string,
  reason: HangupReason,
  seconds: number,
): Promise<void> {
  return invoke<void>("call_hangup", {
    conversationId,
    callId,
    reason,
    seconds,
  });
}
