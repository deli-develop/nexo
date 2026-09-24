/**
 * Whether a picture moves, read from its bytes.
 *
 * What decides whether a picture may go through the cropper. The cropper
 * draws onto a canvas and saves a JPEG, and a canvas holds one frame: an
 * animated GIF chosen as a profile picture was stored as its first frame and
 * never moved again. A moving picture is uploaded as it is instead.
 *
 * Only asks whether there is more than one frame. A GIF with a single frame
 * is a still picture and is cropped like any other, because being able to
 * choose the part of it that shows is worth more than keeping its format.
 * Anything this cannot read answers `false`, which is the old behaviour: the
 * worst case is a still picture, never a refused one.
 */
export function isAnimated(bytes: Uint8Array): boolean {
  if (startsWith(bytes, 0, "GIF87a") || startsWith(bytes, 0, "GIF89a")) {
    return gifFrames(bytes) > 1;
  }
  if (startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WEBP")) {
    // An animated WebP is always the extended format, and says so in the
    // VP8X header's flags: bit 1 is "has animation".
    return startsWith(bytes, 12, "VP8X") && bytes.length > 20 && (bytes[20]! & 0x02) !== 0;
  }
  return false;
}

/**
 * How many images a GIF holds -- counted up to two, which is all the question
 * needs. Walks the blocks rather than searching for `0x2C`, which is as
 * likely to be a byte of compressed pixels as it is an image descriptor.
 */
function gifFrames(bytes: Uint8Array): number {
  if (bytes.length < 13) return 0;
  let at = 13;
  const screen = bytes[10]!;
  if (screen & 0x80) at += 3 * (1 << ((screen & 0x07) + 1));
  let frames = 0;
  while (at < bytes.length) {
    const block = bytes[at]!;
    if (block === 0x3b) break;
    if (block === 0x21) {
      // Extension: introducer, label, then sub-blocks.
      at = skipSubBlocks(bytes, at + 2);
    } else if (block === 0x2c) {
      frames += 1;
      if (frames > 1) break;
      const local = bytes[at + 9] ?? 0;
      at += 10;
      if (local & 0x80) at += 3 * (1 << ((local & 0x07) + 1));
      // The LZW minimum code size, then the image data's sub-blocks.
      at = skipSubBlocks(bytes, at + 1);
    } else {
      break;
    }
  }
  return frames;
}

function skipSubBlocks(bytes: Uint8Array, from: number): number {
  let at = from;
  while (at < bytes.length) {
    const size = bytes[at]!;
    at += 1;
    if (size === 0) break;
    at += size;
  }
  return at;
}

function startsWith(bytes: Uint8Array, from: number, text: string): boolean {
  return [...text].every((char, index) => bytes[from + index] === char.charCodeAt(0));
}
