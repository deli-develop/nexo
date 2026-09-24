import type { BoardItem } from "@nexo/core";

import { useApp } from "../../app/store";
import { ConversationAvatar } from "../../components/ui/ConversationAvatar";
import { IconButton } from "../../components/ui/Button";
import { Callout, EmptyState, Skeleton } from "../../components/ui/Feedback";
import { Icon } from "../../components/ui/Icon";
import { useContextMenu } from "../../components/ui/ContextMenu";
import { relativeTime } from "../../lib/format";
import type { Team } from "../../lib/teams";
import { TeamComments } from "./TeamComments";
import { TeamComposer } from "./TeamComposer";
import { TeamPostCard } from "./TeamPostCard";
import { useTeamBoard } from "./useTeamBoard";

/**
 * A team's board: who it is, who can read it, and what was posted.
 *
 * The header carries the team's marker -- its picture, its name, how many
 * people are in it -- and one quiet line about what the server sees. It is
 * the difference between this and the public feed, stated once where it is
 * true for everything below it, without a padlock or the word "secure".
 *
 * Two things are drawn that a feed would hide: a post this device could not
 * decrypt, in its place; and, for somebody who joined after the team began,
 * the fact that earlier posts are not here, where they would have been.
 */
export function TeamBoard({
  team,
  teams,
  now,
  onSwitch,
}: {
  team: Team;
  teams: Team[];
  now: Date;
  onSwitch: (id: string) => void;
}) {
  const { board, problem, reload } = useTeamBoard(team.id);
  const setTeamPane = useApp((s) => s.setTeamPane);
  const others = teams.filter((other) => other.id !== team.id);
  const switcher = useContextMenu(() =>
    others.map((other) => ({ label: other.name ?? "New team", icon: "team" as const, onSelect: () => onSwitch(other.id) })),
  );
  const name = team.name ?? "New team";
  const members = team.members.length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4 px-4 py-5 sm:px-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <ConversationAvatar
              conversationId={team.id}
              kind="team"
              title={name}
              hasAvatar={team.hasAvatar}
              version={team.avatarVersion}
              size={44}
            />
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={others.length > 0 ? switcher.onContextMenu : undefined}
                disabled={others.length === 0}
                aria-label={others.length > 0 ? `${name}. Switch team` : name}
                className="group flex max-w-full items-center gap-1 text-left disabled:cursor-default"
              >
                <h2 className="font-display text-text-hi truncate text-[20px] font-semibold tracking-[-0.01em]">
                  {name}
                </h2>
                {others.length > 0 ? (
                  <Icon name="chevronDown" size={16} className="text-text-lo group-hover:text-text-hi shrink-0" />
                ) : null}
              </button>
              <p className="text-text-mid text-meta">
                {members === 1 ? "1 member" : `${members} members`}
                {team.myRole && team.myRole !== "member" ? ` · you are ${team.myRole === "owner" ? "the owner" : "an admin"}` : ""}
              </p>
            </div>
            <IconButton name="user" label="Members" size={17} onClick={() => setTeamPane("members")} />
            <IconButton name="settings" label="Team settings" size={17} onClick={() => setTeamPane("settings")} />
          </div>
          {team.description ? (
            <p className="text-text-mid text-body leading-relaxed whitespace-pre-wrap">{team.description}</p>
          ) : null}
          <p className="text-text-lo text-meta leading-relaxed">
            Only members can read this. The server sees who is in the team and when they post, not what they post.
          </p>
        </header>

        <TeamComposer team={team} onPosted={() => void reload()} />

        {problem ? <Callout tone="danger">{problem}</Callout> : null}

        {board === null ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-32" />
            <Skeleton className="h-24" />
          </div>
        ) : (
          <>
            {board.pinned.length > 0 ? (
              <section aria-label="Pinned" className="flex flex-col gap-3">
                {board.pinned.map((post) => (
                  <TeamPostCard key={post.id} team={team} post={post} now={now} onChanged={() => void reload()} />
                ))}
              </section>
            ) : null}

            <section aria-label="Posts" className="flex flex-col gap-3">
              {board.items.map((item) => (
                <Item key={key(item)} item={item} team={team} now={now} onChanged={() => void reload()} />
              ))}
            </section>

            {board.orphans.length > 0 ? (
              <section aria-label="Comments on earlier posts" className="flex flex-col gap-2">
                <p className="text-text-mid text-meta font-medium">Comments on a post that isn't on this device</p>
                <TeamComments
                  team={team}
                  postId=""
                  comments={board.orphans}
                  now={now}
                  onChanged={() => void reload()}
                  canComment={false}
                />
              </section>
            ) : null}

            {board.joinedLate ? (
              <p className="text-text-lo flex items-center justify-center gap-2 border-t border-[var(--hairline)] py-4 text-meta">
                <Icon name="clock" size={14} />
                Posts from before you joined aren't on this device.
              </p>
            ) : board.pinned.length === 0 && board.items.length === 0 ? (
              <EmptyState
                icon="team"
                title="Nothing posted yet"
                body="Whatever you post here is read by the people in this team and nobody else."
              />
            ) : null}
          </>
        )}
      </div>
      {switcher.menu}
    </div>
  );
}

function key(item: BoardItem): string {
  return item.kind === "post" ? item.id : `${item.kind}-${item.envelopeId}`;
}

function Item({ item, team, now, onChanged }: { item: BoardItem; team: Team; now: Date; onChanged: () => void }) {
  if (item.kind === "post") return <TeamPostCard team={team} post={item} now={now} onChanged={onChanged} />;
  // Rule 7: a post nobody can read is said, in its place -- never skipped.
  return (
    <div className="rounded-panel text-text-mid flex items-center gap-3 border border-dashed border-line px-4 py-3 text-body">
      <Icon name="alert" size={16} className="text-text-lo shrink-0" />
      <span className="flex-1">
        {item.kind === "unreadable"
          ? "A post here couldn't be decrypted on this device."
          : "A post here needs a newer version of Nexo."}
      </span>
      <time className="text-text-lo text-meta">{relativeTime(new Date(item.sentAtMs), now)}</time>
    </div>
  );
}
