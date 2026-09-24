import { useEffect, useRef, useState } from "react";

import { Button } from "./Button";
import { Modal } from "./Modal";
import { Callout } from "./Feedback";

/**
 * Choosing which part of a picture to use, before it is uploaded.
 *
 * Setting a picture used to take whatever was picked and stretch it into
 * whatever shape the layout wanted — a portrait photo became a banner by having
 * its top and bottom cut off, with no say in which part survived. Every app
 * people are used to asks first, and the reason is that the interesting part of
 * a photograph is rarely its geometric centre.
 *
 * The image arrives as a `data:` URL from Rust rather than a file path: the page
 * cannot read local files, and giving it that ability to save a round trip
 * would undo the capability that was deliberately removed.
 *
 * Output is re-encoded on a canvas at the target aspect, capped at
 * {@link MAX_EDGE} on the long edge. That cap is the point at which a 6000px
 * phone photo stops being a 12 MB upload nobody asked for.
 *
 * A moving picture never comes here: a canvas holds one frame, so an animated
 * GIF left as its first. `lib/animated.ts` decides, and the caller uploads
 * those as they were picked.
 */

/** The longest edge any stored image may have. */
const MAX_EDGE = 1920;

export function ImageCropper({
  src,
  aspect,
  round,
  title,
  onCancel,
  onDone,
}: {
  /** A `data:` URL, from `read_image_for_crop`. */
  src: string;
  /** Width over height of the region to keep. 1 for an avatar, 3 for a banner. */
  aspect: number;
  /** Draw the mask as a circle. Cosmetic — the output is still a rectangle. */
  round?: boolean;
  title: string;
  onCancel: () => void;
  /** Receives a `data:` URL of the cropped image. */
  onDone: (dataUrl: string) => void;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The frame is a fixed width; its height follows the aspect being cropped to.
  const FRAME_W = 420;
  const frameH = Math.round(FRAME_W / aspect);

  // The scale at which the image just covers the frame. Zoom multiplies this,
  // so 1 always means "no empty space", whatever shape the image is.
  const baseScale = natural
    ? Math.max(FRAME_W / natural.w, frameH / natural.h)
    : 1;
  const scale = baseScale * zoom;

  // Keep the image covering the frame however it is dragged. Without this the
  // crop could include transparent nothing, and the result would have a
  // mysterious blank edge.
  function clamp(next: { x: number; y: number }) {
    if (!natural) return next;
    const w = natural.w * scale;
    const h = natural.h * scale;
    const maxX = Math.max(0, (w - FRAME_W) / 2);
    const maxY = Math.max(0, (h - frameH) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }

  useEffect(() => {
    setOffset((o) => clamp(o));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, natural]);

  function onPointerDown(event: React.PointerEvent) {
    setDragging(true);
    (event.target as Element).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent) {
    if (!dragging) return;
    setOffset((o) => clamp({ x: o.x + event.movementX, y: o.y + event.movementY }));
  }

  function crop() {
    const image = imageRef.current;
    if (!image || !natural) return;

    // The output is the frame, scaled up to the cap rather than to the frame's
    // pixel size -- cropping should not also be a downscale to 420px.
    let outW = Math.round(FRAME_W / scale);
    let outH = Math.round(frameH / scale);
    const longest = Math.max(outW, outH);
    if (longest > MAX_EDGE) {
      const k = MAX_EDGE / longest;
      outW = Math.round(outW * k);
      outH = Math.round(outH * k);
    }

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setProblem("This image could not be prepared.");
      return;
    }

    // Where the visible frame sits on the source image.
    const sw = FRAME_W / scale;
    const sh = frameH / scale;
    const sx = (natural.w - sw) / 2 - offset.x / scale;
    const sy = (natural.h - sh) / 2 - offset.y / scale;

    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, outW, outH);

    // JPEG for photographs: a 1920px PNG of a photo is several megabytes for no
    // visible gain. Quality 0.9 is where the artefacts stop being findable.
    onDone(canvas.toDataURL("image/jpeg", 0.9));
  }

  return (
    <Modal label={title} onClose={onCancel}>
      <div className="rounded-panel bg-surface-2 w-full max-w-[480px] border border-line p-5">
        <h2 className="text-text-hi font-display text-[17px] font-medium">{title}</h2>
        <p className="text-text-lo mt-1.5 text-meta">
          Drag to move, and use the slider to zoom. Only what is inside the frame is
          kept.
        </p>

        <div
          ref={frameRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          className="relative mt-4 mx-auto overflow-hidden bg-surface-0 select-none"
          style={{
            width: FRAME_W,
            height: frameH,
            cursor: dragging ? "grabbing" : "grab",
            borderRadius: round ? "9999px" : "var(--radius-panel, 12px)",
          }}
        >
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <img
            ref={imageRef}
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              setNatural({ w: el.naturalWidth, h: el.naturalHeight });
            }}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: "center",
              maxWidth: "none",
            }}
          />
        </div>

        <label className="mt-4 flex items-center gap-3">
          <span className="text-text-lo text-[11px]">Zoom</span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="accent-accent flex-1"
            aria-label="Zoom"
          />
        </label>

        {problem ? (
          <Callout tone="danger" icon="alert" className="mt-3">
            {problem}
          </Callout>
        ) : null}

        <div className="mt-4 flex gap-2">
          <Button variant="primary" disabled={!natural} onClick={crop}>
            Use this
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}
