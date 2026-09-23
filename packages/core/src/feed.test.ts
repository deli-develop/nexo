import { describe, expect, it, vi } from "vitest";

import { TransportError } from "./errors";
import { downloadImage, sniffImage, uploadBytes } from "./feed";
import { Transport } from "./transport";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** A transport whose only answer is the upload ticket. */
function ticketing(): Transport {
  const transport = new Transport({
    baseUrl: "https://api.example",
    fetch: (async () =>
      new Response(JSON.stringify({ url: "https://objects.example/media/1/a", key: "media/1/a" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });
  transport.adopt({ access_token: "access", refresh_token: "refresh" });
  return transport;
}

describe("uploadBytes", () => {
  it("puts the bytes to the presigned URL and answers the key", async () => {
    const put = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const key = await uploadBytes(ticketing(), new Uint8Array([1, 2]), "image/png", "media", put);

    expect(key).toBe("media/1/a");
    const [url, init] = put.mock.calls[0]!;
    expect(url).toBe("https://objects.example/media/1/a");
    expect(init?.credentials).toBe("omit");
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  // What a browser says when the bucket has no CORS rule for this origin: a
  // bare TypeError, and nothing about why. It has to arrive as a
  // TransportError, or every screen shows "Something went wrong" instead.
  it("reports a refused request as unreachable, not as an unknown error", async () => {
    const put = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const failure = uploadBytes(ticketing(), new Uint8Array([1]), "image/png", "media", put);

    await expect(failure).rejects.toBeInstanceOf(TransportError);
    await expect(failure).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("reports a refusal from the store with its status", async () => {
    const put = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const failure = uploadBytes(ticketing(), new Uint8Array([1]), "image/png", "media", put);

    await expect(failure).rejects.toMatchObject({
      kind: "rejected",
      message: "The storage provider returned 403.",
    });
  });
});

describe("downloadImage", () => {
  it("names the type from the bytes, not from what the store says", async () => {
    const get = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array(PNG), { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const image = await downloadImage(ticketing(), "media/1/a", "media", get);

    expect(image.mime).toBe("image/png");
    expect(image.bytes).toEqual(new Uint8Array(PNG));
    const [url, init] = get.mock.calls[0]!;
    expect(url).toBe("https://objects.example/media/1/a");
    expect(init?.credentials).toBe("omit");
  });

  // Whoever uploads an object picks its Content-Type; the signature covers only
  // the host. A page that believed it would mint a same-origin `blob:` document.
  it("refuses something that is not a picture, whatever it is served as", async () => {
    const get = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<script>alert(1)</script>", {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    await expect(downloadImage(ticketing(), "media/1/a", "media", get)).rejects.toMatchObject({
      kind: "rejected",
      message: "That file is not a picture.",
    });
  });

  it("reports a refused read the same way as a refused upload", async () => {
    const refused = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(downloadImage(ticketing(), "media/1/a", "media", refused)).rejects.toMatchObject({
      kind: "unreachable",
    });

    const gone = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(downloadImage(ticketing(), "media/1/a", "media", gone)).rejects.toMatchObject({
      kind: "rejected",
      message: "The storage provider returned 404.",
    });
  });
});

describe("sniffImage", () => {
  it("knows the four picture formats", () => {
    expect(sniffImage(new Uint8Array(PNG))).toBe("image/png");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(new Uint8Array(ascii("GIF89a....")))).toBe("image/gif");
    expect(sniffImage(new Uint8Array(ascii("GIF87a....")))).toBe("image/gif");
    expect(sniffImage(new Uint8Array(ascii("RIFF\0\0\0\0WEBPVP8 ")))).toBe("image/webp");
  });

  it("knows nothing else", () => {
    // WAV shares WebP's container; only the bytes at 8 differ.
    expect(sniffImage(new Uint8Array(ascii("RIFF\0\0\0\0WAVEfmt ")))).toBeNull();
    expect(sniffImage(new Uint8Array(ascii("<!doctype html>")))).toBeNull();
    expect(sniffImage(new Uint8Array(ascii("<svg xmlns=")))).toBeNull();
    // Too short to be anything, including a truncated signature.
    expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImage(new Uint8Array(ascii("RIFF")))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});
