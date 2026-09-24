import { useCallback, useEffect, useMemo, useState } from "react";

import { asConversationError } from "../lib/conversations";
import { onMembership } from "../lib/stream";
import {
  forgetTeam,
  listTeams,
  reconcileTeam,
  teamRoster,
  type Team,
} from "../lib/teams";
import { totalUnread, useApp } from "./store";
import { onSync } from "./syncAgent";

/**
 * The teams this device is in, kept current.
 *
 * **Mounted once, in `AppShell`**, for the reason `useConversations` gives: two
 * instances would mean two of every read and two copies of the truth, and the
 * rail's badge and the page would disagree.
 *
 * Three things keep it current:
 *
 * - every sync pass, which is when names, descriptions and posts arrive;
 * - the `membership` nudge, which is when the roster changed -- roles, adds,
 *   removals, or the team going away. The roster is read again then, and an
 *   owner's or admin's device commits out anybody who left (`reconcile`),
 *   because a member cannot commit their own removal;
 * - a roster that answers "not found", which means this account is no longer
 *   in the team. It is forgotten on this device then, rather than left in
 *   the list as a board nobody can post to.
 */
export interface TeamsState {
  teams: Team[];
  /** Unread posts and comments across every team, for the Teams badge. */
  unread: number;
  /** Team ids, so the Messages badge can leave them out. */
  ids: ReadonlySet<string>;
  refresh: () => Promise<void>;
  /** Reads one team's roster again, and forgets the team if we are out. */
  refreshRoster: (teamId: string) => Promise<void>;
}

export function useTeams(): TeamsState {
  const [teams, setTeams] = useState<Team[]>([]);
  const unreadLedger = useApp((s) => s.unread);
  const forgetConversation = useApp((s) => s.forgetConversation);

  const refresh = useCallback(async () => {
    try {
      setTeams(await listTeams());
    } catch {
      // Signed out or locked: the list is empty, which is what gets drawn.
    }
  }, []);

  const refreshRoster = useCallback(
    async (teamId: string) => {
      try {
        await teamRoster(teamId);
      } catch (error) {
        if (asConversationError(error).kind === "not_found") {
          // Removed, or the team was deleted. Either way it is not ours to
          // show any more.
          await forgetTeam(teamId);
          forgetConversation(teamId);
        }
        await refresh();
        return;
      }
      // Only does anything for an owner or admin.
      await reconcileTeam(teamId).catch(() => 0);
      await refresh();
    },
    [forgetConversation, refresh],
  );

  useEffect(() => {
    void refresh();
    const stopSync = onSync(() => void refresh());
    let stopMembership: (() => void) | undefined;
    let cancelled = false;
    void onMembership((event) => void refreshRoster(event.conversation_id)).then((stop) => {
      if (cancelled) stop();
      else stopMembership = stop;
    });
    return () => {
      cancelled = true;
      stopSync();
      stopMembership?.();
    };
  }, [refresh, refreshRoster]);

  const ids = useMemo(() => new Set(teams.map((team) => team.id)), [teams]);
  const unread = useMemo(
    () => totalUnread(Object.fromEntries(Object.entries(unreadLedger).filter(([id]) => ids.has(id)))),
    [ids, unreadLedger],
  );

  return { teams, unread, ids, refresh, refreshRoster };
}
