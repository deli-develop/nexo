import { useState } from "react";

import { useApp } from "../../app/store";
import { Avatar } from "../../components/ui/Avatar";
import { Callout } from "../../components/ui/Feedback";
import { HandleAvatar } from "../../components/ui/HandleAvatar";
import { StoryViewer } from "./StoryViewer";
import { groupStories, type StoryGroup } from "./storyGroups";
import { useStories } from "./useStories";

/**
 * The stories strip: other people's stories, on Home.
 *
 * On Home because a story's audience is *contacts* — people you already share
 * a conversation with — and Home is already where other people's things
 * appear.
 *
 * **Posting is not here.** It lives on your profile, with the other things
 * that are yours and that other people see: your picture, your banner, your
 * bio. A `+` sitting among other people's stories reads as "add to this row",
 * which is not what it does. This strip is read-only, and what you posted is
 * looked *through* rather than at, in `profile/MyStories.tsx`.
 *
 * **One circle per person, not per story.** `listStories()` is a flat list —
 * every live story this device holds, own and received mixed together — and
 * this used to draw it exactly as it arrived: two posts from the same person
 * were two circles, indistinguishable from two different people. They are
 * grouped now (`groupStories`), with your own circle leading and a `×n` badge
 * where somebody posted more than once; tapping opens that person's stories
 * (`StoryViewer`) in the order they happened, with Prev/Next between them.
 *
 * **The picture is the person's own**, through `HandleAvatar`, not the
 * generated gradient seeded from their handle. The gradient is what an account
 * *without* a picture looks like and it stays that; drawing it for an account
 * that has one made the same person two different faces on one screen -- their
 * post below wore the photograph and their story circle above it did not.
 *
 * The honesty point the UI has to carry, from `docs/THREAT-MODEL.md`: a story
 * is **public to your contacts and readable by nobody else**, but somebody who
 * was allowed to see it can keep it. The composer says so before anything is
 * posted, not afterwards.
 */
export function Stories() {
  // Only to give your own circle a handle to look a picture up by. A story
  // this device posted carries no author -- `post` writes the handle the
  // server returned, and `groupStories` marks the group `mine` from the empty
  // device id -- so the row itself cannot say whose face belongs on it.
  const myHandle = useApp((s) => s.account?.handle);
  const { stories, problem: loadProblem } = useStories();
  const [viewing, setViewing] = useState<StoryGroup | null>(null);

  const groups = groupStories(stories ?? []);

  return (
    <section className="mb-4">
      {/* The padding is not decoration: the ring below is drawn with
          `ring-offset`, which extends 4px past the avatar's own box, and the
          `×n` badge hangs past it too. A scroll container with no room around
          its content clips that overflow — `overflow-x: auto` forces the
          vertical axis to clip as well, per the CSS overflow spec — so the
          top and bottom of the ring were cut off and the first and last
          circle lost their outer edge to the row's own bounds. `px-1` was
          exactly the 4px the ring needs and nothing for the badge, which is
          flush rather than clear; `px-2` leaves both room. */}
      <div className="flex items-start gap-3 overflow-x-auto px-2 py-2.5">
        {groups.map((group) => {
          const count = group.stories.length;
          const name = group.mine
            ? "Your story"
            : group.authorHandle || "a contact";
          // Blank for a story whose author has not been resolved yet -- see
          // `Story.author_handle`. There is nothing to look a picture up by
          // then, so the generated gradient stands, seeded from the group key
          // the way it always was: one colour per unresolved *device*, rather
          // than one colour shared by all of them.
          const handle = group.mine ? myHandle : group.authorHandle;
          return (
            <button
              key={group.key}
              type="button"
              onClick={() => setViewing(group)}
              className="flex shrink-0 flex-col items-center gap-1"
              aria-label={
                count > 1
                  ? `${count} stories from ${name}`
                  : `Story from ${name}`
              }
            >
              {/* `inline-flex`, not the default. A ring is a box-shadow, and
                  on an inline box it is drawn around the *line box* -- a
                  strip of text height across the middle of the picture --
                  rather than around the 52px avatar inside it. That was the
                  cropped frame: the ring was the wrong size and the scroll
                  box then clipped what was left of it. */}
              <span className="relative inline-flex">
                <span className="ring-accent inline-flex rounded-full ring-2 ring-offset-2 ring-offset-[var(--color-surface-1)]">
                  {handle ? (
                    <HandleAvatar
                      handle={handle}
                      name={group.mine ? "You" : handle}
                      size={52}
                    />
                  ) : (
                    <Avatar seed={group.key} name="?" size={52} />
                  )}
                </span>
                {count > 1 ? (
                  <span
                    aria-hidden="true"
                    className="bg-accent text-on-accent absolute -right-0.5 -bottom-0.5 rounded-full px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums"
                  >
                    ×{count}
                  </span>
                ) : null}
              </span>
              <span className="text-text-lo max-w-[64px] truncate text-[11px]">
                {/* Empty a moment longer than usual only offline, or right
                    after a story arrives and before the listing has caught
                    up -- see `Story.author_handle`. Better a dash than a
                    UUID either way. */}
                {group.mine ? "You" : group.authorHandle || "—"}
              </span>
            </button>
          );
        })}

        {groups.length === 0 && stories ? (
          <p className="text-text-lo text-meta">
            No stories. Yours lasts 24 hours and goes to the people you already
            have a conversation with.
          </p>
        ) : null}
      </div>

      {loadProblem ? (
        <Callout tone="warning" icon="alert" className="mt-2">
          {loadProblem}
        </Callout>
      ) : null}

      {viewing ? (
        <StoryViewer group={viewing} onClose={() => setViewing(null)} />
      ) : null}
    </section>
  );
}
