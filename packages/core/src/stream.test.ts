import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Stream, type ServerEvent, type StreamOptions, type WebSocketLike } from "./stream";

/**
 * The socket.
 *
 * What is worth testing here is not that messages arrive — that is the
 * server's job and one `JSON.parse` — but the three things that go wrong
 * quietly: a credential that ends up somewhere it is logged, a reconnect that
 * never asks for the messages it missed, and a retry loop that turns an outage
 * into a stampede.
 */

class FakeSocket implements WebSocketLike {
  static opened: Array<{ url: string; protocols: string[] }> = [];
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(url: string, protocols: string[]) {
    FakeSocket.opened.push({ url, protocols });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

let sockets: FakeSocket[] = [];

function stream(over: Partial<StreamOptions> = {}) {
  return new Stream({
    baseUrl: "https://api.example",
    token: async () => "the-jwt",
    socket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    ...over,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.opened = [];
  sockets = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Stream", () => {
  it("carries the token as a subprotocol, never in the URL", async () => {
    const socket = stream();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);

    const [opened] = FakeSocket.opened;
    // `?token=…` writes the credential into every proxy log on the way, the
    // server's access log, and the browser's own history. The subprotocol is
    // not part of the URL and the server never echoes it back.
    expect(opened!.url).toBe("wss://api.example/v1/stream");
    expect(opened!.url).not.toContain("the-jwt");
    expect(opened!.protocols).toEqual(["nexo", "nexo.auth.the-jwt"]);
    socket.stop();
  });

  it("asks for a resync on every connect, including the first", async () => {
    const onResync = vi.fn();
    const socket = stream({ onResync });
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.onopen!({});

    // The first connect has a gap behind it too — everything that happened
    // while the app was closed.
    expect(onResync).toHaveBeenCalledTimes(1);

    sockets[0]!.onclose!({});
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.onopen!({});

    // And the gap while it was down is exactly the window where events were
    // missed. Reconnecting without this is how a message sits unseen until
    // something else happens to trigger a sync.
    expect(onResync).toHaveBeenCalledTimes(2);
    socket.stop();
  });

  it("backs off rather than hammering a server that is coming back up", async () => {
    const socket = stream();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      sockets[attempt]!.onclose!({});
      await vi.advanceTimersByTimeAsync(60_000);
    }

    // Five sockets for five attempts, not fifty. A thousand clients retrying
    // every second through an outage is indistinguishable from an attack, and
    // would keep the server down on the way back up.
    expect(sockets).toHaveLength(5);
    socket.stop();
  });

  it("drops an event kind it does not know instead of throwing", async () => {
    const seen: ServerEvent[] = [];
    const socket = stream({ onEvent: (event) => seen.push(event) });
    socket.start();
    await vi.advanceTimersByTimeAsync(0);

    sockets[0]!.onmessage!({ data: '{"type":"hologram"}' });
    sockets[0]!.onmessage!({ data: "not json at all" });
    sockets[0]!.onmessage!({ data: '{"type":"typing","conversation_id":"c1","user_id":2}' });

    // A newer server talking to an older client. The sync underneath already
    // carries whatever the unknown one meant, in a form this build reads.
    expect(seen).toEqual([{ type: "typing", conversation_id: "c1", user_id: 2 }]);
    socket.stop();
  });

  it("passes the membership nudge through", async () => {
    const seen: ServerEvent[] = [];
    const socket = stream({ onEvent: (event) => seen.push(event) });
    socket.start();
    await vi.advanceTimersByTimeAsync(0);

    sockets[0]!.onmessage!({ data: '{"type":"membership","conversation_id":"t1"}' });

    expect(seen).toEqual([{ type: "membership", conversation_id: "t1" }]);
    socket.stop();
  });

  it("drops a typing notice when there is no socket rather than queueing it", async () => {
    const socket = stream();
    socket.typing("c1");
    socket.start();
    await vi.advanceTimersByTimeAsync(0);

    // A typing notice delivered after the person stopped typing is worse than
    // one never sent.
    expect(sockets[0]!.sent).toEqual([]);
    socket.typing("c1");
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: "typing", conversation_id: "c1" });
    socket.stop();
  });

  it("stays closed once stopped, even with a reconnect already in flight", async () => {
    const socket = stream();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.onclose!({});
    socket.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    // Sign-out and lock go through `stop`. A socket that outlives the session
    // that authorised it is a socket holding a token nobody meant it to have.
    expect(sockets).toHaveLength(1);
  });
});
