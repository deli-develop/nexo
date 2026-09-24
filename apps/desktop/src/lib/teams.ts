import {
  attachments as coreAttachments,
  teams as core,
  type AddOutcome,
  type Board,
  type PostDraft,
  type RosterEntry,
  type SealedFile,
  type StoredConversation,
  type TeamRole,
} from "@nexo/core";

import { avatarVersion } from "./conversations";
import { runtime } from "./runtime";

/**
 * Teams, as the page sees them: typed wrappers over `packages/core/src/teams.ts`.
 *
 * Shaped like `lib/feed.ts` and `lib/conversations.ts` -- one `runtime()`
 * away from the core, nothing held here. **Nothing in this file holds a
 * secret**: a team's keys are in the MLS state the core keeps, and what comes
 * back from here is already plaintext the device is allowed to show.
 */

export type { AddOutcome, Board, PostDraft, RosterEntry, SealedFile, TeamRole };

/** A team as the UI lists it, read from this device's store. */
export interface Team {
  id: string;
  /**
   * `null` until the first name has arrived. A new member learns it from the
   * message the adder sends after the add, and until then the UI says "New
   * team" rather than naming the team after the conversation id.
   */
  name: string | null;
  description: string | null;
  members: string[];
  /** By handle, as last read from the roster. Empty until read. */
  roles: Record<string, TeamRole>;
  /** This account's own role, when the roster has been read. */
  myRole: TeamRole | null;
  /**
   * Device id to handle. MLS names the device a post came from; this is how a
   * post is attributed to a person rather than to "someone".
   */
  devices: Record<string, string>;
  hasAvatar: boolean;
  /** Which picture -- see `avatarVersion` in `lib/conversations.ts`. */
  avatarVersion: string | null;
  updatedAtMs: number;
  /**
   * Whether this device joined after the team began -- its board says that
   * earlier posts are not here.
   */
  joinedLate: boolean;
}

function toTeam(row: StoredConversation, me: string | undefined): Team {
  const roles = row.roles ?? {};
  return {
    id: row.id,
    name: row.title,
    description: row.description ?? null,
    members: row.members ?? [],
    roles,
    myRole: me !== undefined ? roles[me] ?? null : null,
    devices: row.memberDevices ?? {},
    hasAvatar: row.avatar !== undefined,
    avatarVersion: avatarVersion(row.avatar),
    updatedAtMs: row.updatedAtMs,
    joinedLate: row.joinedAt !== undefined,
  };
}

/** Every team this device knows about, most recently active first. */
export async function listTeams(): Promise<Team[]> {
  const { store } = await runtime();
  const [rows, account] = await Promise.all([store.conversations(), store.account()]);
  return rows
    .filter((row) => row.kind === "team")
    .map((row) => toTeam(row, account?.handle))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

async function context() {
  return (await runtime()).context();
}

export async function createTeam(name: string, description?: string): Promise<string> {
  return core.createTeam(await context(), name, description);
}

export async function addPeople(teamId: string, handles: string[]): Promise<AddOutcome[]> {
  return core.addPeople(await context(), teamId, handles);
}

export async function removePerson(teamId: string, handle: string): Promise<void> {
  return core.removePerson(await context(), teamId, handle);
}

export async function setRole(teamId: string, handle: string, role: "admin" | "member"): Promise<void> {
  return core.setRole(await context(), teamId, handle, role);
}

export async function transferTeam(teamId: string, handle: string): Promise<void> {
  return core.transfer(await context(), teamId, handle);
}

export async function leaveTeam(teamId: string): Promise<void> {
  return core.leave(await context(), teamId);
}

export async function deleteTeam(teamId: string): Promise<void> {
  return core.deleteTeam(await context(), teamId);
}

/** Commits out whoever left. Does nothing unless this account moderates. */
export async function reconcileTeam(teamId: string): Promise<number> {
  return core.reconcile(await context(), teamId);
}

/** The roster, read fresh. Rejects with `not_found` once this account is out. */
export async function teamRoster(teamId: string): Promise<RosterEntry[]> {
  return core.roster(await context(), teamId);
}

/** Read from the store alone, like the conversation list: no session needed to show what is here. */
export async function teamBoard(teamId: string): Promise<Board> {
  const { store } = await runtime();
  return core.board({ store }, teamId);
}

export async function renameTeam(teamId: string, name: string): Promise<void> {
  return core.rename(await context(), teamId, name);
}

export async function describeTeam(teamId: string, description: string): Promise<void> {
  return core.describe(await context(), teamId, description);
}

export async function postToTeam(teamId: string, draft: PostDraft): Promise<string> {
  return core.post(await context(), teamId, draft);
}

export async function commentOn(
  teamId: string,
  postId: string,
  body: string,
  parent?: string,
): Promise<string> {
  return core.comment(await context(), teamId, postId, body, parent);
}

export async function pinPost(teamId: string, postId: string, pinned: boolean): Promise<void> {
  return core.pin(await context(), teamId, postId, pinned);
}

export async function removeForEveryone(teamId: string, target: string): Promise<void> {
  return core.removeForEveryone(await context(), teamId, target);
}

/**
 * Seals a file for a post and puts it in the bucket. The key comes back inside
 * the `SealedFile`, to travel in the post and nowhere else.
 */
export async function sealTeamFile(
  teamId: string,
  file: { name: string; mime: string; bytes: Uint8Array },
): Promise<SealedFile> {
  const it = await runtime();
  return coreAttachments.sealFile(await it.attachments(), teamId, file.bytes, {
    name: file.name,
    mime: file.mime,
  });
}

/** Opens a post's file. The bytes, for a picture's object URL or a save. */
export async function openTeamFile(file: SealedFile): Promise<Uint8Array> {
  const it = await runtime();
  return coreAttachments.open(await it.attachments(), file);
}

/** Forgets a team on this device, after the server said it is gone or we are out. */
export async function forgetTeam(teamId: string): Promise<void> {
  const { store } = await runtime();
  await store.forgetConversation(teamId);
}
