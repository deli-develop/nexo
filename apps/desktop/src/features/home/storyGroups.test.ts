import { describe, expect, it } from "vitest";

import type { Story } from "../../lib/stories";
import { groupStories, hasLiveStory, storyGroupFor } from "./storyGroups";

const story = (over: Partial<Story>): Story => ({
  id: 1,
  author_handle: "",
  author_device_id: "dev-x",
  mime: "image/jpeg",
  created_at_ms: 0,
  expires_at_ms: 0,
  ...over,
});

/**
 * One circle per person.
 *
 * `listStories()` is a flat, newest-first list of every live story this
 * device holds — own and received mixed together, with no grouping of its
 * own. Drawing it as-is put two circles in the strip for anybody who had
 * posted twice, indistinguishable from two different people. This is the
 * function that fixes that, and the cases below are the ways the input
 * actually arrives: several posts from one person, an unresolved device
 * before the server's listing has caught up, and the reader's own copy.
 */
describe("groupStories", () => {
  it("keeps one story its own group", () => {
    const groups = groupStories([story({ id: 1, author_handle: "alice" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.authorHandle).toBe("alice");
    expect(groups[0]?.stories.map((s) => s.id)).toEqual([1]);
  });

  it("merges several posts from the same handle into one group", () => {
    const groups = groupStories([
      story({ id: 2, author_handle: "alice", created_at_ms: 200 }),
      story({ id: 1, author_handle: "alice", created_at_ms: 100 }),
    ]);
    expect(groups).toHaveLength(1);
    // Oldest first: a sequence is watched in the order it happened.
    expect(groups[0]?.stories.map((s) => s.id)).toEqual([1, 2]);
  });

  it("keeps two different people apart even before either is resolved", () => {
    // Neither has a handle yet -- offline, or the listing has not caught up.
    // The device id is what stops them collapsing into one circle.
    const groups = groupStories([
      story({ id: 1, author_device_id: "dev-a" }),
      story({ id: 2, author_device_id: "dev-b" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("merges a second device once both resolve to the same handle", () => {
    // Someone's second device posting is one person's story circle, not two
    // -- handle is a better identity than device the moment it is known.
    const groups = groupStories([
      story({ id: 1, author_device_id: "dev-a", author_handle: "alice" }),
      story({ id: 2, author_device_id: "dev-b", author_handle: "alice" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.stories).toHaveLength(2);
  });

  it("marks the device's own stories and puts that circle first", () => {
    const groups = groupStories([
      story({ id: 1, author_device_id: "dev-a", author_handle: "alice" }),
      // Own copies carry an empty device id (`stories::post` in Rust), and
      // arrive later in this newest-first list -- still leads once grouped.
      story({ id: 2, author_device_id: "", author_handle: "me" }),
    ]);
    expect(groups[0]?.mine).toBe(true);
    expect(groups[0]?.authorHandle).toBe("me");
    expect(groups[1]?.mine).toBe(false);
  });

  it("never confuses two unresolved people for the reader's own stories", () => {
    // "mine" is decided by the empty device id Rust writes for an own copy,
    // never by an empty handle -- two different unresolved contacts must not
    // both read as "mine" just because neither is named yet.
    const groups = groupStories([
      story({ id: 1, author_device_id: "dev-a" }),
      story({ id: 2, author_device_id: "dev-b" }),
    ]);
    expect(groups.every((g) => !g.mine)).toBe(true);
  });

  it("returns nothing for no stories", () => {
    expect(groupStories([])).toEqual([]);
  });
});

/**
 * The question a "has an active story" ring needs answered: does this device
 * hold a live story for this specific person, or for the reader themself.
 */
describe("storyGroupFor / hasLiveStory", () => {
  it("finds a contact's group by handle", () => {
    const stories = [story({ id: 1, author_handle: "alice" })];
    expect(storyGroupFor(stories, "alice")?.stories.map((s) => s.id)).toEqual([1]);
    expect(hasLiveStory(stories, "alice")).toBe(true);
  });

  it("finds the reader's own group with null", () => {
    const stories = [story({ id: 1, author_device_id: "", author_handle: "me" })];
    expect(storyGroupFor(stories, null)?.mine).toBe(true);
    expect(hasLiveStory(stories, null)).toBe(true);
  });

  it("is absent for somebody with no live story here", () => {
    const stories = [story({ id: 1, author_handle: "alice" })];
    expect(storyGroupFor(stories, "bob")).toBeUndefined();
    expect(hasLiveStory(stories, "bob")).toBe(false);
    expect(hasLiveStory(stories, null)).toBe(false);
  });

  it("does not let an unresolved contact answer for the reader's own ring", () => {
    // A received story with no handle yet must never satisfy `null` -- that
    // would put a stranger's story behind the reader's own avatar ring.
    const stories = [story({ id: 1, author_device_id: "dev-a", author_handle: "" })];
    expect(hasLiveStory(stories, null)).toBe(false);
  });
});
