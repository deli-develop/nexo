import { useCallback, useEffect, useState } from "react";

import { asConversationError } from "../../lib/conversations";
import { listStories, type Story } from "../../lib/stories";

export interface StoriesRead {
  /** `null` until the first read returns. */
  stories: Story[] | null;
  /** Re-reads, which is also the purge -- see `listStories`. */
  refresh: () => Promise<void>;
  problem: string | null;
}

/**
 * Every live story this device holds, read once and re-readable.
 *
 * Shared by the strip, and by every avatar that needs to answer "does this
 * person currently have a story" -- Home's strip, your own profile, and a
 * contact's. Each of those calls this independently rather than sharing one
 * cached copy: `listStories()` is a local read (SQLCipher, with an
 * unauthenticated-friendly `Ok(())` for "not signed in yet"), reading it
 * again is what runs the purge on every surface that opens, and the story
 * listing route it now reconciles against carries no rate limit -- unlike
 * `create` and `download_url`, `list` in `apps/server/src/stories.rs` never
 * calls `state.limits.media.check`.
 */
export function useStories(): StoriesRead {
  const [stories, setStories] = useState<Story[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStories(await listStories());
      setProblem(null);
    } catch (error) {
      const e = asConversationError(error);
      // Not being signed in yet is not a failure worth a banner.
      if (e.kind !== "signed_out") setProblem(e.message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { stories, refresh, problem };
}
