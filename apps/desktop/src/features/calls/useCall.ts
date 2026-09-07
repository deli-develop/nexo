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

/**
 * What a video call asks the camera for, and what it agrees to send.
 *
 * 720p30 at 1.5 Mbps is the shape of a call that looks right on a laptop
 * without being the largest thing on the network. `ideal` rather than `exact`
 * throughout: a camera that cannot do this should give its best, not refuse —
 * `getUserMedia` treats an unmeetable `exact` as a failure, and a call that
 * does not happen is worse than one at 480p.
 *
 * The cap is applied to the sender as well as asked of the camera, because the
 * two are different promises: the camera decides what is captured, the encoder
 * decides what goes out, and congestion control will happily use more than you
 * expected on a fast network.
 */
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};
const VIDEO_MAX_BITRATE = 1_500_000;
const VIDEO_MAX_FRAMERATE = 30;

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
   * Whether our camera is on.
   *
   * Separate from `video`: `video` is what the call is *for*, this is what we
   * are currently sending. Answering a video call with the camera off is an
   * ordinary thing to do, and joining a voice call is not a reason to hide the
   * camera button.
   */
  cameraOn: boolean;
  /** Whether the other side is sending pictures right now. */
  remoteVideo: boolean;
  /**
   * Bumped whenever the remote stream is replaced.
   *
   * The stream itself is a module variable — see the note at the top about
   * keeping media out of React state — so this is what tells a component that
   * `getRemoteStream()` will now answer differently. A number, because that is
   * the smallest thing that can change.
   */
  mediaEpoch: number;
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
  cameraOn: false,
  remoteVideo: false,
  mediaEpoch: 0,
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
/**
 * What the other side is sending, video included.
 *
 * A module variable rather than store state: a `MediaStream` is a mutable
 * handle whose identity almost never changes, so putting it in a store would
 * re-render every subscriber for an object that did not meaningfully change.
 * `mediaEpoch` is what says "ask again".
 */
let remoteStream: MediaStream | null = null;
let ringTimer: number | undefined;
/**
 * The offer we are ringing about, kept until it is accepted or refused.
 *
 * Held here rather than in the store for the same reason the streams are: it is
 * a long SDP string that nothing renders.
 */
let pendingOffer: { sdp: string } | null = null;

/** The other side's stream, for whatever needs to draw it. */
export function getRemoteStream(): MediaStream | null {
  return remoteStream;
}

/**
 * Our own stream, for the self-view.
 *
 * Handed out rather than held by the component, so teardown stays the engine's
 * job: a component that kept its own reference would keep the camera open past
 * the end of the call.
 */
export function getLocalStream(): MediaStream | null {
  return localStream;
}

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
  remoteStream = null;

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
async function buildConnection(video: boolean): Promise<RTCPeerConnection> {
  const ice = await callIceServers();

  // A camera that is missing or refused must not take the call down with it:
  // a video call that ends up audio-only is a working call, and the person can
  // be told about the camera afterwards. A *microphone* that fails is fatal,
  // which is why only the video half is caught.
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      ...(video ? { video: VIDEO_CONSTRAINTS } : {}),
    });
  } catch (error) {
    if (!video) throw error;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    useCall.setState({ error: "Your camera is unavailable, so this is a voice call." });
  }
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

  stream.getTracks().forEach((track) => {
    connection.addTrack(track, stream);
    // A webcam being unplugged, or grabbed by another app, ends the track.
    // Losing the picture is survivable; losing the call over it is not.
    track.addEventListener("ended", () => {
      if (track.kind !== "video") return;
      useCall.setState({
        cameraOn: false,
        error: "Your camera stopped working. The call is still going.",
      });
    });
  });
  useCall.setState({ cameraOn: stream.getVideoTracks().length > 0 });

  // Prefer H.264, and the reason is resolution rather than anything abstract.
  //
  // Measured in this WebView, same canvas source, same 1.5 Mbps cap, same
  // 30 fps: Chromium's default order negotiates VP8 and holds **480x270**;
  // asking for H.264 first holds **960x540**. Four times the pixels for the
  // same bytes, which on a video call is the difference between a face and a
  // suggestion of one. (Hardware offload is the likely cause and would also
  // save battery, but `encoderImplementation` reports nothing here, so that
  // part is not claimed.)
  //
  // A preference, not a requirement: `setCodecPreferences` reorders the list,
  // so a peer without H.264 still negotiates something both support. Guarded
  // because it has to run before the offer is created and is not implemented
  // everywhere.
  if (video) {
    const capabilities = RTCRtpSender.getCapabilities("video");
    const transceiver = connection
      .getTransceivers()
      .find((t) => t.sender.track?.kind === "video");
    if (capabilities && transceiver?.setCodecPreferences) {
      const h264 = capabilities.codecs.filter((c) => /h264/i.test(c.mimeType));
      const rest = capabilities.codecs.filter((c) => !/h264/i.test(c.mimeType));
      if (h264.length > 0) {
        try {
          transceiver.setCodecPreferences([...h264, ...rest]);
        } catch {
          // An unsupported ordering is not worth failing a call over.
        }
      }
    }
  }

  // The remote audio needs an element to come out of. It is never added to the
  // React tree: it renders nothing, and an element React owns would be torn
  // down and rebuilt on renders that have nothing to do with the call.
  connection.addEventListener("track", (event) => {
    const incoming = event.streams[0] ?? null;
    remoteStream = incoming;

    // Sound comes out of an element that is never in the React tree: it renders
    // nothing, and one React owned would be torn down and rebuilt by renders
    // that have nothing to do with the call. The video element in `CallLayer`
    // is muted for exactly this reason -- one stream, one thing playing it.
    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.autoplay = true;
      document.body.appendChild(remoteAudio);
    }
    remoteAudio.srcObject = incoming;
    void remoteAudio.play().catch(() => {
      // Autoplay policy does not apply to a call the person just answered, but
      // a rejected play() must not take the call down with it.
    });

    useCall.setState({
      remoteVideo: (incoming?.getVideoTracks().length ?? 0) > 0,
      mediaEpoch: useCall.getState().mediaEpoch + 1,
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

/**
 * Holds the outgoing video to something a call should use.
 *
 * Applied after the local description, because that is when the sender has
 * encodings to configure. Without it, congestion control aims at whatever the
 * link will bear — which on a fast connection is several megabits for a picture
 * of somebody's face, paid for twice because every byte crosses the relay.
 */
async function capVideoBitrate(connection: RTCPeerConnection): Promise<void> {
  const sender = connection.getSenders().find((s) => s.track?.kind === "video");
  if (!sender) return;
  const params = sender.getParameters();
  // `encodings` can be absent until the description is set; a bare object is
  // the documented way to create the one encoding a simple call has.
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  params.encodings[0]!.maxBitrate = VIDEO_MAX_BITRATE;
  params.encodings[0]!.maxFramerate = VIDEO_MAX_FRAMERATE;
  try {
    await sender.setParameters(params);
  } catch {
    // Not worth failing a call over: the cap is a courtesy to the network, and
    // a browser that refuses these parameters still makes the call.
  }
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
export async function startCall(
  conversationId: string,
  video = false,
): Promise<void> {
  if (useCall.getState().phase !== "idle") return;

  useCall.setState({
    ...initial,
    phase: "outgoing",
    conversationId,
    video,
  });

  try {
    pc = await buildConnection(video);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await capVideoBitrate(pc);
    const sdp = await gatheredSdp(pc);

    const callId = await callOffer(conversationId, video, sdp);
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
  const { phase, conversationId, callId, video } = useCall.getState();
  if (phase !== "incoming" || !conversationId || !callId || !pendingOffer) return;

  const offer = pendingOffer;
  useCall.setState({ phase: "connecting" });

  try {
    // Answer in kind: a video call is answered with the camera on, a voice
    // call without one. What the answerer does after that is their business --
    // `setCameraEnabled` is one press away either direction.
    pc = await buildConnection(video);
    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await capVideoBitrate(pc);
    const sdp = await gatheredSdp(pc);

    await callAnswer(
      conversationId,
      callId,
      useCall.getState().cameraOn,
      sdp,
    );
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
 * Turns the camera on or off mid-call.
 *
 * Toggles `enabled` on the track rather than stopping it. Stopping would
 * release the device — the camera light goes out, which is the honest thing —
 * but getting it back means a new track, a new transceiver and a renegotiation,
 * and there is no renegotiation path here: an offer is a whole new signalling
 * exchange, and this build sends candidates bundled once per call.
 *
 * So the camera stays open and stops sending. The light staying on while
 * "camera off" is showing would be a lie, which is why turning it off is only
 * offered on a call that already had a camera: a voice call never opens one.
 */
export function setCameraEnabled(on: boolean): void {
  const tracks = localStream?.getVideoTracks() ?? [];
  if (tracks.length === 0) return;
  tracks.forEach((track) => {
    track.enabled = on;
  });
  useCall.setState({ cameraOn: on });
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
