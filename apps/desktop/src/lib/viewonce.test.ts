import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredMessage, StoredViewOnce } from "@nexo/core";

/**
 * View-once, as the page draws and opens it.
 *
 * Before this, an arriving view-once was stored as an ordinary message with
 * its key in the row, and nothing wrote the table `openViewOnce` reads — so
 * every one answered "That has already been opened" on the first tap, was
 * drawn as openable for ever, and kept a key nothing ever burned. Core's own
 * tests cover where the key goes on arrival; these cover what the page makes
 * of it. The runtime is faked.
 */
const { open, store } = vi.hoisted(() => {
  const rows: StoredViewOnce[] = [];
  return {
    open: vi.fn<(ctx: unknown, payload: unknown) => Promise<Uint8Array>>(),
    store: {
      rows,
      messages: vi.fn<(id: string) => Promise<StoredMessage[]>>(),
      message: vi.fn<(id: number) => Promise<StoredMessage | null>>(),
      reactions: async () => [],
      pinnedMessages: async () => [],
      viewOnceIn: async () => rows,
      viewOnce: async (clientId: string) => rows.find((row) => row.clientId === clientId) ?? null,
      burnViewOnce: vi.fn(async (clientId: string, at: number) => {
        const row = rows.find((candidate) => candidate.clientId === clientId);
        if (row) Object.assign(row, { encKey: null, nonce: null, sha256: null, openedAtMs: at });
      }),
    },
  };
});

vi.mock("@nexo/core", async (original) => {
  const core = await original<typeof import("@nexo/core")>();
  return { ...core, attachments: { ...core.attachments, open } };
});
vi.mock("./runtime", () => ({
  runtime: async () => ({ store, attachments: async () => ({}) }),
}));
vi.mock("./native", () => ({ saveFile: async () => false }));

const { attachmentBytes, conversationMessages, openViewOnce } = await import("./conversations");

const bubble: StoredMessage = {
  id: 9,
  conversationId: "c1",
  senderDeviceId: "them",
  body: "",
  sentAtMs: 5,
  clientId: "once-1",
  payload: JSON.stringify({ kind: "view_once", id: "once-1", mime: "image/png", size: 3 }),
};

describe("view-once in the page", () => {
  beforeEach(() => {
    store.rows.splice(0, store.rows.length, {
      clientId: "once-1", conversationId: "c1", s3Key: "obj/1", encKey: "01",
      nonce: "02", sha256: "03", mime: "image/png", size: 3, receivedAtMs: 5, openedAtMs: null,
    });
    store.messages.mockResolvedValue([bubble]);
    store.message.mockResolvedValue(bubble);
    store.burnViewOnce.mockClear();
    open.mockReset();
    open.mockResolvedValue(Uint8Array.of(1, 2, 3));
  });

  it("opens once: openable, then opened and burned, then not openable", async () => {
    const [before] = await conversationMessages("c1");
    expect(before!.view_once).toMatchObject({ openable: true, outgoing: false, kind: "image" });

    const url = await openViewOnce("once-1");
    expect(url).toMatch(/^blob:/);
    // Decrypted from the table's key, and burned only after that succeeded.
    expect(open).toHaveBeenCalledWith({}, { s3_key: "obj/1", key: "01", nonce: "02", sha256: "03" });
    expect(store.burnViewOnce).toHaveBeenCalledWith("once-1", expect.any(Number));

    const [after] = await conversationMessages("c1");
    expect(after!.view_once?.openable).toBe(false);
    await expect(openViewOnce("once-1")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("is not openable by its sender", async () => {
    store.messages.mockResolvedValue([{ ...bubble, senderDeviceId: null }]);
    const [mine] = await conversationMessages("c1");
    expect(mine!.view_once).toMatchObject({ openable: false, outgoing: true });
  });

  it("cannot be saved, which would be opening it without the burn", async () => {
    await expect(attachmentBytes(9)).rejects.toMatchObject({ kind: "not_found" });
    expect(open).not.toHaveBeenCalled();
  });
});
