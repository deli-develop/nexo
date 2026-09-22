import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/cn";
import { fileSize, relativeTime } from "../../lib/format";
import { notify } from "../../lib/native";
import { fieldFor } from "../../lib/palette";
import {
  asConversationError,
  attachmentUrl,
  saveAttachment,
  type AttachmentEntry,
} from "../../lib/conversations";
import { IconButton } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import {
  CENTRED,
  clampPan,
  clampZoom,
  panBounds,
  zoomAbout,
  type Point,
} from "./pan";

/** How far each step of the zoom goes, and where it stops. */
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

/** How far one press of an arrow key moves a zoomed picture, in pixels. */
const KEY_PAN = 60;

/**
 * One attachment, full size, over everything.
 *
 * Portalled to `document.body` for the same reason `Modal` is: `fixed` resolves
 * against the nearest transformed ancestor, and the message list sits inside
 * several. Escape and a click on the backdrop both close it; the arrow keys
 * move through the conversation's other media without going back to the thread.
 *
 * Only the envelope id is held here. The bytes are fetched one at a time, and
 * the key that decrypts them never leaves Rust.
 */
export function Lightbox({
  items,
  startAt,
  now,
  onClose,
}: {
  /** Every image and video in the conversation, oldest first. */
  items: AttachmentEntry[];
  /** Which one was clicked. */
  startAt: number;
  now: Date;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startAt);
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>(CENTRED);
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // Where the pointer was when this drag started, and where the pan was then.
  // A ref rather than state: it changes on every pointermove and nothing draws
  // from it, so putting it in state would be a render per pixel of travel.
  const drag = useRef<{ from: Point; pan: Point } | null>(null);

  const current = items[index];

  const step = useCallback(
    (by: number) => {
      setIndex((i) => {
        const next = i + by;
        if (next < 0 || next >= items.length) return i;
        return next;
      });
    },
    [items.length],
  );

  /**
   * The frame and the picture as they are on screen right now.
   *
   * Measured rather than remembered. The picture is laid out by CSS -- fitted
   * into whatever the window leaves -- so its size is not something this
   * component decides and cannot be derived from the zoom alone. `null` while
   * there is nothing drawn, which is also the answer for a video.
   */
  const measure = useCallback((): { scaled: Point; frame: Point } | null => {
    const image = imageRef.current;
    const box = frameRef.current;
    if (!image || !box) return null;
    // `offsetWidth` is the laid-out size *before* the transform, which is the
    // one to multiply. `getBoundingClientRect` would already include the scale
    // and squaring it is a bug that only shows up past 2x.
    return {
      scaled: { x: image.offsetWidth * zoom, y: image.offsetHeight * zoom },
      frame: { x: box.clientWidth, y: box.clientHeight },
    };
  }, [zoom]);

  /**
   * Changes the zoom, keeping `at` where it is and the picture in the frame.
   *
   * `at` is relative to the centre of the frame; leave it out to zoom about the
   * middle, which is what the buttons and the keyboard want.
   */
  const zoomTo = useCallback(
    (next: number, at: Point = CENTRED) => {
      const from = zoom;
      const to = clampZoom(next, ZOOM_MIN, ZOOM_MAX);
      if (to === from) return;
      const moved = zoomAbout(at, pan, from, to);
      const seen = measure();
      setZoom(to);
      // The picture has not been re-laid-out yet, so the bounds are computed
      // against what it *will* be: the same laid-out size at the new scale.
      setPan(
        seen
          ? clampPan(
              moved,
              { x: (seen.scaled.x / from) * to, y: (seen.scaled.y / from) * to },
              seen.frame,
            )
          : moved,
      );
    },
    [measure, pan, zoom],
  );

  /** Moves the picture by a fixed amount, for the keyboard. */
  const nudge = useCallback(
    (dx: number, dy: number) => {
      const seen = measure();
      setPan((p) => {
        const moved = { x: p.x + dx, y: p.y + dy };
        return seen ? clampPan(moved, seen.scaled, seen.frame) : moved;
      });
    },
    [measure],
  );

  /** Back to the whole picture, centred. */
  const reset = useCallback(() => {
    setZoom(1);
    setPan(CENTRED);
  }, []);

  /** Ends a drag, however it ended. */
  const endDrag = useCallback(() => {
    drag.current = null;
    setDragging(false);
  }, []);

  // Fetching resets the zoom: staying at 4x while a different picture arrives
  // shows a corner of something nobody asked to see that closely.
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setUrl(null);
    setZoom(1);
    setPan(CENTRED);
    setProblem(null);
    void attachmentUrl(current.envelope_id)
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch((error) => {
        if (!cancelled) setProblem(asConversationError(error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [current]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The arrows do two jobs, and which one depends on whether there is
      // anywhere to go. At rest they step through the conversation's media.
      // Zoomed in they pan, because otherwise panning is a mouse-only feature
      // and the zoom controls beside them are not.
      const zoomed = zoom > ZOOM_MIN;
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") zoomed ? nudge(-KEY_PAN, 0) : step(1);
      else if (event.key === "ArrowLeft") zoomed ? nudge(KEY_PAN, 0) : step(-1);
      else if (event.key === "ArrowDown" && zoomed) nudge(0, -KEY_PAN);
      else if (event.key === "ArrowUp" && zoomed) nudge(0, KEY_PAN);
      else if (event.key === "+" || event.key === "=") zoomTo(zoom + ZOOM_STEP);
      else if (event.key === "-") zoomTo(zoom - ZOOM_STEP);
      else if (event.key === "0") reset();
      else return;
      // Only for the keys actually handled: swallowing the rest would take
      // Tab and the browser's own shortcuts with it.
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, step, zoom, zoomTo, nudge, reset]);

  // Keep the current thumbnail in view when stepping with the keyboard.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [index]);

  async function save() {
    if (!current) return;
    try {
      if (!(await saveAttachment(current.envelope_id))) return;
      await notify("Saved", `${current.name} was saved.`);
    } catch (error) {
      await notify("Couldn't save that", asConversationError(error).message);
    }
  }

  if (!current) return null;

  // There is somewhere to drag to only when the picture is bigger than the
  // frame. Offering a grab cursor on a picture that cannot move is the small
  // lie that makes people think dragging is broken rather than unnecessary.
  const bounds = measure();
  const canPan =
    current.kind !== "video" &&
    !!bounds &&
    (panBounds(bounds.scaled, bounds.frame).x > 0 ||
      panBounds(bounds.scaled, bounds.frame).y > 0);

  return createPortal(
    <div
      className="fixed inset-0 flex flex-col bg-black/85"
      style={{ zIndex: 300 }}
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
    >
      <header className="no-drag flex shrink-0 items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium text-white">{current.name}</p>
          <p className="text-[11px] text-white/60">
            {fileSize(current.size)} · {relativeTime(new Date(current.sent_at_ms), now)}
            {items.length > 1 ? ` · ${index + 1} of ${items.length}` : ""}
          </p>
        </div>
        <IconButton
          name="minus"
          label="Zoom out"
          size={17}
          disabled={current.kind === "video" || zoom <= ZOOM_MIN}
          onClick={() => zoomTo(zoom - ZOOM_STEP)}
        />
        <span className="w-12 text-center font-mono text-[11px] text-white/70">
          {Math.round(zoom * 100)}%
        </span>
        <IconButton
          name="plus"
          label="Zoom in"
          size={17}
          disabled={current.kind === "video" || zoom >= ZOOM_MAX}
          onClick={() => zoomTo(zoom + ZOOM_STEP)}
        />
        <IconButton name="download" label="Save" size={17} onClick={() => void save()} />
        <IconButton name="close" label="Close" size={17} onClick={onClose} />
      </header>

      {/* The backdrop closes; the media itself does not, so a click meant for
          the picture is not a click meant to leave. */}
      <div
        ref={frameRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
        onClick={onClose}
        onWheel={(event) => {
          if (current.kind === "video") return;
          // The wheel zooms about the cursor rather than the middle. Zooming
          // about the middle is the easy version and the wrong one: you point
          // at a face, zoom, and the face leaves the screen.
          const box = frameRef.current?.getBoundingClientRect();
          if (!box) return;
          const at = {
            x: event.clientX - (box.left + box.width / 2),
            y: event.clientY - (box.top + box.height / 2),
          };
          zoomTo(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), at);
        }}
      >
        {index > 0 ? (
          <button
            type="button"
            aria-label="Previous"
            onClick={(e) => {
              e.stopPropagation();
              step(-1);
            }}
            className="absolute left-4 z-10 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
          >
            <Icon name="chevronLeft" size={22} />
          </button>
        ) : null}

        <div
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full"
        >
          {problem ? (
            <p className="text-white/70">{problem}</p>
          ) : !url ? (
            <div
              className="size-[320px] animate-pulse rounded-panel"
              style={{ background: fieldFor(String(current.envelope_id)) }}
              aria-label="Loading"
              role="img"
            />
          ) : current.kind === "video" ? (
            // Controls, because a video with no way to pause it is a
            // decoration rather than something you can watch.
            <video
              src={url}
              controls
              autoPlay
              className="max-h-[calc(100vh-13rem)] max-w-full rounded-panel"
            />
          ) : (
            <img
              ref={imageRef}
              src={url}
              alt={current.name}
              draggable={false}
              onDoubleClick={() => (zoom > ZOOM_MIN ? reset() : zoomTo(2))}
              onPointerDown={(event) => {
                if (!canPan) return;
                // Captured, so a drag that leaves the picture -- which is most
                // of them, since the picture is bigger than the frame by
                // definition when there is anywhere to drag to -- keeps
                // arriving here instead of being lost to the backdrop.
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                  from: { x: event.clientX, y: event.clientY },
                  pan,
                };
                setDragging(true);
              }}
              onPointerMove={(event) => {
                const held = drag.current;
                if (!held) return;
                const moved = {
                  x: held.pan.x + (event.clientX - held.from.x),
                  y: held.pan.y + (event.clientY - held.from.y),
                };
                const seen = measure();
                setPan(seen ? clampPan(moved, seen.scaled, seen.frame) : moved);
              }}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                // Only the zoom animates. A drag that eased would lag the
                // cursor by exactly the duration, which reads as a stutter.
                transition: dragging
                  ? "none"
                  : "transform var(--motion-fast) var(--ease-state)",
                cursor: canPan ? (dragging ? "grabbing" : "grab") : "default",
                // The browser's own pan gesture would otherwise take the drag
                // and scroll nothing with it.
                touchAction: "none",
              }}
              className="max-h-[calc(100vh-13rem)] max-w-full rounded-panel select-none"
            />
          )}
        </div>

        {index < items.length - 1 ? (
          <button
            type="button"
            aria-label="Next"
            onClick={(e) => {
              e.stopPropagation();
              step(1);
            }}
            className="absolute right-4 z-10 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
          >
            <Icon name="chevronLeft" size={22} className="rotate-180" />
          </button>
        ) : null}
      </div>

      {/* N2: everything else in the conversation, to jump straight to rather
          than scrolling the thread back to find it. */}
      {items.length > 1 ? (
        <div
          ref={stripRef}
          className="no-drag flex shrink-0 gap-2 overflow-x-auto px-4 py-3"
          aria-label="Media in this conversation"
        >
          {items.map((item, i) => (
            <Thumbnail
              key={item.envelope_id}
              item={item}
              index={i}
              active={i === index}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/**
 * One entry in the strip.
 *
 * Each fetches its own bytes, which is the cost of a strip that shows what
 * things actually are. The generated field stands in until then, so the strip
 * has its full width from the first frame and nothing jumps as they arrive.
 */
function Thumbnail({
  item,
  index,
  active,
  onClick,
}: {
  item: AttachmentEntry;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void attachmentUrl(item.envelope_id)
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch(() => {
        // The field stands. A thumbnail that will not decrypt is not worth an
        // error message under a picture somebody is looking at.
      });
    return () => {
      cancelled = true;
    };
  }, [item.envelope_id]);

  return (
    <button
      type="button"
      data-index={index}
      onClick={onClick}
      aria-label={item.name}
      aria-current={active ? "true" : undefined}
      className={cn(
        "size-14 shrink-0 rounded-control bg-cover bg-center ring-2 transition-[box-shadow,opacity] duration-[var(--motion-fast)]",
        active ? "ring-accent opacity-100" : "opacity-60 ring-transparent hover:opacity-100",
      )}
      style={
        url
          ? { backgroundImage: `url(${url})` }
          : { background: fieldFor(String(item.envelope_id)) }
      }
    />
  );
}
