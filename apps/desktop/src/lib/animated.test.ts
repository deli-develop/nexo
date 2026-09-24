import { describe, expect, it } from "vitest";

import { isAnimated } from "./animated";

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/**
 * A 1×1 GIF with `frames` images, each behind a graphic control extension,
 * laid out the way encoders write one: the NETSCAPE2.0 loop block and a
 * comment before the first frame.
 */
function gif(frames: number, pixels: number[] = [0x44, 0x01]): Uint8Array {
  const header = [
    ...ascii("GIF89a"), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
    0x21, 0xff, 11, ...ascii("NETSCAPE2.0"), 3, 1, 0, 0, 0,
    0x21, 0xfe, 5, ...ascii("nexo,"), 0,
  ];
  const frame = [
    0x21, 0xf9, 4, 0, 10, 0, 0, 0,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0,
    2, pixels.length, ...pixels, 0,
  ];
  return Uint8Array.from([...header, ...Array.from({ length: frames }, () => frame).flat(), 0x3b]);
}

function webp(chunk: string, flags = 0): Uint8Array {
  return Uint8Array.from([
    ...ascii("RIFF"), 30, 0, 0, 0, ...ascii("WEBP"), ...ascii(chunk), 10, 0, 0, 0,
    flags, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
}

describe("isAnimated", () => {
  it("tells a moving GIF from a still one", () => {
    expect(isAnimated(gif(1))).toBe(false);
    expect(isAnimated(gif(2))).toBe(true);
    expect(isAnimated(gif(12))).toBe(true);
  });

  it("is not fooled by an image descriptor's byte inside the pixels", () => {
    // 0x2C in the compressed data of the only frame.
    expect(isAnimated(gif(1, [0x2c, 0x2c, 0x2c]))).toBe(false);
  });

  it("reads the animation flag of an extended WebP", () => {
    expect(isAnimated(webp("VP8X", 0x02))).toBe(true);
    expect(isAnimated(webp("VP8X", 0x10))).toBe(false);
    expect(isAnimated(webp("VP8 "))).toBe(false);
  });

  it("answers no for anything else, and for a cut-off file", () => {
    expect(isAnimated(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isAnimated(gif(2).slice(0, 20))).toBe(false);
    expect(isAnimated(new Uint8Array())).toBe(false);
  });
});
