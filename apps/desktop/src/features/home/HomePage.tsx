import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../app/store";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import {
  confirm,
  notify,
  openUrl,
  pickFile,
  type PickedFile,
} from "../../lib/native";
import { useFeed, type NewPostInput } from "../../app/useFeed";
import { RemoteImage } from "../../components/ui/RemoteImage";
import { Stories } from "./Stories";
import { EmojiPicker } from "../../components/ui/EmojiPicker";
import { CommentThread } from "./CommentThread";
import { compose } from "./compose";
import { uploadImage, type FeedSort, type Post } from "../../lib/feed";
import { asFeedError } from "../../lib/feed";
import { Avatar } from "../../components/ui/Avatar";
import { Button, IconButton } from "../../components/ui/Button";
import { Callout, EmptyState, Skeleton } from "../../components/ui/Feedback";
import { Field } from "../../components/ui/Controls";
import { Icon } from "../../components/ui/Icon";
import { Panel } from "../../components/ui/Surface";
import { useLayout } from "../../app/useLayout";
import { HomeChat } from "./HomeChat";
import { MIN_HOME_CHAT, MIN_HOME_FEED, Splitter } from "./Splitter";

const MAX_POST = 2000;

/**
 * Home (§6.2): one global reverse-chronological feed.
 *
 * The banner at the top is not decoration and does not get dismissed. §4.4 and
 * rule 5 require the product to say plainly that this content is not
 * end-to-end encrypted — it is readable by the server and public to any
 * logged-in user — and the place to say it is where people write it.
 *
 * Cursor-paginated with infinite scroll (§6.2). The sentinel at the bottom of
 * the column asks for the next page when it comes into view, which is what
 * makes it infinite rather than a Load More button — and why `useFeed` owns
 * the "already loading" flag: a fast scroll would otherwise fire four
 * overlapping requests for the same page.
 */
export function HomePage({ now }: { now: Date }) {
  const live = useFeed();
  const query = useApp((s) => s.homeSearchQuery);
  const setQuery = useApp((s) => s.setHomeSearchQuery);
  const layout = useLayout();
  const wantsChat = useApp((s) => s.preferences.homeChat);
  // The preference is intent; the viewport gets the last word. Below 1100px
  // the same width rule that folds away the Messages context panel applies
  // here — the feed's reading width and a usable conversation do not both
  // fit, and the feed is what this page is for.
  const showChat = wantsChat && layout.canShowContext;

  // The committed width lives in the preferences. During a gesture it does
  // not: the splitter writes `--home-chat-w` straight onto the row below and
  // React is not told, because a drag that re-renders the feed re-renders
  // every post card in it on every pointer move, and that is what turns a
  // resize into something you can feel catching. The variable is the width
  // while dragging; the preference is the width once the gesture ends.
  const chatWidth = useApp((s) => s.preferences.homeChatWidth);
  const setPreference = useApp((s) => s.setPreference);
  const row = useRef<HTMLDivElement>(null);

  // Search filters what has been loaded, and says so. A box that quietly
  // searched only the first two pages while looking like it searched the feed
  // would be worse than one that admits its scope.
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return live.posts;
    return live.posts.filter(
      (post) =>
        post.body.toLowerCase().includes(term) ||
        post.author_display_name.toLowerCase().includes(term) ||
        post.author_handle.toLowerCase().includes(term),
    );
  }, [live.posts, query]);

  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = live.loadMore;
  const hasMore = live.hasMore;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    // IntersectionObserver rather than a scroll listener: it does not run on
    // every frame of a scroll, and it reports the one thing this needs.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      // A margin so the next page starts arriving slightly before the reader
      // reaches the end.
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, hasMore]);

  return (
    <div
      ref={row}
      className="flex min-h-0 min-w-0 flex-1"
      style={{ "--home-chat-w": `${chatWidth}px` } as CSSProperties}
    >
      <Panel
        tone="content"
        edge={false}
        className="flex min-w-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* No rules of its own. The column used to draw a hairline down each
            side of itself, which put three vertical lines across a page that
            has one division in it — and none of the three was the one you
            could move. That one is the splitter below. */}
          <div className="mx-auto flex min-h-full w-full max-w-[660px] flex-col gap-4 px-6 py-5">
            {live.problem ? (
              <Callout tone="warning" icon="alert">
                {live.problem}
              </Callout>
            ) : null}

            <Field
              label="Search the feed"
              hideLabel
              icon="search"
              placeholder="Search loaded posts"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />

            {/* Above the composer, because a story is somebody else's and the
              composer is yours -- and because opening Home is what purges the
              expired ones. */}
            <Stories />

            <PostComposer onPost={live.post} />

            {/* Who, then how. These two rows do different jobs and are kept
              apart because of it: the first chooses whose posts are in the
              list, the second chooses their order. Merging them into one strip
              of five chips would read as five orderings, one of which
              mysteriously removes most of the feed. */}
            <div className="flex gap-1" role="tablist" aria-label="Whose posts">
              <button
                type="button"
                role="tab"
                aria-selected={!live.following}
                onClick={() => live.setFollowing(false)}
                className={cn(
                  "rounded-control px-2.5 py-1.5 text-[11px] font-medium transition-colors duration-[var(--motion-fast)]",
                  !live.following
                    ? "bg-fill-active text-text-hi"
                    : "text-text-lo hover:bg-fill-hover",
                )}
              >
                Everyone
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={live.following}
                onClick={() => live.setFollowing(true)}
                className={cn(
                  "rounded-control px-2.5 py-1.5 text-[11px] font-medium transition-colors duration-[var(--motion-fast)]",
                  live.following
                    ? "bg-fill-active text-text-hi"
                    : "text-text-lo hover:bg-fill-hover",
                )}
              >
                Following
              </button>
            </div>

            {/* Ordering, not filtering: every post the row above admits is
              still here, and which one is at the top is the whole difference
              between them. */}
            <div
              className="flex gap-1"
              role="tablist"
              aria-label="Sort the feed"
            >
              {FEED_SORTS.map((option) => (
                <button
                  key={option.sort}
                  type="button"
                  role="tab"
                  aria-selected={live.sort === option.sort}
                  onClick={() => live.setSort(option.sort)}
                  className={cn(
                    "rounded-control px-2.5 py-1.5 text-[11px] font-medium transition-colors duration-[var(--motion-fast)]",
                    live.sort === option.sort
                      ? "bg-fill-active text-text-hi"
                      : "text-text-lo hover:bg-fill-hover",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {/* §4.4 and rule 5: the feed has to say plainly that it is not
              end-to-end encrypted, and the place to say it is where people
              write. A sentence under the composer is read; a bordered warning
              box above it becomes furniture within a day. */}
            <p className="text-text-mid -mt-1 flex items-start gap-2 px-1 text-meta leading-relaxed">
              <Icon
                name="globe"
                size={14}
                className="text-text-lo mt-0.5 shrink-0"
              />
              Posts are public. Anyone signed in to Nexo can read them, and so
              can whoever runs the server. Your messages are end-to-end
              encrypted; the feed is not.
            </p>

            {live.loading ? (
              <div
                className="flex flex-col gap-3"
                aria-label="Loading the feed"
              >
                <PostSkeleton />
                <PostSkeleton />
              </div>
            ) : visible.length === 0 ? (
              query.trim() ? (
                <EmptyState
                  icon="search"
                  title="No matches"
                  body={`Nothing loaded so far matches "${query.trim()}".`}
                />
              ) : live.following ? (
                /* A different emptiness, and it needs a different sentence.
                   "Be the first to post" is wrong here — the feed is full, this
                   person just follows nobody who has written, and telling them
                   to post would answer a question they did not ask. */
                <EmptyState
                  icon="user"
                  title="Nothing from anyone you follow"
                  body="Open somebody's profile and follow them, or switch to Everyone."
                />
              ) : (
                /* §6.2: an empty state that invites the first post rather than
                 apologising for emptiness. */
                <EmptyState
                  icon="home"
                  title="Nothing here yet"
                  body="Be the first to post. Whatever you write here is public."
                />
              )
            ) : (
              <ul className="flex flex-col gap-3">
                {visible.map((post, index) => (
                  <li key={post.id}>
                    <PostCard
                      post={post}
                      now={now}
                      index={index}
                      onDelete={() =>
                        void (async () => {
                          // Asked, like every other destructive entry in the
                          // app. Deleting a post used to happen on the first
                          // click of a small icon sitting beside the vote
                          // arrows, with no way back -- while taking back a
                          // *message*, which reaches fewer people, has always
                          // asked first.
                          const ok = await confirm(
                            "Delete this post?",
                            "It goes from your profile and from everyone's feed, along with its comments and reactions. This cannot be undone.",
                          );
                          if (ok) await live.remove(post.id);
                        })()
                      }
                      onReact={(emoji) =>
                        void live.toggleReaction(post.id, emoji)
                      }
                      onVote={(value) => void live.castVote(post.id, value)}
                    />
                  </li>
                ))}
              </ul>
            )}

            {/* The sentinel. Skeletons while a page is on its way, and a plain
              end-of-feed line rather than an infinite spinner that never
              resolves — §6.2 wants infinite scroll, not an infinite wait. */}
            <div ref={sentinel} className="flex flex-col gap-3 pb-4">
              {live.loadingMore ? (
                <>
                  <PostSkeleton />
                  <PostSkeleton />
                </>
              ) : !live.hasMore && live.posts.length > 0 ? (
                <p className="text-text-lo py-2 text-center text-meta">
                  That's the whole feed.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </Panel>
      {showChat ? (
        <>
          <Splitter
            width={chatWidth}
            min={MIN_HOME_CHAT}
            minOther={MIN_HOME_FEED}
            onResize={(next) =>
              row.current?.style.setProperty("--home-chat-w", `${next}px`)
            }
            onCommit={(next) => setPreference("homeChatWidth", next)}
            label="Resize the conversation panel"
          />
          <HomeChat now={now} width="var(--home-chat-w)" />
        </>
      ) : null}
    </div>
  );
}

/** §6.2 caps a post at 2000 characters; a title is shorter by the same logic. */
const MAX_TITLE = 300;

/** The orders the feed offers, in the order they are offered. */
const FEED_SORTS: { sort: FeedSort; label: string }[] = [
  { sort: "new", label: "New" },
  { sort: "hot", label: "Hot" },
  { sort: "top", label: "Top" },
];

/**
 * One editor, not three.
 *
 * This used to open on a row of tabs -- Text, Link, Image -- that had to be
 * chosen before anything was written. They were a mode where a derivation
 * would do: whether a post is a link post is entirely answered by whether it
 * has a link in it. Choosing first meant deciding what you were going to write
 * before you wrote it, and then being stuck: a "text" post could hold a
 * picture, but adding one did not make it an image post, and an "image" post
 * refused to be given a link at all.
 *
 * Now there is one box. Write, attach up to four pictures, add a link if there
 * is one, and what kind of post that adds up to is worked out in `compose.ts`
 * against the rules the server enforces.
 */
function PostComposer({
  onPost,
}: {
  onPost: (input: NewPostInput) => Promise<void>;
}) {
  const me = useApp((s) => s.account);
  const myAvatarKey = useApp((s) => s.myAvatarKey);
  const [title, setTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  // Whether the link field is on screen. Not a mode: it is a field being
  // offered, and it stays offered while it has anything in it so a typed link
  // cannot be hidden by a stray click and silently posted.
  const [linking, setLinking] = useState(false);
  const [body, setBody] = useState("");
  const [images, setImages] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const remaining = MAX_POST - body.length;

  const draft = compose({ title, body, linkUrl, images: images.length });

  const addImage = async () => {
    // §6.2: up to four.
    if (images.length >= 4) return;
    const picked = await pickFile({ title: "Add an image", images: true });
    if (picked) setImages((current) => [...current, picked]);
  };

  const post = async () => {
    if (!draft.ready || busy) return;
    setBusy(true);
    try {
      // Uploaded first, so a post never references an object that failed to
      // arrive. The bytes go straight from here to the object store, signed —
      // they do not pass through `apps/server`.
      const keys: string[] = [];
      for (const image of images) {
        keys.push(await uploadImage(image));
      }
      await onPost({
        body: body.trim(),
        mediaKeys: keys,
        title: title.trim() || null,
        kind: draft.kind,
        linkUrl: draft.linkUrl,
      });
      setBody("");
      setTitle("");
      setLinkUrl("");
      setLinking(false);
      setImages([]);
    } catch (error) {
      await notify("Couldn't post that", asFeedError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-panel border border-line bg-fill p-3">
      <input
        value={title}
        maxLength={MAX_TITLE}
        onChange={(event) => setTitle(event.target.value)}
        aria-label="Title"
        placeholder="Title (optional)"
        className="text-text-hi placeholder:text-text-lo rounded-control mb-2 w-full bg-surface-3 px-3 py-2 text-body font-medium outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />

      {linking || linkUrl ? (
        <input
          value={linkUrl}
          onChange={(event) => setLinkUrl(event.target.value)}
          aria-label="Link"
          placeholder="https://example.com"
          spellCheck={false}
          autoFocus
          className="text-text-hi placeholder:text-text-lo rounded-control mb-2 w-full bg-surface-3 px-3 py-2 font-mono text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
      ) : null}

      <div className="flex gap-3">
        {myAvatarKey ? (
          <RemoteImage
            imageKey={myAvatarKey}
            alt=""
            className="h-[38px] w-[38px] shrink-0 rounded-full object-cover"
            fit="cover"
          />
        ) : (
          <Avatar
            seed={me?.handle ?? "you"}
            name={me?.display_name ?? "You"}
            size={38}
          />
        )}
        <textarea
          rows={3}
          value={body}
          maxLength={MAX_POST}
          onChange={(event) => setBody(event.target.value)}
          aria-label="Write a post"
          placeholder="Say something public"
          // Grows with the text instead of scrolling inside two lines, and can
          // be dragged taller. `field-sizing-content` does the growing where it
          // is supported; `max-h` keeps a very long post from pushing the Post
          // button off-screen, and `resize-y` is the manual escape hatch.
          className="text-text-hi placeholder:text-text-lo min-h-[72px] max-h-[420px] flex-1 resize-y overflow-y-auto bg-transparent py-1.5 text-message leading-6 outline-none [field-sizing:content]"
        />
      </div>
      {images.length > 0 ? (
        <ul className="ml-[50px] mt-2 flex flex-col gap-1.5">
          {images.map((image, index) => (
            <li key={image.url} className="flex items-center gap-2">
              <div
                className="size-14 shrink-0 rounded-control bg-cover bg-center ring-1 ring-line-strong"
                style={{ backgroundImage: `url(${image.url})` }}
              />
              <span className="text-text-mid min-w-0 flex-1 truncate text-meta">
                {image.name}
              </span>
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() =>
                  setImages((current) => current.filter((_, i) => i !== index))
                }
                className="text-text-lo hover:text-text-hi shrink-0"
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-3 pl-[50px]">
        <div className="flex items-center gap-0.5">
          <IconButton
            name="image"
            label={
              images.length >= 4 ? "Four images is the limit" : "Add an image"
            }
            size={17}
            active={images.length > 0}
            disabled={images.length >= 4}
            onClick={() => void addImage()}
          />
          <IconButton
            name="link"
            label={linking || linkUrl ? "Remove the link" : "Add a link"}
            size={17}
            active={!!linkUrl}
            onClick={() => {
              // Toggling it off clears the field. Leaving a typed link behind
              // a hidden field would post it without anybody seeing it.
              if (linking || linkUrl) {
                setLinkUrl("");
                setLinking(false);
              } else {
                setLinking(true);
              }
            }}
          />
        </div>
        <div className="flex items-center gap-3">
          {/* Said while it can still be fixed, rather than as a refusal after
              the fact. The server checks the same thing and has to; this is
              so somebody who typed example.com hears it now. */}
          {draft.problem ? (
            <span className="text-warning text-[11px]">{draft.problem}</span>
          ) : null}
          <span
            className={cn(
              "font-mono text-[11px]",
              remaining < 100 ? "text-warning" : "text-text-lo",
            )}
          >
            {remaining}
          </span>
          <Button
            variant="primary"
            disabled={busy || !draft.ready}
            onClick={() => void post()}
          >
            {busy ? "Posting\u2026" : "Post"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PostCard({
  post,
  now,
  index,
  onDelete,
  onReact,
  onVote,
}: {
  post: Post;
  now: Date;
  index: number;
  onDelete: () => void;
  onReact: (emoji: string) => void;
  onVote: (value: number) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [threadOpen, setThreadOpen] = useState(false);
  const viewProfile = useApp((s) => s.viewProfile);
  const pickerWrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerWrap.current?.contains(event.target as Node))
        setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pickerOpen]);

  return (
    <article
      className="rounded-panel rise-in border border-line bg-fill p-4"
      style={{ "--stagger": `${Math.min(index, 6) * 80}ms` } as CSSProperties}
    >
      <header className="flex items-center gap-3">
        {post.author_avatar_key ? (
          <RemoteImage
            imageKey={post.author_avatar_key}
            alt={post.author_display_name}
            className="size-[38px] shrink-0 rounded-full"
          />
        ) : (
          <Avatar
            seed={post.author_handle}
            name={post.author_display_name}
            size={38}
          />
        )}
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => viewProfile(post.author_handle)}
            className="flex min-w-0 items-baseline gap-2 text-left"
          >
            <span className="text-text-hi truncate text-body font-medium hover:underline">
              {post.author_display_name}
            </span>
            <span className="text-text-lo truncate text-meta">
              @{post.author_handle}
            </span>
          </button>
          <span className="text-text-lo text-[11px]">
            {relativeTime(new Date(post.created_at_ms), now)}
          </span>
        </div>
        {post.is_mine ? (
          <IconButton
            name="trash"
            label="Delete this post"
            size={16}
            onClick={onDelete}
          />
        ) : (
          <IconButton
            name="more"
            label="Post options"
            size={16}
            onClick={() =>
              void notify(
                "Post options",
                "Muting authors and reporting posts arrive with the feed milestone.",
              )
            }
          />
        )}
      </header>

      {post.title ? (
        <h2 className="text-text-hi mt-3 font-display text-[17px] leading-snug font-medium">
          {post.title}
        </h2>
      ) : null}

      {post.link_url ? (
        <a
          href={post.link_url}
          onClick={(event) => {
            // Never in the WebView: that replaces the app with the page and a
            // frameless window has no back button to return with.
            event.preventDefault();
            void openUrl(post.link_url!);
          }}
          className="rounded-panel bg-surface-3/70 mt-2 flex items-center gap-2 border border-line px-3 py-2"
        >
          <Icon
            name="external"
            size={14}
            className="text-accent-soft shrink-0"
          />
          <span className="text-accent-soft min-w-0 flex-1 truncate text-[11px] underline decoration-line-strong underline-offset-2">
            {post.link_url}
          </span>
        </a>
      ) : null}

      {post.body ? (
        <p className="text-text-hi mt-3 text-message leading-6 whitespace-pre-wrap">
          {post.body}
        </p>
      ) : null}

      {post.media_keys.length > 0 ? (
        <div
          className={cn(
            "mt-3 grid gap-1.5 overflow-hidden rounded-panel",
            post.media_keys.length === 1 ? "grid-cols-1" : "grid-cols-2",
          )}
        >
          {post.media_keys.slice(0, 4).map((key) => (
            <RemoteImage
              key={key}
              imageKey={key}
              alt="Attached image"
              // Fitted, not cropped. A 16/9 box with `cover` cut the top and
              // bottom off anything portrait, which throws away the part the
              // person framed. The box keeps its shape so the grid stays even;
              // the image sits inside it whole.
              fit="contain"
              className={cn(
                "bg-surface-3",
                post.media_keys.length === 1
                  ? "aspect-[16/9] max-h-[420px] w-full"
                  : "aspect-[4/3] max-h-[260px] w-full",
              )}
            />
          ))}
        </div>
      ) : null}

      <footer className="mt-3 flex items-center gap-1.5">
        <VoteControl score={post.score} myVote={post.my_vote} onVote={onVote} />
        {post.reactions.map((reaction) => {
          const mine = post.my_reactions.includes(reaction.emoji);
          return (
            <button
              key={reaction.emoji}
              type="button"
              aria-label={`${reaction.count} reacted ${reaction.emoji}`}
              aria-pressed={mine}
              onClick={() => onReact(reaction.emoji)}
              className={cn(
                "rounded-full px-2.5 py-1 text-meta transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
                mine
                  ? "bg-accent/18 text-accent-soft"
                  : "text-text-mid bg-fill-hover hover:bg-fill-active",
              )}
            >
              {/* User content, not chrome: the emoji is what someone chose to
                react with. Every icon in the interface itself is from the
                icon set. */}
              <span aria-hidden="true">{reaction.emoji}</span>{" "}
              <span className="font-mono text-[11px]">{reaction.count}</span>
            </button>
          );
        })}
        <div className="relative" ref={pickerWrap}>
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            aria-expanded={pickerOpen}
            className="text-text-mid rounded-full px-2.5 py-1 text-meta transition-colors duration-[var(--motion-fast)] hover:bg-fill-hover"
          >
            <span className="inline-flex items-center gap-1.5">
              <Icon name="plus" size={13} />
              React
            </span>
          </button>
          {pickerOpen ? (
            <div className="rounded-panel bg-surface-2 ring-line-strong absolute bottom-full left-0 z-[300] mb-2 overflow-hidden shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5)] ring-1">
              {/* Closed after one: a reaction is a single choice, unlike the
                  composer where two in a row is normal. */}
              <EmojiPicker
                onPick={(emoji) => {
                  onReact(emoji);
                  setPickerOpen(false);
                }}
              />
            </div>
          ) : null}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setThreadOpen((open) => !open)}
          aria-expanded={threadOpen}
          className="text-text-mid inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-meta transition-colors duration-[var(--motion-fast)] hover:bg-fill-hover"
        >
          <Icon name="comment" size={14} />
          {post.comment_count > 0 ? post.comment_count : "Reply"}
        </button>
      </footer>

      {/* Wrapped rather than animated in place: the thread pushes everything
          below it down, and appearing instantly reads as the page jumping. */}
      {threadOpen ? (
        <div className="expand-in">
          <CommentThread postId={post.id} now={now} />
        </div>
      ) : null}
    </article>
  );
}

/**
 * Up, down, or neither.
 *
 * Clicking the arrow you already chose takes the vote back rather than casting
 * it again — the same gesture in both directions, and the only way to reach
 * "no vote" without a third control nobody would look for.
 */
function VoteControl({
  score,
  myVote,
  onVote,
}: {
  score: number;
  myVote: number;
  onVote: (value: number) => void;
}) {
  return (
    <span className="rounded-full bg-fill-hover flex items-center gap-0.5 px-1 py-0.5">
      <button
        type="button"
        aria-label="Upvote"
        aria-pressed={myVote === 1}
        onClick={() => onVote(myVote === 1 ? 0 : 1)}
        className={cn(
          "rounded-full p-1 transition-colors duration-[var(--motion-fast)]",
          myVote === 1 ? "text-accent-soft" : "text-text-lo hover:text-text-hi",
        )}
      >
        <Icon name="chevronLeft" size={13} className="rotate-90" />
      </button>
      <span
        className={cn(
          "min-w-[1.5rem] text-center font-mono text-[11px]",
          myVote === 1
            ? "text-accent-soft"
            : myVote === -1
              ? "text-warning"
              : "text-text-mid",
        )}
      >
        {score}
      </span>
      <button
        type="button"
        aria-label="Downvote"
        aria-pressed={myVote === -1}
        onClick={() => onVote(myVote === -1 ? 0 : -1)}
        className={cn(
          "rounded-full p-1 transition-colors duration-[var(--motion-fast)]",
          myVote === -1 ? "text-warning" : "text-text-lo hover:text-text-hi",
        )}
      >
        <Icon name="chevronLeft" size={13} className="-rotate-90" />
      </button>
    </span>
  );
}

function PostSkeleton() {
  return (
    <div className="rounded-panel border border-line p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-2.5 w-20" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-[86%]" />
        <Skeleton className="h-3 w-[64%]" />
      </div>
    </div>
  );
}
