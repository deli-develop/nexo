import { useEffect, useState } from "react";

import { onSync } from "../../app/syncAgent";
import { Button, IconButton } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { Panel } from "../../components/ui/Surface";
import { acceptCall, applySignal, hangUp, setMuted, useCall } from "./useCall";

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

export function CallLayer() {
  const phase = useCall((s) => s.phase);
  const muted = useCall((s) => s.muted);
  const connectedAt = useCall((s) => s.connectedAt);
  const error = useCall((s) => s.error);
  const setState = useCall((s) => s.setState);

  // Signalling arrives on the sync result, and this is its only subscriber.
  // Everything else about a call is downstream of here.
  useEffect(() => onSync((result) => result.calls.forEach(applySignal)), []);

  if (phase === "incoming") {
    return (
      <CallBar label="Incoming call">
        <span className="text-accent" aria-hidden>
          <Icon name="phone" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-text-hi truncate text-[14px] font-medium">
            Incoming call
          </p>
          <p className="text-text-lo truncate text-[12px]">Voice call</p>
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
    return (
      <CallBar>
        <span className="text-accent" aria-hidden>
          <Icon name="phone" size={18} />
        </span>
        <p className="text-text-hi min-w-0 flex-1 truncate text-[13px]">
          {phase === "outgoing"
            ? "Calling…"
            : phase === "connecting"
              ? "Connecting…"
              : "On a call"}
        </p>
        {phase === "connected" && connectedAt !== null ? (
          <CallTimer since={connectedAt} />
        ) : null}
        <IconButton
          name={muted ? "mic-off" : "mic"}
          label={muted ? "Unmute your microphone" : "Mute your microphone"}
          aria-pressed={muted}
          onClick={() => setMuted(!muted)}
        />
        <IconButton
          name="phone-off"
          label="Hang up"
          onClick={() => void hangUp()}
        />
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
