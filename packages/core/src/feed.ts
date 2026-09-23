import { TransportError } from "./errors";
import type { Transport } from "./transport";

/**
 * The Home feed, profiles and follows.
 *
 * The one part of this product the server can read, and deliberately so: a
 * public post is public. `docs/BRIEF.md` §4.4 draws that line — conversations
 * are opaque to the server and the feed is not — and everything in this file
 * sits on the readable side of it. Nothing here touches MLS, which is why it
 * needs no `Context`, no device and no store: it is the transport and a set
 * of shapes.
 *
 * The shapes mirror `apps/server/src/posts.rs` and `profiles.rs`, which stay
 * the authority. Field names are the JSON names — snake_case, uncamelised —
 * for the same reason `types.ts` gives: one translation at the edge of the app
 * is easier to audit than a rename spread through every call site.
 */

export type PostKind = "text" | "link" | "image";

/** How a feed page is ordered. */
export type FeedSort = "new" | "top" | "hot";

export interface ReactionCount {
  emoji: string;
  count: number;
}

export interface Post {
  id: number;
  author_id: number;
  author_handle: string;
  author_display_name: string;
  author_avatar_key: string | null;
  body: string;
  /** Object keys, not URLs. Each is presigned on demand by [`imageUrl`]. */
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

/**
 * One comment, flat.
 *
 * The tree is rebuilt from `parent_id` where it is drawn rather than arriving
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

export interface FeedPage {
  posts: Post[];
  /** Pass back as `before`. `null` means the end of the feed. */
  next_cursor: number | null;
}

export interface ProfileLink {
  label: string;
  /** Always http(s), refused at three layers, opened outside the app. */
  url: string;
}

/**
 * Someone's profile, as far as this viewer may see it.
 *
 * A field that is `null` is **hidden**, not empty. The UI must say "not
 * shared" rather than drawing a blank line that reads as "they wrote nothing":
 * those are different facts, and conflating them shows a privacy setting as an
 * absence.
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

/** Who may see one field. */
export type Visibility = "public" | "contacts" | "private";

/**
 * A settable field.
 *
 * Handle and display name are absent on purpose: they are how you are
 * addressed, so a control for hiding them would be one that cannot be
 * honoured.
 */
export type VisibilityField = "bio" | "location" | "links" | "join_date";

export interface MyProfile extends Profile {
  /** Every settable field, with the value actually in force. */
  visibility: Record<VisibilityField, Visibility>;
  /** Whether this account is private. Only the owner is told. */
  is_private: boolean;
}

export interface ProfileEdit {
  display_name?: string;
  bio?: string;
  location?: string;
  links?: ProfileLink[];
  avatar_key?: string;
  banner_key?: string;
}

export interface FollowState {
  following: boolean;
  followers: number;
}

// --------------------------------------------------------------------- feed

/**
 * One page of the feed.
 *
 * `before` means different things under different orders, and the server says
 * so rather than this file guessing: under `new` it is a post id, because that
 * feed is strictly reverse-chronological; under `top` and `hot` it is how many
 * rows the caller has already seen, because those orders are not monotonic in
 * id and an id cannot express a page boundary in them. Either way it is
 * whatever the last `next_cursor` was.
 */
export function feed(
  transport: Transport,
  options: { before?: number; limit?: number; sort?: FeedSort } = {},
): Promise<FeedPage> {
  const query = new URLSearchParams();
  if (options.before !== undefined) query.set("before", String(options.before));
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.sort !== undefined) query.set("sort", options.sort);
  const suffix = query.size > 0 ? `?${query}` : "";
  return transport.getAuth<FeedPage>(`/v1/feed${suffix}`);
}

export function postsBy(
  transport: Transport,
  handle: string,
  before?: number,
): Promise<FeedPage> {
  const suffix = before === undefined ? "" : `?before=${before}`;
  return transport.getAuth<FeedPage>(`/v1/users/${encodeURIComponent(handle)}/posts${suffix}`);
}

export function createPost(
  transport: Transport,
  input: {
    body: string;
    media_keys?: string[];
    title?: string;
    kind?: PostKind;
    link_url?: string;
  },
): Promise<Post> {
  return transport.postAuth<Post>("/v1/posts", input);
}

export function deletePost(transport: Transport, id: number): Promise<void> {
  return transport.deleteAuth(`/v1/posts/${id}`);
}

export function pinPost(transport: Transport, id: number): Promise<void> {
  return transport.postAuth<void>(`/v1/posts/${id}/pin`, {});
}

export function unpinPost(transport: Transport, id: number): Promise<void> {
  return transport.deleteAuth(`/v1/posts/${id}/pin`);
}

/** Reacts, or takes it back. Answers with the counts after the change. */
export function react(
  transport: Transport,
  id: number,
  emoji: string,
  on: boolean,
): Promise<ReactionCount[]> {
  return transport.postAuth<ReactionCount[]>(`/v1/posts/${id}/react`, { emoji, on });
}

/**
 * Votes, where `1`, `-1` and `0` are up, down and neither.
 *
 * Sending the value rather than toggling: pressing up on a post already upvoted
 * is a different act from pressing it on a fresh one, and only the caller knows
 * which one the person meant.
 */
export function vote(transport: Transport, id: number, value: number): Promise<VoteResult> {
  return transport.postAuth<VoteResult>(`/v1/posts/${id}/vote`, { value });
}

export function comments(transport: Transport, postId: number): Promise<Comment[]> {
  return transport.getAuth<Comment[]>(`/v1/posts/${postId}/comments`);
}

export function addComment(
  transport: Transport,
  postId: number,
  body: string,
  parentId?: number,
): Promise<Comment> {
  return transport.postAuth<Comment>(`/v1/posts/${postId}/comments`, {
    body,
    parent_id: parentId ?? null,
  });
}

export function deleteComment(transport: Transport, id: number): Promise<void> {
  return transport.deleteAuth(`/v1/comments/${id}`);
}

// ----------------------------------------------------------------- profiles

export function profile(transport: Transport, handle: string): Promise<Profile> {
  return transport.getAuth<Profile>(`/v1/users/${encodeURIComponent(handle)}`);
}

export function myProfile(transport: Transport): Promise<MyProfile> {
  return transport.getAuth<MyProfile>("/v1/me");
}

export function updateProfile(transport: Transport, edit: ProfileEdit): Promise<MyProfile> {
  return transport.patchAuth<MyProfile>("/v1/me", edit);
}

/**
 * Changes who may see which field.
 *
 * The whole map goes every time, not a delta. Two settings screens open at
 * once would otherwise each overwrite the other's field with a stale value,
 * and a privacy control that silently reverts is worse than none.
 */
export function updateVisibility(
  transport: Transport,
  visibility: Partial<Record<VisibilityField, Visibility>>,
): Promise<MyProfile> {
  return transport.patchAuth<MyProfile>("/v1/me/visibility", { visibility });
}

export function setFollowing(
  transport: Transport,
  handle: string,
  follow: boolean,
): Promise<void> {
  const path = `/v1/users/${encodeURIComponent(handle)}/follow`;
  return follow ? transport.postAuth<void>(path, {}) : transport.deleteAuth(path);
}

export function followState(transport: Transport, handle: string): Promise<FollowState> {
  return transport.getAuth<FollowState>(`/v1/users/${encodeURIComponent(handle)}/follow-state`);
}

// -------------------------------------------------------------------- media

/** Which bucket an object lives in. The caller says; the server never guesses. */
export type Bucket = "media" | "encrypted" | "story";

export interface UploadTicket {
  url: string;
  key: string;
  expires_in: number;
}

/**
 * Asks for somewhere to put `size` bytes, and gets a presigned URL back.
 *
 * The bytes go straight to object storage from here — they never pass through
 * `apps/server`, which is what keeps one machine from being the bottleneck for
 * every picture anybody posts.
 */
export function uploadUrl(
  transport: Transport,
  size: number,
  bucket: Bucket = "media",
): Promise<UploadTicket> {
  return transport.postAuth<UploadTicket>("/v1/media/upload", { bucket, size });
}

/**
 * A presigned URL for reading one object.
 *
 * Presigned per read rather than public: the feed bucket holds people's
 * pictures, and a URL that works for ever works for ever for everybody who
 * ever saw it.
 */
export async function imageUrl(
  transport: Transport,
  key: string,
  bucket: Bucket = "media",
): Promise<string> {
  const answer = await transport.postAuth<{ url: string; expires_in: number }>(
    "/v1/media/download",
    { bucket, key },
  );
  return answer.url;
}

/**
 * Uploads bytes and returns the key they landed under.
 *
 * `fetch` rather than the transport, because this one request does not go to
 * `apps/server` at all: it is a PUT to object storage, signed, with no bearer
 * token — sending one would leak this account's session to a third party.
 *
 * Its failures are still a `TransportError`. A browser reports a bucket whose
 * CORS rules refuse this origin as nothing more than a `TypeError`, and the
 * screens above turn anything that is not a `TransportError` into "Something
 * went wrong" — which is how a missing bucket rule passed for a bug.
 */
export async function uploadBytes(
  transport: Transport,
  bytes: Uint8Array,
  contentType: string,
  bucket: Bucket = "media",
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const ticket = await uploadUrl(transport, bytes.byteLength, bucket);
  let response: Response;
  try {
    response = await doFetch(ticket.url, {
      method: "PUT",
      body: bytes as unknown as BodyInit,
      headers: { "content-type": contentType },
      credentials: "omit",
    });
  } catch (cause) {
    throw TransportError.unreachable(cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) {
    throw new TransportError("rejected", `The storage provider returned ${response.status}.`);
  }
  return ticket.key;
}
