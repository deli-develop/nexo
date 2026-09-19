import type { Story } from "../../lib/stories";

/** Marks the group that is this device's own stories. */
const MINE = "__mine__";

/** One person's stories, oldest first — the order a sequence is watched in. */
export interface StoryGroup {
  /** Stable across a render: a handle when resolved, else the device id. */
  key: string;
  mine: boolean;
  /** Best name available. Empty when this author has not been resolved yet. */
  authorHandle: string;
  /** This author's live stories, oldest first. Never empty. */
  stories: Story[];
}

/**
 * One circle per person, not one per story.
 *
 * `listStories()` is a flat list — every live story on this device, own and
 * received mixed together — and drawing it as-is meant somebody with two
 * stories up got two circles in the strip, indistinguishable from two
 * different people. This groups them the way the strip is supposed to read:
 * tap a person, watch what they posted.
 *
 * Grouped by handle where one is known, and by device id where it is not —
 * the fallback is what keeps two different unresolved people from merging
 * into one circle while offline. It stops being needed the moment
 * `stories::live`'s reconciliation catches up, because two received stories
 * that resolve to the *same* handle from *different* devices correctly merge
 * once the handle is what groups them — someone's second device posting is
 * still one person's story circle, not two.
 *
 * The input arrives newest-first (`live_stories` in the store orders it that
 * way, matching every other list in this app); within a group that is
 * reversed, because a *sequence* is watched in the order it happened, not
 * backwards. The groups themselves keep that same newest-activity order,
 * except "mine" always leads — the one circle that is unambiguously yours
 * belongs where you look for it first, not wherever chance put its most
 * recent post in the feed.
 */
export function groupStories(stories: Story[]): StoryGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, StoryGroup>();

  for (const story of stories) {
    const mine = story.author_device_id === "";
    const key = mine ? MINE : story.author_handle || story.author_device_id;
    let group = byKey.get(key);
    if (!group) {
      group = { key, mine, authorHandle: story.author_handle, stories: [] };
      byKey.set(key, group);
      order.push(key);
    } else if (!group.authorHandle && story.author_handle) {
      // Every story in a device-id-keyed group should carry the same blank
      // handle, but if a later entry in this same read turned out resolved
      // and an earlier one did not, prefer the answer over the gap.
      group.authorHandle = story.author_handle;
    }
    group.stories.push(story);
  }

  for (const group of byKey.values()) group.stories.reverse();

  const groups = order.map((key) => byKey.get(key)!);
  const mine = groups.filter((g) => g.mine);
  const others = groups.filter((g) => !g.mine);
  return [...mine, ...others];
}

/**
 * One person's group, if this device currently holds a live story of theirs.
 *
 * `null` asks for the reader's own group. Built on `groupStories` rather than
 * scanning the flat list separately, so there is exactly one place that
 * decides what "the same person" means -- a handle where one is known, a
 * device id while it is not, and the reader's own empty device id never
 * confused with either.
 */
export function storyGroupFor(
  stories: Story[],
  handle: string | null,
): StoryGroup | undefined {
  return groupStories(stories).find((g) =>
    handle === null ? g.mine : g.authorHandle === handle,
  );
}

/** Whether this device currently holds a live story for that person. */
export function hasLiveStory(stories: Story[], handle: string | null): boolean {
  return storyGroupFor(stories, handle) !== undefined;
}
