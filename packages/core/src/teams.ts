import { buildBoard, type Board } from "./board";
import * as conversations from "./conversations";
import type { Context } from "./conversations";
import { TransportError } from "./errors";
import type { Payload, SealedFile } from "./payload";
import { moderates, refreshRoster, type RosterEntry } from "./roster";
import type { StoredConversation, TeamRole } from "./store";

/**
 * Teams: a private board of posts over an ordinary MLS conversation.
 *
 * Built on `conversations.ts`, never beside it. A team is a conversation with
 * `kind = 'team'`: the same group, the same envelopes, the same sync, the same
 * outbox. Adding somebody is `addTo`; a post is `sendPayload`; reactions, edits
 * and take-backs are the ordinary ones, because posts and comments are rows in
 * `messages` like any message. What lives here is only what a team has and a
 * group does not -- roles, a board, and the few server routes that manage them
 * (`apps/server/src/teams.rs`).
 *
 * Everything a member writes is inside the ciphertext. The server learns that
 * the team exists, who is in it with which role, and when envelopes flow --
 * not its name, not its description, not a word of any post.
 */

/** A team as the server lists it for its member. Nothing about its content. */
export interface TeamSummary {
  conversation_id: string;
  /** The caller's own role. */
  role: TeamRole;
  member_count: number;
  created_at_ms: number;
}

/** The most people a team may hold. `MAX_MEMBERS` in `apps/server/src/teams.rs`. */
export const MAX_MEMBERS = 200;

/** Every team this account is in, from the server. */
export function listTeams(ctx: Context): Promise<TeamSummary[]> {
  return ctx.transport.getAuth<TeamSummary[]>("/v1/teams");
}

/** Who is in a team and with which role, read fresh and remembered beside it. */
export function roster(ctx: Context, teamId: string): Promise<RosterEntry[]> {
  return refreshRoster(ctx.transport, ctx.store, teamId);
}

/** This account's role in a team, from the roster last read. */
export async function myRole(ctx: Context, teamId: string): Promise<TeamRole | undefined> {
  const me = (await ctx.store.account())?.handle;
  const team = await ctx.store.conversation(teamId);
  return me === undefined ? undefined : team?.roles?.[me];
}

// ------------------------------------------------------------------- creating

/**
 * Starts a team with this account as its owner and only member.
 *
 * The name is kept on this device and **not sent**: there is nobody yet to
 * send it to, and earlier ciphertext cannot be read by a later member anyway.
 * It goes out with the description and picture after every add
 * (`addPeople`), which is how somebody new learns what the team is called.
 */
export async function createTeam(ctx: Context, name: string, description = ""): Promise<string> {
  const title = name.trim();
  if (title === "") throw new TransportError("rejected", "A team needs a name.");
  const now = (ctx.now ?? Date.now)();
  const id = (ctx.uuid ?? (() => globalThis.crypto.randomUUID()))();

  ctx.crypto.createGroup(ctx.device, id, now);
  await ctx.store.setMlsState(ctx.device.exportState());
  const created = await ctx.transport.postAuth<TeamSummary>("/v1/teams", { conversation_id: id });
  if (created.conversation_id !== id) {
    throw new TransportError("rejected", "The server returned a different team id.");
  }

  const me = (await ctx.store.account())?.handle;
  const team: StoredConversation = {
    id,
    title,
    kind: "team",
    epoch: 0,
    syncedTo: 0,
    lastMessage: null,
    updatedAtMs: now,
  };
  if (me !== undefined) {
    team.members = [me];
    team.roles = { [me]: "owner" };
  }
  if (description.trim() !== "") team.description = description.trim();
  await ctx.store.putConversation(team);
  return id;
}

// ------------------------------------------------------------------ membership

/** Why somebody could not be added, in words the add-people dialog can show. */
export interface AddOutcome {
  handle: string;
  added: boolean;
  /** Present when `added` is false: what the server or the device said. */
  reason?: string;
}

/**
 * Adds people, one commit each, and then tells the team what it is called.
 *
 * One commit per person because that is what `addTo` is, and a partial
 * success is honest here: the people who could be added are, and each one who
 * could not says why. The server decides who may be added -- only an owner or
 * admin, not somebody blocked or private without an invitation, not past the
 * cap -- and answers the same way it answers a group, so a refusal never says
 * *which* of blocked or private it was.
 *
 * After the adds, the name, the description and the picture are sent again.
 * A new member reads nothing sent before their Welcome, so without this they
 * would see "New team" until somebody next renamed it.
 */
export async function addPeople(ctx: Context, teamId: string, handles: string[]): Promise<AddOutcome[]> {
  const outcomes: AddOutcome[] = [];
  for (const handle of handles) {
    try {
      await conversations.addTo(ctx, teamId, handle);
      outcomes.push({ handle, added: true });
    } catch (error) {
      outcomes.push({
        handle,
        added: false,
        reason: error instanceof Error ? error.message : "That could not be done.",
      });
    }
  }
  if (outcomes.some((outcome) => outcome.added)) {
    await announce(ctx, teamId);
    await roster(ctx, teamId);
  }
  return outcomes;
}

/** Sends what a new member needs to name and describe the team. */
async function announce(ctx: Context, teamId: string): Promise<void> {
  const team = await ctx.store.conversation(teamId);
  if (!team) return;
  if (team.title) await conversations.rename(ctx, teamId, team.title);
  if (team.description) {
    await conversations.sendPayload(ctx, teamId, { kind: "team_meta", description: team.description });
  }
  if (team.avatar) {
    await conversations.sendPayload(ctx, teamId, JSON.parse(team.avatar) as Payload);
  }
}

/** Takes somebody out: the server's rule first, then the commit that locks them out. */
export async function removePerson(ctx: Context, teamId: string, handle: string): Promise<void> {
  await conversations.removeFrom(ctx, teamId, handle);
  await roster(ctx, teamId);
}

/** Makes somebody an admin, or an admin a member again. */
export async function setRole(
  ctx: Context,
  teamId: string,
  handle: string,
  role: Exclude<TeamRole, "owner">,
): Promise<void> {
  await ctx.transport.patchAuth<void>(
    `/v1/teams/${teamId}/members/${encodeURIComponent(handle)}`,
    { role },
  );
  await roster(ctx, teamId);
}

/** Hands the team to somebody already in it. This account stays, as an admin. */
export async function transfer(ctx: Context, teamId: string, handle: string): Promise<void> {
  await ctx.transport.postAuth<void>(`/v1/teams/${teamId}/transfer`, { handle });
  await roster(ctx, teamId);
}

/**
 * Leaves a team. Anybody but the owner.
 *
 * The routing row goes and this device forgets the team. Its MLS leaf stays
 * until an owner's or admin's device commits it out (`reconcile`) -- a member
 * cannot commit their own removal -- and until then the server no longer
 * hands this device anything to read with it.
 */
export async function leave(ctx: Context, teamId: string): Promise<void> {
  await ctx.transport.postAuth<void>(`/v1/teams/${teamId}/leave`, {});
  await ctx.store.forgetConversation(teamId);
}

/** Deletes a team for everybody. The owner only; the server refuses anybody else. */
export async function deleteTeam(ctx: Context, teamId: string): Promise<void> {
  await ctx.transport.deleteAuth(`/v1/teams/${teamId}`);
  await ctx.store.forgetConversation(teamId);
}

/**
 * Commits out every device that is still in the MLS group but no longer on
 * the server's list -- somebody who left, or whose routing removal landed and
 * whose commit did not.
 *
 * Only an owner's or admin's device does this, and only against a list read
 * just now: a stale list would name a member added since as somebody to
 * remove. Returns how many devices it removed.
 */
export async function reconcile(ctx: Context, teamId: string): Promise<number> {
  await conversations.discover(ctx);
  await roster(ctx, teamId);
  if (!moderates(await myRole(ctx, teamId))) return 0;

  const team = await ctx.store.conversation(teamId);
  const group = ctx.crypto.loadGroup(ctx.device, teamId, (ctx.now ?? Date.now)());
  if (!team?.memberDevices || !group) return 0;
  const me = (await ctx.store.identity())?.deviceId;
  const listed = new Set(Object.keys(team.memberDevices));
  const gone = group
    .members()
    .map((member) => member.deviceId)
    .filter((deviceId) => deviceId !== me && !listed.has(deviceId));
  for (const deviceId of gone) await conversations.removeDevice(ctx, teamId, deviceId);
  return gone.length;
}

// -------------------------------------------------------------------- the board

/** What a new post may carry. */
export interface PostDraft {
  title?: string;
  body: string;
  files?: SealedFile[];
}

/**
 * Posts to the board. Answers the post's name, which comments, reactions and
 * pins point at.
 *
 * `null` from `sendPayload` means the post is queued offline; the name is
 * still the one it will have.
 */
export async function post(ctx: Context, teamId: string, draft: PostDraft): Promise<string> {
  const body = draft.body.trim();
  const files = draft.files ?? [];
  if (body === "" && files.length === 0) {
    throw new TransportError("rejected", "Write something, or attach a file.");
  }
  const id = (ctx.uuid ?? (() => globalThis.crypto.randomUUID()))();
  const payload: Payload = { kind: "team_post", id, body };
  const title = draft.title?.trim();
  if (title) payload.title = title;
  if (files.length > 0) payload.files = files;
  await conversations.sendPayload(ctx, teamId, payload);
  return id;
}

/** Comments on a post, or answers a top-level comment on it. */
export async function comment(
  ctx: Context,
  teamId: string,
  postId: string,
  body: string,
  parent?: string,
): Promise<string> {
  const text = body.trim();
  if (text === "") throw new TransportError("rejected", "A comment needs some words.");
  const id = (ctx.uuid ?? (() => globalThis.crypto.randomUUID()))();
  const payload: Payload = { kind: "team_comment", id, post: postId, body: text };
  if (parent !== undefined) payload.parent = parent;
  await conversations.sendPayload(ctx, teamId, payload);
  return id;
}

/**
 * Pins a post, or unpins it. Offered to owners and admins only, and refused
 * here for anybody else -- the other devices would ignore it anyway, and a pin
 * that shows on one screen and nowhere else is worse than none.
 */
export async function pin(ctx: Context, teamId: string, postId: string, pinned: boolean): Promise<void> {
  await requireModerator(ctx, teamId);
  await conversations.sendPayload(ctx, teamId, { kind: "team_pin", post: postId, pinned });
}

/**
 * Asks every member's device to stop showing a post or comment.
 *
 * A request, exactly like taking back your own message: every Nexo client
 * honours it, a modified one need not, and nothing reaches a copy somebody
 * already saved. The dialog that offers it says so.
 */
export async function removeForEveryone(ctx: Context, teamId: string, target: string): Promise<void> {
  await requireModerator(ctx, teamId);
  await conversations.sendPayload(ctx, teamId, { kind: "team_remove", target });
}

/** Renames the team, for everybody in it. */
export function rename(ctx: Context, teamId: string, name: string): Promise<void> {
  const title = name.trim();
  if (title === "") return Promise.reject(new TransportError("rejected", "A team needs a name."));
  return conversations.rename(ctx, teamId, title);
}

/** Says what the team is for. An empty string clears it. */
export async function describe(ctx: Context, teamId: string, description: string): Promise<void> {
  await conversations.sendPayload(ctx, teamId, { kind: "team_meta", description: description.trim() });
}

/**
 * The board, folded from what this device has stored. Only the store: reading
 * what is already here needs no session, no network and no MLS.
 */
export async function board(ctx: Pick<Context, "store">, teamId: string): Promise<Board> {
  const [messages, reactions, marks, team] = await Promise.all([
    ctx.store.messages(teamId),
    ctx.store.reactions(teamId),
    ctx.store.teamMarks(teamId),
    ctx.store.conversation(teamId),
  ]);
  const rows: Parameters<typeof buildBoard>[0] = { messages, reactions, marks };
  if (team?.joinedAt !== undefined) rows.joinedAt = team.joinedAt;
  return buildBoard(rows);
}

async function requireModerator(ctx: Context, teamId: string): Promise<void> {
  let role = await myRole(ctx, teamId);
  if (role === undefined) {
    await roster(ctx, teamId);
    role = await myRole(ctx, teamId);
  }
  if (!moderates(role)) {
    throw new TransportError("rejected", "Only the owner and admins can do that.");
  }
}
