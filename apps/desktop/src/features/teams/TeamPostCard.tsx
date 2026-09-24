import type { BoardPost } from "@nexo/core";
import { useState } from "react";

import { Icon } from "../../components/ui/Icon";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import type { Team } from "../../lib/teams";
import { AuthorAvatar, useAuthor } from "./Author";
import { InlineEditor, MoreButton, Reactions, useEntryMenu } from "./entry";
import { TeamComments } from "./TeamComments";
import { TeamFiles } from "./TeamFiles";

/**
 * One post on a team's board.
 *
 * Built from the same tokens as a feed post and deliberately not one: no vote
 * controls, no "public" line, no reach. What makes a board private is said by
 * the board's own header (the team, its members, who can read it); a card
 * carries no padlock, because a padlock on each post would claim more than
 * MLS gives and turn the claim into decoration.
 *
 * A post that is gone stays in its place as a line saying how -- taken back by
 * its author or removed by an admin -- because both are requests other copies
 * may not have honoured, and the board should not pretend it never existed.
 */
export function TeamPostCard({
  team,
  post,
  now,
  onChanged,
}: {
  team: Team;
  post: BoardPost;
  now: Date;
  onChanged: () => void;
}) {
  const { name } = useAuthor(team, post.author);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState(post.comments.length > 0 && post.comments.length <= 3);
  const gone = post.state !== "live";
  const { onContextMenu, menu, hasItems } = useEntryMenu({
    team,
    id: post.id,
    body: post.body,
    mine: post.author === null,
    sentAtMs: post.sentAtMs,
    gone,
    pinnable: true,
    pinned: post.pinned,
    onEdit: () => setEditing(true),
    onReact: () => setPicking(true),
    onChanged,
  });
  const commentCount = post.comments.reduce((n, c) => n + 1 + c.replies.length, 0);

  return (
    <article
      onContextMenu={onContextMenu}
      aria-label={post.title ?? `Post by ${name}`}
      className={cn(
        "rounded-panel flex flex-col gap-3 border bg-surface-2/60 p-4",
        post.pinned ? "border-line-strong" : "border-line",
      )}
    >
      <header className="flex items-center gap-3">
        <AuthorAvatar team={team} device={post.author} size={36} />
        <div className="min-w-0 flex-1">
          <p className="text-text-hi truncate text-body font-medium">{name}</p>
          <p className="text-text-lo text-meta">
            <time>{relativeTime(new Date(post.sentAtMs), now)}</time>
            {post.editedAtMs !== undefined ? " · edited" : ""}
          </p>
        </div>
        {post.pinned ? (
          <span className="text-text-mid flex items-center gap-1 text-meta">
            <Icon name="pin" size={13} />
            Pinned
          </span>
        ) : null}
        {hasItems ? <MoreButton onOpen={onContextMenu} /> : null}
      </header>

      {gone ? (
        <p className="text-text-lo text-body italic">
          {post.state === "removed"
            ? "Removed by an admin."
            : "Taken back by its author."}
        </p>
      ) : (
        <>
          {post.title ? (
            <h3 className="font-display text-text-hi text-title font-semibold tracking-[-0.01em]">{post.title}</h3>
          ) : null}
          {editing ? (
            <InlineEditor
              team={team}
              id={post.id}
              initial={post.body}
              onDone={() => {
                setEditing(false);
                onChanged();
              }}
            />
          ) : post.body ? (
            <p className="text-text-hi text-message leading-relaxed whitespace-pre-wrap break-words">{post.body}</p>
          ) : null}
          <TeamFiles files={post.files} leftOut={post.filesLeftOut} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Reactions
              team={team}
              target={post.id}
              reactions={post.reactions}
              picking={picking}
              setPicking={setPicking}
              onChanged={onChanged}
            />
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              className="text-text-mid hover:text-text-hi flex items-center gap-1.5 text-meta transition-colors duration-[var(--motion-fast)]"
            >
              <Icon name="comment" size={14} />
              {commentCount === 0 ? "Comment" : commentCount === 1 ? "1 comment" : `${commentCount} comments`}
            </button>
          </div>
        </>
      )}

      {open || (gone && post.comments.length > 0) ? (
        <div className="border-t border-[var(--hairline)] pt-3">
          <TeamComments team={team} postId={post.id} comments={post.comments} now={now} onChanged={onChanged} />
        </div>
      ) : null}
      {menu}
    </article>
  );
}
