import { describe, expect, it, vi } from "vitest";

import {
  messageMenuItems,
  type MessageMenuActions,
  type MessageMenuState,
} from "./menu";

const actions: MessageMenuActions = {
  reply: vi.fn(),
  copy: vi.fn(),
  forward: vi.fn(),
  edit: vi.fn(),
  react: vi.fn(),
  togglePin: vi.fn(),
  deleteForMe: vi.fn(),
  deleteForEveryone: vi.fn(),
};

const base: MessageMenuState = {
  hasBody: true,
  hasAttachment: false,
  mine: true,
  clientId: "c1",
  retracted: false,
  withinWindow: true,
  queued: false,
  pinned: false,
};

const labels = (state: Partial<MessageMenuState>) =>
  messageMenuItems({ ...base, ...state }, actions).map((item) => item.label);

/**
 * The order of the message menu.
 *
 * Worth a test rather than a careful read, because the entries come and go
 * with the message's state: "the last two" means something different in each
 * of the cases below, and every one of them is reachable by right-clicking a
 * real message. This is also where `MenuItem`'s "destructive entries always sit
 * last" is actually kept.
 */
describe("messageMenuItems", () => {
  it("ends with the two deletions, least reaching first", () => {
    expect(labels({})).toEqual([
      "Reply",
      "Copy text",
      "Forward…",
      "Edit",
      "React",
      "Pin on this device",
      "Delete for me",
      "Delete for everyone",
    ]);
  });

  it("does not offer to forward a file, whatever its body says", () => {
    // A file's body is its caption or its name, so `hasBody` is true for every
    // one — which put Forward on files that the design keeps it off, and the
    // forward arrived unmarked, as the forwarder's own.
    const onFile = labels({ hasAttachment: true });
    expect(onFile).not.toContain("Forward…");
    expect(onFile).toContain("Copy text");
  });

  it("offers Reply first, because that is what the menu is usually for", () => {
    expect(labels({})[0]).toBe("Reply");
  });

  it("cannot reply to a message with no name to refer to", () => {
    // A reply names its target the way an edit does. Sent before names
    // existed, there is nothing to point at -- absent, not shown and refused.
    expect(labels({ clientId: undefined })).not.toContain("Reply");
  });

  it("cannot reply to a message that was taken back", () => {
    expect(labels({ retracted: true })).not.toContain("Reply");
  });

  it("cannot reply to a message still in the outbox", () => {
    // Nobody has seen it, so nobody is answering it -- and its own name is
    // not yet anywhere the other side could resolve.
    expect(labels({ queued: true })).not.toContain("Reply");
  });

  it("keeps them last when there is nothing to copy", () => {
    // An image with no caption. The entry above them goes, they do not move.
    expect(labels({ hasBody: false }).slice(-2)).toEqual([
      "Delete for me",
      "Delete for everyone",
    ]);
  });

  it("leaves only the local delete once the window has closed", () => {
    // Absent, not greyed out: an action that is gone was never offered.
    const items = labels({ withinWindow: false });
    expect(items).not.toContain("Edit");
    expect(items).not.toContain("Delete for everyone");
    expect(items.at(-1)).toBe("Delete for me");
  });

  it("leaves only the local delete on somebody else's message", () => {
    const items = labels({ mine: false });
    expect(items).not.toContain("Delete for everyone");
    expect(items.at(-1)).toBe("Delete for me");
  });

  it("offers no deletion at all while the message is queued", () => {
    // No envelope id yet, and that is what both a pin and a local delete are
    // keyed by. "Delete for everyone" is still ours to offer -- taking one out
    // of the outbox is the cleanest version of it, since nothing was sent.
    const items = labels({ queued: true });
    expect(items).not.toContain("Delete for me");
    expect(items).not.toContain("Pin on this device");
    expect(items.at(-1)).toBe("Delete for everyone");
  });

  it("offers nothing to revise on a message with no name", () => {
    // Sent before message ids existed. Nothing can refer to it.
    const items = labels({ clientId: undefined });
    // Forwarding survives: it needs the words, not the name. Only the things
    // that refer to the message by name are gone.
    expect(items).toEqual([
      "Copy text",
      "Forward…",
      "Pin on this device",
      "Delete for me",
    ]);
  });

  it("does not offer to forward what there is nothing left of", () => {
    // A retracted message has no body to pass on, and a queued one has not
    // reached the first conversation yet.
    expect(labels({ retracted: true })).not.toContain("Forward…");
    expect(labels({ queued: true })).not.toContain("Forward…");
  });

  it("marks both deletions destructive", () => {
    const items = messageMenuItems(base, actions);
    expect(items.slice(-2).every((item) => item.danger)).toBe(true);
    // And nothing above them is, or "last" would not be saying anything.
    expect(items.slice(0, -2).some((item) => item.danger)).toBe(false);
  });
});
