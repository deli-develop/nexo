import { describe, expect, it } from "vitest";

import { firstLink, links } from "./useLinkPreview";

/**
 * What counts as a link worth previewing. Wrong in one direction it fetches a
 * URL with a sentence's full stop glued to the end (a 404, every time); wrong
 * in the other it offers to preview something Rust will refuse to fetch.
 */
describe("firstLink", () => {
  it("finds an https link in a sentence", () => {
    expect(firstLink("look at https://example.com/page for this")).toBe(
      "https://example.com/page",
    );
  });

  it("takes the first when there are several", () => {
    expect(firstLink("https://one.example and https://two.example")).toBe(
      "https://one.example",
    );
  });

  it("does not take the sentence's punctuation with it", () => {
    expect(firstLink("read https://example.com/page.")).toBe("https://example.com/page");
    expect(firstLink("(see https://example.com/x)")).toBe("https://example.com/x");
    expect(firstLink("here: https://example.com/a,")).toBe("https://example.com/a");
  });

  it("keeps punctuation that is part of the path", () => {
    expect(firstLink("https://example.com/a.b.c/d")).toBe("https://example.com/a.b.c/d");
    expect(firstLink("https://example.com/wiki/Foo_(bar)/x")).toBe(
      "https://example.com/wiki/Foo_(bar)/x",
    );
  });

  it("ignores http, because Rust will not fetch it either", () => {
    // Offering a preview and then refusing it would read as a bug rather than
    // as the policy it is.
    expect(firstLink("http://example.com/page")).toBeNull();
  });

  it("is null when there is no link", () => {
    expect(firstLink("no links here")).toBeNull();
    expect(firstLink("")).toBeNull();
  });
});

describe("links", () => {
  it("finds every https link, in order, each without the sentence's punctuation", () => {
    expect(links("https://one.example, then (https://two.example/x).")).toEqual([
      "https://one.example",
      "https://two.example/x",
    ]);
  });

  it("finds nothing in a body without an https link", () => {
    expect(links("http://plain.example and no more")).toEqual([]);
  });
});
