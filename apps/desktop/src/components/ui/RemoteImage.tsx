import type { CSSProperties } from "react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/cn";
import { acquireImage } from "../../lib/images";
import { fieldFor } from "../../lib/palette";

/**
 * An image stored in object storage, rendered from its key.
 *
 * The bucket is private (§5.3), so there is no public URL — every read goes
 * through a presigned GET. And the presigned URL is not drawn either: the CSP's
 * `img-src` names no remote host, so the bytes are fetched and drawn from a
 * `blob:` URL. `lib/images.ts` owns that URL — it shares one per key between
 * everything drawing the same picture and revokes it once nothing does, which
 * is why this component holds a handle while it is mounted and gives it back
 * when it is not.
 *
 * A generated field stands in while the picture is on its way and stays if it
 * never arrives, so a feed with a dead object still lays out correctly instead
 * of collapsing to zero height or showing a broken-image glyph. Nothing is
 * persisted: a presigned URL is a bearer credential for one object, and the
 * bytes are somebody's picture.
 */
export function RemoteImage({
  imageKey,
  alt,
  className,
  style,
  fit = "cover",
}: {
  /** The object key, e.g. `media/42/{uuid}`. */
  imageKey: string;
  alt: string;
  className?: string;
  /**
   * How the image sits in its box.
   *
   * `cover` fills and crops — right for an avatar, where the box is a circle
   * and the middle is what matters. `contain` fits the whole image inside,
   * which is right for anything somebody chose to post: cropping their picture
   * to a shape the layout preferred throws away the part they framed.
   */
  fit?: "cover" | "contain";
  /** Exact dimensions, for callers sized in pixels rather than in classes. */
  style?: CSSProperties;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    const image = acquireImage(imageKey);
    void image.url
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch(() => {
        // Left as the placeholder field. Rule 7 says a failure is shown, and
        // here the honest showing is "this image is not available" rather than
        // an error dialog for something nobody asked to open.
      });
    return () => {
      cancelled = true;
      image.release();
    };
  }, [imageKey]);

  if (!url) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={cn(className)}
        style={{ background: fieldFor(imageKey), ...style }}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={alt}
      className={cn(
        fit === "contain" ? "bg-contain bg-no-repeat" : "bg-cover",
        "bg-center",
        className,
      )}
      style={{ backgroundImage: `url(${url})`, ...style }}
    />
  );
}
