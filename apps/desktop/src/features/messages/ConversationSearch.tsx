import { useCallback, useEffect, useRef, useState } from "react";

import {
  asConversationError,
  searchMessages,
  type SearchHit,
} from "../../lib/conversations";
import { IconButton } from "../../components/ui/Button";
import { Field } from "../../components/ui/Controls";
import { jumpToMessage } from "./jump";

/**
 * Searching inside the conversation you are looking at.
 *
 * The engine has been here the whole time: `Store.searchMessages` in
 * `packages/core` looks words up in the `searchTerms` index, and the
 * conversation list has used it to decide which rows match. What was missing was the other half of what people expect from
 * `Ctrl+F` — finding the message *in* this chat and being taken to it.
 *
 * # Why the scoping happens in the store
 *
 * The store takes the conversation as part of the query rather than filtering
 * afterwards, because the limit is applied last: filtering the result would
 * search the newest messages anywhere and then keep whichever were in this
 * chat. A quiet conversation beside a busy one would find nothing and call it
 * "no matches".
 *
 * # Why results are walked newest-first
 *
 * The store returns newest first and this keeps that order, so "next" moves
 * backwards through time — which is the direction you are looking when you are
 * trying to find something you remember saying.
 *
 * The term never leaves the machine. A server-side search would need the
 * plaintext, and the server does not have it.
 */
export function ConversationSearch({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [at, setAt] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);

  // Opening it puts the cursor in it. A search box that needs to be clicked
  // before it can be typed into is a shortcut that saved nobody anything.
  useEffect(() => {
    box.current?.focus();
  }, []);

  // Starting again when the conversation changes, rather than carrying one
  // chat's results into another where the envelope ids mean nothing.
  useEffect(() => {
    setTerm("");
    setHits([]);
    setAt(0);
    setProblem(null);
  }, [conversationId]);

  useEffect(() => {
    const cleaned = term.trim();
    if (!cleaned) {
      setHits([]);
      setAt(0);
      return;
    }
    let cancelled = false;
    // Debounced for the same reason the list's box is: a query per keystroke
    // is an FTS scan per keystroke.
    const timer = window.setTimeout(() => {
      void searchMessages(cleaned, { conversationId, limit: 200 })
        .then((found) => {
          if (cancelled) return;
          setHits(found);
          setAt(0);
          setProblem(null);
          if (found.length > 0) jumpToMessage(found[0]!.envelope_id);
        })
        .catch((error) => {
          if (!cancelled) setProblem(asConversationError(error).message);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [term, conversationId]);

  const step = useCallback(
    (by: number) => {
      if (hits.length === 0) return;
      // Wraps, because the alternative is a disabled button at each end and a
      // person pressing it anyway.
      const next = (at + by + hits.length) % hits.length;
      setAt(next);
      jumpToMessage(hits[next]!.envelope_id);
    },
    [at, hits],
  );

  const count =
    term.trim() === ""
      ? ""
      : hits.length === 0
        ? "No matches"
        : `${at + 1} of ${hits.length}`;

  return (
    <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-3 py-2">
      <div className="min-w-0 flex-1">
        <Field
          ref={box}
          label="Search this conversation"
          hideLabel
          icon="search"
          placeholder="Search this conversation"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
            if (event.key === "Enter") {
              event.preventDefault();
              // Shift walks back up, the way a browser's find does.
              step(event.shiftKey ? -1 : 1);
            }
          }}
          {...(problem ? { error: problem } : {})}
        />
      </div>
      <span className="text-text-lo shrink-0 text-meta tabular-nums">{count}</span>
      <IconButton
        name="chevronUp"
        label="Previous match"
        size={16}
        disabled={hits.length === 0}
        onClick={() => step(-1)}
      />
      <IconButton
        name="chevronDown"
        label="Next match"
        size={16}
        disabled={hits.length === 0}
        onClick={() => step(1)}
      />
      <IconButton name="close" label="Close search" size={16} onClick={onClose} />
    </div>
  );
}
