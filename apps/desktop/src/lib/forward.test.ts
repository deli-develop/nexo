import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Payload } from "@nexo/core";

/**
 * A forward gets a name of its own.
 *
 * `forwardMessage` spread the original payload, name included, so forwarding
 * one message twice into a conversation — or a forward back where it came
 * from — left two messages there answering to one name, and an edit, a
 * retraction or a reaction reached whichever the store found first. The
 * runtime is faked; what is under test is what gets sent.
 */
const { sendPayload, message } = vi.hoisted(() => ({
  sendPayload: vi.fn<(ctx: unknown, conversationId: string, payload: Payload) => Promise<number>>(),
  message: vi.fn<(id: number) => Promise<unknown>>(),
}));

vi.mock("@nexo/core", async (original) => {
  const core = await original<typeof import("@nexo/core")>();
  return { ...core, conversations: { ...core.conversations, sendPayload } };
});
vi.mock("./runtime", () => ({
  runtime: async () => ({ store: { message }, context: async () => ({}) }),
}));
vi.mock("./native", () => ({ saveFile: async () => false }));

const { forwardMessage } = await import("./conversations");

describe("forwardMessage", () => {
  beforeEach(() => {
    sendPayload.mockReset();
    message.mockReset();
    sendPayload.mockResolvedValue(1);
  });

  it("sends text under a new name, marked, never the original's", async () => {
    message.mockResolvedValue({
      id: 7,
      body: "the mountains are out",
      payload: JSON.stringify({ kind: "text", body: "the mountains are out", id: "original" }),
    });

    await forwardMessage("from", 7, "to", "ada");
    await forwardMessage("from", 7, "to", "ada");

    const sent = sendPayload.mock.calls.map(([, , payload]) => payload);
    expect(sent[0]).toMatchObject({
      kind: "text",
      body: "the mountains are out",
      forwarded: true,
      forwarded_from: "ada",
    });
    const names = sent.map((payload) => (payload as { id?: string }).id);
    expect(names[0]).toBeTruthy();
    expect(names).not.toContain("original");
    expect(new Set(names).size).toBe(2);
  });

  it("forwards a reply's words as new text, not as a reply to something the reader lacks", async () => {
    message.mockResolvedValue({
      id: 9,
      body: "yes",
      payload: JSON.stringify({ kind: "reply", body: "yes", target: "t1", id: "r1" }),
    });

    await forwardMessage("from", 9, "to");

    const sent = sendPayload.mock.calls[0]![2];
    expect(sent).toMatchObject({ kind: "text", body: "yes", forwarded: true });
    expect(sent).not.toHaveProperty("target");
  });

  it("refuses a file rather than sending it on unmarked", async () => {
    message.mockResolvedValue({
      id: 10,
      body: "a.png",
      payload: JSON.stringify({
        kind: "attachment", s3_key: "k", key: "01", nonce: "02", sha256: "03",
        name: "a.png", mime: "image/png", size: 1, id: "a1",
      }),
    });

    await expect(forwardMessage("from", 10, "to")).rejects.toMatchObject({ kind: "rejected" });
    expect(sendPayload).not.toHaveBeenCalled();
  });

  it("names a forward of a message that never had a name", async () => {
    // Text stored without a payload predates names; its forward still gets one.
    message.mockResolvedValue({ id: 8, body: "old" });

    await forwardMessage("from", 8, "to");

    expect(sendPayload.mock.calls[0]![2]).toMatchObject({ kind: "text", body: "old", forwarded: true });
    expect((sendPayload.mock.calls[0]![2] as { id?: string }).id).toBeTruthy();
  });
});
