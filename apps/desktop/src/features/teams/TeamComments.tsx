import type { BoardComment } from "@nexo/core";
import { useState } from "react";

import { Button } from "../../components/ui/Button";
import { relativeTime } from "../../lib/format";
import { commentOn, type Team } from "../../lib/teams";
import { AuthorAvatar, useAuthor } from "./Author";
import { InlineEditor, MoreButton, Reactions, useEntryMenu } from "./entry";

/**
 * A post's comments, and one level of answers under each.
 *
 * The nesting was decided by the fold (`packages/core/src/board.ts`), which
 * keeps a comment whose parent does not fit rather than dropping it. This
 * only draws the tree it is given, and offers "Reply" on the top level alone
 * so nobody writes an answer the next device would flatten.
 */
export function TeamComments({
  team,
  postId,
  comments,
  now,
  onChanged,
  canComment = true,
}: {
  team: Team;
  postId: string;
  comments: BoardComment[];
  now: Date;
  onChanged: () => void;
  /** False for comments whose post is not on this device: there is nothing to answer onto. */
  canComment?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {comments.map((comment) => (
        <div key={comment.id} className="flex flex-col gap-2">
          <Comment
            team={team}
            postId={postId}
            comment={comment}
            now={now}
            onChanged={onChanged}
            topLevel={canComment}
          />
          {comment.replies.length > 0 ? (
            <div className="ml-9 flex flex-col gap-2 border-l border-[var(--hairline)] pl-3">
              {comment.replies.map((reply) => (
                <Comment key={reply.id} team={team} postId={postId} comment={reply} now={now} onChanged={onChanged} />
              ))}
            </div>
          ) : null}
        </div>
      ))}
      {canComment ? <CommentBox team={team} postId={postId} onSent={onChanged} /> : null}
    </div>
  );
}

function Comment({
  team,
  postId,
  comment,
  now,
  onChanged,
  topLevel = false,
}: {
  team: Team;
  postId: string;
  comment: BoardComment;
  now: Date;
  onChanged: () => void;
  topLevel?: boolean;
}) {
  const { name } = useAuthor(team, comment.author);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [replying, setReplying] = useState(false);
  const gone = comment.state !== "live";
  const { onContextMenu, menu, hasItems } = useEntryMenu({
    team,
    id: comment.id,
    body: comment.body,
    mine: comment.author === null,
    sentAtMs: comment.sentAtMs,
    gone,
    pinnable: false,
    pinned: false,
    onEdit: () => setEditing(true),
    onReact: () => setPicking(true),
    onChanged,
  });

  return (
    <div className="flex gap-2.5" onContextMenu={onContextMenu}>
      <AuthorAvatar team={team} device={comment.author} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-text-hi truncate text-meta font-medium">{name}</span>
          <time className="text-text-lo shrink-0 text-[11px]">
            {relativeTime(new Date(comment.sentAtMs), now)}
          </time>
          {comment.editedAtMs !== undefined ? <span className="text-text-lo text-[11px]">edited</span> : null}
          <span className="flex-1" />
          {hasItems ? <MoreButton onOpen={onContextMenu} /> : null}
        </div>

        {gone ? (
          <p className="text-text-lo text-body italic">
            {comment.state === "removed" ? "Removed by an admin." : "Taken back by its author."}
          </p>
        ) : editing ? (
          <InlineEditor
            team={team}
            id={comment.id}
            initial={comment.body}
            onDone={() => {
              setEditing(false);
              onChanged();
            }}
          />
        ) : (
          <p className="text-text-hi text-body leading-relaxed whitespace-pre-wrap break-words">{comment.body}</p>
        )}

        {!gone ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Reactions
              team={team}
              target={comment.id}
              reactions={comment.reactions}
              picking={picking}
              setPicking={setPicking}
              onChanged={onChanged}
            />
            {topLevel ? (
              <Button variant="ghost" className="h-7 px-2 text-meta" onClick={() => setReplying(!replying)}>
                Reply
              </Button>
            ) : null}
          </div>
        ) : null}

        {replying ? (
          <div className="mt-2">
            <CommentBox
              team={team}
              postId={postId}
              parent={comment.id}
              onSent={() => {
                setReplying(false);
                onChanged();
              }}
            />
          </div>
        ) : null}
      </div>
      {menu}
    </div>
  );
}

function CommentBox({
  team,
  postId,
  parent,
  onSent,
}: {
  team: Team;
  postId: string;
  parent?: string;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <form
      className="flex items-end gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (text.trim() === "" || busy) return;
        setBusy(true);
        setProblem(null);
        try {
          await commentOn(team.id, postId, text, parent);
          setText("");
          onSent();
        } catch (error) {
          setProblem(error instanceof Error ? error.message : "That comment was not sent.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={1}
          aria-label={parent ? "Reply" : "Comment"}
          placeholder={parent ? "Reply…" : "Comment…"}
          className="rounded-control text-text-hi placeholder:text-text-lo min-h-9 w-full resize-none border border-line bg-fill px-3 py-2 text-body outline-none focus-visible:border-line-strong"
        />
        {problem ? <p className="text-danger text-meta">{problem}</p> : null}
      </div>
      <Button type="submit" variant="secondary" disabled={busy || text.trim() === ""}>
        {parent ? "Reply" : "Comment"}
      </Button>
    </form>
  );
}
