import { beforeEach, describe, expect, it, vi } from "vitest";

import { TransportError } from "@nexo/core";

/**
 * A right PIN on a session the server has ended.
 *
 * `unlockWithPin` answered `null` both when the digits were wrong and when
 * they were right but `Session.resume` found the session revoked, and the
 * lock screen reads `null` as a wrong PIN — so a right PIN was drawn as a
 * wrong one, try after try. These pin the three answers apart.
 *
 * The runtime is faked because the real one loads the wasm module; what is
 * under test is the decision between the three, not MLS.
 */
// Hoisted with the mocks below, which vitest moves above everything else.
const { verify, resume } = vi.hoisted(() => ({
  verify: vi.fn<(ctx: unknown, pin: string) => Promise<boolean>>(),
  resume: vi.fn<() => Promise<{ userId: number; handle: string; displayName: string } | null>>(),
}));

vi.mock("@nexo/core", async (original) => {
  const core = await original<typeof import("@nexo/core")>();
  return { ...core, pin: { ...core.pin, verify } };
});
vi.mock("./runtime", () => ({
  runtime: async () => ({
    pin: {},
    session: { resume },
    store: { identity: async () => ({ deviceId: "device-1", secret: new Uint8Array() }) },
  }),
  resetRuntime: () => {},
}));
vi.mock("./native", () => ({ forgetAccount: async () => {} }));
vi.mock("./stream", () => ({ closeStream: () => {} }));

const { asAuthError, unlockWithPin } = await import("./auth");

describe("unlockWithPin", () => {
  beforeEach(() => {
    verify.mockReset();
    resume.mockReset();
  });

  it("answers null for wrong digits, and does not try the server", async () => {
    verify.mockResolvedValue(false);
    await expect(unlockWithPin("0000")).resolves.toBeNull();
    expect(resume).not.toHaveBeenCalled();
  });

  it("answers the account for a right PIN on a live session", async () => {
    verify.mockResolvedValue(true);
    resume.mockResolvedValue({ userId: 7, handle: "ada", displayName: "Ada" });
    await expect(unlockWithPin("1234")).resolves.toEqual({
      user_id: 7,
      handle: "ada",
      display_name: "Ada",
      device_id: "device-1",
    });
  });

  it("rejects a right PIN on an ended session as signed out, not as a wrong PIN", async () => {
    verify.mockResolvedValue(true);
    resume.mockResolvedValue(null);
    const outcome = await unlockWithPin("1234").then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({ rejected: asAuthError(error) }),
    );
    expect(outcome).toEqual({
      rejected: { kind: "signed_out", message: expect.stringMatching(/password/i) },
    });
  });

  it("lets a network failure through as what it is", async () => {
    verify.mockResolvedValue(true);
    resume.mockRejectedValue(TransportError.unreachable("offline"));
    const error = await unlockWithPin("1234").catch((e: unknown) => asAuthError(e));
    expect(error).toMatchObject({ kind: "unreachable" });
  });
});
