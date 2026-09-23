/**
 * A WebSocket transport that speaks through a relay.
 *
 * The relay is a local TCP listener (started by the Rust shell) that accepts
 * WebSocket connections from blocked users and forwards them through a plain
 * `wss://` connection to the real server. The relay sees opaque Nexo envelopes —
 * it never reads messages, tokens, or MLS state.
 *
 * Protocol:
 * 1. The relay accepts a TCP connection from this client.
 * 2. This client sends a `{"jsonrpc":"2.0","method":"relay_connect"}` JSON-RPC
 *    message containing its device ID (the relay uses this to select the
 *    outbound server connection).
 * 3. The relay answers with `{"jsonrpc":"2.0","result":null}` on success or
 *    `{"jsonrpc":"2.0","error":{"code":-32600,"message":"..."}}` on failure.
 * 4. After handshake, the relay proxies all frames in both directions until
 *    one side disconnects.
 *
 * This is the transport that a blocked user selects when the server returns a
 * `relay` transport type in `profile_info` (§4.3 of CONTEXT.md).
 */

import { TransportError } from "./errors";

export interface RelayTransportOptions {
  /** The relay's local WebSocket URL, e.g. `ws://127.0.0.1:41731`. */
  relayUrl: string;
  /** Device ID to identify the relay tunnel. */
  deviceId: string;
  /** Optional ping interval in ms (default: 30000). Set 0 to disable. */
  pingIntervalMs?: number;
}

export class RelayTransport {
  readonly relayUrl: string;
  readonly deviceId: string;
  readonly pingIntervalMs: number;
  #ws: WebSocket | null = null;
  #closed = false;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectAttempts = 0;
  #onCloseListeners: (() => void)[] = [];

  constructor(options: RelayTransportOptions) {
    this.relayUrl = options.relayUrl;
    this.deviceId = options.deviceId;
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
  }

  /** Register a listener that fires when the relay closes. */
  onClose(fn: () => void): void {
    this.#onCloseListeners.push(fn);
  }

  /** Start the WebSocket connection. Rejects on handshake failure. */
  async connect(): Promise<void> {
    if (this.#ws) return;
    if (this.#closed) throw new TransportError("unreachable", "RelayTransport is closed.");

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.relayUrl);
      ws.binaryType = "arraybuffer";
      this.#ws = ws;

      ws.onopen = () => {
        // Send relay_connect handshake.
        const connectMsg = JSON.stringify({
          jsonrpc: "2.0",
          method: "relay_connect",
          params: { device_id: this.deviceId },
          id: 1,
        });
        ws.send(connectMsg);
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Binary frames: relay data forwarded to server.
          // The upper layer (stream.ts) handles these.
          return;
        }
        // Text frame: JSON-RPC handshake response.
        const data = JSON.parse(event.data);
        if (data.error) {
          ws.close();
          reject(
            new TransportError(
              "unreachable",
              `Relay handshake failed: ${data.error.message}`,
            ),
          );
          return;
        }
        // Connected. Start optional ping timer.
        this.#reconnectAttempts = 0;
        if (this.pingIntervalMs > 0) {
          this.#pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({ jsonrpc: "2.0", method: "ping", id: Date.now() }),
              );
            }
          }, this.pingIntervalMs);
        }
        resolve();
      };

      ws.onerror = () => {
        // Will be followed by onclose; reject the connect promise.
        reject(
          new TransportError(
            "unreachable",
            "Failed to connect to relay.",
          ),
        );
      };

      ws.onclose = () => {
        if (this.#closed) {
          // Intentional close.
          return;
        }
        // Notify listeners.
        for (const fn of this.#onCloseListeners) fn();
        // Attempt reconnection.
        if (this.#reconnectAttempts < 5) {
          const delay = Math.min(1000 * 2 ** this.#reconnectAttempts, 30_000);
          this.#reconnectAttempts++;
          setTimeout(() => this.connect().catch(() => {}), delay);
        }
      };
    });
  }

  /** Send binary data through the relay. */
  send(data: Uint8Array<ArrayBuffer>): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new TransportError("unreachable", "Relay transport is not connected.");
    }
    this.#ws.send(data);
  }

  /** Get the current ready state. */
  get readyState(): number {
    return this.#ws?.readyState ?? WebSocket.CLOSED;
  }

  /** Close the relay connection. */
  close(): void {
    this.#closed = true;
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
  }
}
