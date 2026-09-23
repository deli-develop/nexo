import { describe, expect, it } from "vitest";

import type { Attachment, Message } from "../../lib/types";
import { sharedIn } from "./shared";

let next = 0;
function message(extra: Partial<Message> = {}): Message {
  next += 1;
  return {
    id: String(next),
    conversationId: "c",
    authorId: "a",
    body: "",
    at: new Date(next * 1000),
    state: "read",
    ...extra,
  };
}

function file(kind: Attachment["kind"], name = `${kind}.bin`): Attachment {
  next += 1;
  return { id: String(next), name, size: 10, mime: "application/octet-stream", kind };
}

describe("sharedIn", () => {
  it("sorts pictures and video from files, newest first", () => {
    const shared = sharedIn([
      message({ attachments: [file("image", "old.png")] }),
      message({ attachments: [file("file", "notes.pdf")] }),
      message({ attachments: [file("video", "clip.mp4")], authorId: "me" }),
      message({ attachments: [file("audio", "song.mp3")] }),
    ]);

    expect(shared.media.map((m) => m.attachment.name)).toEqual(["clip.mp4", "old.png"]);
    expect(shared.media[0]?.outgoing).toBe(true);
    expect(shared.files.map((f) => f.attachment.name)).toEqual(["song.mp3", "notes.pdf"]);
  });

  it("leaves out voice notes, taken-back messages and ones that would not decrypt", () => {
    const shared = sharedIn([
      message({ attachments: [file("voice")] }),
      message({ attachments: [file("image")], retracted: true }),
      message({ attachments: [file("file")], undecryptable: true }),
      message({ body: "https://gone.example", retracted: true }),
    ]);

    expect(shared).toEqual({ media: [], files: [], links: [] });
  });

  it("counts a link once, at the last time it was sent", () => {
    const first = message({ body: "see https://a.example and https://b.example." });
    const again = message({ body: "again: https://a.example", authorId: "me" });
    const shared = sharedIn([first, again]);

    expect(shared.links.map((l) => l.url)).toEqual(["https://a.example", "https://b.example"]);
    expect(shared.links[0]?.at).toEqual(again.at);
    expect(shared.links[0]?.outgoing).toBe(true);
  });
});
