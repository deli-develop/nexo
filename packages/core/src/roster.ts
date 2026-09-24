import type { StoredConversation, Store, TeamRole } from "./store";
import type { Transport } from "./transport";

/**
 * A team's roster as this device last read it: who holds which role, and
 * which MLS device belongs to whom.
 *
 * Its own module, beside rather than inside `teams.ts`, because the receive
 * path in `conversations.ts` needs it and `teams.ts` is built on
 * `conversations.ts` -- the one direction the imports may run.
 *
 * # Why a receiver checks roles at all
 *
 * The server enforces who may add, remove and promote, because those change
 * its routing table. It cannot enforce who may pin a post or remove one for
 * everyone: both are inside the ciphertext, and the server never sees that
 * they are pins. So every receiving device asks, as the mark arrives, whether
 * the device that sent it belongs to an owner or an admin **now** -- by the
 * roster the server serves. Not at the moment it was sent, which a receiver
 * cannot know: a pin from somebody demoted before this device caught up is
 * dropped, and that is the honest cost of a rule nobody else can check.
 */

/** One person on a team's roster, as `GET /v1/teams/{id}/members` answers. */
export interface RosterEntry {
  handle: string;
  role: TeamRole;
  joined_at_ms: number;
}

/** Reads the roster from the server and remembers the roles beside the team. */
export async function refreshRoster(
  transport: Transport,
  store: Store,
  conversationId: string,
): Promise<RosterEntry[]> {
  const roster = await transport.getAuth<RosterEntry[]>(
    `/v1/teams/${encodeURIComponent(conversationId)}/members`,
  );
  const existing = await store.conversation(conversationId);
  if (existing) {
    await store.putConversation({
      ...existing,
      roles: Object.fromEntries(roster.map((entry) => [entry.handle, entry.role])),
    });
  }
  return roster;
}

/** The role behind a device, when both the device's owner and their role are known. */
export function roleOfDevice(
  conversation: Pick<StoredConversation, "memberDevices" | "roles"> | null | undefined,
  deviceId: string,
): TeamRole | undefined {
  const handle = conversation?.memberDevices?.[deviceId];
  return handle === undefined ? undefined : conversation?.roles?.[handle];
}

/** Whether a role may pin, unpin and remove for everyone. */
export function moderates(role: TeamRole | undefined): boolean {
  return role === "owner" || role === "admin";
}
