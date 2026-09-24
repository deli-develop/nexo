import { describe, expect, it } from "vitest";

import { postMenuItems, type PostMenuState } from "./postMenu";

const noop = () => {};
const actions = {
  copy: noop,
  edit: noop,
  react: noop,
  togglePin: noop,
  takeBack: noop,
  removeForEveryone: noop,
};

const base: PostMenuState = {
  hasBody: true,
  mine: false,
  withinWindow: true,
  gone: false,
  moderates: false,
  pinnable: true,
  pinned: false,
};

const labels = (state: Partial<PostMenuState>) =>
  postMenuItems({ ...base, ...state }, actions).map((item) => item.label);

describe("a team post's menu", () => {
  it("offers a member only copying and reacting on somebody else's post", () => {
    expect(labels({})).toEqual(["Copy text", "React"]);
  });

  it("lets the author edit and take back inside the window, and not after", () => {
    expect(labels({ mine: true })).toEqual(["Copy text", "Edit", "React", "Take back"]);
    expect(labels({ mine: true, withinWindow: false })).toEqual(["Copy text", "React"]);
  });

  it("gives an admin pinning and removal, with removal last", () => {
    expect(labels({ moderates: true })).toEqual([
      "Copy text",
      "React",
      "Pin for everyone",
      "Remove for everyone",
    ]);
    expect(labels({ moderates: true, pinned: true })).toContain("Unpin for everyone");
  });

  it("puts the author's take-back before an admin's removal, never after", () => {
    // An admin's own post: they take it back, they do not "remove" it.
    expect(labels({ moderates: true, mine: true })).toEqual([
      "Copy text",
      "Edit",
      "React",
      "Pin for everyone",
      "Take back",
    ]);
  });

  it("keeps every destructive entry after every other one, in every state", () => {
    for (const mine of [true, false]) {
      for (const moderates of [true, false]) {
        for (const withinWindow of [true, false]) {
          for (const pinnable of [true, false]) {
            const items = postMenuItems({ ...base, mine, moderates, withinWindow, pinnable }, actions);
            const firstRed = items.findIndex((item) => item.danger);
            if (firstRed === -1) continue;
            expect(items.slice(firstRed).every((item) => item.danger)).toBe(true);
          }
        }
      }
    }
  });

  it("does not offer pinning a comment", () => {
    expect(labels({ moderates: true, pinnable: false })).not.toContain("Pin for everyone");
  });

  it("offers nothing on a post that is already gone", () => {
    expect(labels({ gone: true, moderates: true, mine: true })).toEqual([]);
  });
});
