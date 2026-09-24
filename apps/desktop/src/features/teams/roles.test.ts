import { describe, expect, it } from "vitest";

import { addRow, mayRemove, maySetRole, TEAM_CAP } from "./roles";

describe("the role rules the members screen offers", () => {
  it("lets removal go down the ladder only, and nobody remove the owner", () => {
    expect(mayRemove("owner", "admin", false)).toBe(true);
    expect(mayRemove("admin", "member", false)).toBe(true);
    expect(mayRemove("admin", "admin", false)).toBe(false);
    expect(mayRemove("admin", "owner", false)).toBe(false);
    expect(mayRemove("member", "member", false)).toBe(false);
    // Leaving: everybody but the owner.
    expect(mayRemove("member", "member", true)).toBe(true);
    expect(mayRemove("owner", "owner", true)).toBe(false);
  });

  it("moves roles between admin and member, and never to owner", () => {
    expect(maySetRole("admin", "member", "admin")).toBe(true);
    expect(maySetRole("admin", "admin", "member")).toBe(false);
    expect(maySetRole("owner", "admin", "member")).toBe(true);
    expect(maySetRole("owner", "member", "owner")).toBe(false);
    expect(maySetRole(null, "member", "admin")).toBe(false);
  });
});

describe("a row in the add-people dialog", () => {
  const members = new Set(["ada", "bo"]);
  const blocked = new Set(["zed"]);
  const row = (handle: string, over: Partial<Parameters<typeof addRow>[0]> = {}) =>
    addRow({ handle, members, blocked, seatsTaken: 3, ...over });

  it("is addable when nothing stands in the way", () => {
    expect(row("cy")).toEqual({ state: "addable" });
  });

  it("says somebody is already in, whatever the case of their handle", () => {
    expect(row("Ada")).toMatchObject({ state: "already_in" });
  });

  it("says you blocked them, which this device knows", () => {
    expect(row("zed")).toMatchObject({ state: "blocked" });
  });

  it("says the team is full once the seats are gone", () => {
    expect(row("cy", { seatsTaken: TEAM_CAP })).toMatchObject({ state: "full" });
    expect(row("cy", { seatsTaken: TEAM_CAP - 1 })).toEqual({ state: "addable" });
  });

  it("words the server's refusal without choosing between private and blocked", () => {
    const refused = row("cy", {
      outcome: { handle: "cy", added: false, reason: "That could not be delivered." },
    });
    expect(refused).toMatchObject({ state: "refused" });
    if (refused.state === "refused") {
      expect(refused.reason).toContain("private");
      expect(refused.reason).toContain("blocked you");
    }
  });

  it("says somebody who has never opened Nexo cannot be added yet", () => {
    const early = row("cy", {
      outcome: {
        handle: "cy",
        added: false,
        reason: "That handle has no key package available.",
      },
    });
    expect(early).toMatchObject({ state: "refused" });
  });

  it("says added once they are in", () => {
    expect(row("cy", { outcome: { handle: "cy", added: true } })).toEqual({ state: "added" });
  });
});
