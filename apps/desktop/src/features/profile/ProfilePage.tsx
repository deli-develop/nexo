import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { useApp } from "../../app/store";
import { cn } from "../../lib/cn";
import { relativeTime, safetyNumber } from "../../lib/format";
import { copyText, notify, openUrl, pickFile } from "../../lib/native";
import { fieldFor, hashString } from "../../lib/palette";
import { useProfile } from "../../app/useProfile";
import {
  asFeedError,
  pinPost,
  unpinPost,
} from "../../lib/feed";
import { deviceFingerprint } from "../../lib/auth";
import { RemoteImage } from "../../components/ui/RemoteImage";
import { ImageCropper } from "../../components/ui/ImageCropper";
import type {
  MyProfile,
  Post,
  ProfileEdit,
  Visibility,
  VisibilityField,
} from "../../lib/feed";
import { VisibilityControls } from "./VisibilityControls";
import { Avatar } from "../../components/ui/Avatar";
import { Button, IconButton } from "../../components/ui/Button";
import { FactRow, Field, Tabs, TextArea } from "../../components/ui/Controls";
import { MyStories } from "./MyStories";
import { PrivacyPanel } from "./PrivacyPanel";
import { pickAndPostStory } from "../home/story";
import { hasLiveStory } from "../home/storyGroups";
import { useStories } from "../home/useStories";
import {
  Callout,
  EmptyState,
  Pill,
  Skeleton,
} from "../../components/ui/Feedback";
import { Icon } from "../../components/ui/Icon";
import { Panel, SectionHeader } from "../../components/ui/Surface";
import { useSignOut } from "../auth/useSignOut";
import { PrivacyTable } from "../settings/PrivacyTable";

type Tab = "posts" | "media" | "identity" | "stories" | "privacy";

export interface ProfileEdits {
  displayName: string;
  bio: string;
  location: string;
  link: string;
}

/**
 * Profile (§6.3).
 *
 * Banner at 3:1 with the avatar overlapping its lower-left, which is the same
 * arrangement as the sidebar profile card one size up. Editable fields are
 * display name, bio, location and links; handle, numeric ID and join date are
 * facts, not settings.
 *
 * The Security tab is on your own profile only, and it is where the §4.4 table
 * and the G2 visibility controls live — the two places the product has to be
 * straight about what the server can read.
 */
export function ProfilePage({ now }: { now: Date }) {
  const [tab, setTab] = useState<Tab>("posts");
  const [posting, setPosting] = useState(false);
  // Bumped after a story is posted from the avatar, and used as the strip's
  // `key`. The strip loads on mount and reading it is also what purges the
  // expired ones, so remounting it is both the refresh and the sweep -- and it
  // is the only way to reach a list that belongs to a component this one does
  // not otherwise talk to.
  const [storiesEpoch, setStoriesEpoch] = useState(0);
  const [editing, setEditing] = useState(false);
  const live = useProfile();
  const me = live.profile;
  // For the ring on the avatar below -- independent of the Stories tab's own
  // read, which remounts by `storiesEpoch` instead. Two reads of the same
  // local list are cheap; sharing one between a ring and a tab that gets
  // replaced by its own gallery next would be the wrong thing to couple.
  const { stories: myStories, refresh: refreshStories } = useStories();

  // What the cropper is currently working on. `null` when it is closed.
  const [cropping, setCropping] = useState<{
    which: "avatar" | "banner";
    src: string;
  } | null>(null);

  async function pickFor(which: "avatar" | "banner") {
    const picked = await pickFile({
      title: which === "avatar" ? "Change picture" : "Change banner",
      images: true,
    });
    if (!picked) return;
    // The picker already handed us an object URL for exactly these bytes, so
    // there is nothing to read back — the round trip this used to make was
    // the file being loaded a second time.
    setCropping({ which, src: picked.url });
  }

  const changeBanner = () => void pickFor("banner");
  const changePicture = () => void pickFor("avatar");

  /**
   * Posts a story from the plus on the picture.
   *
   * Success moves to the Stories tab rather than raising a toast. The story
   * itself is the confirmation, and it is more informative than a sentence
   * saying it worked -- you can see what went out, and take it back from
   * there. A failure does need saying, since nothing else would show it.
   */
  async function addStory() {
    setPosting(true);
    try {
      const result = await pickAndPostStory();
      if (result.posted) {
        setStoriesEpoch((n) => n + 1);
        void refreshStories();
        setTab("stories");
      } else if (result.problem) {
        await notify("Couldn't post that story", result.problem);
      }
    } finally {
      setPosting(false);
    }
  }

  if (live.loading || !me) {
    return (
      <Panel
        tone="content"
        edge={false}
        className="flex min-w-0 flex-1 flex-col"
      >
        <div className="mx-auto w-full max-w-[840px] px-6 pt-4">
          {live.problem ? (
            <Callout tone="warning" icon="alert">
              {live.problem}
            </Callout>
          ) : (
            <div
              className="flex flex-col gap-4"
              aria-label="Loading your profile"
            >
              <Skeleton className="rounded-panel aspect-[3/1] max-h-[240px] w-full" />
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-[70%]" />
            </div>
          )}
        </div>
      </Panel>
    );
  }

  return (
    <Panel tone="content" edge={false} className="flex min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[840px] px-6 pb-12">
          {live.problem ? (
            <Callout tone="warning" icon="alert" className="mt-4">
              {live.problem}
            </Callout>
          ) : null}

          <div className="relative mt-4">
            {me.banner_key ? (
              <RemoteImage
                imageKey={me.banner_key}
                alt={`${me.display_name}'s banner`}
                className="rounded-panel aspect-[3/1] max-h-[240px] w-full"
              />
            ) : (
              <div
                className="rounded-panel aspect-[3/1] max-h-[240px] w-full"
                style={{ background: fieldFor(me.handle + "-banner") }}
                role="img"
                aria-label={`${me.display_name}'s banner`}
              />
            )}
            <IconButton
              name="camera"
              label="Change banner"
              variant="secondary"
              className="absolute top-3 right-3"
              disabled={live.saving}
              onClick={() => void changeBanner()}
            />
            {/* §6.3: the avatar overlaps the lower-left of the banner, which
                is the sidebar profile card's arrangement one size up.

                It is also the control that changes it. The button that used to
                do that sat in the row underneath, far from the thing it
                acted on and giving no hint that the picture was changeable at
                all; the banner beside it had the better idea already. */}
            <div className="absolute -bottom-10 left-5">
            {/* A ring around the ring: the existing `ring-surface-2 ring-4`
                separates the picture from the banner behind it and stays
                exactly as it was. This one is a second, outer signal that
                says "there is a story here" -- `ring-offset` so it does not
                collide with the one underneath, same construction as the
                strip's circles. It does not change what a click here does:
                the picture is already the control that changes the picture,
                and the Stories tab (one tap away) is where an existing one is
                actually watched. */}
            <span
              className={cn(
                "block rounded-full",
                hasLiveStory(myStories ?? [], null) &&
                  "ring-accent ring-2 ring-offset-2 ring-offset-[var(--color-surface-1)]",
              )}
            >
            <button
              type="button"
              aria-label="Change picture"
              disabled={live.saving}
              onClick={() => void changePicture()}
              className="group ring-surface-2 focus-visible:ring-accent block rounded-full ring-4 outline-none"
            >
              {me.avatar_key ? (
                <RemoteImage
                  imageKey={me.avatar_key}
                  alt={me.display_name}
                  className="size-[88px] rounded-full"
                />
              ) : (
                <Avatar seed={me.handle} name={me.display_name} size={88} />
              )}
              {/* Answers to focus as well as to hover. A control that exists
                  only under a pointer does not exist for everyone. */}
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/55 opacity-0 transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-state)] group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:opacity-0">
                <Icon name="camera" size={22} className="text-white" />
              </span>
            </button>
            </span>

            {/* Adding to your story, on the picture, because that is where
                people look for it -- and a *sibling* of the button rather
                than inside it, since the picture is itself the control that
                changes it and a button inside a button is neither valid nor
                clickable.

                Small, and in the corner, so the two are not mistaken for each
                other: the whole circle changes the picture, this one badge
                posts a story. Both say which they are out loud, because a
                plus over a photograph could mean either. */}
            <button
              type="button"
              aria-label="Add to your story"
              title="Add to your story — your contacts can see it for 24 hours"
              disabled={live.saving || posting}
              onClick={() => void addStory()}
              className="bg-accent text-on-accent ring-surface-2 absolute right-0 bottom-0 flex size-7 items-center justify-center rounded-full ring-4 transition-transform duration-[var(--motion-fast)] ease-[var(--ease-state)] enabled:hover:scale-110 disabled:cursor-not-allowed disabled:bg-fill-disabled disabled:text-text-disabled"
            >
              <Icon name="plus" size={15} />
            </button>
            </div>
          </div>

          <div className="flex items-start justify-end gap-2 pt-3">
            <Button
              variant={editing ? "secondary" : "primary"}
              icon={editing ? "close" : "pencil"}
              onClick={() => setEditing((value) => !value)}
            >
              {editing ? "Cancel" : "Edit profile"}
            </Button>
          </div>

          {editing ? (
            <EditProfile
              profile={me}
              saving={live.saving}
              onSave={async (edit) => {
                if (await live.save(edit)) setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div className="mt-4">
              <h1 className="font-display text-text-hi text-[26px] leading-tight font-semibold tracking-[-0.02em]">
                {me.display_name}
              </h1>
              <p className="text-text-mid text-body">@{me.handle}</p>
              {me.bio ? (
                <p className="text-text-hi mt-3 max-w-[62ch] text-body leading-relaxed">
                  {me.bio}
                </p>
              ) : null}

              <div className="text-text-mid mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-meta">
                {me.location ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="location" size={14} className="text-text-lo" />
                    {me.location}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="hash" size={14} className="text-text-lo" />
                  <span className="font-mono">{me.user_id}</span>
                </span>
                {me.join_date_ms !== null ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="calendar" size={14} className="text-text-lo" />
                    Joined{" "}
                    {new Date(me.join_date_ms).toLocaleDateString(undefined, {
                      month: "long",
                      year: "numeric",
                    })}
                  </span>
                ) : null}
                {(me.links ?? []).map((link) => (
                  <button
                    key={link.url}
                    type="button"
                    /* Opened in the system browser, never in the WebView --
                       a page loaded here would share an origin with the IPC
                       bridge. */
                    onClick={() => void openUrl(link.url)}
                    className="text-accent-soft inline-flex items-center gap-1.5"
                  >
                    <Icon name="link" size={14} />
                    {link.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 border-b border-[var(--hairline)]">
            <Tabs
              tabs={[
                { id: "posts", label: "Posts", icon: "home" },
                { id: "media", label: "Media", icon: "image" },
                { id: "identity", label: "Identity", icon: "key" },
                { id: "stories", label: "Stories", icon: "image" },
                { id: "privacy", label: "Privacy", icon: "shield" },
              ]}
              active={tab}
              onChange={setTab}
            />
          </div>

          <div className="py-5">
            {tab === "posts" ? (
              <PostsTab
                now={now}
                posts={live.posts}
                onChanged={() => void live.refresh()}
              />
            ) : null}
            {tab === "media" ? <MediaTab posts={live.posts} /> : null}
            {tab === "identity" ? (
              <IdentityTab
                profile={me}
                onVisibilityChange={(field, value) =>
                  void live.setVisibility(field, value)
                }
              />
            ) : null}
            {tab === "stories" ? (
              <section className="flex flex-col gap-3">
                <div>
                  <h2 className="text-text-hi font-display text-[17px] font-medium">
                    Your stories
                  </h2>
                  {/* The honest description, before anything is posted rather
                      than after. Contacts is not a follower list: it is
                      whoever you already share a conversation with. */}
                  <p className="text-text-lo mt-1 text-meta">
                    A story goes to everyone you already have a conversation
                    with, and disappears after 24 hours — from the server, and
                    from their app. Someone who has already seen it can still
                    have kept it. Pictures and video.
                  </p>
                </div>
                {/* Remounted after a post rather than merely refreshed: the
                    tab's own read, its tiles and their in-flight fetches are
                    all keyed to the list it opened with, and starting them
                    over is both simpler and what somebody who just posted
                    expects to see. */}
                <MyStories
                  key={storiesEpoch}
                  onPost={() => void addStory()}
                  posting={posting}
                />
              </section>
            ) : null}
            {tab === "privacy" ? (
              <PrivacyPanel
                isPrivate={me.is_private}
                onChanged={() => void live.refresh()}
              />
            ) : null}
          </div>
        </div>
      </div>
      {cropping ? (
        <ImageCropper
          src={cropping.src}
          // A 3:1 banner and a square avatar, matching where each is drawn.
          aspect={cropping.which === "banner" ? 3 : 1}
          round={cropping.which === "avatar"}
          title={
            cropping.which === "banner"
              ? "Position your banner"
              : "Position your picture"
          }
          onCancel={() => setCropping(null)}
          onDone={async (dataUrl) => {
            const which = cropping.which;
            setCropping(null);
            await live.setImage(which, dataUrl);
          }}
        />
      ) : null}
    </Panel>
  );
}

/**
 * §6.3: display name, bio, location and links are editable; handle, numeric ID
 * and join date are not — they are facts about the account, and a control that
 * looks editable but is not would be a lie.
 *
 * The link field takes a whole URL rather than a bare host. `example.com` had
 * to be prefixed with `https://` somewhere, and doing that silently is how a
 * user ends up with a link they did not write; the server refuses anything that
 * is not http(s), so asking for the scheme is asking for what will actually be
 * stored.
 */
function EditProfile({
  profile,
  saving,
  onSave,
  onCancel,
}: {
  profile: MyProfile;
  saving: boolean;
  onSave: (edit: ProfileEdit) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState({
    displayName: profile.display_name,
    bio: profile.bio ?? "",
    location: profile.location ?? "",
    linkLabel: profile.links?.[0]?.label ?? "",
    linkUrl: profile.links?.[0]?.url ?? "",
  });

  const url = draft.linkUrl.trim();
  const linkProblem =
    url && !/^https?:\/\//i.test(url)
      ? "Start the link with http:// or https://."
      : url && !draft.linkLabel.trim()
        ? "Give the link a label."
        : null;

  return (
    <div className="rounded-panel mt-4 border border-line bg-fill p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Display name"
          value={draft.displayName}
          maxLength={40}
          onChange={(event) =>
            setDraft((d) => ({ ...d, displayName: event.target.value }))
          }
        />
        <Field
          label="Location"
          value={draft.location}
          icon="location"
          maxLength={60}
          hint="Free text. Nexo never asks the operating system where you are."
          onChange={(event) =>
            setDraft((d) => ({ ...d, location: event.target.value }))
          }
        />
      </div>
      <div className="mt-4">
        <TextArea
          label="Bio"
          value={draft.bio}
          rows={3}
          maxLength={280}
          hint="Up to 280 characters. Who can see it is set on the Security tab."
          onChange={(event) =>
            setDraft((d) => ({ ...d, bio: event.target.value }))
          }
        />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_2fr]">
        <Field
          label="Link label"
          value={draft.linkLabel}
          maxLength={40}
          onChange={(event) =>
            setDraft((d) => ({ ...d, linkLabel: event.target.value }))
          }
        />
        <Field
          label="Link"
          value={draft.linkUrl}
          icon="link"
          placeholder="https://example.com"
          {...(linkProblem ? { error: linkProblem } : {})}
          onChange={(event) =>
            setDraft((d) => ({ ...d, linkUrl: event.target.value }))
          }
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div className="text-text-mid flex-1 text-meta">
          <FactRow icon="user" label="Handle">
            <span className="font-mono">@{profile.handle}</span>
          </FactRow>
          <FactRow icon="hash" label="Nexo ID">
            <span className="font-mono">{profile.user_id}</span>
          </FactRow>
        </div>
        <div className="flex gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={
              saving ||
              draft.displayName.trim().length === 0 ||
              linkProblem !== null
            }
            onClick={() =>
              onSave({
                display_name: draft.displayName.trim(),
                bio: draft.bio,
                location: draft.location,
                // An empty URL clears the list, which is how a link is
                // removed -- there is no separate delete for something with
                // one slot.
                links: url ? [{ label: draft.linkLabel.trim(), url }] : [],
              })
            }
          >
            {saving ? "Saving\u2026" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PostsTab({
  now,
  posts,
  onChanged,
}: {
  now: Date;
  posts: Post[];
  onChanged: () => void;
}) {
  const go = useApp((s) => s.go);

  async function togglePin(post: Post) {
    try {
      if (post.pinned) await unpinPost(post.id);
      else await pinPost(post.id);
      onChanged();
    } catch (error) {
      // The server owns the cap of three, so this is where "unpin one first"
      // arrives. Said plainly rather than swallowed.
      await notify("Couldn't change that pin", asFeedError(error).message);
    }
  }

  if (posts.length === 0) {
    return (
      <EmptyState
        icon="home"
        title="Nothing posted yet"
        body="Your posts show up here and in everyone's feed. They are public and not end-to-end encrypted."
        action={
          <Button variant="primary" onClick={() => go("home")}>
            Write your first post
          </Button>
        }
      />
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {posts.map((post) => (
        <li
          key={post.id}
          className="rounded-panel border border-line bg-fill p-4"
        >
          <div className="flex items-start gap-3">
            {/* A post is not only its body.
                This used to render `post.body` and nothing else, so a link
                post -- which carries a title and a URL and no body at all --
                drew a completely blank card, an image post drew an empty one
                with the pictures only visible under Media, and every title
                anywhere was dropped. The feed had always shown all of it; only
                the profile threw it away. */}
            <div className="flex-1 space-y-1.5">
              {post.title ? (
                <p className="text-text-hi font-display text-[15px] font-medium">
                  {post.title}
                </p>
              ) : null}
              {post.body ? (
                <p className="text-text-hi text-body leading-relaxed whitespace-pre-wrap">
                  {post.body}
                </p>
              ) : null}
              {post.link_url ? (
                <button
                  type="button"
                  onClick={() => void openUrl(post.link_url as string)}
                  className="text-accent-soft inline-flex max-w-full items-center gap-1.5 text-meta hover:opacity-80"
                >
                  <Icon name="link" size={12} />
                  <span className="truncate">{post.link_url}</span>
                </button>
              ) : null}
              {post.media_keys.length > 0 ? (
                <p className="text-text-lo inline-flex items-center gap-1.5 text-meta">
                  <Icon name="image" size={12} />
                  {post.media_keys.length === 1
                    ? "1 picture"
                    : `${post.media_keys.length} pictures`}
                </p>
              ) : null}
            </div>
            <IconButton
              name="pin"
              label={
                post.pinned
                  ? "Unpin from your profile"
                  : "Pin to the top of your profile"
              }
              size={16}
              active={post.pinned ?? false}
              onClick={() => void togglePin(post)}
            />
          </div>
          <p className="text-text-lo mt-2 flex items-center gap-1.5 text-[11px]">
            {post.pinned ? (
              <span className="text-accent-soft inline-flex items-center gap-1">
                <Icon name="pin" size={11} />
                Pinned
              </span>
            ) : null}
            {relativeTime(new Date(post.created_at_ms), now)}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Pinning, from the profile that owns the post.
 *
 * The cap of three lives on the server, so the failure arrives as a refusal
 * rather than as a disabled button. That is deliberate: a limit enforced only
 * in the UI is a limit a second client does not have, and the message the
 * server sends back says exactly what to do about it.
 */
function MediaTab({ posts }: { posts: Post[] }) {
  const media = posts.flatMap((post) => post.media_keys);
  if (media.length === 0) {
    return (
      <EmptyState
        icon="image"
        title="No media yet"
        body="Images you add to a post collect here."
      />
    );
  }
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {media.map((key) => (
        <RemoteImage
          key={key}
          imageKey={key}
          alt="Post image"
          className="aspect-square w-full rounded-panel"
        />
      ))}
    </div>
  );
}

/**
 * Identity: how other people see and verify you.
 *
 * Two things live here, and they are the same kind of thing: which profile
 * fields each audience may read (G2), and the fingerprint someone compares
 * with you to know they are talking to you and not to whoever is relaying
 * the messages.
 *
 * The unlock PIN used to be here too and is now in Settings → Security,
 * beside the password and the auto-lock timer. That is the dividing line
 * this tab is named for: the profile is identity as others encounter it,
 * Settings is access to this machine. The PIN only ever appears after
 * auto-lock fires, so it belonged next to the timer that fires it.
 */
function IdentityTab({
  profile,
  onVisibilityChange,
}: {
  profile: MyProfile;
  onVisibilityChange: (field: VisibilityField, value: Visibility) => void;
}) {
  // The real thing, from this device's identity keypair (`deviceFingerprint`
  // in `lib/auth.ts`). Only the public half is read, and `null` means there
  // is no key yet rather than a value worth showing.
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void deviceFingerprint()
      .then((value) => {
        if (!cancelled) setFingerprint(value);
      })
      .catch(() => {
        // Left as "no key": this screen may not guess at a fingerprint.
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = fingerprint ? safetyNumber(fingerprint) : [];

  return (
    <div className="flex flex-col gap-8">
      <VisibilityControls profile={profile} onChange={onVisibilityChange} />

      <section className="flex flex-col gap-3">
        <SectionHeader>This device</SectionHeader>
        <p className="text-text-mid max-w-[70ch] text-body leading-relaxed">
          Your identity key never leaves this machine. The digits below are
          derived from its public half — compare them with someone in person or
          over a channel you already trust, and you know you are talking to them
          and not to whoever is carrying the message.
        </p>

        {!checked ? (
          <Skeleton className="h-[120px] w-full max-w-[520px]" />
        ) : !fingerprint ? (
          <Callout icon="info">
            This device has no identity key yet. One is generated when you
            register, and its fingerprint appears here then.
          </Callout>
        ) : (
          <div className="flex flex-wrap items-start gap-5">
            <FingerprintPattern seed={fingerprint} />
            <div className="min-w-[280px] flex-1">
              <div className="rounded-panel border border-line bg-fill p-4">
                <div className="text-text-hi grid grid-cols-3 gap-x-6 gap-y-2 font-mono text-[15px] tracking-[0.08em]">
                  {groups.map((group, index) => (
                    <span key={`${group}-${index}`}>{group}</span>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  icon="refresh"
                  onClick={() =>
                    void notify(
                      "Compare with someone",
                      "Read the digits above aloud, or over a channel you already trust, and have them read theirs back. They should see the same twelve groups against your name.",
                    )
                  }
                >
                  Compare with someone
                </Button>
                <Button
                  icon="key"
                  onClick={async () => {
                    await copyText(groups.join(" "));
                    await notify(
                      "Fingerprint copied",
                      "This device's fingerprint is on your clipboard.",
                    );
                  }}
                >
                  Copy fingerprint
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader>Sessions</SectionHeader>
        <Callout icon="info">
          One device per account in v0.1. Signing in somewhere else signs this
          machine out, and the local message store is wiped when it happens.
        </Callout>
        {/* One device per account in v0.1, as the callout says, and there is no
            session list to read from. A second row here was invented data
            contradicting the sentence directly above it. */}
        <div className="rounded-panel divide-y divide-[var(--hairline)] border border-line">
          <SessionRow
            name="This device"
            detail="Signed in now"
            when="Active now"
            current
          />
        </div>
        <div>
          <SignOutRow />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader>What is encrypted</SectionHeader>
        <PrivacyTable />
      </section>
    </div>
  );
}

function SessionRow({
  name,
  detail,
  when,
  current = false,
}: {
  name: string;
  detail: string;
  when: string;
  current?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="text-text-mid flex size-9 items-center justify-center rounded-control bg-fill-hover">
        <Icon name="database" size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-text-hi text-body font-medium">{name}</span>
          {current ? <Pill tone="success">Current</Pill> : null}
        </div>
        <span className="text-text-mid text-meta">{detail}</span>
      </div>
      <span className="text-text-lo text-meta">{when}</span>
    </div>
  );
}

/**
 * A visual for the safety number.
 *
 * Deliberately not a QR code. §4.1 wants a scannable code beside the digits,
 * and that code has to encode a real identity key — which does not exist until
 * M2 generates one. Drawing a decorative square grid and calling it a QR code
 * would invite someone to try to scan it. This is a pattern derived from the
 * same digits: it changes completely if the key changes, which makes a
 * mismatch obvious at a glance, and it is labelled as what it is.
 */
function FingerprintPattern({ seed }: { seed: string }) {
  const cells = Array.from({ length: 64 }, (_, index) => {
    const digit = seed.charCodeAt(index % seed.length) - 48;
    const noise = hashString(`${seed}:${index}`) % 5;
    return (digit + noise) % 3 === 0;
  });

  return (
    <figure className="flex w-[168px] flex-col gap-2">
      <div
        className="rounded-panel grid grid-cols-8 gap-1 border border-line bg-fill p-3"
        aria-hidden="true"
      >
        {cells.map((filled, index) => (
          <span
            key={index}
            className={cn(
              "aspect-square rounded-[3px]",
              filled ? "bg-accent-soft" : "bg-fill-hover",
            )}
            style={{ "--stagger": `${index * 4}ms` } as CSSProperties}
          />
        ))}
      </div>
      <figcaption className="text-text-lo text-[11px] leading-relaxed">
        Derived from the same digits. A scannable code arrives with the real
        identity key.
      </figcaption>
    </figure>
  );
}

/**
 * Sign out, as a labelled button.
 *
 * The same action as the rail's icon and now the same code: the two had
 * drifted, and only one of them guarded against a second click while the
 * confirmation was open. See `useSignOut`.
 */
function SignOutRow() {
  const { signOut, busy } = useSignOut();
  return (
    <Button
      variant="danger"
      icon="logout"
      disabled={busy}
      onClick={() => void signOut()}
    >
      Sign out
    </Button>
  );
}
