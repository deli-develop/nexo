import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredMessage } from "@nexo/core";

/**
 * What a bubble draws as text under an attachment.
 *
 * A stored attachment keeps the list's preview in `body` -- its caption, or
 * its file name, or "Voice message" -- and the bubble used to draw that as if
 * somebody had typed it. Every voice note arrived as the recording plus a
 * second bubble saying `voice-message.webm`. The runtime is faked.
 */
const { store } = vi.hoisted(() => ({
  store: {
    messages: vi.fn<(id: string) => Promise<StoredMessage[]>>(),
    reactions: async () => [],
    pinnedMessages: async () => [],
    viewOnceIn: async () => [],
  },
}));

vi.mock("./runtime", () => ({ runtime: async () => ({ store }) }));
vi.mock("./native", () => ({ saveFile: async () => false }));

const { conversationMessages } = await import("./conversations");

const voice = {
  kind: "attachment", s3_key: "obj/1", key: "01", nonce: "02", sha256: "03",
  name: "voice-message.webm", mime: "audio/webm", size: 3, id: "v1",
  voice: { duration_ms: 1500, peaks: [1, 2, 3] },
};

function row(id: number, body: string, payload: object, extra: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id, conversationId: "c1", senderDeviceId: null, body, sentAtMs: id,
    payload: JSON.stringify(payload), ...extra,
  };
}

describe("an attachment's text", () => {
  beforeEach(() => store.messages.mockReset());

  it("draws no words for a voice note that has none, old or new", async () => {
    store.messages.mockResolvedValue([
      // Sent before the preview said "Voice message": the file name.
      row(1, "voice-message.webm", voice, { clientId: "v1" }),
      row(2, "Voice message", { ...voice, id: "v2" }, { clientId: "v2" }),
    ]);
    const [old, current] = await conversationMessages("c1");
    expect(old!.body).toBe("");
    expect(current!.body).toBe("");
    expect(old!.attachment?.voice?.duration_ms).toBe(1500);
  });

  it("draws no file name for a picture, and keeps a caption", async () => {
    const picture = { ...voice, name: "IMG_4021.jpg", mime: "image/jpeg", voice: undefined };
    store.messages.mockResolvedValue([
      row(1, "IMG_4021.jpg", picture),
      row(2, "look at this", { ...picture, body: "look at this" }),
    ]);
    const [bare, captioned] = await conversationMessages("c1");
    expect(bare!.body).toBe("");
    expect(captioned!.body).toBe("look at this");
  });

  it("keeps words an edit put on an attachment that had none", async () => {
    store.messages.mockResolvedValue([row(1, "added later", voice, { editedAtMs: 9 })]);
    const [edited] = await conversationMessages("c1");
    expect(edited!.body).toBe("added later");
  });

  it("quotes a voice note as what it is, not as its file name", async () => {
    store.messages.mockResolvedValue([
      row(1, "voice-message.webm", voice, { clientId: "v1", senderDeviceId: "them" }),
      row(2, "yes", { kind: "reply", body: "yes", target: "v1", id: "r1" }, { clientId: "r1", replyTo: "v1" }),
    ]);
    const [, reply] = await conversationMessages("c1");
    expect(reply!.reply?.excerpt).toBe("Voice message");
  });
});
