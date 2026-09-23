import { describe, expect, it, vi } from "vitest";

import * as attachments from "./attachments";
import type { Payload } from "./payload";
import { Transport } from "./transport";

/**
 * Attachments.
 *
 * The cryptography is `crates/crypto`'s and is tested there. What is tested
 * here is the ordering, because the ordering is what cannot be repaired: a
 * message that names an object which was never uploaded is a broken
 * attachment for everybody in the conversation, for ever, and MLS will not let
 * that message be sent again to correct it.
 */

/** A seal that is not cryptography: it records what it was asked to do. */
const fakeCrypto: attachments.ObjectCrypto = {
  seal: (plaintext) => ({
    ciphertext: Uint8Array.of(0xff, ...plaintext),
    key: Uint8Array.of(1, 2),
    nonce: Uint8Array.of(3),
    sha256: Uint8Array.of(4),
    size: plaintext.byteLength,
  }),
  open: (ciphertext) => ciphertext.slice(1),
  // Marked apart from `open`, so a test can tell which one a payload reached.
  openSegmented: (ciphertext, _key, _nonce, _sha256, size) =>
    Uint8Array.of(0x5e, size, ...ciphertext.slice(1)),
};

function harness(answers: Array<{ status: number; body: unknown }>) {
  const paths: string[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    paths.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
    const answer = answers.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  });
  const transport = new Transport({
    baseUrl: "https://api.example",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  transport.adopt({ access_token: "a", refresh_token: "r" });

  const put = vi.fn(async (_url: string, _bytes: Uint8Array, _type: string) => {});
  const sent: Payload[] = [];
  const ctx: attachments.AttachmentContext = {
    transport,
    crypto: fakeCrypto,
    objects: { put, get: async () => Uint8Array.of(0xff, 7, 8) },
    sendPayload: async (_id, payload) => {
      sent.push(payload);
      return 1;
    },
  };
  return { ctx, paths, put, sent };
}

describe("attachments", () => {
  it("uploads before it announces", async () => {
    const order: string[] = [];
    const { ctx, put, sent } = harness([{ status: 200, body: { url: "https://s3/put", key: "k1" } }]);
    put.mockImplementation(async () => {
      order.push("upload");
    });
    const announce = ctx.sendPayload;
    ctx.sendPayload = async (id, payload) => {
      order.push("announce");
      return announce(id, payload);
    };

    await attachments.sendAttachment(ctx, "c1", Uint8Array.of(1, 2, 3), {
      name: "notes.txt",
      mime: "text/plain",
    });

    // The other order leaves a permanent broken attachment in everybody's
    // history, and there is no second chance to fix it: MLS will not let that
    // envelope be sent again.
    expect(order).toEqual(["upload", "announce"]);
    expect(sent[0]).toMatchObject({ kind: "attachment", s3_key: "k1", name: "notes.txt" });
  });

  it("sends the key in the payload and never to the object store", async () => {
    const { ctx, put, sent } = harness([{ status: 200, body: { url: "https://s3/put", key: "k1" } }]);

    await attachments.sendAttachment(ctx, "c1", Uint8Array.of(9), {
      name: "a.bin",
      mime: "application/octet-stream",
    });

    const [, uploaded] = put.mock.calls[0]!;
    // Ciphertext only. The bucket is a third party's in production, and the
    // whole arrangement is that it holds bytes it has no key for.
    expect(uploaded).toEqual(Uint8Array.of(0xff, 9));
    expect(sent[0]).toMatchObject({ key: "0102", nonce: "03", sha256: "04" });
  });

  it("leaves an absent caption off the wire entirely", async () => {
    const { ctx, sent } = harness([{ status: 200, body: { url: "https://s3/put", key: "k1" } }]);

    await attachments.sendAttachment(ctx, "c1", Uint8Array.of(1), { name: "a", mime: "b" });

    // Adding a field must not change a byte of what a message without it puts
    // on the wire, or every message this build sends becomes something older
    // builds have to tolerate for no reason.
    expect(JSON.stringify(sent[0])).not.toContain("body");
  });

  it("carries a voice note's length and waveform", async () => {
    const { ctx, sent } = harness([{ status: 200, body: { url: "https://s3/put", key: "k1" } }]);

    await attachments.sendAttachment(ctx, "c1", Uint8Array.of(1), {
      name: "voice-message.webm",
      mime: "audio/webm",
      voice: { duration_ms: 4200, peaks: [3, 140, 255] },
    });

    // Dropped here once: the recorder measured both, and every voice note
    // still arrived as a plain audio file.
    expect(sent[0]).toMatchObject({ voice: { duration_ms: 4200, peaks: [3, 140, 255] } });
  });

  it("leaves voice off the wire for a file nobody recorded", async () => {
    const { ctx, sent } = harness([{ status: 200, body: { url: "https://s3/put", key: "k1" } }]);

    await attachments.sendAttachment(ctx, "c1", Uint8Array.of(1), { name: "a.mp3", mime: "audio/mpeg" });

    expect(JSON.stringify(sent[0])).not.toContain("voice");
  });

  it("refuses a payload whose key is not hex rather than guessing", async () => {
    const { ctx } = harness([{ status: 200, body: { url: "https://s3/get" } }]);

    await expect(
      attachments.open(ctx, { s3_key: "k", key: "zz", nonce: "03", sha256: "04" }),
    ).rejects.toMatchObject({ kind: "rejected" });
  });

  it("opens a segmented attachment as segmented, with its declared size", async () => {
    const { ctx } = harness([{ status: 200, body: { url: "https://s3/get" } }]);

    // Both encodings look the same from the ciphertext; only the payload
    // says which. Opening a segmented object whole fails its tag, which is
    // how every video an old client sent read as "can't decrypt".
    const opened = await attachments.open(ctx, {
      s3_key: "k",
      key: "01",
      nonce: "03",
      sha256: "04",
      segmented: true,
      size: 2,
    });
    expect(opened).toEqual(Uint8Array.of(0x5e, 2, 7, 8));
  });

  it("opens everything else whole", async () => {
    const { ctx } = harness([{ status: 200, body: { url: "https://s3/get" } }]);

    const opened = await attachments.open(ctx, {
      s3_key: "k",
      key: "01",
      nonce: "03",
      sha256: "04",
      segmented: false,
      size: 2,
    });
    expect(opened).toEqual(Uint8Array.of(7, 8));
  });

  it("refuses a segmented attachment that does not say how large it is", async () => {
    const { ctx } = harness([{ status: 200, body: { url: "https://s3/get" } }]);

    await expect(
      attachments.open(ctx, { s3_key: "k", key: "01", nonce: "03", sha256: "04", segmented: true }),
    ).rejects.toMatchObject({ kind: "rejected" });
  });

  it("sends a sticker without uploading anything", async () => {
    const { ctx, put, sent } = harness([]);

    await attachments.sendSticker(ctx, "c1", "classic", "wave");

    // Stickers ship with the app. Sending the picture would be sending the
    // same fifty kilobytes every time anybody used it.
    expect(put).not.toHaveBeenCalled();
    expect(sent[0]).toEqual({ kind: "sticker", pack: "classic", id: "wave" });
  });
});
