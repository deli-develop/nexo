import { describe, expect, it, vi } from "vitest";

import { Transport } from "./transport";
import { createInvite, invites, report, revokeInvite, search } from "./people";

function signedIn(fetch: typeof globalThis.fetch): Transport {
  const transport = new Transport({ baseUrl: "https://api.example", fetch });
  transport.adopt({ access_token: "access", refresh_token: "refresh" });
  return transport;
}

const json = (value: unknown): Response => Response.json(value);

describe("people wire contract", () => {
  it("encodes a search query and leaves visibility decisions to the server", async () => {
    const results = [{ handle: "zoe", display_name: "Zoë", avatar_key: null }];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(results));
    const transport = signedIn(fetch);

    await expect(search({ transport }, "Zoë & me")).resolves.toEqual(results);

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.example/v1/users?q=Zo%C3%AB%20%26%20me");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer access");
    expect(init?.credentials).toBe("omit");
  });

  it("returns an invitation secret only at creation and revokes by server id", async () => {
    const fresh = { id: 14, secret: "one-time-secret", expires_at_ms: 80_000 };
    const listed = [{
      id: 14, label: "Friends", created_at_ms: 10_000, expires_at_ms: 80_000,
      revoked: false, live: true, used: 2,
    }];
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(fresh))
      .mockResolvedValueOnce(json(listed))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const ctx = { transport: signedIn(fetch) };

    await expect(createInvite(ctx, "Friends", 7)).resolves.toEqual(fresh);
    await expect(invites(ctx)).resolves.toEqual(listed);
    await expect(revokeInvite(ctx, 14)).resolves.toBeUndefined();

    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      label: "Friends", days: 7,
    });
    expect(fetch.mock.calls[1]![0]).toBe("https://api.example/v1/invites");
    expect(fetch.mock.calls[2]![0]).toBe("https://api.example/v1/invites/14");
    expect(fetch.mock.calls[2]![1]!.method).toBe("DELETE");
    expect(JSON.stringify(listed)).not.toContain(fresh.secret);
  });

  it("sends a report and exposes no moderation result", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const ctx = { transport: signedIn(fetch) };

    await expect(report(ctx, "user", 91, "harassment", "One example")).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]![0]).toBe("https://api.example/v1/reports");
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      subject_kind: "user", subject_id: 91, reason: "harassment", note: "One example",
    });
  });
});
