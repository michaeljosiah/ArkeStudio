const { app, nativeImage } = require("electron");
const { copyFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

// Reuse the desktop mark. The ICO's largest frame is an uncompressed 32-bit DIB; decoding
// its bottom-up rows here also works on platforms where nativeImage cannot read ICO files.
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const source = join(__dirname, "../apps/desktop/assets/arke-studio.ico");
  const ico = readFileSync(source);
  const entries = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => 6 + i * 16);
  const entry = entries.sort((a, b) => (ico[b] || 256) - (ico[a] || 256))[0];
  const offset = ico.readUInt32LE(entry + 12);
  const width = ico.readInt32LE(offset + 4), height = ico.readInt32LE(offset + 8) / 2;
  if (ico.readUInt32LE(offset) !== 40 || ico.readUInt16LE(offset + 14) !== 32 || ico.readUInt32LE(offset + 16) !== 0)
    throw new Error("The desktop icon format changed; update its web export.");
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = offset + 40 + (height - y - 1) * width * 4;
    ico.copy(pixels, y * width * 4, row, row + width * 4);
  }
  // Home-screen artwork has an opaque background; composite before handing BGRA to Electron
  // so partially transparent edges do not get interpreted as premultiplied colour.
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    for (const [channel, background] of [[0, 0x19], [1, 0x16], [2, 0x14]])
      pixels[i + channel] = Math.round(pixels[i + channel] * alpha + background * (1 - alpha));
    pixels[i + 3] = 255;
  }
  const icon = nativeImage.createFromBitmap(pixels, { width, height });
  const output = join(__dirname, "../packages/client/public");
  mkdirSync(join(output, "icons"), { recursive: true });
  copyFileSync(source, join(output, "favicon.ico"));
  for (const [name, size] of [["apple-touch-icon", 180], ["arke-192", 192], ["arke-512", 512]]) {
    writeFileSync(join(output, "icons", name + ".png"), icon.resize({ width: size, height: size, quality: "best" }).toPNG());
  }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
