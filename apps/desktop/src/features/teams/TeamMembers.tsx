import { useCallback, useEffect, useState } from "react";

import { useApp } from "../../app/store";
import { Button, IconButton } from "../../components/ui/Button";
import { Select } from "../../components/ui/Controls";
import { Callout, Skeleton } from "../../components/ui/Feedback";
import { HandleAvatar } from "../../components/ui/HandleAvatar";
import { asConversationError } from "../../lib/conversations";
import { confirm } from "../../lib/native";
import { removePerson, setRole, teamRoster, type RosterEntry, type Team, type TeamRole } from "../../lib/teams";
import { useDisplayName } from "./Author";
import { AddPeopleDialog } from "./AddPeopleDialog";
import { mayRemove, maySetRole } from "./roles";

const SECTIONS: { role: TeamRole; title: string; about: string }[] = [
  {
    role: "owner",
    title: "Owner",
    about: "Hands the team on, deletes it, and can do everything an admin can. There is always exactly one.",
  },
  {
    role: "admin",
    title: "Admins",
    about: "Add and remove members, make members admins, pin posts, and remove posts for everyone.",
  },
  {
    role: "member",
    title: "Members",
    about: "Read, post, comment and react. Anybody but the owner can leave.",
  },
];

/**
 * Who is in a team, and what each of them may do -- a section of the team's
 * settings rather than a screen of its own.
 *
 * Three groups, each with a plain sentence about its role, and per person a
 * handle, when they joined, and -- only where the viewer is allowed to act on
 * that row -- a role and a remove button. What is **not** here is the point as
 * much as what is: no "last active", no "online". A roster is who is in and
 * what they may do, not a record of when anybody was last seen.
 *
 * It was the board's third pane, next to Board and Settings, and a second
 * place to go to change the team. Now the settings are the one place: its
 * name, its people, and the ways out of it. The roster it reads is handed up
 * (`onRoster`), so the hand-on picker below it offers who is actually in.
 */
export function TeamMembers({
  team,
  onRoster,
  onChanged,
}: {
  team: Team;
  /** Every time the roster is read. */
  onRoster?: (roster: RosterEntry[]) => void;
  /** Somebody was added, removed or given another role. */
  onChanged?: () => void;
}) {
  const account = useApp((s) => s.account);
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await teamRoster(team.id);
      setRoster(next);
      onRoster?.(next);
      setProblem(null);
    } catch (error) {
      setProblem(asConversationError(error).message);
    }
  }, [team.id, onRoster]);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = () => {
    void load();
    onChanged?.();
  };

  const me = account?.handle.toLowerCase();
  const myRole = roster?.find((entry) => entry.handle.toLowerCase() === me)?.role ?? team.myRole;
  const canAdd = myRole === "owner" || myRole === "admin";

  return (
    <section className="flex flex-col gap-4 border-t border-[var(--hairline)] pt-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-text-hi text-body font-semibold">Members</h3>
          <p className="text-text-mid text-meta">
            {roster ? `${roster.length} ${roster.length === 1 ? "person" : "people"}. ` : ""}
            Only they can read {team.name ?? "this team"}.
          </p>
        </div>
        {canAdd ? (
          <Button variant="primary" icon="userPlus" onClick={() => setAdding(true)}>
            Add people
          </Button>
        ) : null}
      </header>

      {problem ? <Callout tone="danger">{problem}</Callout> : null}

      {roster === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : (
        SECTIONS.map((section) => {
          const people = roster.filter((entry) => entry.role === section.role);
          if (people.length === 0 && section.role !== "member") return null;
          return (
            <div key={section.role} className="flex flex-col gap-1">
              <h4 className="text-text-hi text-meta font-semibold">{section.title}</h4>
              <p className="text-text-lo text-meta leading-relaxed">{section.about}</p>
              {people.length === 0 ? (
                <p className="text-text-lo py-2 text-meta">Nobody yet.</p>
              ) : (
                <ul className="flex flex-col">
                  {people.map((entry) => (
                    <MemberRow
                      key={entry.handle}
                      team={team}
                      entry={entry}
                      myRole={myRole ?? null}
                      isSelf={entry.handle.toLowerCase() === me}
                      onChanged={changed}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}

      {adding ? (
        <AddPeopleDialog
          team={team}
          // The roster this device last read, when a fresh one would not come:
          // a button that does nothing because a read failed is worse than a
          // dialog working from what is known. The server still decides.
          roster={
            roster ??
            Object.entries(team.roles).map(([handle, role]) => ({ handle, role, joined_at_ms: 0 }))
          }
          onClose={() => setAdding(false)}
          onAdded={changed}
        />
      ) : null}
    </section>
  );
}

function MemberRow({
  team,
  entry,
  myRole,
  isSelf,
  onChanged,
}: {
  team: Team;
  entry: RosterEntry;
  myRole: TeamRole | null;
  isSelf: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const display = useDisplayName(entry.handle);
  const shown = isSelf ? "You" : display ?? `@${entry.handle}`;
  const canChangeRole =
    !isSelf && (maySetRole(myRole, entry.role, "admin") || maySetRole(myRole, entry.role, "member"));
  const canRemove = !isSelf && mayRemove(myRole, entry.role, false);

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await run();
      onChanged();
    } catch (error) {
      setProblem(asConversationError(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-1 border-b border-[var(--hairline)] py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <HandleAvatar handle={entry.handle} name={display ?? entry.handle} size={36} />
        <div className="min-w-0 flex-1">
          <p className="text-text-hi truncate text-body font-medium">{shown}</p>
          <p className="text-text-lo truncate text-meta">
            @{entry.handle} · Joined {new Date(entry.joined_at_ms).toLocaleDateString()}
          </p>
        </div>
        {canChangeRole ? (
          <Select<"admin" | "member">
            label={`Role for @${entry.handle}`}
            value={entry.role === "admin" ? "admin" : "member"}
            options={[
              { value: "admin", label: "Admin" },
              { value: "member", label: "Member" },
            ]}
            onChange={(role) => {
              if (role !== entry.role) void act(() => setRole(team.id, entry.handle, role));
            }}
          />
        ) : null}
        {canRemove ? (
          <IconButton
            name="trash"
            label={`Remove @${entry.handle}`}
            size={16}
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const ok = await confirm(
                  `Remove ${shown}`,
                  "They stop receiving the team, and its keys change so they can't read anything posted after this. What they already have stays on their device.",
                );
                if (ok) await removePerson(team.id, entry.handle);
              })
            }
          />
        ) : null}
      </div>
      {problem ? <p className="text-danger pl-12 text-meta">{problem}</p> : null}
    </li>
  );
}
