import { useMemo, useState } from "react";

import { useApp } from "../../app/store";
import { ConversationAvatar } from "../../components/ui/ConversationAvatar";
import { Button } from "../../components/ui/Button";
import { Field, Tabs } from "../../components/ui/Controls";
import { EmptyState } from "../../components/ui/Feedback";
import { cn } from "../../lib/cn";
import type { Team } from "../../lib/teams";

type Segment = "teams" | "invites";

/**
 * The left column: every team, searchable, with the new ones apart.
 *
 * *Invites* is the teams somebody added you to that you have not opened on
 * this device yet -- the place an addition is noticed, since being added
 * happens on somebody else's screen. Opening one moves it across.
 */
export function TeamList({
  teams,
  activeId,
  onOpen,
}: {
  teams: Team[];
  activeId: string;
  onOpen: (id: string) => void;
}) {
  const overrides = useApp((s) => s.conversationOverrides);
  const unread = useApp((s) => s.unread);
  const teamPane = useApp((s) => s.teamPane);
  const setTeamPane = useApp((s) => s.setTeamPane);
  const setCreateTeamOpen = useApp((s) => s.setCreateTeamOpen);
  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState<Segment>("teams");

  const invites = useMemo(
    // Never opened here, and not one you started: a team you own was not an
    // invitation to anything.
    () => teams.filter((team) => !overrides[team.id]?.opened && team.myRole !== "owner"),
    [overrides, teams],
  );
  const shown = useMemo(() => {
    const pool = segment === "invites" ? invites : teams.filter((team) => !invites.includes(team));
    const needle = query.trim().toLowerCase();
    return needle === "" ? pool : pool.filter((team) => (team.name ?? "new team").toLowerCase().includes(needle));
  }, [invites, query, segment, teams]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 p-3">
        <Field
          label="Search teams"
          hideLabel
          icon="search"
          placeholder="Search teams"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Tabs<Segment>
          tabs={[
            { id: "teams", label: "Teams" },
            { id: "invites", label: invites.length > 0 ? `Invites · ${invites.length}` : "Invites" },
          ]}
          active={segment}
          onChange={setSegment}
        />
      </div>

      {shown.length === 0 ? (
        segment === "invites" ? (
          <EmptyState
            icon="team"
            title="No new teams"
            body="When somebody adds you to a team, it waits here until you open it."
          />
        ) : teams.length === 0 ? (
          <EmptyState
            icon="team"
            title="No teams yet"
            body="A team is a private board for the people in it. Only members can read it, and nobody else can find it."
            action={
              <Button variant="primary" icon="plus" onClick={() => setCreateTeamOpen(true)}>
                New team
              </Button>
            }
          />
        ) : (
          <p className="text-text-lo px-4 py-6 text-center text-meta">No team matches that.</p>
        )
      ) : (
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
          {shown.map((team) => {
            const count = unread[team.id] ?? 0;
            const name = team.name ?? "New team";
            return (
              <li key={team.id}>
                <button
                  type="button"
                  onClick={() => onOpen(team.id)}
                  aria-current={team.id === activeId ? "true" : undefined}
                  className={cn(
                    "rounded-control flex w-full items-center gap-3 px-2.5 py-2 text-left",
                    "transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
                    team.id === activeId ? "bg-fill-active" : "hover:bg-fill-hover",
                  )}
                >
                  <ConversationAvatar
                    conversationId={team.id}
                    kind="team"
                    title={name}
                    hasAvatar={team.hasAvatar}
                    version={team.avatarVersion}
                    size={36}
                  />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-body", count > 0 ? "text-text-hi font-semibold" : "text-text-hi font-medium")}>
                      {name}
                    </span>
                    <span className="text-text-lo block truncate text-meta">
                      {team.members.length === 1 ? "1 member" : `${team.members.length} members`}
                    </span>
                  </span>
                  {count > 0 ? (
                    <span className="bg-accent text-on-accent tabular min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold">
                      {count}
                    </span>
                  ) : null}
                </button>
                {/* The open team's parts, hung under it on a guide line. */}
                {team.id === activeId ? (
                  <ul className="my-0.5 ml-[29px] flex flex-col border-l border-[var(--hairline)] pl-2">
                    {(["board", "settings"] as const).map((pane) => (
                      <li key={pane}>
                        <button
                          type="button"
                          onClick={() => setTeamPane(pane)}
                          aria-current={teamPane === pane ? "page" : undefined}
                          className={cn(
                            "rounded-control w-full px-2.5 py-1.5 text-left text-meta",
                            "transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
                            teamPane === pane ? "text-text-hi bg-fill-hover font-medium" : "text-text-mid hover:text-text-hi",
                          )}
                        >
                          {pane === "board" ? "Board" : "Settings"}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
