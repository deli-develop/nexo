import { useCallback, useEffect, useMemo, useState } from "react";

import { useApp } from "../../app/store";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import {
  addComment,
  asFeedError,
  comments as commentsCall,
  deleteComment,
  type Comment,
} from "../../lib/feed";
import { Avatar } from "../../components/ui/Avatar";
import { HandleAvatar } from "../../components/ui/HandleAvatar";
import { Button, IconButton } from "../../components/ui/Button";
import { Callout, Skeleton } from "../../components/ui/Feedback";
import { ReportDialog } from "./ReportDialog";

/** How deep the indent goes before it stops growing. */
const MAX_INDENT = 6;

/** A comment with its replies hanging off it. */
interface Node {
  comment: Comment;
  replies: Node[];
}

/**
 * Rebuilds the thread from a flat list.
 *
 * The server sends comments flat and ordered by id, which keeps the response
 * shape independent of depth. The tree is assembled here because this is the
 * only place that cares about it.
 *
 * A reply whose parent is missing is promoted to the top rather than dropped.
 * That should not happen — the server refuses a parent from another post — but
 * losing somebody's comment because of a broken link is the worse failure.
 */
export function buildThread(comments: Comment[]): Node[] {
  const nodes = new Map<number, Node>();
  for (const comment of comments) {
    nodes.set(comment.id, { comment, replies: [] });
  }

  const roots: Node[] = [];
  for (const comment of comments) {
    const node = nodes.get(comment.id)!;
    const parent = comment.parent_id === null ? undefined : nodes.get(comment.parent_id);
    if (parent) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}

export function CommentThread({ postId, now }: { postId: number; now: Date }) {
  const [thread, setThread] = useState<Comment[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setThread(await commentsCall(postId));
      setProblem(null);
    } catch (error) {
      setProblem(asFeedError(error).message);
    }
  }, [postId]);

  useEffect(() => {
    void load();
  }, [load]);

  const roots = useMemo(() => buildThread(thread ?? []), [thread]);

  const add = useCallback(
    async (body: string, parentId: number | null) => {
      const created = await addComment(postId, body, parentId);
      // Appended rather than refetched: the round trip already happened, and a
      // second one before your own comment appears reads as "it didn't work".
      setThread((current) => [...(current ?? []), created]);
    },
    [postId],
  );

  const remove = useCallback(async (id: number) => {
    try {
      await deleteComment(id);
      // Blanked in place, not removed. The row keeps its position so replies
      // underneath keep theirs — the same reason the server soft-deletes.
      setThread((current) =>
        (current ?? []).map((c) => (c.id === id ? { ...c, body: "", deleted: true } : c)),
      );
    } catch (error) {
      setProblem(asFeedError(error).message);
    }
  }, []);

  return (
    <section className="mt-3 border-t border-[var(--hairline)] pt-3">
      <CommentComposer placeholder="Add a comment" onSubmit={(body) => add(body, null)} />

      {problem ? (
        <Callout tone="warning" icon="alert" className="mt-3">
          {problem}
        </Callout>
      ) : null}

      {thread === null ? (
        <div className="mt-3 flex flex-col gap-2" aria-label="Loading comments">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : roots.length === 0 ? (
        <p className="text-text-lo mt-3 text-meta">No comments yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {roots.map((node) => (
            <CommentNode
              key={node.comment.id}
              node={node}
              depth={0}
              now={now}
              onReply={add}
              onDelete={remove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CommentNode({
  node,
  depth,
  now,
  onReply,
  onDelete,
}: {
  node: Node;
  depth: number;
  now: Date;
  onReply: (body: string, parentId: number | null) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [replying, setReplying] = useState(false);
  const [reporting, setReporting] = useState(false);
  const viewProfile = useApp((s) => s.viewProfile);
  const { comment } = node;

  return (
    <li>
      <div className="flex gap-2.5">
        <HandleAvatar
          handle={comment.author_handle}
          name={comment.author_display_name}
          size={26}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <button
              type="button"
              onClick={() => viewProfile(comment.author_handle)}
              className="text-text-hi truncate text-meta font-medium hover:underline"
            >
              {comment.author_display_name}
            </button>
            <span className="text-text-lo truncate text-[11px]">@{comment.author_handle}</span>
            <span className="text-text-lo shrink-0 text-[11px]">
              {relativeTime(new Date(comment.created_at_ms), now)}
            </span>
          </div>

          {comment.deleted ? (
            // Kept rather than removed, so its replies keep their place. Saying
            // "deleted" is the honest showing; dropping the row would silently
            // reparent everything under it.
            <p className="text-text-lo mt-0.5 text-meta italic">[deleted]</p>
          ) : (
            <p className="text-text-hi mt-0.5 text-meta leading-relaxed whitespace-pre-wrap">
              {comment.body}
            </p>
          )}

          <div className="mt-1 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setReplying((open) => !open)}
              className="text-text-lo hover:text-text-hi rounded-full px-1.5 py-0.5 text-[11px]"
            >
              Reply
            </button>
            {comment.is_mine && !comment.deleted ? (
              <IconButton
                name="trash"
                label="Delete this comment"
                size={13}
                onClick={() => void onDelete(comment.id)}
              />
            ) : null}
            {/* Somebody else's, and still there to be read. A word beside
                Reply rather than a menu: a comment has one other thing to do
                with it, and a menu for one entry is a click spent finding it. */}
            {!comment.is_mine && !comment.deleted ? (
              <button
                type="button"
                onClick={() => setReporting(true)}
                className="text-text-lo hover:text-text-hi rounded-full px-1.5 py-0.5 text-[11px]"
              >
                Report
              </button>
            ) : null}
          </div>
          {reporting ? (
            <ReportDialog
              subject="comment"
              id={comment.id}
              name={comment.author_display_name}
              onClose={() => setReporting(false)}
            />
          ) : null}

          {replying ? (
            <CommentComposer
              placeholder={`Reply to ${comment.author_display_name}`}
              autoFocus
              onCancel={() => setReplying(false)}
              onSubmit={async (body) => {
                await onReply(body, comment.id);
                setReplying(false);
              }}
            />
          ) : null}
        </div>
      </div>

      {node.replies.length > 0 ? (
        <ul
          className={cn(
            "mt-3 flex flex-col gap-3 border-l border-[var(--hairline)] pl-3",
            // The indent stops growing after a few levels. A thread deep enough
            // to run out of width is one where the line, not the offset, is
            // what still says who replied to whom.
            depth >= MAX_INDENT ? "ml-0" : "ml-3",
          )}
        >
          {node.replies.map((child) => (
            <CommentNode
              key={child.comment.id}
              node={child}
              depth={depth + 1}
              now={now}
              onReply={onReply}
              onDelete={onDelete}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** §6.2's limit again: a comment is as long as a post. */
const MAX_COMMENT = 2000;

function CommentComposer({
  placeholder,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  placeholder: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const me = useApp((s) => s.account);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onSubmit(text);
      setBody("");
      setProblem(null);
    } catch (error) {
      setProblem(asFeedError(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <div className="flex gap-2.5">
        <Avatar seed={me?.handle ?? "you"} name={me?.display_name ?? "You"} size={26} />
        <textarea
          rows={1}
          value={body}
          maxLength={MAX_COMMENT}
          autoFocus={autoFocus}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line: a comment is usually
            // one line, and reaching for a button for one line is a nuisance.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          aria-label={placeholder}
          placeholder={placeholder}
          className="text-text-hi placeholder:text-text-lo rounded-control min-h-[34px] max-h-[240px] flex-1 resize-y overflow-y-auto bg-surface-3 px-3 py-1.5 text-meta leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-accent [field-sizing:content]"
        />
      </div>

      {problem ? (
        <Callout tone="danger" icon="alert" className="mt-2">
          {problem}
        </Callout>
      ) : null}

      {body.trim() || onCancel ? (
        <div className="mt-2 flex gap-2 pl-[36px]">
          <Button variant="primary" disabled={!body.trim() || busy} onClick={() => void submit()}>
            {busy ? "Posting…" : "Comment"}
          </Button>
          {onCancel ? (
            <Button onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
