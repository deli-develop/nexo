import * as auth from "./auth";
import * as conversations from "./conversations";
import type { CryptoModule, Device } from "./crypto";
import { TransportError } from "./errors";
import type { Account, Identity, Store } from "./store";
import type { Transport } from "./transport";
import type { Argon2Params, SessionTokens } from "./types";

/** Argon2id comes from Rust/WASM, never a JavaScript implementation here. */
export interface PasswordCrypto {
  deriveVerifier(password: string, salt: Uint8Array, params: Argon2Params):
    Uint8Array | Promise<Uint8Array>;
}

export interface SessionOptions {
  transport: Transport;
  store: Store;
  crypto: CryptoModule;
  password: PasswordCrypto;
  now?: () => number;
  uuid?: () => string;
  randomBytes?: (length: number) => Uint8Array;
  /**
   * The server ended this session while it was in use -- see
   * `TransportOptions.onSessionEnded`. Runs after the dead refresh token is
   * gone from the store; what is on this device stays, so signing in again
   * here picks it back up.
   */
  onEnded?: () => void | Promise<void>;
}

/** One signed-in device, independent of React and its host platform. */
export class Session {
  readonly #transport: Transport;
  readonly #store: Store;
  readonly #crypto: CryptoModule;
  readonly #password: PasswordCrypto;
  readonly #now: () => number;
  readonly #uuid: () => string;
  readonly #randomBytes: (length: number) => Uint8Array;
  #device: Device | null = null;
  #keyPackagesPending = false;
  #pendingResume: SessionTokens | null = null;

  constructor(options: SessionOptions) {
    this.#transport = options.transport;
    this.#store = options.store;
    this.#crypto = options.crypto;
    this.#password = options.password;
    this.#now = options.now ?? Date.now;
    this.#uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
    this.#randomBytes = options.randomBytes ?? ((length) => globalThis.crypto.getRandomValues(new Uint8Array(length)));
    this.#transport.setRotationHandler((tokens) => this.#store.setRefreshToken(tokens.refresh_token));
    const onEnded = options.onEnded;
    this.#transport.setEndedHandler(async () => {
      // Not spent again on the next start: it would only be refused again.
      await this.#store.clearRefreshToken();
      await onEnded?.();
    });
  }

  /** A new device retries publishing its first KeyPackages on sync. */
  get keyPackagesPending(): boolean {
    return this.#keyPackagesPending;
  }

  async register(handle: string, displayName: string, password: string): Promise<Account> {
    this.#guardAccount(handle, await this.#store.account());
    const { argon2 } = await auth.salt(this.#transport, handle);
    const salt = this.#randomBytes(16);
    const verifier = await this.#derive(password, salt, argon2);
    // The server assigns a device id only after registration. Generate the
    // identity under a temporary credential, then bind it to the returned id.
    const provisional = this.#crypto.newDevice(this.#uuid());
    const secret = provisional.exportSecret();
    let tokens: SessionTokens;
    try {
      tokens = await auth.register(this.#transport, {
        handle,
        displayName,
        pwSalt: hex(salt),
        pwVerifier: hex(verifier),
        identityPubkey: hex(provisional.publicKey()),
      });
    } catch (error) {
      secret.fill(0);
      throw error;
    } finally {
      verifier.fill(0);
    }
    const device = this.#crypto.deviceFromSecret(tokens.device_id, secret);
    const account: Account = { userId: tokens.user_id, handle, displayName };
    try {
      await this.#store.persistSignIn(
        account, { deviceId: tokens.device_id, secret }, tokens.refresh_token, device.exportState(),
      );
    } finally {
      secret.fill(0);
    }
    this.#device = device;
    this.#transport.adopt(tokens);
    this.#keyPackagesPending = true;
    await this.#publishInitialKeyPackages();
    return account;
  }

  async login(handle: string, password: string): Promise<Account> {
    const previous = await this.#store.account();
    this.#guardAccount(handle, previous);
    const { salt, argon2 } = await auth.salt(this.#transport, handle);
    const verifier = await this.#derive(password, unhex(salt), argon2);
    const identity = await this.#store.identity();
    const provisional = identity
      ? this.#crypto.deviceFromSecret(identity.deviceId, identity.secret)
      : this.#crypto.newDevice(this.#uuid());
    const secret = provisional.exportSecret();
    let tokens: SessionTokens;
    try {
      tokens = await auth.login(this.#transport, handle, hex(verifier), hex(provisional.publicKey()));
    } catch (error) {
      secret.fill(0);
      throw error;
    } finally {
      verifier.fill(0);
    }
    const device = this.#crypto.deviceFromSecret(tokens.device_id, secret);
    const oldState = identity ? await this.#store.mlsState() : null;
    if (oldState) device.importState(oldState);
    const account: Account = {
      userId: tokens.user_id,
      handle,
      // Login does not return a display name. Keep the one this device knew.
      displayName: previous?.displayName ?? handle,
    };
    try {
      await this.#store.persistSignIn(
        account, { deviceId: tokens.device_id, secret }, tokens.refresh_token, device.exportState(),
      );
    } finally {
      secret.fill(0);
    }
    this.#device = device;
    this.#transport.adopt(tokens);
    this.#keyPackagesPending = !identity;
    await this.#publishInitialKeyPackages();
    return account;
  }

  /** Opens local history without a network request. */
  async restore(): Promise<Account | null> {
    const account = await this.#store.account();
    if (!account) return null;
    const identity = await this.#store.identity();
    if (!identity) throw new Error("The account has no identity key on this device.");
    this.#device = this.#crypto.deviceFromSecret(identity.deviceId, identity.secret);
    const state = await this.#store.mlsState();
    if (state) this.#device.importState(state);
    return account;
  }

  /** Exchanges the stored, single-use refresh token for a live session. */
  async resume(): Promise<Account | null> {
    const account = await this.restore();
    if (!account) return null;
    const refreshToken = await this.#store.refreshToken();
    if (!refreshToken) return null;
    let tokens: SessionTokens;
    try {
      tokens = this.#pendingResume ?? await this.#transport.post<SessionTokens>(
        "/v1/auth/refresh", { refresh_token: refreshToken },
      );
    } catch (error) {
      if (error instanceof TransportError && error.kind === "invalid_credentials") {
        await this.#store.clearRefreshToken();
        this.#transport.clear();
        return null;
      }
      throw error;
    }
    // Rotation is already final on the server. Store it before a bearer call.
    this.#pendingResume = tokens;
    await this.#store.setRefreshToken(tokens.refresh_token);
    this.#pendingResume = null;
    this.#transport.adopt(tokens);
    return account;
  }

  /** Sign-out wipes local data even if revocation cannot reach the API. */
  async logout(): Promise<void> {
    try {
      const refreshToken = await this.#store.refreshToken();
      if (refreshToken) await auth.logout(this.#transport, refreshToken);
    } finally {
      this.#transport.clear();
      this.#device = null;
      this.#keyPackagesPending = false;
      this.#pendingResume = null;
      await this.#store.wipe();
    }
  }

  /** Server-first: a refusal must leave this device able to reach the account. */
  async deleteAccount(password: string): Promise<void> {
    const account = await this.#requireAccount();
    const { salt, argon2 } = await auth.salt(this.#transport, account.handle);
    const verifier = await this.#derive(password, unhex(salt), argon2);
    try {
      await this.#transport.postAuth<void>("/v1/auth/delete-account", {
        pw_verifier: hex(verifier),
      });
    } finally {
      verifier.fill(0);
    }
    this.#transport.clear();
    this.#device = null;
    await this.#store.wipe();
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (!newPassword) throw new Error("The new password is empty.");
    const account = await this.#requireAccount();
    const { salt, argon2 } = await auth.salt(this.#transport, account.handle);
    const oldVerifier = await this.#derive(currentPassword, unhex(salt), argon2);
    const newSalt = this.#randomBytes(16);
    const newVerifier = await this.#derive(newPassword, newSalt, argon2);
    try {
      await this.#transport.postAuth<void>("/v1/auth/change-password", {
        pw_verifier: hex(oldVerifier),
        new_pw_salt: hex(newSalt),
        new_pw_verifier: hex(newVerifier),
      });
    } finally {
      oldVerifier.fill(0);
      newVerifier.fill(0);
    }
  }

  account(): Promise<Account | null> { return this.#store.account(); }
  identity(): Promise<Identity | null> { return this.#store.identity(); }

  startConversation(handle: string): Promise<string> {
    return this.#context().then((ctx) => conversations.startWith(ctx, handle));
  }
  openConversation(handle: string): Promise<string> {
    return this.#context().then((ctx) => conversations.openWith(ctx, handle));
  }
  sendMessage(conversationId: string, body: string): Promise<number | null> {
    return this.#context().then((ctx) => conversations.send(ctx, conversationId, body));
  }
  sendReaction(conversationId: string, target: string, emoji: string, on: boolean): Promise<void> {
    return this.#context().then((ctx) => conversations.react(ctx, conversationId, target, emoji, on));
  }
  renameConversation(conversationId: string, title: string): Promise<void> {
    return this.#context().then((ctx) => conversations.rename(ctx, conversationId, title));
  }
  async sync(): Promise<conversations.SyncOutcome> {
    const ctx = await this.#context();
    if (this.#keyPackagesPending) await this.#publishInitialKeyPackages();
    else await conversations.refillKeyPackagesIfLow(ctx);
    return conversations.syncAll(ctx);
  }
  flushOutbox(): Promise<number> { return this.#context().then(conversations.flushOutbox); }
  discoverConversations(): Promise<string[]> { return this.#context().then(conversations.discover); }

  async #publishInitialKeyPackages(): Promise<void> {
    if (!this.#keyPackagesPending) return;
    try {
      await conversations.publishKeyPackages(await this.#context(), 50);
      this.#keyPackagesPending = false;
    } catch {
      // Auth succeeded and was persisted. Retry on sync instead of reporting a
      // failed registration that would tempt a second attempt at the handle.
    }
  }

  /**
   * The signed-in context, for the operations that are not methods here.
   *
   * `attachments`, `stories`, `pin` and the rest take a context rather than a
   * session, because none of them has any business calling `logout`. This is
   * the one door to it, so "am I signed in" is still asked in exactly one
   * place and still answers the same way.
   */
  context(): Promise<conversations.Context> {
    return this.#context();
  }

  /** The MLS device, for a safety number or a fingerprint. */
  async device(): Promise<Device> {
    return (await this.#context()).device;
  }

  async #context(): Promise<conversations.Context> {
    if (!await this.#store.account() || !this.#device) {
      throw new TransportError("invalid_credentials", "You are not signed in.");
    }
    return {
      transport: this.#transport, store: this.#store, crypto: this.#crypto,
      device: this.#device, now: this.#now, uuid: this.#uuid,
    };
  }

  async #requireAccount(): Promise<Account> {
    const account = await this.#store.account();
    if (!account) throw new TransportError("invalid_credentials", "You are not signed in.");
    return account;
  }
  #guardAccount(handle: string, existing: Account | null): void {
    if (existing && existing.handle !== handle) {
      throw new Error(`This device is signed in as @${existing.handle}.`);
    }
  }
  async #derive(password: string, salt: Uint8Array, params: Argon2Params): Promise<Uint8Array> {
    return this.#password.deriveVerifier(password, salt, params);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function unhex(value: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error("The server sent an invalid salt.");
  return Uint8Array.from(value.match(/../g)!, (pair) => Number.parseInt(pair, 16));
}
