import { useEffect, useRef, useState } from "react";

import { onSync } from "../../app/syncAgent";
import { Button, IconButton } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { Panel } from "../../components/ui/Surface";
import {
  acceptCall,
  applySignal,
  getLocalStream,
  getRemoteStream,
  hangUp,
  setCameraEnabled,
  setMuted,
  useCall,
} from "./useCall";

/**
 * Everything a call puts on screen, and the one place signalling is applied.
 *
 * Mounted once by the shell. Three surfaces, never more than one at a time:
 * the sheet that asks about an incoming call, the bar that sits above the app
 * while one is running, and a line saying why one failed.
 *
 * None of them is a route. A call has to survive moving between conversations,
 * and somebody on a call is still allowed to read something else — which is
 * also why this floats rather than taking the window.
 */

/** Seconds as `4:07`, or `1:02:33` once a call has run past an hour. */
function duration(totalSeconds: number): string {
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * The running time.
 *
 * Its own component so the tick re-renders one `<span>`. Put in `CallLayer`
 * itself, the interval would re-render the buttons once a second for ever.
 */
function CallTimer({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="text-text-lo text-[13px] tabular-nums">
      {duration(Math.max(0, Math.floor((now - since) / 1000)))}
    </span>
  );
}

/** The floating shell all three surfaces share. */
function CallBar({
  label,
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3"
      role={label ? "dialog" : undefined}
      aria-label={label}
    >
      <Panel
        tone="raised"
        className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl px-4 py-2.5"
      >
        {children}
      </Panel>
    </div>
  );
}

/**
 * The other side, drawn.
 *
 * The stream is fetched through `getRemoteStream()` rather than passed as a
 * prop: it lives in a module variable so that arriving media does not re-render
 * anything, and `mediaEpoch` is the number that says it changed. The element is
 * **muted** on purpose — the sound is already coming out of an `<audio>` the
 * engine owns, and a second player would double every voice.
 */
function RemoteVideo({ epoch }: { epoch: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = getRemoteStream();
    void el.play().catch(() => {
      // A refused play() must not take the call down. The audio is elsewhere.
    });
  }, [epoch]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className="h-full w-full bg-black object-cover"
    />
  );
}

/** Our own camera, small, and mirrored the way a mirror is. */
function SelfVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const cameraOn = useCall((s) => s.cameraOn);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Read at mount rather than held: the local stream is the engine's, and a
    // component that kept its own reference would keep it alive past teardown.
    el.srcObject = getLocalStream();
    void el.play().catch(() => {});
  }, [cameraOn]);
  if (!cameraOn) return null;
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className="border-line absolute right-2 bottom-2 h-[72px] w-[96px] rounded-md border bg-black object-cover [transform:scaleX(-1)]"
    />
  );
}

export function CallLayer() {
  const phase = useCall((s) => s.phase);
  const muted = useCall((s) => s.muted);
  const connectedAt = useCall((s) => s.connectedAt);
  const video = useCall((s) => s.video);
  const cameraOn = useCall((s) => s.cameraOn);
  const remoteVideo = useCall((s) => s.remoteVideo);
  const mediaEpoch = useCall((s) => s.mediaEpoch);
  const error = useCall((s) => s.error);
  const setState = useCall((s) => s.setState);

  // Signalling arrives on the sync result, and this is its only subscriber.
  // Everything else about a call is downstream of here.
  useEffect(() => onSync((result) => result.calls.forEach(applySignal)), []);

  if (phase === "incoming") {
    return (
      <CallBar label="Incoming call">
        <span className="text-accent" aria-hidden>
          <Icon name={video ? "video" : "phone"} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-text-hi truncate text-[14px] font-medium">
            Incoming call
          </p>
          <p className="text-text-lo truncate text-[12px]">
            {video ? "Video call" : "Voice call"}
          </p>
        </div>
        <Button variant="ghost" onClick={() => void hangUp()}>
          Decline
        </Button>
        <Button variant="primary" onClick={() => void acceptCall()}>
          Answer
        </Button>
      </CallBar>
    );
  }

  if (phase === "outgoing" || phase === "connecting" || phase === "connected") {
    const status =
      phase === "outgoing"
        ? "Calling…"
        : phase === "connecting"
          ? "Connecting…"
          : "On a call";

    const controls = (
      <>
        {phase === "connected" && connectedAt !== null ? (
          <CallTimer since={connectedAt} />
        ) : null}
        <IconButton
          name={muted ? "mic-off" : "mic"}
          label={muted ? "Unmute your microphone" : "Mute your microphone"}
          aria-pressed={muted}
          onClick={() => setMuted(!muted)}
        />
        {/* Only on a call that opened a camera. A voice call never did, and a
            button that would have to reopen the device mid-call needs a
            renegotiation this build does not do. */}
        {video ? (
          <IconButton
            name={cameraOn ? "video" : "video-off"}
            label={cameraOn ? "Turn your camera off" : "Turn your camera on"}
            aria-pressed={!cameraOn}
            onClick={() => setCameraEnabled(!cameraOn)}
          />
        ) : null}
        <IconButton
          name="phone-off"
          label="Hang up"
          onClick={() => void hangUp()}
        />
      </>
    );

    // Pictures get a surface; a voice call stays a strip. The panel appears
    // only once something is actually arriving, so "Calling…" does not open a
    // black rectangle at somebody.
    if (video && remoteVideo) {
      return (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3">
          <Panel
            tone="raised"
            className="pointer-events-auto w-full max-w-md overflow-hidden rounded-xl"
          >
            <div className="relative aspect-video w-full">
              <RemoteVideo epoch={mediaEpoch} />
              <SelfVideo />
            </div>
            <div className="flex items-center gap-3 px-4 py-2.5">
              <p className="text-text-hi min-w-0 flex-1 truncate text-[13px]">
                {status}
              </p>
              {controls}
            </div>
          </Panel>
        </div>
      );
    }

    return (
      <CallBar>
        <span className="text-accent" aria-hidden>
          <Icon name={video ? "video" : "phone"} size={18} />
        </span>
        <p className="text-text-hi min-w-0 flex-1 truncate text-[13px]">
          {status}
        </p>
        {controls}
      </CallBar>
    );
  }

  // A call that failed says why, once, and then gets out of the way. Not a
  // dialog: nothing here needs answering, and a modal for "they declined"
  // would demand a click in exchange for information.
  if (error) {
    return (
      <CallBar>
        <span className="text-text-lo" aria-hidden>
          <Icon name="info" size={18} />
        </span>
        <p className="text-text-hi min-w-0 flex-1 truncate text-[13px]">
          {error}
        </p>
        <Button variant="ghost" onClick={() => setState({ error: null })}>
          Dismiss
        </Button>
      </CallBar>
    );
  }

  return null;
}
