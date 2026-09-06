import { invoke } from "@tauri-apps/api/core";

/**
 * The auth surface, as the WebView sees it.
 *
 * Rule 2: nothing secret crosses this boundary. A password goes *in* once and
 * is never held here; what comes back is an account and nothing else. There is
 * deliberately no token in any of these types — tokens live in the Rust
 * process, out of reach of anything that ever manages to run script here.
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
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    "message" in error
  ) {
    return error as AuthError;
  }
  // A command that rejects with something else is a bug in the Rust side, not
  // a state the user can act on.
  return { kind: "internal", message: "Something went wrong. Try again." };
}

export function register(
  handle: string,
  displayName: string,
  password: string,
): Promise<Account> {
  return invoke<Account>("register", {
    handle,
    displayName,
    password,
  });
}

export function login(handle: string, password: string): Promise<Account> {
  return invoke<Account>("login", { handle, password });
}

/** The account this installation is signed in as, if any. */
export function restoreSession(): Promise<Account | null> {
  return invoke<Account | null>("restore_session");
}

/**
 * This device's identity fingerprint, already grouped (brief 4.1).
 *
 * `null` when there is no identity key to fingerprint. The Security screen
 * shows that as "no key yet" rather than inventing digits: it is the one
 * screen that asks people to compare a value in person, so a placeholder there
 * would teach exactly the wrong habit.
 */
export function deviceFingerprint(): Promise<string | null> {
  return invoke<string | null>("device_fingerprint");
}

/** Whether an unlock PIN is set, and how many tries remain. */
export interface PinStatus {
  set: boolean;
  attempts_left: number;
}

export function pinStatus(): Promise<PinStatus> {
  return invoke<PinStatus>("pin_status");
}

/**
 * Sets or replaces the unlock PIN.
 *
 * The digits go in and are gone when this resolves. What is written down is a
 * salted Argon2id verifier wrapped by the OS keystore, so it is bound to this
 * Windows account as well as to the PIN — neither alone opens anything.
 */
export function setPin(pin: string): Promise<void> {
  return invoke<void>("set_pin", { pin });
}

export function clearPin(): Promise<void> {
  return invoke<void>("clear_pin");
}

/**
 * Unlocks with the PIN. `null` means it was wrong — and nothing else does.
 *
 * Only ever reopens what is already on this machine: locking dropped the store
 * connection and the MLS state, and the tokens stayed in the Rust process, so
 * this needs no server. The server has never heard of the PIN.
 *
 * The one path that does reach the network — an app that opened offline and
 * so never installed a session — reports its failures as errors (`unreachable`,
 * `signed_out`) rather than as `null`. Reading either of those as a wrong PIN
 * is what made the correct one show "That PIN is wrong."
 */
export function unlockWithPin(pin: string): Promise<Account | null> {
  return invoke<Account | null>("unlock_with_pin", { pin });
}

export function logout(): Promise<void> {
  return invoke<void>("logout");
}

/**
 * Deletes the account, on the server and then on this machine.
 *
 * The password goes to Rust and no further: it becomes a verifier there and is
 * never sent, stored or logged — the same path `changePassword` takes. The
 * handle goes with it because the verifier has to be derived against that
 * account's salt.
 *
 * Rejects without having deleted anything local if the server refuses, which
 * is the whole reason the order is server-first: an account that still exists
 * but that this machine can no longer reach would have no way back, because
 * there is no account recovery.
 */
export function deleteAccount(handle: string, password: string): Promise<void> {
  return invoke<void>("delete_account", { handle, password });
}

/**
 * Changes the account password (§6.4).
 *
 * Both passwords go in once and are gone when this resolves. Rust derives the
 * two verifiers — the current one proves knowledge of the password, because a
 * signed-in session alone is only possession of an unlocked machine — and
 * neither password is ever sent.
 *
 * Nothing local is re-encrypted: the store's key comes from the OS keystore,
 * not from the password, so no history can be lost to this.
 */
export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  return invoke<void>("change_password", { currentPassword, newPassword });
}

/**
 * The handle rules from §4.1, checked here so the message arrives as you type
 * rather than after a round trip. The server and the database both enforce
 * them again — this is a courtesy, not the control.
 */
export function handleProblem(handle: string): string | null {
  if (handle.length === 0) return null;
  if (handle.length < 3) return "At least 3 characters.";
  if (handle.length > 20) return "At most 20 characters.";
  if (!/^[a-z0-9_]+$/.test(handle)) {
    return "Lowercase letters, digits and underscores only.";
  }
  return null;
}
