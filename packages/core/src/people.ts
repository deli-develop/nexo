/** Finding people, invitations, and reports. The server owns every policy here. */

import type { Transport } from "./transport";
import type { InviteSummary, MintedInvite, SearchResult } from "./types";

export interface PeopleContext {
  transport: Transport;
}

export type ReportSubject = "post" | "comment" | "user";
export type ReportReason = "spam" | "harassment" | "illegal" | "impersonation" | "other";

/** Private accounts, blocked accounts, and the caller are excluded by the server. */
export function search(ctx: PeopleContext, term: string): Promise<SearchResult[]> {
  return ctx.transport.getAuth<SearchResult[]>(`/v1/users?q=${encodeURIComponent(term)}`);
}

/** The secret is returned only by this call; the server stores its hash. */
export function createInvite(
  ctx: PeopleContext,
  label: string | null,
  days: number,
): Promise<MintedInvite> {
  return ctx.transport.postAuth<MintedInvite>("/v1/invites", { label, days });
}

/** Summaries contain use counts, never the invitation secrets. */
export function invites(ctx: PeopleContext): Promise<InviteSummary[]> {
  return ctx.transport.getAuth<InviteSummary[]>("/v1/invites");
}

export function revokeInvite(ctx: PeopleContext, id: number): Promise<void> {
  return ctx.transport.deleteAuth(`/v1/invites/${id}`);
}

/** A report confirms receipt only; moderation is deliberately not reflected here. */
export function report(
  ctx: PeopleContext,
  subjectKind: ReportSubject,
  subjectId: number,
  reason: ReportReason,
  note: string | null = null,
): Promise<void> {
  return ctx.transport.postAuth<void>("/v1/reports", {
    subject_kind: subjectKind,
    subject_id: subjectId,
    reason,
    note,
  });
}
