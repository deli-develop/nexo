import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Keeping the window out of screenshots while a view-once is open.
 *
 * The window API is faked: what matters here is that protection goes on with
 * the first hold, comes off only with the last release, and that a refusal is
 * reported rather than assumed away -- the viewer's wording depends on it.
 */
const { setContentProtected, host } = vi.hoisted(() => ({
  setContentProtected: vi.fn<(on: boolean) => Promise<void>>(),
  host: { tauri: true },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setContentProtected }),
}));
vi.mock("./runtime", () => ({ inTauri: () => host.tauri }));

const { blockScreenCapture, canBlockScreenCapture } = await import("./native");

describe("blockScreenCapture", () => {
  beforeEach(() => {
    host.tauri = true;
    setContentProtected.mockReset();
    setContentProtected.mockResolvedValue(undefined);
  });

  it("protects the window until the last of two holds lets go", async () => {
    const first = await blockScreenCapture();
    const second = await blockScreenCapture();
    expect(first.held && second.held).toBe(true);
    expect(setContentProtected).toHaveBeenLastCalledWith(true);

    first.release();
    first.release();
    expect(setContentProtected).not.toHaveBeenCalledWith(false);

    second.release();
    expect(setContentProtected).toHaveBeenLastCalledWith(false);
  });

  it("says so when the shell refuses", async () => {
    setContentProtected.mockRejectedValueOnce(new Error("not allowed"));
    const hold = await blockScreenCapture();
    expect(hold.held).toBe(false);
    hold.release();
  });

  it("never claims to protect a browser tab", async () => {
    host.tauri = false;
    expect(canBlockScreenCapture()).toBe(false);
    const hold = await blockScreenCapture();
    expect(hold.held).toBe(false);
    expect(setContentProtected).not.toHaveBeenCalled();
  });
});
