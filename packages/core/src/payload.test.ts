import { describe, expect, it } from "vitest";

import {
  MAX_PEAKS,
  decodePayload,
  encodePayload,
  encodePayloadString,
  forwardedText,
  payloadId,
  preview,
  voiceMeta,
  type Payload,
} from "./payload";

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
    expect(preview({
      kind: "story", story_id: 42, s3_key: "story/x", key: "aa", nonce: "bb",
      sha256: "cc", mime: "image/png", size: 1, expires_at_ms: 1_000,
    })).toBe("");
    expect(preview({ kind: "unsupported", unsupportedKind: "hologram" })).toBe("");
  });

  it("previews a file by its caption or its name, and a voice note as one", () => {
    const file = {
      kind: "attachment" as const, s3_key: "k", key: "aa", nonce: "bb", sha256: "cc",
      name: "report.pdf", mime: "application/pdf", size: 3,
    };
    expect(preview(file)).toBe("report.pdf");
    expect(preview({ ...file, body: "the numbers" })).toBe("the numbers");
    // The recorder's file name is not something anybody wrote.
    const voice = {
      ...file, name: "voice-message.webm", mime: "audio/webm",
      voice: { duration_ms: 1200, peaks: [1, 2, 3] },
    };
    expect(preview(voice)).toBe("Voice message");
    expect(preview({ ...voice, body: "listen" })).toBe("listen");
  });

  it("recognises a story with and without the later server id", () => {
    const story = {
      kind: "story" as const, story_id: 42, s3_key: "story/x", key: "aa",
      nonce: "bb", sha256: "cc", mime: "image/png", size: 3,
      expires_at_ms: 9_000,
    };
    expect(decodePayload(encodePayload(story))).toEqual(story);
    const { story_id: _newField, ...legacy } = story;
    expect(decodePayload(JSON.stringify(legacy))).toEqual(legacy);
  });
});

/**
 * A forward, as `Payload::forwarded` in `crates/protocol` builds it: new text
 * with a name of its own, never a copy of the original's.
 */
describe("forwardedText", () => {
  it("is text with a fresh name, the mark, and the author when known", () => {
    expect(forwardedText("hello", "new-id", "ada")).toEqual({
      kind: "text",
      body: "hello",
      id: "new-id",
      forwarded: true,
      forwarded_from: "ada",
    });
  });

  it("leaves the author off when it cannot be told", () => {
    const payload = forwardedText("hello", "new-id");
    expect(payload).toEqual({ kind: "text", body: "hello", id: "new-id", forwarded: true });
    expect(JSON.stringify(payload)).not.toContain("forwarded_from");
  });
});

/**
 * A voice note's metadata, held to `VoiceMeta` in `crates/protocol`: a `u32`
 * length and at most sixty-four byte-sized bars. The same rules as
 * `drawable_peaks` there — truncate, never refuse.
 */
describe("voiceMeta", () => {
  it("passes a well-formed note through unchanged", () => {
    expect(voiceMeta({ duration_ms: 4200, peaks: [0, 128, 255] })).toEqual({
      duration_ms: 4200,
      peaks: [0, 128, 255],
    });
  });

  it("truncates a waveform past the cap rather than refusing the note", () => {
    const long = voiceMeta({ duration_ms: 1, peaks: Array.from({ length: 5000 }, () => 42) });
    expect(long?.peaks).toHaveLength(MAX_PEAKS);
    expect(long?.peaks.every((peak) => peak === 42)).toBe(true);
  });

  it("holds every bar and the length to what the wire can carry", () => {
    expect(
      voiceMeta({ duration_ms: -5.4, peaks: [-1, 12.6, 300, Number.NaN, "loud"] }),
    ).toEqual({ duration_ms: 0, peaks: [0, 13, 255, 0, 0] });
    expect(voiceMeta({ duration_ms: 2 ** 40, peaks: [] })?.duration_ms).toBe(0xffff_ffff);
  });

  it("answers undefined for anything that is not a voice note", () => {
    for (const value of [
      undefined,
      null,
      "voice",
      { peaks: [1] },
      { duration_ms: "4200", peaks: [1] },
      { duration_ms: Number.POSITIVE_INFINITY, peaks: [1] },
      { duration_ms: 4200, peaks: "1,2,3" },
    ]) {
      expect(voiceMeta(value)).toBeUndefined();
    }
  });

  describe("teams", () => {
    const post: Payload = {
      kind: "team_post",
      id: "p1",
      title: "Monday",
      body: "Standup moves to 10:00",
      files: [
        {
          s3_key: "enc/team/a",
          key: "aa",
          nonce: "bb",
          sha256: "cc",
          name: "a.png",
          mime: "image/png",
          size: 512,
        },
      ],
    };

    it("reads every team kind as known, not as a newer version's", () => {
      // The same five names `crates/protocol` asserts. One missing from
      // `KNOWN` would draw an ordinary post as "needs a newer version".
      const payloads: Payload[] = [
        { kind: "team_meta", description: "Design crew" },
        post,
        { kind: "team_comment", id: "c1", post: "p1", parent: "c0", body: "Works for me" },
        { kind: "team_pin", post: "p1", pinned: true },
        { kind: "team_remove", target: "c1" },
      ];
      for (const payload of payloads) {
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
      }
    });

    it("names posts and comments, and nothing else a team sends", () => {
      expect(payloadId(post)).toBe("p1");
      expect(payloadId({ kind: "team_comment", id: "c1", post: "p1", body: "x" })).toBe("c1");
      expect(payloadId({ kind: "team_pin", post: "p1", pinned: false })).toBeUndefined();
      expect(payloadId({ kind: "team_remove", target: "p1" })).toBeUndefined();
    });

    it("previews nothing, because a team is not in the conversation list", () => {
      expect(preview(post)).toBe("");
    });
  });
});
