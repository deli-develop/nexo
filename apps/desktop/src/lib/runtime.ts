import {
  Session,
  Store,
  Transport,
  TransportError,
  bindObjectWasm,
  bindPasswordWasm,
  bindWasm,
  conversations,
  type AttachmentContext,
  type Context,
  type CryptoModule,
  type ObjectCrypto,
  type ObjectStore,
  type PinContext,
  type WasmModule,
} from "@nexo/core";

/**
 * The one place that knows which platform this is running on.
 *
 * Everything else in `src/` imports from here and gets the same objects
 * whether it is a Windows WebView, a browser tab, or an Android WebView. That
 * is the whole shape of the rework: one page, three hosts, and the host-shaped
 * decisions gathered where they can be counted rather than spread through
 * ninety-nine call sites.
 *
 * # What moved, and what that cost
 *
 * Until wave 7 the tokens and the MLS state lived in the Rust process, and a
 * script injected into the WebView could not reach them — that was invariant 2.
 * A browser has no such other side. The session now lives in the page, and
 * `docs/REWORK.md` records that as the price of one client across three
 * targets. It is not a detail to be discovered later by somebody reading
 * `Store`: everything here is as reachable as the page is.
 *
 * What *has not* changed: the server still never holds a key, and a message is
 * still opaque to it. Invariant 1 is untouched, and it is the one that matters
 * to somebody who is not holding this device.
 */

/** Where the API is, with a development override that never ships. */
function baseUrl(): string {
  // Vite inlines this at build time, so a production bundle contains the
  // literal and no branch — there is no environment to read in a browser, and
  // nothing a page could be talked into pointing somewhere else.
  const override = import.meta.env["VITE_NEXO_API_BASE"];
  if (import.meta.env.DEV && typeof override === "string" && override !== "") {
    return override;
  }
  return "https://api.delidev.net";
}

/** Whether this page is inside the Tauri shell rather than a browser tab. */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface Runtime {
  transport: Transport;
  store: Store;
  session: Session;
  crypto: CryptoModule;
  objects: ObjectCrypto;
  context(): Promise<Context>;
  attachments(): Promise<AttachmentContext>;
  pin: PinContext;
}

let pending: Promise<Runtime> | null = null;

/**
 * Builds the runtime once, and hands the same one to everybody afterwards.
 *
 * A promise rather than a value because the wasm module is fetched: the `web`
 * glue is an ES module with an async `init` that goes and gets the binary.
 * Two callers racing during start-up is normal — the sign-in screen and the
 * sync loop both want it — and caching the *promise* rather than the result is
 * what stops two MLS providers existing over one IndexedDB, which is a
 * corrupted ratchet rather than a slow start.
 */
export function runtime(): Promise<Runtime> {
  pending ??= build();
  return pending;
}

async function build(): Promise<Runtime> {
  const wasm = await import("@nexo/crypto-wasm/web");
  await wasm.default();
  wasm.initPanicHook();

  const crypto = bindWasm(wasm as unknown as WasmModule);
  const objects = bindObjectWasm(wasm as never);
  const store = await Store.open("nexo");
  const transport = new Transport({ baseUrl: baseUrl() });

  const session = new Session({
    transport,
    store,
    crypto,
    password: bindPasswordWasm(wasm as never),
  });

  // One door to "am I signed in", and it is the session's. Building a context
  // here from parts would be a second answer to that question, and the two
  // would disagree the first time a token expired.
  const context = (): Promise<Context> => session.context();

  return {
    transport,
    store,
    session,
    crypto,
    objects,
    // 19 MiB, two passes, one lane — the same parameters as
    // `crates/client/src/pin.rs`, and they are not a knob. A PIN is four to
    // twelve digits, so the only thing standing between a stolen device and
    // the messages on it is how long one guess takes.
    pin: {
      store,
      derive: async (pin, salt) => wasm.deriveVerifier(pin, salt, 19 * 1024, 2, 1),
    },
    context,
    attachments: async (): Promise<AttachmentContext> => {
      const ctx = await context();
      return {
        transport,
        crypto: objects,
        objects: httpObjects,
        sendPayload: (conversationId, payload) =>
          conversations.sendPayload(ctx, conversationId, payload),
      };
    },
  };
}

/**
 * Bytes to and from the object store.
 *
 * Plain `fetch`, deliberately without the transport: these requests do not go
 * to `apps/server` at all. They are presigned PUTs and GETs against a third
 * party, and attaching this account's bearer token to one would hand that
 * third party the session.
 *
 * Failures still come out as a `TransportError`, the same as the transport's
 * own. A bare `TypeError` from `fetch` — which is all a browser says when the
 * bucket's CORS rules refuse this origin — is not one, so every screen used to
 * flatten it into "Something went wrong" and nobody could tell a missing
 * bucket rule from a bug.
 */
const httpObjects: ObjectStore = {
  async put(url, bytes, contentType) {
    await objectRequest(url, {
      method: "PUT",
      body: bytes as unknown as BodyInit,
      headers: { "content-type": contentType },
    });
  },
  async get(url) {
    const response = await objectRequest(url, { method: "GET" });
    return new Uint8Array(await response.arrayBuffer());
  },
};

async function objectRequest(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "omit" });
  } catch (cause) {
    throw TransportError.unreachable(cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) {
    throw new TransportError("rejected", `The storage provider returned ${response.status}.`);
  }
  return response;
}

/** Forgets the runtime. Sign-out, and the failure path of a sign-in. */
export function resetRuntime(): void {
  pending = null;
}
