import { useCallback, useEffect, useState } from "react";

import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/cn";
import { asConversationError } from "../../lib/conversations";
import { openStory } from "../../lib/stories";
import type { StoryGroup } from "./storyGroups";

/**
 * One person's stories, watched in the order they were posted.
 *
 * Pulled out of `Stories.tsx` so the strip is not the only place a story can
 * be watched from: the ring on a profile avatar opens the same viewer on the
 * same group, rather than a second implementation of Prev/Next, the fetch
 * dance, and the honesty line about what taking a copy means.
 *
 * `startIndex` is for the one caller that is not a circle. A strip or a ring
 * names a *person*, so watching starts where the sequence starts; the gallery
 * on your own profile names a particular story, and opening it at somebody
 * else's would answer a different question than the one that was asked.
 */
export function StoryViewer({
  group,
  startIndex = 0,
  onClose,
}: {
  group: StoryGroup;
  startIndex?: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const [src, setSrc] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const current = group.stories[index];

  // Fetches whichever story `index` now points at. Runs on open and on every
  // Prev/Next, rather than pre-fetching the whole group up front: most
  // groups have one story, and the ones that do not are watched one at a
  // time anyway.
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setSrc(null);
    void openStory(current.id)
      .then((next) => {
        if (!cancelled) setSrc(next);
      })
      .catch((error) => {
        if (!cancelled) setProblem(asConversationError(error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [current]);

  const step = useCallback(
    (by: number) => {
      setIndex((i) => {
        const next = i + by;
        if (next < 0 || next >= group.stories.length) return i;
        return next;
      });
    },
    [group.stories.length],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") step(1);
      else if (event.key === "ArrowLeft") step(-1);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [step]);

  if (!current) return null;

  return (
    <Modal
      label={group.mine ? "Your story" : `Story from ${group.authorHandle || "a contact"}`}
      onClose={onClose}
    >
      <div className="relative">
        {index > 0 ? (
          <button
            type="button"
            aria-label="Previous"
            onClick={(e) => {
              e.stopPropagation();
              step(-1);
            }}
            className="absolute top-1/2 -left-4 z-10 -translate-x-full -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
          >
            <Icon name="chevronLeft" size={20} />
          </button>
        ) : null}

        <div className="rounded-panel bg-surface-2 border-line max-w-[560px] border p-3">
          {group.stories.length > 1 ? (
            <div className="mb-2 flex gap-1" aria-hidden="true">
              {group.stories.map((s, i) => (
                <span
                  key={s.id}
                  className={cn(
                    "h-[3px] flex-1 rounded-full",
                    i <= index ? "bg-accent" : "bg-line",
                  )}
                />
              ))}
            </div>
          ) : null}

          {problem ? (
            <p className="text-text-lo flex h-[240px] w-[300px] items-center justify-center text-center text-meta">
              {problem}
            </p>
          ) : !src ? (
            <div
              className="flex h-[240px] w-[300px] items-center justify-center"
              aria-label="Loading"
              role="img"
            >
              <span className="text-text-lo text-meta">Decrypting…</span>
            </div>
          ) : /* A `data:` URL from Rust. Nothing remote is fetched — rule 3.
                 The kind comes from the URL itself, which Rust built from the
                 *sniffed* type rather than from anything the sender claimed. */
          src.startsWith("data:video/") ? (
            <video
              src={src}
              controls
              autoPlay
              className="rounded-control max-h-[70vh] w-auto"
            />
          ) : (
            <img src={src} alt="" className="rounded-control max-h-[70vh] w-auto" />
          )}
          <p className="text-text-lo mt-2 text-meta">
            Gone {new Date(current.expires_at_ms).toLocaleString()} — from this
            device and from the server. Someone who has already seen it can
            still have kept it.
          </p>
        </div>

        {index < group.stories.length - 1 ? (
          <button
            type="button"
            aria-label="Next"
            onClick={(e) => {
              e.stopPropagation();
              step(1);
            }}
            className="absolute top-1/2 -right-4 z-10 -translate-y-1/2 translate-x-full rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
          >
            <Icon name="chevronLeft" size={20} className="rotate-180" />
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
