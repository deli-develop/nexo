/**
 * The live socket.
 *
 * # It adds promptness, not correctness
 *
 * Every envelope also lands in the database and every client keeps a cursor,
 * so a dropped connection, a missed event or a subscriber the server gave up
 * on are all repaired by the next `sync`. That is stated on the server side in
 * `apps/server/src/stream/mod.rs`, and it is the licence this file operates
 * under: **nothing here may throw into the app**. A socket that reported its
 * own failures loudly would be reporting something the four-second poll has
 * already fixed.
 *
 * What it must do is the opposite of that: on every successful (re)connect it
 * calls `onResync`, because the gap while it was down is exactly the window
 * where events were missed, and only a sync can close it.
 *
 * # The token does not go in the URL
 *
 * A browser's `WebSocket` cannot set an `Authorization` header, and the usual
 * workaround — `?token=…` — writes the credential into every proxy log, every
 * access log and the browser's own history. The server takes it as a
 * **subprotocol** instead (`nexo.auth.<jwt>`), which is not logged as part of
 * the URL, and it never echoes that value back. Native clients still send the
 * header; this file is the browser half of the same door.
 */

/** Something arrived for a conversation. */
export interface EnvelopeEvent {
  type: "envelope";
  envelope_id: number;
  conversation_id: string;
  sender_device_id: string;
  epoch: number;
  /** Hex. Opaque here, as everywhere outside MLS. */
  ciphertext: string;
  is_commit: boolean;
  server_timestamp_ms: number;
}

export interface TypingEvent {
  type: "typing";
  conversation_id: string;
  user_id: number;
}

export interface PresenceEvent {
  type: "presence";
  user_id: number;
  online: boolean;
}

export interface ReceiptEvent {
  type: "receipt";
  conversation_id: string;
  envelope_id: number;
  user_id: number;
}

export type ServerEvent = EnvelopeEvent | TypingEvent | PresenceEvent | ReceiptEvent;

export interface StreamOptions {
  /** The API base, `https://…`. Rewritten to `wss://` here, not by callers. */
  baseUrl: string;
  /** Asked for a fresh access token per connection, never cached here. */
  token: () => Promise<string>;
  /**
   * Called after every connect, including reconnects.
   *
   * The whole reason this class is safe to lose: it says "you were away, go
   * and find out what happened" rather than trying to replay it.
   */
  onResync?: () => void;
  onEvent?: (event: ServerEvent) => void;
  /** Injectable so tests drive a double rather than a real socket. */
  socket?: (url: string, protocols: string[]) => WebSocketLike;
}

/** What this file needs of a WebSocket, and no more. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** First retry, and the ceiling. Both deliberately unhurried. */
const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class Stream {
  readonly #options: StreamOptions;
  #socket: WebSocketLike | null = null;
  #backoff = FIRST_BACKOFF_MS;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Set by `stop`, so a reconnect already in flight does not resurrect it. */
  #stopped = true;

  constructor(options: StreamOptions) {
    this.#options = options;
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  /** Opens the socket, and keeps it open. Safe to call twice. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#connect();
  }

  /**
   * Closes it and stops reconnecting.
   *
   * Called on sign-out and on lock. Not calling it there is how a socket
   * outlives the session that authorised it.
   */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    try {
      socket?.close();
    } catch {
      // Closing a socket that is already gone is not news.
    }
  }

  /** Tells a conversation this device is typing. Fire and forget, by design. */
  typing(conversationId: string): void {
    this.#send({ type: "typing", conversation_id: conversationId });
  }

  /** Confirms an envelope arrived, so the server can stop holding it. */
  ack(conversationId: string, envelopeId: number): void {
    this.#send({ type: "ack", conversation_id: conversationId, envelope_id: envelopeId });
  }

  #send(payload: unknown): void {
    // Dropped when there is no socket, rather than queued. A typing notice
    // delivered after the person stopped typing is worse than none, and an ack
    // is re-sent by the next sync anyway.
    if (!this.#socket) return;
    try {
      this.#socket.send(JSON.stringify(payload));
    } catch {
      // The close handler will deal with it.
    }
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;

    let token: string;
    try {
      token = await this.#options.token();
    } catch {
      // No session, or the refresh failed. Neither is this file's problem;
      // try again later rather than reporting a second time.
      this.#retry();
      return;
    }
    if (this.#stopped) return;

    const url = this.#options.baseUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/v1/stream";
    const open = this.#options.socket ?? defaultSocket;

    let socket: WebSocketLike;
    try {
      socket = open(url, ["nexo", `nexo.auth.${token}`]);
    } catch {
      this.#retry();
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#backoff = FIRST_BACKOFF_MS;
      // Every connect, not just reconnects: the first one also has a gap
      // behind it — everything that happened while the app was closed.
      this.#options.onResync?.();
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const type = (parsed as { type?: unknown }).type;
      // An unknown `type` is a newer server talking to an older client. It is
      // dropped, not reported: the sync underneath already carries whatever it
      // meant, in a form this build does understand.
      if (type !== "envelope" && type !== "typing" && type !== "presence" && type !== "receipt") {
        return;
      }
      this.#options.onEvent?.(parsed as ServerEvent);
    };

    const fall = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#retry();
    };
    socket.onclose = fall;
    socket.onerror = fall;
  }

  /**
   * Waits, then tries again — with the wait doubling to half a minute.
   *
   * The ceiling matters more than the growth: a client that retried every
   * second through an outage would be indistinguishable from an attack on the
   * way back up, and a thousand of them would keep the server down.
   */
  #retry(): void {
    if (this.#stopped || this.#timer !== null) return;
    const wait = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#connect();
    }, wait);
  }
}

function defaultSocket(url: string, protocols: string[]): WebSocketLike {
  return new globalThis.WebSocket(url, protocols) as unknown as WebSocketLike;
}
