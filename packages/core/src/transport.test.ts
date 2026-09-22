import { describe, expect, it, vi } from "vitest";

import { TransportError } from "./errors";
import { Transport } from "./transport";
import type { SessionTokens } from "./types";

/**
 * The transport's own behaviour, against a fake `fetch`.
 *
 * These are the cases `crates/client` learned by being wrong about them, and
 * they are the reason this file exists before anything that uses it: a session
 * layer built on a transport that loses a rotated token is a session layer
 * that signs people out at random, weeks later, with no way to trace it.
 */

const tokens = (n: number): SessionTokens => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: 900,
  user_id: 1,
  device_id: "d",
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Transport", () => {
  it("sends a bearer token and no cookies", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const transport = new Transport({ baseUrl: "https://api.example", fetch });
    transport.adopt(tokens(1));

    await transport.getAuth("/v1/health");

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.example/v1/health");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer access-1");
    // A cookie riding along would be a second, ambient credential nobody chose
    // to send — and on the web it would arrive on every cross-origin call.
    expect(init.credentials).toBe("omit");
  });

  it("refreshes once on a 401 and retries the original call", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "expired" }))
      .mockResolvedValueOnce(jsonResponse(200, tokens(2)))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const transport = new Transport({ baseUrl: "https://api.example", fetch });
    transport.adopt(tokens(1));

    await expect(transport.getAuth("/v1/feed")).resolves.toEqual({ ok: true });

    expect(fetch.mock.calls[1]![0]).toBe("https://api.example/v1/auth/refresh");
    // The retry carries the *new* token, not the one that just failed.
    expect(
      (fetch.mock.calls[2]![1].headers as Record<string, string>)["authorization"],
    ).toBe("Bearer access-2");
  });

  it("hands the rotated refresh token to its owner before returning", async () => {
    // The whole reason this callback exists. A rotation that is not written
    // down is replayed on the next start, and the server reads a reused
    // refresh token as theft: it revokes every session for the account.
    const rotated: string[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(200, tokens(2)))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const transport = new Transport({
      baseUrl: "https://api.example",
      fetch,
      onTokensRotated: (t) => {
        rotated.push(t.refresh_token);
      },
    });
    transport.adopt(tokens(1));
    await transport.getAuth("/v1/feed");

    expect(rotated).toEqual(["refresh-2"]);
  });

  it("refreshes once for concurrent calls, never twice", async () => {
    // Two requests meeting a 401 together must not both spend the refresh
    // token: the second would present one the first had already replaced,
    // which is the same theft response, self-inflicted.
    let refreshes = 0;
    const fetch = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).endsWith("/v1/auth/refresh")) {
        refreshes += 1;
        return jsonResponse(200, tokens(2));
      }
      return refreshes === 0 ? jsonResponse(401, {}) : jsonResponse(200, { ok: true });
    });

    const transport = new Transport({ baseUrl: "https://api.example", fetch });
    transport.adopt(tokens(1));

    await Promise.all([
      transport.getAuth("/v1/feed"),
      transport.getAuth("/v1/conversations"),
      transport.getAuth("/v1/me"),
    ]);

    expect(refreshes).toBe(1);
  });

  it("gives up after one refresh rather than looping", async () => {
    const fetch = vi.fn(async (url: URL | RequestInfo) =>
      String(url).endsWith("/v1/auth/refresh")
        ? jsonResponse(200, tokens(2))
        : jsonResponse(401, { message: "revoked" }),
    );
    const transport = new Transport({ baseUrl: "https://api.example", fetch });
    transport.adopt(tokens(1));

    await expect(transport.getAuth("/v1/feed")).rejects.toMatchObject({
      kind: "invalid_credentials",
    });
    // One original, one refresh, one retry. Not a loop.
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("carries the epoch out of a 409 instead of flattening it", async () => {
    // A commit that lost a race. The caller has to resync to this epoch, and
    // throwing away the number would make it guess.
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse(409, { error: "stale_epoch", message: "behind", current_epoch: 7 }),
    );
    const transport = new Transport({ baseUrl: "https://api.example", fetch });
    transport.adopt(tokens(1));

    const error: unknown = await transport
      .postAuth("/v1/conversations/x/send", {})
      .catch((e: unknown) => e);
    if (!(error instanceof TransportError)) throw new Error("expected a TransportError");
    expect(error).toBeInstanceOf(TransportError);
    expect(error.kind).toBe("stale_epoch");
    expect(error.currentEpoch).toBe(7);
  });

  it("reports a refusal that is not JSON by its status rather than inventing prose", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const transport = new Transport({ baseUrl: "https://api.example", fetch });
    transport.adopt(tokens(1));

    await expect(transport.getAuth("/v1/feed")).rejects.toMatchObject({
      kind: "rejected",
      message: "The server returned 502.",
    });
  });

  it("calls a dead network unreachable, not rejected", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const transport = new Transport({ baseUrl: "https://api.example", fetch });
    transport.adopt(tokens(1));

    await expect(transport.getAuth("/v1/feed")).rejects.toMatchObject({
      kind: "unreachable",
    });
  });

  it("reads an empty 204 as success rather than a parse failure", async () => {
    // A 204 must be built with a null body; the platform refuses an empty
    // string, which is a fair reminder that this is a real Response.
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const transport = new Transport({ baseUrl: "https://api.example", fetch });
    transport.adopt(tokens(1));

    await expect(transport.deleteAuth("/v1/invites/1")).resolves.toBeUndefined();
  });

  it("refuses to send without a session rather than sending an empty bearer", async () => {
    const fetch = vi.fn();
    const transport = new Transport({ baseUrl: "https://api.example", fetch });

    await expect(transport.getAuth("/v1/feed")).rejects.toMatchObject({
      kind: "invalid_credentials",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
