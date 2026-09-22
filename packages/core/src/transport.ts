import { TransportError } from "./errors";
import type { SessionTokens } from "./types";

/**
 * The network seam, over `fetch`.
 *
 * A port of `crates/client/src/http.rs`, and the three things that file learned
 * the hard way are carried over deliberately:
 *
 * **Refresh tokens rotate, and a spent one reads as theft.** Every refresh
 * issues a *new* refresh token and invalidates the old one. If the new one is
 * not written down, the next start replays a spent token, the server treats
 * that as a stolen credential, and it revokes every session for the account.
 * So a rotation is not "nice to persist" — losing one signs the person out
 * everywhere, and they cannot tell why.
 *
 * **Only one refresh may be in flight.** Two requests that both meet a 401
 * would both refresh, and the second would spend a token the first had already
 * replaced — the same theft response, self-inflicted. `refreshing` is the one
 * promise every caller waits on.
 *
 * **A 4xx is not an error until the body has been read.** The server puts the
 * useful part of a refusal in the body, and a 409 carries the epoch now in
 * force. Throwing on the status alone discards exactly the thing the caller
 * needs.
 */
export interface TransportOptions {
  baseUrl: string;
  /**
   * Called whenever the server issues a new refresh token.
   *
   * The transport has no store and must not acquire one: it is the piece that
   * has to run identically in a browser, a WebView and Node. Persisting is the
   * session layer's job, and this is how it hears about it.
   */
  onTokensRotated?: (tokens: SessionTokens) => void | Promise<void>;
  /** Injectable for tests. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
}

interface Refusal {
  error?: string;
  message?: string;
  current_epoch?: number;
}

export class Transport {
  readonly baseUrl: string;
  #accessToken: string | null = null;
  #refreshToken: string | null = null;
  #refreshing: Promise<boolean> | null = null;
  #expiresAt = 0;
  #pendingRotation: SessionTokens | null = null;
  #persisting: Promise<void> | null = null;
  #onRotated: TransportOptions["onTokensRotated"];
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#onRotated = options.onTokensRotated;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** The session layer installs its durable refresh-token hand-off here. */
  setRotationHandler(handler: NonNullable<TransportOptions["onTokensRotated"]>): void {
    this.#onRotated = handler;
  }

  /** Adopt a session, after signing in or restoring one from the store. */
  adopt(tokens: Pick<SessionTokens, "access_token" | "refresh_token"> & Partial<SessionTokens>): void {
    this.#accessToken = tokens.access_token;
    this.#refreshToken = tokens.refresh_token;
    this.#expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0;
    this.#pendingRotation = null;
  }

  /** Forget it. Sign-out, and any refusal that cannot be recovered from. */
  clear(): void {
    this.#accessToken = null;
    this.#refreshToken = null;
    this.#expiresAt = 0;
    this.#pendingRotation = null;
  }

  get signedIn(): boolean {
    return this.#accessToken !== null;
  }

  /** A current bearer for the browser WebSocket, which cannot set headers. */
  async accessToken(): Promise<string> {
    await this.#persistRotation();
    if (this.#expiresAt !== 0 && this.#expiresAt <= Date.now() + 30_000) {
      if (!(await this.#refresh())) {
        throw new TransportError("invalid_credentials", "You are not signed in.");
      }
    }
    return this.#bearer();
  }

  // ------------------------------------------------------------ unauthenticated

  async post<R>(path: string, body: unknown): Promise<R> {
    return this.#send<R>(path, { method: "POST", body });
  }

  // -------------------------------------------------------------- authenticated

  async getAuth<R>(path: string): Promise<R> {
    return this.#withRefresh((token) => this.#send<R>(path, { method: "GET", token }));
  }

  async postAuth<R>(path: string, body: unknown): Promise<R> {
    return this.#withRefresh((token) =>
      this.#send<R>(path, { method: "POST", body, token }),
    );
  }

  async patchAuth<R>(path: string, body: unknown): Promise<R> {
    return this.#withRefresh((token) =>
      this.#send<R>(path, { method: "PATCH", body, token }),
    );
  }

  async deleteAuth(path: string): Promise<void> {
    await this.#withRefresh((token) => this.#send<void>(path, { method: "DELETE", token }));
  }

  // --------------------------------------------------------------------- refresh

  /**
   * Runs `send`, and on a 401 refreshes once and runs it again.
   *
   * Exactly once: a second 401 after a successful refresh means the session is
   * genuinely gone, and retrying further would spend tokens for nothing.
   */
  async #withRefresh<R>(send: (token: string) => Promise<R>): Promise<R> {
    const token = await this.accessToken();
    try {
      return await send(token);
    } catch (error) {
      if (!(error instanceof TransportError) || error.kind !== "invalid_credentials") throw error;
      // Another caller may have refreshed while this request was in flight.
      // Retrying with its token avoids spending another rotating refresh token.
      if (this.#accessToken !== token) return send(await this.accessToken());
      if (!(await this.#refresh())) throw error;
      return send(await this.accessToken());
    }
  }

  /**
   * Trades the refresh token for a new pair. At most one at a time.
   *
   * Callers that arrive while a refresh is in flight wait on the same promise
   * and take its result, rather than starting a second one against a token the
   * first has already spent.
   */
  async #refresh(): Promise<boolean> {
    if (this.#refreshing) return this.#refreshing;

    const refreshToken = this.#refreshToken;
    if (!refreshToken) return false;

    this.#refreshing = (async () => {
      try {
        const tokens = await this.#send<SessionTokens>("/v1/auth/refresh", {
          method: "POST",
          body: { refresh_token: refreshToken },
        });
        this.#accessToken = tokens.access_token;
        this.#refreshToken = tokens.refresh_token;
        this.#expiresAt = Date.now() + tokens.expires_in * 1000;
        this.#pendingRotation = tokens;
        await this.#persistRotation();
        return true;
      } catch (error) {
        if (error instanceof TransportError && error.kind === "invalid_credentials") {
          this.clear();
          return false;
        }
        // In particular, a failed persistence callback is not an expired
        // session. Keep the newly rotated token for a later persistence retry.
        throw error;
      } finally {
        this.#refreshing = null;
      }
    })();

    return this.#refreshing;
  }

  async #persistRotation(): Promise<void> {
    if (this.#persisting) return this.#persisting;
    const pending = this.#pendingRotation;
    if (!pending) return;
    this.#persisting = Promise.resolve()
      .then(() => this.#onRotated?.(pending))
      .then(() => {
        if (this.#pendingRotation === pending) this.#pendingRotation = null;
      })
      .finally(() => {
        this.#persisting = null;
      });
    return this.#persisting;
  }

  #bearer(): string {
    if (!this.#accessToken) {
      throw new TransportError("invalid_credentials", "You are not signed in.");
    }
    return this.#accessToken;
  }

  // ------------------------------------------------------------------ the wire

  async #send<R>(
    path: string,
    options: { method: string; body?: unknown; token?: string },
  ): Promise<R> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.token) headers["authorization"] = `Bearer ${options.token}`;

    let response: Response;
    try {
      const init: RequestInit = {
        method: options.method,
        headers,
        // The browser must not attach cookies: this API authenticates with a
        // bearer token and nothing else, and a cookie riding along would be a
        // second, ambient credential nobody chose to send.
        credentials: "omit",
      };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);
      response = await this.#fetch(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      throw TransportError.unreachable(cause instanceof Error ? cause.message : String(cause));
    }

    const text = await response.text();

    if (response.ok) {
      // 204, and anything else with nothing in it. `undefined` cast to R is
      // honest here: the callers of those routes ask for `void`.
      if (text.trim() === "") return undefined as R;
      try {
        return JSON.parse(text) as R;
      } catch (cause) {
        throw new TransportError(
          "rejected",
          `Unreadable response: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }

    throw classify(response.status, text);
  }
}

/**
 * One place decides what a status means, so the meaning cannot drift between
 * call sites.
 *
 * A refusal body is expected to be `{error, message}`. When it is not — a
 * handler that answered with bare prose, a proxy's own HTML error page — the
 * status is all there is, and saying so beats inventing a sentence.
 */
function classify(status: number, body: string): TransportError {
  let parsed: Refusal = {};
  try {
    parsed = JSON.parse(body) as Refusal;
  } catch {
    /* not JSON; the status carries the meaning on its own */
  }
  const message = parsed.message ?? `The server returned ${status}.`;

  if (status === 401 || status === 403) {
    return new TransportError("invalid_credentials", message);
  }
  if (status === 404) return new TransportError("not_found", message);
  if (status === 409 && typeof parsed.current_epoch === "number") {
    return new TransportError("stale_epoch", message, parsed.current_epoch);
  }
  return new TransportError("rejected", message);
}
