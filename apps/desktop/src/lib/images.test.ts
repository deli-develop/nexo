import { describe, expect, it, vi } from "vitest";

import { createImageCache } from "./images";

/** A cache over a loader that answers `blob:<key>`, and records what it revoked. */
function setup(idleLimit = 2) {
  const load = vi.fn(async (key: string) => `blob:${key}`);
  const revoked: string[] = [];
  const cache = createImageCache({ load, revoke: (url) => revoked.push(url), idleLimit });
  return { cache, load, revoked };
}

/** Lets the revocations, which wait on the URL's promise, run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createImageCache", () => {
  it("fetches a picture once however many places draw it", async () => {
    const { cache, load } = setup();
    const one = cache.acquire("media/1/a");
    const two = cache.acquire("media/1/a");

    await expect(one.url).resolves.toBe("blob:media/1/a");
    await expect(two.url).resolves.toBe("blob:media/1/a");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps a released picture for when it scrolls back", async () => {
    const { cache, load, revoked } = setup();
    cache.acquire("media/1/a").release();
    await settle();

    await expect(cache.acquire("media/1/a").url).resolves.toBe("blob:media/1/a");
    expect(load).toHaveBeenCalledTimes(1);
    expect(revoked).toEqual([]);
  });

  it("revokes the pictures released longest ago once too many are idle", async () => {
    const { cache, revoked } = setup(2);
    for (const key of ["a", "b", "c", "d"]) cache.acquire(key).release();
    await settle();

    expect(revoked).toEqual(["blob:a", "blob:b"]);
  });

  // The element drawing it would lose the picture on its next repaint.
  it("never revokes a picture something still draws, however many are idle", async () => {
    const { cache, revoked } = setup(0);
    const held = cache.acquire("held");
    for (const key of ["a", "b", "c"]) cache.acquire(key).release();
    await settle();

    expect(revoked).toEqual(["blob:a", "blob:b", "blob:c"]);
    held.release();
    await settle();
    expect(revoked).toContain("blob:held");
  });

  it("forgets a failed load, so the next one tries again", async () => {
    const load = vi
      .fn<(key: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValue("blob:again");
    const cache = createImageCache({ load, revoke: () => {}, idleLimit: 2 });

    const failed = cache.acquire("media/1/a");
    await expect(failed.url).rejects.toThrow("refused");
    await expect(cache.acquire("media/1/a").url).resolves.toBe("blob:again");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not let a failed handle's release count against the retry", async () => {
    const revoked: string[] = [];
    const load = vi
      .fn<(key: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValue("blob:again");
    const cache = createImageCache({ load, revoke: (url) => revoked.push(url), idleLimit: 0 });

    const failed = cache.acquire("media/1/a");
    await failed.url.catch(() => {});
    const retry = cache.acquire("media/1/a");
    await retry.url;

    failed.release();
    await settle();
    expect(revoked).toEqual([]);
  });

  it("counts a handle released twice only once", async () => {
    const { cache, revoked } = setup(0);
    const one = cache.acquire("media/1/a");
    const two = cache.acquire("media/1/a");
    one.release();
    one.release();
    await settle();

    expect(revoked).toEqual([]);
    two.release();
    await settle();
    expect(revoked).toEqual(["blob:media/1/a"]);
  });
});
