/**
 * Finding people, letting them in, and reporting them.
 *
 * What is left of `meet.ts` after the map was removed — none of it was ever
 * about the map. Nothing here holds a secret: the invitation secret is minted
 * by the server and shown once, and the page never sees key material.
 */

import { invoke } from "@tauri-apps/api/core";

/** Why something was reported. The server accepts exactly these. */
export type ReportReason =
  | "spam"
  | "harassment"
  | "illegal"
  | "impersonation"
  | "other";

/**
 * Report a person.
 *
 * Blocking answers "I do not want to see this person"; reporting answers "this
 * should not be here", and only the second asks somebody else to look. The
 * reporter is told it was received and nothing more — not whether others
 * reported the same account, which would make reporting a way of learning
 * about other people.
 */
export function reportUser(
  userId: number,
  reason: ReportReason,
  note?: string,
): Promise<void> {
  return invoke<void>("report", {
    subjectKind: "user",
    subjectId: userId,
    reason,
    note: note ?? null,
  });
}

/** Why a people call failed. Match on `kind`, never on `message`. */
export interface PeopleError {
  kind: "unreachable" | "signed_out" | "not_found" | "rejected" | "internal";
  message: string;
}

/** Narrows an unknown thrown value to something the UI can show. */
export function asPeopleError(error: unknown): PeopleError {
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    "message" in error
  ) {
    return error as PeopleError;
  }
  return { kind: "internal", message: "Something went wrong. Try again." };
}

/** Somebody a search turned up. */
export interface SearchResult {
  handle: string;
  display_name: string;
  avatar_key: string | null;
}

/**
 * A freshly minted invitation.
 *
 * `secret` is readable **once**. The server keeps only a hash, so a lost
 * secret cannot be looked up — it is revoked and replaced, the same answer a
 * password reset gives.
 */
export interface MintedInvite {
  id: number;
  secret: string;
  expires_at_ms: number;
}

/** One invitation afterwards. */
export interface Invite {
  id: number;
  label: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  revoked: boolean;
  /** Usable right now. Expiry is by the clock, not by a cleanup job. */
  live: boolean;
  /** How many people reached you through it. */
  used: number;
}

/**
 * Find people by handle or display name.
 *
 * **Private accounts are absent**, and the server decides that — a directory
 * the client trims is one anybody can untrim.
 */
export function searchUsers(term: string): Promise<SearchResult[]> {
  return invoke<SearchResult[]>("search_users", { term });
}

/** Mint an invitation. At most seven days. */
export function createInvite(
  label: string | undefined,
  days: number,
): Promise<MintedInvite> {
  return invoke<MintedInvite>("create_invite", {
    label: label ?? null,
    days,
  });
}

/** My invitations, live and spent. */
export function listInvites(): Promise<Invite[]> {
  return invoke<Invite[]>("invites");
}

/**
 * Withdraw one.
 *
 * The record stays, so the uses already counted against it are not lost with
 * it.
 */
export function revokeInvite(id: number): Promise<void> {
  return invoke<void>("revoke_invite", { id });
}
