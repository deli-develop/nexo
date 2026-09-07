import { create } from "zustand";

import {
  callAnswer,
  callHangup,
  callIceServers,
  callOffer,
  type CallSignal,
  type HangupReason,
  type IncomingCall,
} from "../../lib/calls";

/**
 * One call at a time, and the machinery that carries it.
 *
 * # What lives where
 *
 * Signalling is Rust's: an offer is an encrypted payload in the conversation,
 * and the page only ever hands over an SDP string. **The media is the
 * WebView's**, and deliberately so — `RTCPeerConnection` brings echo
 * cancellation, noise suppression, gain control, an Opus encoder and a jitter
 * buffer that no amount of Rust in this repository would improve on.
 *
 * The keys for that media are therefore generated in the page, which is the one
 * place rule 2 says key material must not be. The reasoning, in short: those
 * keys are ephemeral and per-call, their loss exposes one call's audio rather
 * than any history, and the identity that *authenticates* them never leaves
 * Rust — a DTLS fingerprint is only trustworthy here because it travelled
 * inside an MLS message that the server could not read or alter. See
 * `docs/THREAT-MODEL.md`.
 *
 * # Why the state machine is small
 *
 * One call, five phases, and no queue. A second incoming call while one is up
 * is declined rather than stacked: a messenger that rings twice at once is
 * worse than one that says "busy", and call waiting is a feature nobody asked
 * for yet.
 *
 * # Performance
 *
 * This store is separate from `useApp` on purpose. A connection state change
 * or a mute toggle must not re-render the conversation list or the message
 * thread, and sharing a store is the easiest way to make that happen by
 * accident. Nothing here holds media in React state either — the streams live
 * in module-level variables, because putting a `MediaStream` in a store makes
 * every subscriber re-render for an object that never meaningfully changes.
 */

/** How long an unanswered call rings before it gives up. */
const RING_TIMEOUT_MS = 45_000;

/**
 * How long to wait for ICE gathering before sending what we have.
 *
 * Candidates are bundled into the offer rather than trickled, so this wait is
 * on the critical path of every call — see `Payload::Call`. Against a relay it
 * finishes in well under a second. The cap exists for the case where the relay
 * is unreachable: without it, gathering never completes and the call hangs
 * with nothing on screen to explain why. Sending an SDP with no usable
 * candidate fails honestly instead, and fails fast.
 */
const GATHER_TIMEOUT_MS = 3_000;

export type CallPhase =
  | "idle"
  /** We are ringing them. */
  | "outgoing"
  /** They are ringing us, and nothing has been decided. */
  | "incoming"
  /** Accepted on both sides; the media path is coming up. */
  | "connecting"
  | "connected";

export interface CallState {
  phase: CallPhase;
  callId: string | null;
  conversationId: string | null;
  /** Whether this call is offering video. Audio-only today. */
  video: boolean;
  /** When the two actually connected, for the timer and the record. */
  connectedAt: number | null;
  /** Our own microphone, as the person set it. */
  muted: boolean;
  /**
   * What went wrong, for the one line the UI shows.
   *
   * Set rather than thrown: a call that fails is an ordinary outcome, and the
   * person needs to be told which ordinary outcome it was.
   */
  error: string | null;
}

interface CallActions {
  setState: (patch: Partial<CallState>) => void;
  reset: () => void;
}

const initial: CallState = {
  phase: "idle",
  callId: null,
  conversationId: null,
  video: false,
  connectedAt: null,
  muted: false,
  error: null,
};

export const useCall = create<CallState & CallActions>()((set) => ({
  ...initial,
  setState: (patch) => set(patch),
  reset: () => set(initial),
}));

// --- The parts that must not live in React state ---------------------------

let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let remoteAudio: HTMLAudioElement | null = null;
let ringTimer: number | undefined;
/**
 * The offer we are ringing about, kept until it is accepted or refused.
 *
 * Held here rather than in the store for the same reason the streams are: it is
 * a long SDP string that nothing renders.
 */
let pendingOffer: { sdp: string } | null = null;

/** Everything this module allocated, put back. */
function teardown(): void {
  if (ringTimer !== undefined) {
    window.clearTimeout(ringTimer);
    ringTimer = undefined;
  }
  pendingOffer = null;

  // Stop the tracks before closing the connection: a stopped track releases
  // the microphone, and a person whose microphone light stays on after a call
  // has every reason to distrust the app.
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;

  if (remoteAudio) {
    remoteAudio.srcObject = null;
    remoteAudio.remove();
    remoteAudio = null;
  }

  pc?.close();
  pc = null;
}

/** How long the call has been up, in whole seconds. */
function elapsedSeconds(): number {
  const { connectedAt } = useCall.getState();
  if (connectedAt === null) return 0;
  return Math.max(0, Math.floor((Date.now() - connectedAt) / 1000));
}

/**
 * Waits for ICE gathering, then returns the SDP with its candidates in it.
 *
 * See `GATHER_TIMEOUT_MS` for why this is capped rather than awaited forever.
 */
function gatheredSdp(connection: RTCPeerConnection): Promise<string> {
  const sdpNow = () => connection.localDescription?.sdp ?? "";
  if (connection.iceGatheringState === "complete") {
    return Promise.resolve(sdpNow());
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      connection.removeEventListener("icegatheringstatechange", onChange);
      window.clearTimeout(timer);
      resolve(sdpNow());
    };
    const onChange = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    connection.addEventListener("icegatheringstatechange", onChange);
    const timer = window.setTimeout(finish, GATHER_TIMEOUT_MS);
  });
}

/**
 * Builds the connection, with the media and the policy the server dictated.
 *
 * `iceTransportPolicy` is not a preference. When the server says `relay_only`,
 * a direct candidate would put this machine's IP address in the SDP the other
 * side receives — which is the whole thing relaying exists to prevent. Reading
 * the flag and ignoring it would be worse than never asking.
 */
async function buildConnection(): Promise<RTCPeerConnection> {
  const ice = await callIceServers();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  localStream = stream;

  const connection = new RTCPeerConnection({
    // Built key by key rather than spread: `exactOptionalPropertyTypes` is on,
    // and a STUN entry carrying `username: undefined` is not the same thing as
    // one with no username at all.
    iceServers: ice.servers.map((s) => {
      const server: RTCIceServer = { urls: s.urls };
      if (s.username !== undefined) server.username = s.username;
      if (s.credential !== undefined) server.credential = s.credential;
      return server;
    }),
    iceTransportPolicy: ice.relay_only ? "relay" : "all",
  });

  stream.getTracks().forEach((track) => connection.addTrack(track, stream));

  // The remote audio needs an element to come out of. It is never added to the
  // React tree: it renders nothing, and an element React owns would be torn
  // down and rebuilt on renders that have nothing to do with the call.
  connection.addEventListener("track", (event) => {
    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.autoplay = true;
      document.body.appendChild(remoteAudio);
    }
    remoteAudio.srcObject = event.streams[0] ?? null;
    void remoteAudio.play().catch(() => {
      // Autoplay policy does not apply to a call the person just answered, but
      // a rejected play() must not take the call down with it.
    });
  });

  connection.addEventListener("connectionstatechange", () => {
    const state = connection.connectionState;
    if (state === "connected") {
      useCall.setState({ phase: "connected", connectedAt: Date.now() });
      if (ringTimer !== undefined) {
        window.clearTimeout(ringTimer);
        ringTimer = undefined;
      }
    }
    if (state === "failed") {
      void end("failed", "The call could not connect.");
    }
    // `disconnected` is not an ending: it is what a few lost packets look like,
    // and WebRTC recovers from it on its own. Ending here would drop calls that
    // were about to come back.
    if (state === "closed") {
      useCall.getState().reset();
    }
  });

  return connection;
}

/** Turns a failure into the one sentence the UI shows. */
function reasonFor(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError") {
    return "Nexo needs permission to use your microphone.";
  }
  if (name === "NotFoundError") {
    return "No microphone was found.";
  }
  if (name === "NotReadableError") {
    return "Your microphone is in use by another app.";
  }
  // A refusal carries the server's own sentence, and the shell passes it
  // through untouched — "Calls are not available on this server." is already
  // exactly what somebody needs to read. Matching on the `kind` rather than on
  // the prose: the wording is the server's to change, the kind is a contract.
  const refusal = error as { kind?: string; message?: string } | null;
  if (refusal?.kind === "rejected" && refusal.message) return refusal.message;
  return "The call could not be started.";
}

// --- What the UI calls ------------------------------------------------------

/** Rings somebody. */
export async function startCall(conversationId: string): Promise<void> {
  if (useCall.getState().phase !== "idle") return;

  useCall.setState({
    ...initial,
    phase: "outgoing",
    conversationId,
    video: false,
  });

  try {
    pc = await buildConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdp = await gatheredSdp(pc);

    const callId = await callOffer(conversationId, false, sdp);
    useCall.setState({ callId });

    // Nobody picked up. Cancelling rather than going quiet is what leaves the
    // other side a "missed call" instead of nothing.
    ringTimer = window.setTimeout(() => {
      void end("cancelled");
    }, RING_TIMEOUT_MS);
  } catch (error) {
    teardown();
    useCall.setState({ ...initial, error: reasonFor(error) });
  }
}

/** Accepts the call that is ringing. */
export async function acceptCall(): Promise<void> {
  const { phase, conversationId, callId } = useCall.getState();
  if (phase !== "incoming" || !conversationId || !callId || !pendingOffer) return;

  const offer = pendingOffer;
  useCall.setState({ phase: "connecting" });

  try {
    pc = await buildConnection();
    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const sdp = await gatheredSdp(pc);

    await callAnswer(conversationId, callId, false, sdp);
    pendingOffer = null;
  } catch (error) {
    const message = reasonFor(error);
    // The other side is still ringing, and is owed an ending rather than
    // silence — even though the failure was ours.
    await callHangup(conversationId, callId, "failed", 0).catch(() => {});
    teardown();
    useCall.setState({ ...initial, error: message });
  }
}

/**
 * Ends whatever is happening, and tells the other side why.
 *
 * One function for decline, cancel and hang up, because they are one message
 * on the wire and differ only in the reason they carry — which is exactly what
 * the record in the conversation is made of.
 */
export async function end(
  reason: HangupReason,
  error?: string,
): Promise<void> {
  const { phase, conversationId, callId } = useCall.getState();
  if (phase === "idle") return;

  const seconds = elapsedSeconds();
  teardown();
  useCall.setState({ ...initial, error: error ?? null });

  if (conversationId && callId) {
    // Fire and forget: the call is already over locally, and a failed hangup
    // must not leave the UI stuck in a call that has ended.
    await callHangup(conversationId, callId, reason, seconds).catch(() => {});
  }
}

/** Hangs up, choosing the reason from where the call had got to. */
export function hangUp(): Promise<void> {
  const { phase } = useCall.getState();
  if (phase === "incoming") return end("declined");
  if (phase === "connected") return end("ended");
  return end("cancelled");
}

/** Mutes or unmutes the microphone. */
export function setMuted(muted: boolean): void {
  localStream?.getAudioTracks().forEach((track) => {
    track.enabled = !muted;
  });
  useCall.setState({ muted });
}

/**
 * Applies signalling that arrived on a sync.
 *
 * Called for every signal the sync agent hands over. Signals for a call this
 * device is not in are ignored rather than acted on — two people ringing each
 * other at once is the ordinary way that happens, and answering the wrong call
 * is worse than missing one.
 */
export function applySignal(call: IncomingCall): void {
  const state = useCall.getState();
  const signal: CallSignal = call.signal;

  if (signal.signal === "offer") {
    // Busy: one call at a time. Declining is the honest answer, and it leaves
    // the caller a record rather than a phone that rang into nothing.
    if (state.phase !== "idle") {
      void callHangup(call.conversation_id, call.call_id, "declined", 0).catch(
        () => {},
      );
      return;
    }
    pendingOffer = { sdp: signal.sdp };
    useCall.setState({
      ...initial,
      phase: "incoming",
      callId: call.call_id,
      conversationId: call.conversation_id,
      video: signal.video,
    });
    return;
  }

  // Everything below is about a call in progress, and only about *this* one.
  if (call.call_id !== state.callId) return;

  if (signal.signal === "answer") {
    if (state.phase !== "outgoing" || !pc) return;
    useCall.setState({ phase: "connecting" });
    void pc
      .setRemoteDescription({ type: "answer", sdp: signal.sdp })
      .catch(() => {
        void end("failed", "The call could not connect.");
      });
    return;
  }

  if (signal.signal === "hangup") {
    teardown();
    useCall.setState({
      ...initial,
      // Only worth a message when it ended before it began. "Call ended" after
      // a conversation is noise: both people were there.
      error:
        signal.reason === "declined" && state.phase === "outgoing"
          ? "Call declined."
          : null,
    });
  }
}
