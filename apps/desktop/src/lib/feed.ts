import { feed as core } from "@nexo/core";

import { runtime } from "./runtime";

/**
 * The Home feed and profiles, as the WebView sees them.
 *
 * **None of this is end-to-end encrypted**, and that is not a caveat buried in
 * a type file — §4.4 requires the product to say it in plain language where
 * someone is about to post, which `HomePage` does under the composer. It is
 * repeated here because this is the module a future change would touch while
 * assuming the rest of the app's guarantees carry over. They do not: the server
 * can read every post, every profile field, and every feed image.
 *
 * Pictures travel as object keys. Uploading hands bytes to `uploadImage` and
 * gets a key back; drawing turns a key into a `blob:` URL (`lib/images.ts`),
 * with the type read from the bytes rather than from the bucket.
 */

export interface Post {
  id: number;
  author_id: number;
  author_handle: string;
  author_display_name: string;
  author_avatar_key: string | null;
  body: string;
  /** Object keys, not URLs. Each is fetched on demand through `lib/images.ts`. */
  media_keys: string[];
  created_at_ms: number;
  reactions: ReactionCount[];
  /** Emoji this account has used, so the UI can draw them pressed. */
  my_reactions: string[];
  is_mine: boolean;
  /** The headline, when there is one. Posts written before titles have none. */
  title: string | null;
  kind: PostKind;
  /** Where a link post points. `null` for the other kinds. */
  link_url: string | null;
  /** Upvotes minus downvotes. */
  score: number;
  /** This account's own vote: 1, -1, or 0. */
  my_vote: number;
  comment_count: number;
  /** Pinned to the top of its author's profile. Only set on a profile page. */
  pinned?: boolean;
}

export type PostKind = "text" | "link" | "image";

/** How a feed page is ordered. */
export type FeedSort = "new" | "top" | "hot";

/**
 * One comment, flat.
 *
 * The tree is rebuilt from `parent_id` where it is drawn, rather than arriving
 * nested: a flat list keeps the response shape independent of depth, and the
 * whole thread comes in one round trip either way.
 */
export interface Comment {
  id: number;
  post_id: number;
  /** `null` at the top level. */
  parent_id: number | null;
  author_id: number;
  author_handle: string;
  author_display_name: string;
  author_avatar_key: string | null;
  /** Empty when deleted. */
  body: string;
  created_at_ms: number;
  is_mine: boolean;
  /** Deleted comments keep their place so their replies keep theirs. */
  deleted: boolean;
}

export interface VoteResult {
  score: number;
  my_vote: number;
}

export interface ReactionCount {
  emoji: string;
  count: number;
}

export interface FeedPage {
  posts: Post[];
  /** Pass back as `before`. `null` means the end of the feed. */
  next_cursor: number | null;
}

export interface ProfileLink {
  label: string;
  /** Always http(s) — refused at three layers, and opened in the system
   * browser rather than the WebView. */
  url: string;
}

/**
 * Someone's profile, as far as this viewer may see it.
 *
 * A field that is `null` is **hidden**, not empty. The UI must say "not
 * shared" rather than drawing a blank line that reads as "they wrote nothing" —
 * the two are different facts and conflating them misrepresents a privacy
 * setting as an empty one.
 */
export interface Profile {
  user_id: number;
  handle: string;
  display_name: string;
  avatar_key: string | null;
  banner_key: string | null;
  bio: string | null;
  location: string | null;
  links: ProfileLink[] | null;
  join_date_ms: number | null;
  is_me: boolean;
}

/** Who may see one field (G2). */
export type Visibility = "public" | "contacts" | "private";

/** A settable field. Handle and display name are absent: they are how you are
 * addressed, so a control for them would be one that cannot be honoured. */
export type VisibilityField = "bio" | "location" | "links" | "join_date";

export interface MyProfile extends Profile {
  /** Every settable field, with the value actually in force. */
  visibility: Record<VisibilityField, Visibility>;
  /**
   * Whether this account is private. Only the owner is told.
   *
   * Private means absent from search *and* unreachable without an invitation,
   * both enforced by the server.
   */
  is_private: boolean;
}

export interface ProfileEdit {
  /**
   * Whether the account is private.
   *
   * Two enforced things, not one cosmetic one: absent from search, and
   * unreachable without an invitation. Both are checked on the server.
   */
  is_private?: boolean;
  display_name?: string;
  bio?: string;
  location?: string;
  links?: ProfileLink[];
  avatar_key?: string;
  banner_key?: string;
}

export interface FeedError {
  kind:
    | "unreachable"
    | "signed_out"
    | "rejected"
    | "invalid_request"
    | "unreadable_file"
    | "too_large"
    | "internal";
  message: string;
}

/** Narrows an unknown rejection to something renderable. */
export function asFeedError(error: unknown): FeedError {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    "message" in error
  ) {
    return error as FeedError;
  }
  return { kind: "internal", message: "Something went wrong. Try again." };
}

/**
 * A page of the feed.
 *
 * `before` is a post id under `new` and a row offset under `top` and `hot` —
 * those orders are not monotonic in id, so an id cannot express a page
 * boundary in them. Pass back whatever `next_cursor` gave you.
 */
export function feed(
  before?: number,
  sort: FeedSort = "new",
  following = false,
): Promise<FeedPage> {
  return runtime().then((it) => {
    const options: { before?: number; sort: FeedSort } = { sort };
    if (before !== undefined) options.before = before;
    // `following` narrows the feed to people you follow. The server reads it
    // from the same query, so it belongs in the same place as `sort` rather
    // than as a second call.
    return core.feed(it.transport, following ? { ...options, sort } : options);
  });
}

export interface FollowState {
  following: boolean;
  followers: number;
}

export function setFollowing(handle: string, follow: boolean): Promise<void> {
  return runtime().then((it) => core.setFollowing(it.transport, handle, follow));
}

export function followState(handle: string): Promise<FollowState> {
  return runtime().then((it) => core.followState(it.transport, handle));
}

export function postsBy(handle: string, before?: number): Promise<FeedPage> {
  return runtime().then((it) => core.postsBy(it.transport, handle, before));
}

export function createPost(input: {
  body: string;
  mediaKeys?: string[];
  title?: string | null;
  kind?: PostKind;
  linkUrl?: string | null;
}): Promise<Post> {
  return runtime().then((it) =>
    core.createPost(it.transport, {
      body: input.body,
      media_keys: input.mediaKeys ?? [],
      kind: input.kind ?? "text",
      // Absent rather than null: the server defaults them, and sending an
      // explicit null is how a field that was never set becomes one that was
      // deliberately cleared.
      ...(input.title ? { title: input.title } : {}),
      ...(input.linkUrl ? { link_url: input.linkUrl } : {}),
    }),
  );
}

export function pinPost(id: number): Promise<void> {
  return runtime().then((it) => core.pinPost(it.transport, id));
}

export function unpinPost(id: number): Promise<void> {
  return runtime().then((it) => core.unpinPost(it.transport, id));
}

export function deletePost(id: number): Promise<void> {
  return runtime().then((it) => core.deletePost(it.transport, id));
}

export function react(id: number, emoji: string, on: boolean): Promise<ReactionCount[]> {
  return runtime().then((it) => core.react(it.transport, id, emoji, on));
}

export function vote(id: number, value: number): Promise<VoteResult> {
  return runtime().then((it) => core.vote(it.transport, id, value));
}

export function comments(postId: number): Promise<Comment[]> {
  return runtime().then((it) => core.comments(it.transport, postId));
}

export function addComment(
  postId: number,
  body: string,
  parentId?: number | null,
): Promise<Comment> {
  return runtime().then((it) =>
    core.addComment(it.transport, postId, body, parentId ?? undefined),
  );
}

export function deleteComment(id: number): Promise<void> {
  return runtime().then((it) => core.deleteComment(it.transport, id));
}

export function profile(handle: string): Promise<Profile> {
  return runtime().then((it) => core.profile(it.transport, handle));
}

export function myProfile(): Promise<MyProfile> {
  return runtime().then((it) => core.myProfile(it.transport));
}

export function updateProfile(edit: ProfileEdit): Promise<MyProfile> {
  return runtime().then((it) => core.updateProfile(it.transport, edit));
}

export function updateVisibility(
  visibility: Partial<Record<VisibilityField, Visibility>>,
): Promise<MyProfile> {
  return runtime().then((it) => core.updateVisibility(it.transport, visibility));
}

/**
 * Uploads a picture for a post, an avatar or a banner, and returns its key.
 *
 * Bytes rather than a path, like everything else that used to go through a
 * native dialog: the page is handed a file and that is all it will ever have.
 */
export function uploadImage(file: { bytes: Uint8Array; mime: string }): Promise<string> {
  return runtime().then((it) => core.uploadBytes(it.transport, file.bytes, file.mime));
}

/**
 * Uploads what a cropper produced.
 *
 * A canvas hands back a data URL, so this is the one place that decodes one.
 * Doing it at the call site would mean every screen with a cropper grew its
 * own base64 loop, and they would not stay the same.
 */
export function uploadImageDataUrl(dataUrl: string): Promise<string> {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? "image/png";
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return uploadImage({ bytes, mime });
}

/**
 * One picture from the bucket, as a `blob:` URL the page may draw.
 *
 * Not the presigned URL itself: `img-src` names no remote host, so the bytes
 * come through `connect-src` and are drawn locally. Presigned per read rather
 * than public all the same — this bucket holds people's pictures, and a URL
 * that works for ever works for ever for everybody who ever saw it.
 *
 * The URL holds the bytes until it is revoked. Draw through `lib/images.ts`,
 * which shares one per key and revokes it, rather than calling this directly.
 */
export async function imageObjectUrl(key: string): Promise<string> {
  const it = await runtime();
  const { bytes, mime } = await core.downloadImage(it.transport, key);
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
}
