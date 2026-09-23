import { useEffect, useState } from "react";

import { previewLink, type LinkPreviewData } from "../lib/native";
import { useApp } from "./store";

/**
 * The first https link in a message body, if there is one.
 *
 * Only `https`, matching what Rust will agree to fetch — offering to preview
 * an `http` link and then refusing it would read as a bug rather than as the
 * policy it is. Exported for its test.
 */
export function firstLink(body: string): string | null {
  return links(body)[0] ?? null;
}

/**
 * Every https link in a message body, in order — the same rule as
 * `firstLink`, for the context panel's list of what was shared.
 */
export function links(body: string): string[] {
  // Trailing punctuation is almost always the sentence's, not the URL's.
  return [...body.matchAll(/https:\/\/[^\s<>"']+/g)].map((match) =>
    match[0].replace(/[.,;:!?)\]]+$/, ""),
  );
}

/**
 * Fetched previews, kept for the lifetime of the process.
 *
 * A conversation scrolled back and forth would otherwise re-fetch the same
 * link repeatedly — and every fetch is another ping to whoever owns that URL,
 * which is exactly the cost this feature is asking the user to accept. Not
 * persisted: what someone has read is not something to write down.
 *
 * `null` is cached too. A link that has no preview has none the second time,
 * and retrying on every render would be the noisiest possible way to find out.
 */
const cache = new Map<string, Promise<LinkPreviewData | null>>();

function lookup(url: string): Promise<LinkPreviewData | null> {
  const existing = cache.get(url);
  if (existing) return existing;
  const pending = previewLink(url);
  cache.set(url, pending);
  return pending;
}

/**
 * The preview for a message body, or `null` (§4.5).
 *
 * Returns `null` immediately when the preference is off, without asking Rust
 * for anything: the setting is about whether the fetch happens at all, so a
 * hook that fetched first and hid the result afterwards would honour the
 * checkbox visually while breaking its actual promise.
 */
export function useLinkPreview(body: string): LinkPreviewData | null {
  const enabled = useApp((s) => s.preferences.linkPreviews);
  const [preview, setPreview] = useState<LinkPreviewData | null>(null);

  useEffect(() => {
    if (!enabled) {
      setPreview(null);
      return;
    }
    const url = firstLink(body);
    if (!url) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void lookup(url).then((found) => {
      if (!cancelled) setPreview(found);
    });
    return () => {
      cancelled = true;
    };
  }, [body, enabled]);

  return preview;
}
