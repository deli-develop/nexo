import { describe, expect, it } from "vitest";

import { decodePayload, encodePayload, encodePayloadString, preview } from "./payload";

/**
 * The payload codec.
 *
 * Mirrors the cases `crates/protocol`'s own tests assert, because the two ends
 * have to agree and nothing at runtime will tell them if they stop.
 */
describe("payload", () => {
  it("round-trips a text message", () => {
    const encoded = encodePayload({ kind: "text", body: "the mountains are out" });
    expect(decodePayload(encoded)).toEqual({ kind: "text", body: "the mountains are out" });
  });

  it("leaves absent fields out of the wire entirely", () => {
    // Adding a field must not change a byte of what a message without it puts
    // on the wire, or every message this build sends becomes something older
    // builds have to tolerate for no reason.
    expect(encodePayloadString({ kind: "text", body: "hi" })).toBe('{"kind":"text","body":"hi"}');
  });

  it("names a kind it cannot read instead of guessing at it", () => {
    // A newer client sends a shape this build has never heard of. The honest
    // answer is to say so — not to render the raw JSON as though somebody
    // had typed it, which is what this used to do.
    const fromTheFuture = '{"kind":"hologram","body":"hello"}';
    expect(decodePayload(fromTheFuture)).toEqual({
      kind: "unsupported",
      unsupportedKind: "hologram",
    });
  });

  it("still reads bare UTF-8 as text", () => {
    // The very first messages this project sent had no envelope at all.
    // Refusing them now would be self-inflicted data loss.
    expect(decodePayload("just some words")).toEqual({ kind: "text", body: "just some words" });
  });

  it("treats JSON that is not an object as somebody's message", () => {
    // `42` and `"hello"` are valid JSON and are not payloads. Somebody typed
    // them, so they are text.
    expect(decodePayload("42")).toEqual({ kind: "text", body: "42" });
    expect(decodePayload('"quoted"')).toEqual({ kind: "text", body: '"quoted"' });
  });

  it("treats a JSON object with no kind as text, not as a broken payload", () => {
    const typed = '{"hello": "world"}';
    expect(decodePayload(typed)).toEqual({ kind: "text", body: typed });
  });

  it("refuses to encode an unsupported payload", () => {
    // Received, never sent. Encoding one would be claiming to speak a variant
    // this build does not understand.
    expect(() =>
      encodePayloadString({ kind: "unsupported", unsupportedKind: "hologram" }),
    ).toThrow(/never sent/);
  });

  it("previews only the things somebody said", () => {
    expect(preview({ kind: "text", body: "hello" })).toBe("hello");
    // `target`, not `quoted`: the Rust variant names it that, and a reply
    // whose field does not match is a reply nobody can see the quote of.
    expect(preview({ kind: "reply", body: "yes", target: "m1" })).toBe("yes");
    // A reaction changes shared state and draws no bubble, so it must not
    // become the conversation list's preview.
    expect(preview({ kind: "reaction", target: "m1", emoji: "👍", on: true })).toBe("");
    expect(preview({ kind: "rename", title: "Weekend" })).toBe("");
    expect(preview({ kind: "unsupported", unsupportedKind: "hologram" })).toBe("");
  });
});
