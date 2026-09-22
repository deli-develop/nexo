import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import { TransportError } from "./errors";
import { Store } from "./store";
import { postStory, listStories, openStory, fetchStoryObjects } from "./stories";
import type { StoryContext, StoryCrypto, StoryObjects, StoryPayload } from "./stories";
import { Transport } from "./transport";

const receipt = {
  id: 72,
  author_handle: "alice",
  created_at_ms: 1_000,
  expires_at_ms: 90_000,
};

async function setup(
  apiFetch: typeof fetch,
  overrides: Partial<Pick<StoryContext, "crypto" | "objects" | "sendPayload" | "now">> = {},
): Promise<StoryContext> {
  const store = await Store.open("stories-test", new IDBFactory());
  const transport = new Transport({ baseUrl: "https://api.example", fetch: apiFetch });
  transport.adopt({ access_token: "access", refresh_token: "refresh" });
  const crypto: StoryCrypto = overrides.crypto ?? {
    encrypt: vi.fn(async () => ({
      ciphertext: new Uint8Array([9, 8, 7, 6, 5]),
      key: new Uint8Array([0, 255]),
      nonce: new Uint8Array([1, 2]),
      sha256: new Uint8Array([3, 4]),
    })),
    decrypt: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
  const objects: StoryObjects = overrides.objects ?? {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => new Uint8Array([9, 8, 7, 6, 5])),
  };
  return {
    transport, store, crypto, objects,
    sendPayload: overrides.sendPayload ?? vi.fn(async () => 1),
    now: overrides.now ?? (() => 2_000),
  };
}

const response = (value: unknown): Response => Response.json(value);

describe("stories", () => {
  it("uploads one ciphertext before recording, saves the author's key, and keeps fanning out", async () => {
    const events: string[] = [];
    const apiFetch = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith("/v1/media/upload")) {
        events.push("presign");
        return response({ url: "https://objects.example/one", key: "story/one" });
      }
      events.push("record");
      return response(receipt);
    });
    const objects: StoryObjects = {
      put: vi.fn(async () => { events.push("put"); }),
      get: vi.fn(async () => new Uint8Array()),
    };
    const sendPayload = vi.fn(async (conversationId: string, _payload: StoryPayload) => {
      events.push(`send:${conversationId}`);
      if (conversationId === "a") throw new Error("blocked");
      return 101;
    });
    const ctx = await setup(apiFetch, { objects, sendPayload });
    await ctx.store.putStory({
      id: 1, authorHandle: "old", authorDeviceId: "", s3Key: "story/old",
      encKey: "aa", nonce: "bb", sha256: "cc", mime: "image/png", size: 1,
      createdAtMs: 1, expiresAtMs: 90_000,
    });
    // The existing conversation list, not a follower graph, is the audience.
    await (ctx.store as Store).putConversation({
      id: "a", title: null, kind: "direct", epoch: 1, syncedTo: 0,
      lastMessage: null, updatedAtMs: 1,
    });
    await (ctx.store as Store).putConversation({
      id: "b", title: null, kind: "direct", epoch: 1, syncedTo: 0,
      lastMessage: null, updatedAtMs: 2,
    });
    const failures: string[] = [];
    ctx.onFanoutError = (id) => failures.push(id);

    await expect(postStory(ctx, new Uint8Array([1, 2, 3]), "image/png")).resolves.toBe(72);

    expect(events.slice(0, 3)).toEqual(["presign", "put", "record"]);
    expect(events).toContain("send:a");
    expect(events).toContain("send:b");
    expect(failures).toEqual(["a"]);
    const body = JSON.parse(apiFetch.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ bucket: "story", size: 5 });
    const payload = sendPayload.mock.calls[0]![1];
    expect(payload).toMatchObject({
      kind: "story", story_id: 72, s3_key: "story/one", key: "00ff",
      nonce: "0102", sha256: "0304", size: 3,
    });
    expect((await ctx.store.liveStories(2_000)).find((s) => s.id === 72)).toMatchObject({
      authorHandle: "alice", encKey: "00ff", expiresAtMs: 90_000,
    });
  });

  it("does not record or hand out a key if object upload fails", async () => {
    const apiFetch = vi.fn<typeof fetch>()
      .mockResolvedValue(response({ url: "https://objects.example/one", key: "story/one" }));
    const sendPayload = vi.fn(async () => 1);
    const ctx = await setup(apiFetch, {
      objects: {
        put: vi.fn(async () => { throw new Error("upload failed"); }),
        get: vi.fn(async () => new Uint8Array()),
      },
      sendPayload,
    });

    await expect(postStory(ctx, new Uint8Array([1]), "image/png"))
      .rejects.toThrow("upload failed");
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(await ctx.store.liveStories(2_000)).toEqual([]);
    expect(sendPayload).not.toHaveBeenCalled();
  });

  it("purges expired keys offline and resolves incoming authors by story id", async () => {
    const apiFetch = vi.fn<typeof fetch>().mockResolvedValue(response([
      { ...receipt, id: 30, author_handle: "bob" },
    ]));
    const ctx = await setup(apiFetch, { now: () => 2_000 });
    const base = {
      authorDeviceId: "device-bob", s3Key: "story/x", encKey: "aa",
      nonce: "bb", sha256: "cc", mime: "image/png", size: 1,
      createdAtMs: 1_000,
    };
    await ctx.store.putStory({ ...base, id: 30, authorHandle: "", expiresAtMs: 90_000 });
    await ctx.store.putStory({ ...base, id: 31, authorHandle: "carol", expiresAtMs: 90_000 });
    await ctx.store.putStory({ ...base, id: 32, authorHandle: "", expiresAtMs: 2_000 });

    const listed = await listStories(ctx);
    expect(listed.map((story) => [story.id, story.authorHandle])).toEqual([
      [31, "carol"], [30, "bob"],
    ]);
    expect(await ctx.store.liveStories(2_000)).toHaveLength(2);

    apiFetch.mockRejectedValueOnce(new Error("offline"));
    const cached = await listStories(ctx);
    expect(cached.find((story) => story.id === 30)?.authorHandle).toBe("");
  });

  it("refuses an expired story before asking for a URL; opens a live one with decoded keys", async () => {
    const apiFetch = vi.fn<typeof fetch>()
      .mockResolvedValue(response({ url: "https://objects.example/one" }));
    const decrypt = vi.fn(async (
      _ciphertext: Uint8Array,
      _key: Uint8Array,
      _nonce: Uint8Array,
      _sha256: Uint8Array,
    ) => new Uint8Array([137, 80, 78, 71]));
    const ctx = await setup(apiFetch, {
      crypto: {
        encrypt: vi.fn(async () => { throw new Error("unused"); }),
        decrypt,
      },
      now: () => 3_000,
    });
    const base = {
      authorHandle: "bob", authorDeviceId: "device-bob", s3Key: "story/x",
      encKey: "00ff", nonce: "0102", sha256: "0304", mime: "image/png",
      size: 4, createdAtMs: 1_000,
    };
    await ctx.store.putStory({ ...base, id: 1, expiresAtMs: 3_000 });
    await ctx.store.putStory({ ...base, id: 2, expiresAtMs: 4_000 });

    await expect(openStory(ctx, 1)).rejects.toMatchObject({ kind: "not_found" });
    expect(apiFetch).not.toHaveBeenCalled();
    await expect(openStory(ctx, 2)).resolves.toEqual({
      bytes: new Uint8Array([137, 80, 78, 71]), mime: "image/png",
    });
    expect(apiFetch.mock.calls[0]![0]).toBe("https://api.example/v1/stories/2/url");
    expect(decrypt.mock.calls[0]![1]).toEqual(new Uint8Array([0, 255]));
    expect(decrypt.mock.calls[0]![2]).toEqual(new Uint8Array([1, 2]));
    expect(decrypt.mock.calls[0]![3]).toEqual(new Uint8Array([3, 4]));
  });

  it("sends no API bearer token or cookies to a presigned object URL", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200 }));
    const objects = fetchStoryObjects(fetcher);
    await objects.put("https://objects.example/one", new Uint8Array([3, 4]));
    await expect(objects.get("https://objects.example/one")).resolves.toEqual(new Uint8Array([1, 2]));
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.credentials).toBe("omit");
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
    }
    fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(objects.get("https://objects.example/forbidden"))
      .rejects.toBeInstanceOf(TransportError);
  });
});
