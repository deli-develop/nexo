import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

import { Icon } from "../../components/ui/Icon";
import { cn } from "../../lib/cn";
import { formatDuration } from "./useRecorder";

/**
 * Nexo's own player for a voice message or a sound file.
 *
 * It used to be the browser's `<audio controls>`: a grey Windows strip with
 * its own volume slider and its own "⋮" menu, the one control in a bubble that
 * looked like it came from another app. What replaces it is what people
 * expect a voice message to be: a round play button, the recording's own
 * waveform filling in as it plays, the time, and a speed.
 *
 * What the native control gave for free is kept on purpose. The waveform is a
 * `slider` -- reachable by Tab, moved with the arrow keys, Home and End, and
 * announced as "0:03 of 0:12" -- and it seeks by click or drag. A track with
 * no waveform (a picked file, or a note from before the recorder sent one)
 * gets a thin bar that behaves the same way.
 *
 * **One sound at a time.** Starting one pauses whichever was playing, the way
 * every messenger does; two voices at once is never what somebody meant.
 */
export function SoundPlayer({
  url,
  peaks,
  durationMs,
  label,
}: {
  /** `null` while the bytes are still being fetched and decrypted. */
  url: string | null;
  /** The recorder's envelope, 0–255 per bar. Absent for a track. */
  peaks?: number[] | undefined;
  /** What the sender measured. Trusted over the file: see `settleDuration`. */
  durationMs?: number | undefined;
  /** What a screen reader calls it: "Voice message" or the file's name. */
  label: string;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [paused, setPaused] = useState(true);
  const [positionMs, setPositionMs] = useState(0);
  const [lengthMs, setLengthMs] = useState(durationMs ?? 0);
  const [speed, setSpeed] = useState<Speed>(1);
  const [broken, setBroken] = useState(false);

  // While it plays, the position is read every frame rather than on
  // `timeupdate`, which fires four times a second and makes the waveform fill
  // in visible steps.
  useEffect(() => {
    if (paused) return;
    let frame = 0;
    const tick = () => {
      const element = audio.current;
      if (element) setPositionMs(element.currentTime * 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paused]);

  // Leaving the conversation stops the sound: nothing on screen would say what
  // is playing or offer a way to stop it.
  useEffect(
    () => () => {
      const element = audio.current;
      if (!element) return;
      element.pause();
      if (current === element) current = null;
    },
    [],
  );

  const toggle = useCallback(() => {
    const element = audio.current;
    if (!element || !url) return;
    if (!element.paused) {
      element.pause();
      return;
    }
    if (current && current !== element) current.pause();
    current = element;
    element.playbackRate = speed;
    void element.play().catch(() => setBroken(true));
  }, [speed, url]);

  const seekTo = useCallback(
    (ms: number) => {
      const element = audio.current;
      if (!element || lengthMs <= 0) return;
      const clamped = Math.min(Math.max(0, ms), lengthMs);
      element.currentTime = clamped / 1000;
      setPositionMs(clamped);
    },
    [lengthMs],
  );

  const nextSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!;
    setSpeed(next);
    if (audio.current) audio.current.playbackRate = next;
  };

  const fraction = lengthMs > 0 ? Math.min(1, positionMs / lengthMs) : 0;
  const started = !paused || positionMs > 0;

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {url ? (
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onEnded={() => {
            setPaused(true);
            setPositionMs(0);
            if (audio.current) audio.current.currentTime = 0;
          }}
          onLoadedMetadata={(event) => settleDuration(event.currentTarget, durationMs, setLengthMs)}
          onError={() => setBroken(true)}
        />
      ) : null}

      <button
        type="button"
        onClick={toggle}
        disabled={!url || broken}
        aria-label={paused ? `Play ${label}` : `Pause ${label}`}
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full outline-none",
          "transition-[background-color,transform] duration-[var(--motion-fast)] ease-[var(--ease-state)]",
          "focus-visible:ring-accent focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-2)]",
          "bg-accent text-on-accent enabled:hover:bg-accent-soft enabled:active:scale-95",
          "disabled:bg-fill-disabled disabled:text-text-disabled",
        )}
      >
        {/* The triangle's weight sits left of its box; a pixel right puts it
            in the middle of the circle to the eye. */}
        <Icon
          name={paused ? "play" : "pause"}
          size={16}
          strokeWidth={2.25}
          className={paused ? "translate-x-px" : undefined}
          fill={paused ? "currentColor" : "none"}
        />
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Scrubber
          peaks={peaks}
          fraction={fraction}
          positionMs={positionMs}
          lengthMs={lengthMs}
          label={label}
          disabled={!url || broken || lengthMs <= 0}
          onSeek={seekTo}
        />
        <span className="flex items-center justify-between gap-2">
          <span className="text-text-lo font-mono text-[11px] tabular-nums">
            {!url
              ? "Decrypting…"
              : broken
                ? "Can't be played here"
                : // The length until it starts, then how far in: the two
                  // numbers people read a voice message by.
                  formatDuration(started ? positionMs : lengthMs)}
          </span>
          {peaks && url && !broken ? (
            <button
              type="button"
              onClick={nextSpeed}
              aria-label={`Playback speed, ${speed} times`}
              className="text-text-mid bg-fill hover:bg-fill-hover focus-visible:ring-accent rounded-full px-1.5 py-px font-mono text-[10px] font-semibold tabular-nums outline-none focus-visible:ring-1"
            >
              {speed}×
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

type Speed = 1 | 1.5 | 2;
const SPEEDS: readonly Speed[] = [1, 1.5, 2];

/** The element that is playing now, anywhere in the app. */
let current: HTMLAudioElement | null = null;

/**
 * Settles how long the sound is.
 *
 * The sender's measurement wins where there is one: a recorder writes WebM
 * with no duration in its header, so Chromium reports `Infinity` until the
 * whole file has been played -- and cannot seek in it either. Asking for a
 * position past the end makes it read the file through and learn both; the
 * position goes back to the start once it has.
 */
function settleDuration(
  element: HTMLAudioElement,
  declaredMs: number | undefined,
  setLengthMs: (ms: number) => void,
) {
  if (Number.isFinite(element.duration)) {
    if (!declaredMs) setLengthMs(element.duration * 1000);
    return;
  }
  const learned = () => {
    if (!Number.isFinite(element.duration)) return;
    element.removeEventListener("durationchange", learned);
    element.currentTime = 0;
    if (!declaredMs) setLengthMs(element.duration * 1000);
  };
  element.addEventListener("durationchange", learned);
  element.currentTime = Number.MAX_SAFE_INTEGER;
}

/**
 * Where you are in the sound, and the way to move.
 *
 * The recording's own bars when there are some, filled in the accent up to
 * where it has played; a thin line otherwise. Either is one `slider`.
 */
function Scrubber({
  peaks,
  fraction,
  positionMs,
  lengthMs,
  label,
  disabled,
  onSeek,
}: {
  peaks?: number[] | undefined;
  fraction: number;
  positionMs: number;
  lengthMs: number;
  label: string;
  disabled: boolean;
  onSeek: (ms: number) => void;
}) {
  const seekFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    onSeek(((event.clientX - box.left) / box.width) * lengthMs);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Two seconds a press: a voice message is short, and five would skip a
    // sentence.
    const step = 2000;
    const target =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? positionMs + step
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? positionMs - step
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? lengthMs
              : null;
    if (target === null) return;
    event.preventDefault();
    onSeek(target);
  };

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={`Position in ${label}`}
      aria-valuemin={0}
      aria-valuemax={Math.round(lengthMs / 1000)}
      aria-valuenow={Math.round(positionMs / 1000)}
      aria-valuetext={`${formatDuration(positionMs)} of ${formatDuration(lengthMs)}`}
      aria-disabled={disabled || undefined}
      onKeyDown={disabled ? undefined : onKeyDown}
      onPointerDown={
        disabled
          ? undefined
          : (event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              seekFromPointer(event);
            }
      }
      onPointerMove={
        disabled
          ? undefined
          : (event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromPointer(event);
            }
      }
      className={cn(
        "focus-visible:ring-accent rounded-[4px] outline-none focus-visible:ring-1",
        disabled ? "cursor-default" : "cursor-pointer",
      )}
    >
      {peaks && peaks.length > 0 ? (
        <span aria-hidden className="flex h-7 items-center justify-between gap-[2px]">
          {peaks.map((peak, index) => (
            <span
              key={index}
              className={cn(
                "w-[3px] min-w-[2px] shrink rounded-full transition-colors duration-[var(--motion-fast)]",
                (index + 0.5) / peaks.length <= fraction ? "bg-accent" : "bg-text-lo/50",
              )}
              // Never zero: a silent moment is a dot on the line, not a gap.
              style={{ height: `${Math.max(12, (peak / 255) * 100)}%` }}
            />
          ))}
        </span>
      ) : (
        <span aria-hidden className="flex h-7 items-center">
          <span className="bg-fill relative h-1 w-full overflow-hidden rounded-full">
            <span
              className="bg-accent absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${fraction * 100}%` }}
            />
          </span>
        </span>
      )}
    </div>
  );
}
