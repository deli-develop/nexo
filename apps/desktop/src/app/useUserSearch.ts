import { useEffect, useRef, useState } from "react";

import { asPeopleError, searchUsers, type SearchResult } from "../lib/people";

/** How long typing has to stop before a search is sent. */
const DEBOUNCE_MS = 180;

/**
 * The shortest term worth sending.
 *
 * Two, matching the server, which returns nothing below that and says why:
 * one character stops being a search and becomes a download of the user table.
 * The client knowing the same number saves a round trip per keystroke for the
 * first letter of every name anybody types.
 */
export const MIN_TERM = 2;

/** Whether this is worth asking the server about. */
export function searchable(term: string): boolean {
  return term.trim().length >= MIN_TERM;
}

export interface UserSearch {
  results: SearchResult[];
  /** A request is in flight. Distinct from "no results". */
  searching: boolean;
  /** Set when the search itself failed, never when it simply found nobody. */
  problem: string | null;
}

/**
 * People matching what has been typed, as it is typed.
 *
 * Debounced, because a request per keystroke is a request per keystroke — and
 * the profile rate limiter would start refusing them halfway through a name.
 *
 * The part that is easy to get wrong is ordering. Responses come back in
 * whatever order the network gives them, so a slow answer for "al" can land
 * after a fast one for "alice" and replace the right list with a stale one.
 * Each request carries a number and only the newest one is allowed to write,
 * which is cheaper and more reliable than trying to cancel the others.
 *
 * Private accounts are absent from the answer and the *server* decides that.
 * A directory the client trims is one anybody can untrim.
 */
export function useUserSearch(term: string): UserSearch {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    if (!searchable(term)) {
      // Not an empty result: a question that was never asked. Clearing the
      // number too means an answer still in flight cannot land afterwards.
      latest.current += 1;
      setResults([]);
      setSearching(false);
      setProblem(null);
      return;
    }

    const id = ++latest.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void searchUsers(term.trim())
        .then((found) => {
          if (latest.current !== id) return;
          setResults(found);
          setProblem(null);
        })
        .catch((error) => {
          if (latest.current !== id) return;
          const e = asPeopleError(error);
          // Not being signed in yet is not a failure worth a line of red.
          setProblem(e.kind === "signed_out" ? null : e.message);
          setResults([]);
        })
        .finally(() => {
          if (latest.current === id) setSearching(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [term]);

  return { results, searching, problem };
}
