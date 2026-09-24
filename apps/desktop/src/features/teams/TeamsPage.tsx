import { useApp } from "../../app/store";
import type { TeamsState } from "../../app/useTeams";
import { useLayout } from "../../app/useLayout";
import { PageTitleCell } from "../../components/chrome/TopBar";
import { IconButton } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { Panel } from "../../components/ui/Surface";
import { cn } from "../../lib/cn";
import { CreateTeamDialog } from "./CreateTeamDialog";
import { TeamBoard } from "./TeamBoard";
import { TeamList } from "./TeamList";
import { TeamMembers } from "./TeamMembers";
import { TeamSettings } from "./TeamSettings";

/**
 * The Teams destination: the list, and the open team beside it.
 *
 * The same widths as Messages (`useLayout`): below 768px one pane at a time --
 * the list is a screen, and opening a team replaces it, with the top row
 * drawing the way back -- and from 768px the list beside the board.
 */
export function TeamsPage({ now, teams }: { now: Date; teams: TeamsState }) {
  const layout = useLayout();
  const activeTeamId = useApp((s) => s.activeTeamId);
  const teamPane = useApp((s) => s.teamPane);
  const closeTeam = useApp((s) => s.closeTeam);
  const createTeamOpen = useApp((s) => s.createTeamOpen);
  const open = useOpenTeam();

  const team = teams.teams.find((candidate) => candidate.id === activeTeamId);
  const showList = !layout.phone || !team;
  const showBoard = !layout.phone || team !== undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {showList ? (
        <Panel
          tone="list"
          edge={false}
          className={cn(
            "flex min-h-0 flex-col border-r border-[var(--hairline)]",
            layout.phone ? "flex-1" : "w-80 shrink-0",
          )}
        >
          <TeamList teams={teams.teams} activeId={activeTeamId} onOpen={(id) => open(id, teams)} />
        </Panel>
      ) : null}

      {showBoard ? (
        team ? (
          teamPane === "members" ? (
            <TeamMembers key={team.id} team={team} />
          ) : teamPane === "settings" ? (
            <TeamSettings
              key={team.id}
              team={team}
              onGone={() => {
                closeTeam();
                void teams.refresh();
              }}
            />
          ) : (
            <TeamBoard
              key={team.id}
              team={team}
              teams={teams.teams}
              now={now}
              onSwitch={(id) => open(id, teams)}
            />
          )
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-center">
            <EmptyState icon="team" title="No team open" body="Choose a team to read its board." />
          </div>
        )
      ) : null}

      {createTeamOpen ? (
        <CreateTeamDialog
          onCreated={(id) => {
            void teams.refresh().then(() => open(id, teams));
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Opening a team: it becomes the open one, it is no longer an invitation, what
 * was unread on it is read, and its roster is read again -- roles decide what
 * this device may offer on the board.
 */
function useOpenTeam() {
  const openTeam = useApp((s) => s.openTeam);
  const markTeamOpened = useApp((s) => s.markTeamOpened);
  const clearUnread = useApp((s) => s.clearUnread);
  return (id: string, teams: TeamsState) => {
    openTeam(id);
    markTeamOpened(id);
    clearUnread(id);
    void teams.refreshRoster(id);
  };
}

/**
 * The Teams cell of the top row: a way back on a phone, a way to start one
 * everywhere. On a phone the members and settings screens are screens of their
 * own, and back from them goes to the board, not out of the team.
 */
export function TeamsHeader({ teams }: { teams: TeamsState }) {
  const layout = useLayout();
  const activeTeamId = useApp((s) => s.activeTeamId);
  const teamPane = useApp((s) => s.teamPane);
  const closeTeam = useApp((s) => s.closeTeam);
  const setTeamPane = useApp((s) => s.setTeamPane);
  const setCreateTeamOpen = useApp((s) => s.setCreateTeamOpen);
  const team = teams.teams.find((candidate) => candidate.id === activeTeamId);

  if (layout.phone && team) {
    const onBoard = teamPane === "board";
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1 px-2">
        <IconButton
          name="chevronLeft"
          label={onBoard ? "Back to teams" : "Back to the board"}
          className="no-drag"
          onClick={onBoard ? closeTeam : () => setTeamPane("board")}
        />
        <h1 className="font-display text-text-hi truncate text-title font-semibold tracking-[-0.01em]">
          {onBoard ? team.name ?? "New team" : teamPane === "members" ? "Members" : "Team settings"}
        </h1>
      </div>
    );
  }
  return (
    <PageTitleCell
      title="Teams"
      actions={
        <IconButton name="plus" label="New team" size={17} onClick={() => setCreateTeamOpen(true)} />
      }
    />
  );
}
