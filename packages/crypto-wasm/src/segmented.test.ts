/**
 * Segmented attachments, through the **real** module and core's real reader.
 *
 * The Rust client sealed video in 256 KiB segments, and the page could only
 * open objects sealed whole, so every such video read as "can't decrypt".
 * Core's own test proves the reader picks the right door from the payload;
 * this proves the door opens — real ciphertext, several segments, and the
 * refusals rule 7 asks for when it has been cut, altered or described wrongly.
 */

import { describe, expect, it } from "vitest";

import * as attachments from "../../core/src/attachments";
import { Transport } from "../../core/src/transport";
import { bindObjectWasm } from "../../core/src/wasm";

import * as wasm from "../pkg/nexo_crypto_wasm.js";

const objects = bindObjectWasm(wasm as never);

/** Three segments and a bit: 256 KiB each, and a short tail. */
function plaintext(): Uint8Array {
  const bytes = new Uint8Array(3 * 256 * 1024 + 777);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

function sealed() {
  const input = plaintext();
  const out = wasm.sealSegmentedObject(input);
  return {
    input,
    ciphertext: out.ciphertext,
    key: out.key,
    nonce: out.nonce,
    sha256: out.sha256,
    size: Number(out.size),
  };
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("segmented objects", () => {
  it("open whole, byte for byte", () => {
    const s = sealed();
    const opened = objects.openSegmented(s.ciphertext, s.key, s.nonce, s.sha256, s.size);
    expect(opened).toEqual(s.input);
  });

  it("do not open as whole objects, which is what the page used to try", () => {
    const s = sealed();
    expect(() => objects.open(s.ciphertext, s.key, s.nonce, s.sha256)).toThrow();
  });

  it("refuse a cut, an altered byte, or a size the ciphertext cannot hold", () => {
    const s = sealed();
    const cut = s.ciphertext.slice(0, s.ciphertext.length - 100);
    expect(() => objects.openSegmented(cut, s.key, s.nonce, s.sha256, s.size)).toThrow();

    const altered = s.ciphertext.slice();
    altered[300_000] = altered[300_000]! ^ 1;
    expect(() => objects.openSegmented(altered, s.key, s.nonce, s.sha256, s.size)).toThrow();

    // A sender's number decides nothing on its own. The largest of these would
    // have been an allocation of petabytes before the length check.
    for (const size of [s.size + 1, s.size - 1, 2 ** 52, 0]) {
      expect(() => objects.openSegmented(s.ciphertext, s.key, s.nonce, s.sha256, size)).toThrow();
    }
    expect(() => objects.openSegmented(s.ciphertext, s.key, s.nonce, s.sha256, 1.5)).toThrow();
  });

  it("open through core's reader when the payload says segmented", async () => {
    const s = sealed();
    const transport = new Transport({
      baseUrl: "https://api.example",
      fetch: (async () =>
        new Response(JSON.stringify({ url: "https://bucket/object" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof globalThis.fetch,
    });
    transport.adopt({ access_token: "a", refresh_token: "r" });

    const opened = await attachments.open(
      {
        transport,
        crypto: objects,
        objects: { put: async () => {}, get: async () => s.ciphertext },
        sendPayload: async () => null,
      },
      {
        s3_key: "k",
        key: hex(s.key),
        nonce: hex(s.nonce),
        sha256: hex(s.sha256),
        segmented: true,
        size: s.size,
      },
    );
    expect(opened).toEqual(s.input);
  });
});
