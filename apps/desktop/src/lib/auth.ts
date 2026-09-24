import { TransportError, pin as corePin } from "@nexo/core";

import { forgetAccount } from "./native";
import { onRuntimeSessionEnded, resetRuntime, runtime } from "./runtime";
import { closeStream } from "./stream";

/**
 * The auth surface, as the page sees it.
 *
 * # What changed in wave 7, and it is not small
 *
 * This file used to be a set of `invoke()` calls into a Rust process that held
 * the tokens and the MLS state where no script in this WebView could reach
 * them. There is no such other side in a browser, so the session now lives
 * here — see `runtime.ts`, where the trade is written down, and
 * `docs/REWORK.md`, where it is the recorded price of one client across three
 * targets.
 *
 * What did **not** change: a password still goes *in* once and is never held.
 * It is turned into a verifier by Argon2id in the Rust/WASM crate and the
 * verifier is what travels; the server never sees the password, which was
 * always the part that mattered to somebody who is not holding this device.
 */
export interface Account {
  user_id: number;
  handle: string;
  display_name: string;
  device_id: string;
}

/**
 * `kind` is for branching, `message` is for showing.
 *
 * The UI must never match on `message`: it is prose, and a copy edit would
 * otherwise become a behaviour change.
 */
export interface AuthError {
  kind:
    | "invalid_credentials"
    | "handle_taken"
    | "wrong_password"
    | "signed_out"
    | "unreachable"
    | "rejected"
    | "store_unreadable"
    // Too many wrong PINs. The password is the only way past the lock screen
    // until it is set again.
    | "pin_locked"
    | "internal";
  message: string;
}

/** Narrows an unknown rejection to something renderable. */
export function asAuthError(error: unknown): AuthError {
  if (error instanceof TransportError) {
    return { kind: mapKind(error.kind, error.message), message: error.message };
  }
  if (error instanceof corePin.PinError) {
    return {
      kind: error.kind === "locked" ? "pin_locked" : "rejected",
      message: error.message,
    };
  }
  if (typeof error === "object" && error !== null && "kind" in error && "message" in error) {
    return error as AuthError;
  }
  // Anything else is a bug in this build, not a state the person can act on.
  return { kind: "internal", message: "Something went wrong. Try again." };
}

/**
 * The transport has five kinds and the sign-in screen needs eight.
 *
 * The extra three are distinctions only this screen makes — a taken handle and
 * a wrong password are both `rejected` on the wire, because the server is not
 * in the business of confirming which half of a credential was right. Reading
 * the prose to tell them apart is exactly what the UI is forbidden to do, so
 * it is done here, once, where a copy edit that breaks it breaks one test.
 */
function mapKind(kind: TransportError["kind"], message: string): AuthError["kind"] {
  if (kind === "unreachable") return "unreachable";
  if (kind === "invalid_credentials") return "invalid_credentials";
  if (kind === "not_found") return "invalid_credentials";
  if (/handle/i.test(message) && /taken|already/i.test(message)) return "handle_taken";
  return "rejected";
}

export async function register(
  handle: string,
  displayName: string,
  password: string,
): Promise<Account> {
  const { session } = await runtime();
  return toAccount(await session.register(handle, displayName, password));
}

export async function login(handle: string, password: string): Promise<Account> {
  const { session } = await runtime();
  return toAccount(await session.login(handle, password));
}

/**
 * Picks up where the last run left off, or answers `null`.
 *
 * `resume` rather than `restore`: the stored refresh token is single-use and
 * has to be spent for a live session. Restoring without spending it leaves an
 * app that looks signed in and cannot reach anything.
 */
export async function restoreSession(): Promise<Account | null> {
  const { session } = await runtime();
  const account = await session.resume();
  return account ? toAccount(account) : null;
}

/** This device's public key, short, for showing next to a safety number. */
export async function deviceFingerprint(): Promise<string | null> {
  try {
    const device = await (await runtime()).session.device();
    const key = device.publicKey();
    return Array.from(key.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .replace(/(.{4})(?=.)/g, "$1 ");
  } catch {
    // Not signed in. A fingerprint is decoration on a screen that has other
    // things to say, so it is absent rather than an error.
    return null;
  }
}

export interface PinStatus {
  set: boolean;
  attempts_left: number;
}

export async function pinStatus(): Promise<PinStatus> {
  return corePin.status((await runtime()).pin);
}

export async function setPin(value: string): Promise<void> {
  return corePin.set((await runtime()).pin, value);
}

export async function clearPin(): Promise<void> {
  return corePin.clear((await runtime()).pin);
}

/**
 * Unlocks with a PIN.
 *
 * `null` means the digits were wrong, and nothing else: the lock screen counts
 * it as a spent try. A right PIN whose session the server has since ended —
 * signed out elsewhere, or revoked — rejects with `signed_out` instead, because
 * no PIN can bring that back and the lock screen's answer to it is the
 * password. Both used to be `null`, so a right PIN was drawn as a wrong one
 * until the tries ran out.
 *
 * The PIN does not decrypt anything — it gates a session that is already on
 * this device. That is the honest description, and the settings screen says it
 * too: it protects the screen, not the disk.
 */
export async function unlockWithPin(value: string): Promise<Account | null> {
  const it = await runtime();
  if (!(await corePin.verify(it.pin, value))) return null;
  const account = await it.session.resume();
  if (!account) {
    const ended: AuthError = {
      kind: "signed_out",
      message: "Your session has ended. Sign in with your password.",
    };
    throw ended;
  }
  return toAccount(account);
}

/**
 * Locks the app.
 *
 * # What this does, and what it cannot do
 *
 * It drops the MLS device and the tokens from memory, so nothing in the page
 * can read or send until a PIN or a password rebuilds them. It does **not**
 * make the messages unreadable: they are in IndexedDB, in the clear, and they
 * stay there. The lock screen guards the screen.
 *
 * That used to be different, and the difference is worth stating rather than
 * quietly losing. The Windows build kept its store in SQLCipher and locking
 * closed it, so the data on disk genuinely became ciphertext. A browser has
 * no keystore to hold that key, so there is no such thing to close — see
 * `docs/REWORK.md`. The settings screen says so where the lock is offered,
 * because a feature called "lock" invites a stronger reading than it can bear.
 */
export async function lockSession(): Promise<void> {
  closeStream();
  const { transport } = await runtime();
  transport.clear();
  // The device is built from the identity secret, which is still stored. What
  // this drops is the in-memory MLS provider, so a locked page holds no
  // ratchet — and `resume` rebuilds it from the store on unlock.
  resetRuntime();
}

/**
 * Signs out.
 *
 * By default what is on this device stays -- the keys, the MLS state, every
 * conversation's history -- so signing in again as the same person brings all
 * of it back (`Session.logout` says how). `erase` takes it all, for a
 * computer somebody else will use: nothing here can read those
 * conversations again afterwards.
 */
export async function logout(options: { erase?: boolean } = {}): Promise<void> {
  const { session } = await runtime();
  closeStream();
  await session.logout(options);
  // The tray tooltip and the startup entry, neither of which the page owns.
  // Nothing on the web, where there is neither.
  await forgetAccount();
  // The runtime holds an MLS device and tokens for the session that just
  // ended. Keeping it would mean the next sign-in on this page -- possibly as
  // somebody else -- inherits them; the next one rebuilds from the store.
  resetRuntime();
}

/**
 * Whose history is kept on this device while nobody is signed in, or `null`.
 *
 * What the sign-in form uses to say that signing in as somebody else removes
 * it -- and that signing in as them brings it back.
 */
export async function keptAccount(): Promise<string | null> {
  try {
    return (await (await runtime()).session.keptAccount())?.handle ?? null;
  } catch {
    return null;
  }
}

/**
 * Calls `listener` when the server ends this session while it is in use.
 *
 * Almost always because the account signed in somewhere else: one device per
 * account, so the web app signing in retires this one, and the reverse. Until
 * this the retired app went on drawing conversations whose every request was
 * refused, and each screen swallowed the refusal as `signed_out`.
 *
 * What is dropped is what `lockSession` drops -- the socket, the tokens, the
 * runtime -- and not the store: the identity key and the MLS state stay, so
 * signing in here again makes this the live device, with what it had. Signing
 * out does the same now, unless it is asked to erase.
 */
export function onSessionEnded(listener: () => void): () => void {
  return onRuntimeSessionEnded(() => {
    closeStream();
    resetRuntime();
    void forgetAccount();
    listener();
  });
}

export async function deleteAccount(_handle: string, password: string): Promise<void> {
  const { session } = await runtime();
  await session.deleteAccount(password);
  resetRuntime();
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const { session } = await runtime();
  await session.changePassword(currentPassword, newPassword);
}

export function handleProblem(handle: string): string | null {
  if (handle.length === 0) return null;
  if (handle.length < 3) return "At least 3 characters.";
  if (handle.length > 20) return "At most 20 characters.";
  if (!/^[a-z0-9_]+$/.test(handle)) {
    return "Lowercase letters, digits and underscores only.";
  }
  return null;
}

/** The store's account plus the device it is signed in on. */
async function toAccount(account: {
  userId: number;
  handle: string;
  displayName: string;
}): Promise<Account> {
  const identity = await (await runtime()).store.identity();
  return {
    user_id: account.userId,
    handle: account.handle,
    display_name: account.displayName,
    device_id: identity?.deviceId ?? "",
  };
}
