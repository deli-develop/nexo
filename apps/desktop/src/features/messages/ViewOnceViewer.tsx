import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "../../components/ui/Button";
import { blockScreenCapture, canBlockScreenCapture } from "../../lib/native";

/**
 * A view-once photo or video, over the whole window, with the window kept out
 * of screenshots for as long as it is open.
 *
 * It used to open inside the bubble, in the middle of the conversation, and
 * stay there until the conversation was left -- with "Nexo cannot stop a
 * screenshot" as all there was to say. Now it is a viewer of its own, the way
 * Telegram and WhatsApp show one, closed with its button or Escape, after
 * which the picture is gone from this page.
 *
 * **In the desktop app the window is excluded from capture while this is
 * open** (`blockScreenCapture`): a screenshot, the Snipping Tool or a screen
 * recording shows the window blank. The media is not drawn until that
 * protection is in place, so there is no first frame to catch. In a browser
 * no page can do this, and the viewer says so instead of implying otherwise.
 *
 * Picture-in-picture is off for the video: it would put the clip in a window
 * of its own, and that window is not protected.
 */
export function ViewOnceViewer({
  url,
  kind,
  onClose,
}: {
  url: string;
  kind: "image" | "video";
  onClose: () => void;
}) {
  const noun = kind === "video" ? "Video" : "Photo";
  // "pending" until the shell has answered: nothing is drawn before then.
  const [shield, setShield] = useState<"pending" | "held" | "none">(
    canBlockScreenCapture() ? "pending" : "none",
  );

  useEffect(() => {
    let cancelled = false;
    let release = () => {};
    void blockScreenCapture().then((hold) => {
      release = hold.release;
      if (cancelled) hold.release();
      else setShield(hold.held ? "held" : "none");
    });
    return () => {
      cancelled = true;
      release();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${noun}, opened once`}
      // Above everything, overlays included (§7.3 puts them at 200): nothing
      // else in the window should sit on top of this.
      className="no-drag fixed inset-0 flex flex-col bg-black text-white"
      style={{ zIndex: 210 }}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-[13px] font-medium">{noun} · once</span>
        <IconButton
          name="close"
          label="Close. It cannot be opened again."
          onClick={onClose}
          className="text-white/80 enabled:hover:bg-white/10 enabled:hover:text-white"
        />
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        {shield === "pending" ? (
          <span className="text-[12px] text-white/60">Opening…</span>
        ) : kind === "video" ? (
          <video
            src={url}
            controls
            autoPlay
            disablePictureInPicture
            controlsList="nodownload noremoteplayback noplaybackrate"
            className="max-h-full max-w-full rounded-[10px]"
          />
        ) : (
          <img
            src={url}
            alt={`${noun}, opened once`}
            draggable={false}
            className="max-h-full max-w-full rounded-[10px] object-contain select-none"
          />
        )}
      </div>

      <p className="mx-auto max-w-[560px] px-4 py-4 text-center text-[12px] leading-relaxed text-white/60">
        {shield === "none"
          ? canBlockScreenCapture()
            ? "Nexo could not keep this window out of screenshots. Closing this ends it — the key is already gone from this device."
            : "A browser cannot stop a screenshot of this. Closing this ends it — the key is already gone from this device."
          : "Screenshots and screen recordings of Nexo come out blank while this is open. A camera pointed at the screen still works. Closing this ends it — the key is already gone from this device."}
      </p>
    </div>,
    document.body,
  );
}
