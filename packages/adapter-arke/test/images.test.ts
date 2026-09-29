import test from "node:test";
import assert from "node:assert/strict";
import { imageSize, imageTokens, MAX_IMAGE_TOKENS } from "../src/images.js";

const png = (width: number, height: number) => {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
};
const jpeg = (width: number, height: number) => Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const gif = (width: number, height: number) => { const b = Buffer.alloc(13); b.write("GIF89a", 0, "latin1"); b.writeUInt16LE(width, 6); b.writeUInt16LE(height, 8); return b; };
const webpX = (width: number, height: number) => {
  const b = Buffer.alloc(30); b.write("RIFF", 0, "latin1"); b.write("WEBP", 8, "latin1"); b.write("VP8X", 12, "latin1");
  b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3); return b;
};

test("the four image formats a confined read returns are measured from their headers", () => {
  assert.deepEqual(imageSize(png(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(imageSize(jpeg(4032, 3024)), { width: 4032, height: 3024 });
  assert.deepEqual(imageSize(gif(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageSize(webpX(2048, 1536)), { width: 2048, height: 1536 });
});

test("an image is charged by its size, never below a fixed encoder's cost, and never optimistically", () => {
  assert.equal(imageTokens(png(64, 64).toString("base64")), 768, "a small image costs what a fixed-cost encoder charges");
  assert.equal(imageTokens(png(1920, 1080).toString("base64")), 120 * 68, "a screenshot grows with its pixels");
  assert.equal(imageTokens(jpeg(8000, 6000).toString("base64")), MAX_IMAGE_TOKENS, "held to the most one image is usually allowed");
  assert.equal(imageTokens(Buffer.from("not an image").toString("base64")), MAX_IMAGE_TOKENS, "unreadable is charged the most");
});
