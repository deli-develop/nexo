import { useEffect, useState } from "react";

import { useApp } from "../../app/store";
import { relativeTime } from "../../lib/format";
import { openUrl } from "../../lib/native";
import { fieldFor } from "../../lib/palette";
import {
  asFeedError,
  followState,
  postsBy,
  profile as profileCall,
  setFollowing,
  type FollowState,
  type Post,
  type Profile,
} from "../../lib/feed";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { block, confirmBlock, listBlocks, unblock } from "../../lib/blocks";
import { ReportDialog } from "../home/ReportDialog";
import { notify } from "../../lib/native";
import { Callout, EmptyState, Skeleton } from "../../components/ui/Feedback";
import { Icon } from "../../components/ui/Icon";
import { Panel } from "../../components/ui/Surface";
import { RemoteImage } from "../../components/ui/RemoteImage";
import { startConversation } from "../../lib/conversations";
import { StoryViewer } from "../home/StoryViewer";
import { storyGroupFor } from "../home/storyGroups";
import { useStories } from "../home/useStories";
import { cn } from "../../lib/cn";

/**
 * Somebody else's profile.
 *
 * Read-only, and short by design: a public profile shows what its owner chose
 * to make visible (G2), and the server has already applied that — a field that
 * is not public simply is not in the response. Nothing here decides what to
 * hide, which is the only way that promise stays true.
 */
export function PublicProfile({ handle, now }: { handle: string; now: Date }) {
  const go = useApp((s) => s.go);
  const openConversation = useApp((s) => s.openConversation);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Follow state comes from the server rather than being assumed: the button
  // has to say what is true for *this* account, and a locally guessed "Follow"
  // on somebody already followed is the sort of small lie people stop trusting
  // the rest of the screen over.
  const [follow, setFollow] = useState<FollowState | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFollow(null);
    void followState(handle)
      .then((next) => {
        if (!cancelled) setFollow(next);
      })
      .catch(() => {
        // Blocked, private, or gone -- the server answers all three the same
        // way on purpose. The button stays absent rather than guessing which.
      });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  async function toggleFollow() {
    if (!follow || followBusy) return;
    setFollowBusy(true);
    const next = !follow.following;
    try {
      await setFollowing(handle, next);
      // Recomputed rather than incremented: the count is the server's, and two
      // devices following at once would otherwise drift apart from it.
      setFollow(await followState(handle));
    } catch (error) {
      await notify("Nexo", asFeedError(error).message);
    } finally {
      setFollowBusy(false);
    }
  }
  const [viewingStory, setViewingStory] = useState(false);
  // The same local list Home's strip and the reader's own ring read --
  // whatever this device currently holds a live story for. If `handle` is
  // not a contact, or is one but has posted nothing right now, nothing here
  // ever matches: the fan-out in `stories::post` never reached this device in
  // the first place, so there is no story to find and no separate check to
  // write for "should this be hidden".
  const { stories } = useStories();
  const storyGroup = storyGroupFor(stories ?? [], handle);
  const [blocked, setBlocked] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [reporting, setReporting] = useState(false);

  // Read from the server rather than remembered locally: the block is the
  // server's state, and a button that showed this machine's guess would be
  // wrong on the second device.
  useEffect(() => {
    let cancelled = false;
    void listBlocks()
      .then((list) => {
        if (!cancelled) setBlocked(list.some((b) => b.handle === handle));
      })
      .catch(() => {
        // Not knowing is not worth an error banner over somebody's profile.
        // The button then offers Block, and blocking twice is a no-op.
      });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setPosts(null);
    setProblem(null);

    void profileCall(handle)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((error) => {
        if (!cancelled) setProblem(asFeedError(error).message);
      });

    void postsBy(handle)
      .then((page) => {
        if (!cancelled) setPosts(page.posts);
      })
      .catch(() => {
        // The profile is the point; its posts failing to load is not worth a
        // second error message on the same screen.
      });

    return () => {
      cancelled = true;
    };
  }, [handle]);

  async function toggleBlock() {
    if (!profile || blocking) return;
    if (!blocked) {
      if (!(await confirmBlock(profile.display_name))) return;
    }
    setBlocking(true);
    try {
      if (blocked) await unblock(profile.handle);
      else await block(profile.handle);
      setBlocked(!blocked);
    } catch (error) {
      setProblem(asFeedError(error).message);
    } finally {
      setBlocking(false);
    }
  }

  async function message() {
    if (!profile || starting) return;
    setStarting(true);
    try {
      openConversation(await startConversation(profile.handle));
      go("messages");
    } catch (error) {
      setProblem(asFeedError(error).message);
    } finally {
      setStarting(false);
    }
  }

  if (problem) {
    return (
      <Panel tone="content" edge={false} className="flex flex-1 items-center justify-center p-8">
        <EmptyState icon="user" title="No such profile" body={problem} />
      </Panel>
    );
  }

  return (
    <Panel tone="content" edge={false} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[840px] px-6 pb-12">
        <div className="relative pt-4">
          {profile?.banner_key ? (
            <RemoteImage
              imageKey={profile.banner_key}
              alt={`${profile.display_name}'s banner`}
              className="rounded-panel aspect-[3/1] max-h-[240px] w-full"
            />
          ) : (
            <div
              className="rounded-panel aspect-[3/1] max-h-[240px] w-full"
              style={{ background: fieldFor(handle + "-banner") }}
              role="img"
              aria-label={`${handle}'s banner`}
            />
          )}

          {/* Two rings, same construction as the reader's own avatar: the
              inner `ring-surface-2` separates the picture from the banner
              behind it, unconditionally; the outer one, only when this device
              currently holds a live story from this person, is the same
              accent-and-offset the strip uses. Unlike the reader's own
              avatar, this one is also the way *in* -- there is no "their
              Stories tab" to visit instead, so the ring is the entry point. */}
          <button
            type="button"
            disabled={!storyGroup}
            onClick={() => setViewingStory(true)}
            aria-label={
              storyGroup
                ? `View ${profile?.display_name ?? handle}'s story`
                : undefined
            }
            className={cn(
              "absolute -bottom-10 left-5 block rounded-full outline-none",
              storyGroup
                ? "ring-accent focus-visible:ring-accent cursor-pointer ring-2 ring-offset-2 ring-offset-[var(--color-surface-1)]"
                : "ring-surface-2 ring-4",
            )}
          >
            {profile?.avatar_key ? (
              <RemoteImage
                imageKey={profile.avatar_key}
                alt={profile.display_name}
                className="rounded-full"
                style={{ width: 88, height: 88 }}
              />
            ) : (
              <Avatar seed={handle} name={profile?.display_name ?? handle} size={88} />
            )}
          </button>
        </div>

        {/* Neither action makes sense against yourself. The store already
            redirects your own handle to your own profile, so reaching here as
            `is_me` means something upstream missed -- and a Message button that
            starts a conversation with your own account is the visible result.

            Wraps: four buttons are about 350px, more than a phone has, and a
            row that cannot wrap widens the page instead. */}
        <div className="flex flex-wrap items-start justify-end gap-2 pt-3">
          {profile?.is_me ? null : (
          <>
          <Button
            variant={follow?.following ? "secondary" : "primary"}
            icon="user"
            disabled={!profile || followBusy}
            onClick={() => void toggleFollow()}
          >
            {follow?.following ? "Following" : "Follow"}
          </Button>
          <Button icon="messages" disabled={!profile || starting} onClick={() => void message()}>
            {starting ? "Opening…" : "Message"}
          </Button>
          <Button disabled={!profile} onClick={() => setReporting(true)}>
            Report
          </Button>
          <Button
            variant={blocked ? "secondary" : "danger"}
            disabled={!profile || blocking}
            onClick={() => void toggleBlock()}
          >
            {blocked ? "Unblock" : "Block"}
          </Button>
          </>
          )}
          {reporting && profile ? (
            <ReportDialog
              subject="user"
              id={profile.user_id}
              name={profile.display_name}
              onClose={() => setReporting(false)}
            />
          ) : null}
        </div>

        <div className="mt-6">
          {profile ? (
            <>
              <h1 className="text-text-hi font-display text-[26px] leading-tight font-semibold">
                {profile.display_name}
              </h1>
              <p className="text-text-lo mt-0.5 text-body">@{profile.handle}</p>
            </>
          ) : (
            <>
              <Skeleton className="h-6 w-48" />
              <Skeleton className="mt-2 h-3 w-24" />
            </>
          )}

          {profile?.bio ? (
            <p className="text-text-mid mt-3 max-w-[70ch] text-body leading-relaxed whitespace-pre-wrap">
              {profile.bio}
            </p>
          ) : null}

          <div className="text-text-lo mt-3 flex flex-wrap items-center gap-4 text-meta">
            {profile?.location ? (
              <span className="inline-flex items-center gap-1.5">
                <Icon name="pin" size={13} />
                {profile.location}
              </span>
            ) : null}
            {profile?.join_date_ms ? (
              <span className="inline-flex items-center gap-1.5">
                <Icon name="calendar" size={13} />
                Joined {relativeTime(new Date(profile.join_date_ms), now)}
              </span>
            ) : null}
          </div>

          {profile?.links?.length ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {profile.links.map((link) => (
                <li key={link.url}>
                  <button
                    type="button"
                    onClick={() => void openUrl(link.url)}
                    className="rounded-control text-accent-soft bg-fill hover:bg-fill-hover inline-flex items-center gap-1.5 border border-line px-2.5 py-1.5 text-meta"
                  >
                    <Icon name="external" size={13} />
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <h2 className="text-text-hi mt-8 font-display text-[17px] font-medium">Posts</h2>
        {posts === null ? (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : posts.length === 0 ? (
          <p className="text-text-lo mt-3 text-meta">Nothing posted yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {posts.map((post) => (
              <li key={post.id} className="rounded-panel border border-line bg-fill p-3">
                {post.title ? (
                  <p className="text-text-hi text-body font-medium">{post.title}</p>
                ) : null}
                {post.body ? (
                  <p className="text-text-mid mt-0.5 text-meta whitespace-pre-wrap">{post.body}</p>
                ) : null}
                <p className="text-text-lo mt-1 text-[11px]">
                  {relativeTime(new Date(post.created_at_ms), now)}
                </p>
              </li>
            ))}
          </ul>
        )}

        {problem ? (
          <Callout tone="warning" icon="alert" className="mt-4">
            {problem}
          </Callout>
        ) : null}
      </div>

      {viewingStory && storyGroup ? (
        <StoryViewer group={storyGroup} onClose={() => setViewingStory(false)} />
      ) : null}
    </Panel>
  );
}
