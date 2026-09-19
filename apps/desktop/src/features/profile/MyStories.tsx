import { useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { Icon } from "../../components/ui/Icon";
import { timeLeft } from "../../lib/format";
import { asConversationError } from "../../lib/conversations";
import { openStory, type Story } from "../../lib/stories";
import { StoryViewer } from "../home/StoryViewer";
import { storyGroupFor } from "../home/storyGroups";
import { useStories } from "../home/useStories";

/**
 * Your own stories, as a gallery.
 *
 * This tab used to draw `Stories` — the strip from Home — which answers a
 * different question with the same pixels. The strip is *other people*: one
 * circle per person, tap to watch what they posted. On your own profile that
 * put your contacts' faces under a heading saying "Your stories", and gave you
 * no way to see what you had actually posted: your own posts were one circle
 * however many there were, and a circle is not a thing you can look through.
 *
 * A gallery answers the question the tab asks. Each tile is one story you
 * posted, newest last, with what it looks like and how long it has left.
 *
 * # Why each tile fetches
 *
 * There is no thumbnail anywhere to draw instead. A story is ciphertext in
 * object storage and a key on this device — nothing decrypted is written down,
 * which is the point — so a picture of it means fetching and decrypting it.
 * That is bounded by what it is: your own live stories, which is a handful
 * within a 24-hour window, and the download route's rate limit is 60 a minute.
 *
 * It is also why a tile draws its frame, its countdown and its position
 * immediately and fills the picture in when it arrives, rather than holding
 * the gallery back until every one of them has landed.
 */
export function MyStories({
  onPost,
  posting = false,
}: {
  /**
   * Posts a story. The profile's own handler, not a second one — the `+` on
   * your picture and this empty state must not become two flows that drift.
   */
  onPost: () => void;
  posting?: boolean;
}) {
  const { stories, refresh, problem } = useStories();
  const group = storyGroupFor(stories ?? [], null);
  const [watching, setWatching] = useState<number | null>(null);

  // Re-read on mount, which is also the purge: opening this tab is one of the
  // moments an expired story and its key leave the disk. `useStories` already
  // reads once; this is the tab being opened again after one was posted.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!group) {
    return (
      <>
        <EmptyState
          icon="image"
          title="Nothing up right now"
          body="A story goes to everyone you already have a conversation with and disappears after 24 hours."
          action={
            <Button icon="plus" disabled={posting} onClick={onPost}>
              {posting ? "Posting…" : "Post a story"}
            </Button>
          }
        />
        {problem ? (
          <p className="text-text-lo mt-2 text-center text-meta">{problem}</p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-3">
        {group.stories.map((story, index) => (
          <li key={story.id}>
            <StoryTile
              story={story}
              position={index + 1}
              of={group.stories.length}
              onOpen={() => setWatching(index)}
            />
          </li>
        ))}
      </ul>

      {problem ? (
        <p className="text-text-lo mt-3 text-meta">{problem}</p>
      ) : null}

      {watching !== null ? (
        <StoryViewer
          group={group}
          startIndex={watching}
          onClose={() => setWatching(null)}
        />
      ) : null}
    </>
  );
}

/**
 * One story in the gallery.
 *
 * The countdown is read once, when the tile mounts, and not on a timer. A
 * story lasts a day and the number is in whole hours for all but the last one
 * of them, so a ticking clock would repaint the page to say the same word;
 * what actually ends a story is `live_stories`, on the next read.
 */
function StoryTile({
  story,
  position,
  of,
  onOpen,
}: {
  story: Story;
  position: number;
  of: number;
  onOpen: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void openStory(story.id)
      .then((next) => {
        if (!cancelled) setSrc(next);
      })
      .catch((error) => {
        if (!cancelled) setFailed(asConversationError(error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [story.id]);

  const remaining = timeLeft(new Date(story.expires_at_ms), new Date());

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group border-line bg-surface-2 focus-visible:ring-accent relative block aspect-[3/4] w-full overflow-hidden rounded-panel border outline-none focus-visible:ring-2"
      aria-label={`${of > 1 ? `Story ${position} of ${of}` : "Your story"}, ${remaining}`}
    >
      {failed ? (
        // Rule 7: it says it could not open it. It does not draw an empty
        // frame that reads as a story with nothing in it.
        <span className="text-text-lo absolute inset-0 flex items-center justify-center p-3 text-center text-[11px]">
          {failed}
        </span>
      ) : !src ? (
        <span className="text-text-lo absolute inset-0 flex items-center justify-center text-[11px]">
          Decrypting…
        </span>
      ) : src.startsWith("data:video/") ? (
        <>
          {/* Muted and never played here: this is the poster frame, and a
              wall of tiles that all started talking at once is not a gallery.
              `preload="metadata"` is what gets a first frame drawn without
              fetching the whole file a second time. */}
          <video
            src={src}
            muted
            playsInline
            preload="metadata"
            className="absolute inset-0 size-full object-cover"
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white">
              <Icon name="play" size={15} />
            </span>
          </span>
        </>
      ) : (
        <img
          src={src}
          alt=""
          className="absolute inset-0 size-full object-cover"
        />
      )}

      {/* A gradient rather than a bar, so the countdown stays readable over
          whatever the picture happens to be behind it. */}
      <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pt-6 pb-1.5">
        <span className="text-[11px] text-white">{remaining}</span>
        {of > 1 ? (
          <span className="font-mono text-[10px] text-white/80">
            {position}/{of}
          </span>
        ) : null}
      </span>
    </button>
  );
}
