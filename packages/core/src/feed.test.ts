import { describe, expect, it, vi } from "vitest";

import { TransportError } from "./errors";
import { uploadBytes } from "./feed";
import { Transport } from "./transport";

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
