import { useEffect, useState } from "react";

import { conversationAvatar } from "../../lib/conversations";
import { Avatar } from "./Avatar";
import { HandleAvatar } from "./HandleAvatar";
import { Icon } from "./Icon";

/**
 * Whatever a conversation should look like.
 *
 * Three cases, and they are genuinely different rather than fallbacks for one
 * another. A group with a picture wears it; the bytes are encrypted to the
 * group, so Rust fetches and decrypts them and hands back a `data:` URL. A DM
 * has exactly one other person and wears theirs. Everything else is the
 * generated gradient, which is what an unnamed thing looks like rather than a
 * placeholder waiting to be replaced.
 *
 * Saved messages is none of them: it wears the pin the list's own row for it
 * wears. As a DM it was handed to `HandleAvatar`, which looked "Saved
 * messages" up as somebody's handle.
 */
export function ConversationAvatar({
  conversationId,
  kind,
  title,
  hasAvatar,
  size = 40,
}: {
  conversationId: string;
  kind: "dm" | "group" | "self";
  /** A DM's title is the other person's handle. */
  title: string;
  /** Whether a picture has been set, so no request is made when none has. */
  hasAvatar?: boolean;
  size?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hasAvatar) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    void conversationAvatar(conversationId)
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch(() => {
        // The gradient stands. A picture that will not decrypt is not worth an
        // error in a conversation list.
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, hasAvatar]);

  if (url) {
    return (
      <span
        role="img"
        aria-label={title}
        className="shrink-0 rounded-full bg-cover bg-center ring-1 ring-line-strong"
        style={{ width: size, height: size, backgroundImage: `url(${url})` }}
      />
    );
  }

  if (kind === "self") {
    return (
      <span
        role="img"
        aria-label={title}
        className="bg-fill text-text-mid ring-line flex shrink-0 items-center justify-center rounded-full ring-1"
        style={{ width: size, height: size }}
      >
        <Icon name="pin" size={Math.round(size * 0.4)} />
      </span>
    );
  }

  if (kind === "dm") {
    return <HandleAvatar handle={title} name={title} size={size} />;
  }

  return <Avatar seed={conversationId} name={title} size={size} />;
}
