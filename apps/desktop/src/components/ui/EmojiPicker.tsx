import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import groups from "unicode-emoji-json/data-by-group.json";

import { cn } from "../../lib/cn";
import { Icon } from "./Icon";

/** One emoji as the data package describes it. */
interface Entry {
  emoji: string;
  name: string;
  slug: string;
}

interface Group {
  name: string;
  slug: string;
  emojis: Entry[];
}

/**
 * The full standard set, bundled.
 *
 * `unicode-emoji-json` is data with no dependencies of its own and no code: the
 * list is imported, not fetched, so nothing here reaches the network and the
 * CSP stays as strict as it was. The picker itself is ours, which is the point
 * — a picker from a component library would arrive with its own styling to
 * fight, and this one is a grid of buttons in the app's own tokens.
 *
 * All 1,914 of them go into the bundle. That is the trade this was chosen for:
 * a set that is complete offline costs a few hundred kilobytes once, rather
 * than a request every time somebody opens it.
 */
const ALL = groups as Group[];

/** Kept across openings, so the ones you actually use come first. */
const RECENT_KEY = "nexo.emoji.recent";
const RECENT_MAX = 24;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]).slice(0, RECENT_MAX) : [];
  } catch {
    // A private window, or storage the browser refused. An empty list is the
    // same thing a first run looks like, which is the right fallback.
    return [];
  }
}

function remember(emoji: string): string[] {
  const next = [emoji, ...loadRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Not worth interrupting a message over.
  }
  return next;
}

/** Short labels for the group rail. The data's own names are too long for it. */
const SHORT: Record<string, string> = {
  "Smileys & Emotion": "Smileys",
  "People & Body": "People",
  "Animals & Nature": "Nature",
  "Food & Drink": "Food",
  "Travel & Places": "Travel",
  Activities: "Activity",
  Objects: "Objects",
  Symbols: "Symbols",
  Flags: "Flags",
};

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [group, setGroup] = useState<string>(ALL[0]?.name ?? "");
  const scroller = useRef<HTMLDivElement>(null);

  // Searching cuts across groups: someone typing "cat" wants the cat, not the
  // group it lives in. The slug is matched as well as the name so "thumbs_up"
  // and "thumbs up" both work.
  const results = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return null;
    const hits: Entry[] = [];
    for (const g of ALL) {
      for (const e of g.emojis) {
        if (e.name.includes(term) || e.slug.includes(term)) hits.push(e);
        if (hits.length >= 120) return hits;
      }
    }
    return hits;
  }, [query]);

  // Jumping to a group scrolls rather than filters, so the rail is a shortcut
  // through one list instead of nine separate ones.
  useEffect(() => {
    if (query) return;
    scroller.current
      ?.querySelector<HTMLElement>(`[data-group="${group}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [group, query]);

  // Stable, so the memoised grids below are not rebuilt on every render of
  // this component -- which is what makes the memo worth having at all.
  const pick = useCallback(
    (emoji: string) => {
      setRecent(remember(emoji));
      onPick(emoji);
    },
    [onPick],
  );

  return (
    <div className="flex h-[320px] w-[352px] flex-col">
      <div className="border-b border-[var(--hairline)] p-2">
        <div className="relative">
          <Icon
            name="search"
            size={14}
            className="text-text-lo pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search emoji"
            className="text-text-hi placeholder:text-text-lo rounded-control bg-surface-3 w-full py-1.5 pr-2 pl-8 text-meta outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-2">
        {results ? (
          results.length === 0 ? (
            <p className="text-text-lo px-1 py-4 text-center text-meta">Nothing matches.</p>
          ) : (
            <Grid entries={results} onPick={pick} />
          )
        ) : (
          <>
            {recent.length > 0 ? (
              <section>
                <h3 className="text-text-lo px-1 pb-1 text-[11px] font-medium">Recent</h3>
                <Grid entries={recent.map((emoji) => ({ emoji, name: emoji, slug: emoji }))} onPick={pick} />
              </section>
            ) : null}
            {ALL.map((g) => (
              <section
                key={g.slug}
                data-group={g.name}
                // The whole reason this picker used to take seconds to appear.
                //
                // All 1,914 emoji are in the DOM at once, which is the design:
                // the group rail scrolls through one list rather than swapping
                // nine. What cost the time was not the elements but the
                // *glyphs* -- the browser was rasterising the entire standard
                // set out of the system emoji font before it could draw the
                // first row.
                //
                // `content-visibility: auto` lets it skip layout and paint for
                // a section that is off screen, and do that work when the
                // section scrolls into view. `contain-intrinsic-size` is what
                // keeps the scrollbar and the rail's jump-to-group honest
                // while a section is skipped: without a placeholder height
                // every unrendered group would measure zero and the list would
                // shudder as it scrolled.
                style={{
                  contentVisibility: "auto",
                  containIntrinsicSize: `auto ${sectionHeight(g.emojis.length)}px`,
                }}
              >
                <h3 className="text-text-lo px-1 pt-2 pb-1 text-[11px] font-medium">{g.name}</h3>
                <Grid entries={g.emojis} onPick={pick} />
              </section>
            ))}
          </>
        )}
      </div>

      <div className="flex gap-0.5 border-t border-[var(--hairline)] p-1">
        {ALL.map((g) => (
          <button
            key={g.slug}
            type="button"
            title={g.name}
            aria-label={g.name}
            onClick={() => {
              setQuery("");
              setGroup(g.name);
            }}
            className={cn(
              "rounded-control flex-1 px-1 py-1.5 text-[10px] transition-colors duration-[var(--motion-fast)]",
              group === g.name && !query
                ? "bg-fill-active text-text-hi"
                : "text-text-lo hover:bg-fill-hover",
            )}
          >
            {SHORT[g.name] ?? g.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Roughly how tall a group will be once drawn.
 *
 * Eight per row at 40px, plus the heading. It does not have to be exact --
 * `contain-intrinsic-size` is a placeholder, and the real height replaces it
 * the moment the section is rendered -- it only has to be close enough that
 * scrolling does not lurch.
 */
function sectionHeight(count: number): number {
  return Math.ceil(count / 8) * 42 + 24;
}

/**
 * Memoised on purpose.
 *
 * Nine of these are mounted at once and the picker re-renders on every
 * keystroke in the search box and every tap on the group rail. Without this,
 * each of those rebuilt all 1,914 buttons.
 */
const Grid = memo(function Grid({
  entries,
  onPick,
}: {
  entries: Entry[];
  onPick: (emoji: string) => void;
}) {
  return (
    <div className="grid grid-cols-8 gap-0.5">
      {entries.map((entry, index) => (
        <button
          key={`${entry.slug}-${index}`}
          type="button"
          title={entry.name}
          aria-label={entry.name}
          onClick={() => onPick(entry.emoji)}
          className="hover:bg-fill-hover rounded-control flex size-10 items-center justify-center text-[21px] leading-none transition-colors duration-[var(--motion-fast)]"
        >
          {/* User content, not chrome: an emoji is what someone picked, and it
              is drawn by the system font rather than the icon set. */}
          <span aria-hidden="true">{entry.emoji}</span>
        </button>
      ))}
    </div>
  );
});
