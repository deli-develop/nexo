import type { AddOutcome, TeamRole } from "../../lib/teams";

/**
 * The role rules, as the UI needs them.
 *
 * The same three rules `apps/server/src/teams.rs` enforces (`may_remove`,
 * `may_set_role`), mirrored so the members screen offers only what the server
 * will allow. Mirrored, not moved: the server is where the rule holds, and a
 * control this file wrongly offered would be refused there -- this only saves
 * somebody the refusal.
 */

export function mayRemove(actor: TeamRole | null, target: TeamRole, isSelf: boolean): boolean {
  if (actor === null) return false;
  if (isSelf) return actor !== "owner";
  if (actor === "owner") return target !== "owner";
  if (actor === "admin") return target === "member";
  return false;
}

export function maySetRole(actor: TeamRole | null, target: TeamRole, to: TeamRole): boolean {
  if (actor === null || to === "owner" || target === "owner") return false;
  if (actor === "owner") return true;
  if (actor === "admin") return target === "member";
  return false;
}

/** The most people a team may hold. `MAX_MEMBERS` on the server. */
export const TEAM_CAP = 200;

/** What one row of the add-people dialog can say about a person. */
export type AddRow =
  | { state: "addable" }
  | { state: "added" }
  | { state: "already_in"; reason: string }
  | { state: "blocked"; reason: string }
  | { state: "full"; reason: string }
  | { state: "refused"; reason: string };

/**
 * Why somebody can or cannot be added, said in the row rather than by the row
 * disappearing.
 *
 * What this device can know ahead of time: who is already in, whom *you* have
 * blocked, and whether the seats are gone. What only the server knows -- that
 * the person is private and you have no way in, or that they blocked you --
 * comes back as the same refusal for both, and is worded so, because telling
 * them apart would tell you something about their account.
 */
export function addRow(input: {
  handle: string;
  members: ReadonlySet<string>;
  blocked: ReadonlySet<string>;
  /** People in the team now plus those already picked ahead of this one. */
  seatsTaken: number;
  outcome?: AddOutcome;
}): AddRow {
  const handle = input.handle.toLowerCase();
  if (input.outcome?.added) return { state: "added" };
  if (input.members.has(handle)) return { state: "already_in", reason: "Already in the team" };
  if (input.blocked.has(handle)) {
    return { state: "blocked", reason: "You've blocked them. Unblock them to add them." };
  }
  if (input.outcome && !input.outcome.added) {
    return { state: "refused", reason: refusal(input.outcome.reason) };
  }
  if (input.seatsTaken >= TEAM_CAP) {
    return { state: "full", reason: `The team is full — ${TEAM_CAP} people at most` };
  }
  return { state: "addable" };
}

function refusal(reason: string | undefined): string {
  // The server's deliberate non-answer, for a block and for a private account
  // alike. Said as what it is, without choosing between them.
  if (!reason || reason === "That could not be delivered.") {
    return "Couldn't be added. They may be private, or may have blocked you.";
  }
  if (/key package/i.test(reason)) {
    return "Couldn't be added yet. They need to open Nexo once first.";
  }
  return reason;
}
