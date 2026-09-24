import { useEffect, useRef, useState } from "react";

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
 *
 * A team is a group here: its picture is the same encrypted `group_avatar`.
 * The board and the team list used to draw the gradient whatever had been
 * set, so changing a team's picture changed nothing anybody could see.
 *
 * `version` says *which* picture. `hasAvatar` stays true from the first
 * picture to the last, so without it the first one was drawn until the app
 * restarted.
 */
export function ConversationAvatar({
  conversationId,
  kind,
  title,
  hasAvatar,
  version,
  size = 40,
}: {
  conversationId: string;
  kind: "dm" | "group" | "self" | "team";
  /** A DM's title is the other person's handle. */
  title: string;
  /** Whether a picture has been set, so no request is made when none has. */
  hasAvatar?: boolean;
  /** Which picture is set -- a new one is fetched when this changes. */
  version?: string | null | undefined;
  size?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  // The URL on screen, let go of once another replaces it or the avatar
  // goes. Every picture change and every row scrolled away used to keep its
  // decrypted copy for as long as the page lived.
  const shown = useRef<string | null>(null);
  const show = (next: string | null) => {
    const previous = shown.current;
    shown.current = next;
    setUrl(next);
    if (previous && previous !== next) URL.revokeObjectURL(previous);
  };
  useEffect(() => () => show(null), []);

  useEffect(() => {
    if (!hasAvatar) {
      show(null);
      return;
    }
    let cancelled = false;
    void conversationAvatar(conversationId)
      .then((next) => {
        if (!cancelled) show(next);
        else if (next) URL.revokeObjectURL(next);
      })
      .catch(() => {
        // The gradient stands. A picture that will not decrypt is not worth an
        // error in a conversation list.
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, hasAvatar, version]);

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
