import { deflateSync, inflateSync } from "node:zlib";

/**
 * A minimal PNG codec for the classic-grid compositor (SPEC-010 R-10, D6): 8-bit greyscale,
 * RGB and RGBA, non-interlaced — what generation providers actually emit. Deliberately no
 * native dependency: the grid must compile with no provider, no cost, and byte-determinism.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  pixels: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u32(d: Uint8Array, i: number): number {
  return ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!) >>> 0;
}

/** Paeth predictor per the PNG spec. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(data: Uint8Array): RgbaImage {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== SIGNATURE[i]) throw new Error("not a PNG");
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= data.length) {
    const length = u32(data, pos);
    const type = String.fromCharCode(data[pos + 4]!, data[pos + 5]!, data[pos + 6]!, data[pos + 7]!);
    const body = data.slice(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = u32(body, 0);
      height = u32(body, 4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNGs are unsupported");
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : -1;
  if (channels === -1) throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat.map((b) => Buffer.from(b))));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  const prior = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[offset]!;
    offset += 1;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[offset + x]!;
      const left = x >= channels ? line[x - channels]! : 0;
      const up = prior[x]!;
      const upLeft = x >= channels ? prior[x - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = (rawByte + left) & 0xff;
          break;
        case 2:
          value = (rawByte + up) & 0xff;
          break;
        case 3:
          value = (rawByte + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          value = (rawByte + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      line[x] = value;
    }
    offset += stride;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (channels === 1) {
        pixels[p] = pixels[p + 1] = pixels[p + 2] = line[x]!;
        pixels[p + 3] = 255;
      } else if (channels === 3) {
        pixels[p] = line[x * 3]!;
        pixels[p + 1] = line[x * 3 + 1]!;
        pixels[p + 2] = line[x * 3 + 2]!;
        pixels[p + 3] = 255;
      } else {
        pixels[p] = line[x * 4]!;
        pixels[p + 1] = line[x * 4 + 1]!;
        pixels[p + 2] = line[x * 4 + 2]!;
        pixels[p + 3] = line[x * 4 + 3]!;
      }
    }
    prior.set(line);
  }
  return { width, height, pixels };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  const typeBytes = new TextEncoder().encode(type);
  out.set(typeBytes, 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(typeBytes, body));
  return out;
}

/** Deterministic encode: RGBA, filter 0 everywhere, fixed deflate settings (R-10). */
export function encodePng(image: RgbaImage): Uint8Array {
  const { width, height, pixels } = image;
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none, everywhere — determinism beats size here
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9, memLevel: 9, strategy: 0 });
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from(SIGNATURE),
      Buffer.from(chunk("IHDR", ihdr)),
      Buffer.from(chunk("IDAT", idat)),
      Buffer.from(chunk("IEND", new Uint8Array(0))),
    ]),
  );
}

/** Nearest-neighbour draw of `src` into `dst` at (dx, dy) scaled to (dw, dh) — deterministic. */
export function drawScaled(dst: RgbaImage, src: RgbaImage, dx: number, dy: number, dw: number, dh: number): void {
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / dw));
      const sp = (sy * src.width + sx) * 4;
      const dp = ((dy + y) * dst.width + (dx + x)) * 4;
      dst.pixels[dp] = src.pixels[sp]!;
      dst.pixels[dp + 1] = src.pixels[sp + 1]!;
      dst.pixels[dp + 2] = src.pixels[sp + 2]!;
      dst.pixels[dp + 3] = src.pixels[sp + 3]!;
    }
  }
}

export function solidImage(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = rgba[0];
    pixels[i * 4 + 1] = rgba[1];
    pixels[i * 4 + 2] = rgba[2];
    pixels[i * 4 + 3] = rgba[3];
  }
  return { width, height, pixels };
}
