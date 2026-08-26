import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { downloadFileName, mediaExtension } from "../src/index.js";

/**
 * What a saved picture is called (issue 478).
 *
 * Shared between the browser build's anchor and the desktop host's save dialog, so both halves
 * offer the same name — and the host sanitises again on its own side, because the name that
 * reaches it came from the renderer.
 */

describe("the extension of a media path", () => {
  it("is the file's own, lowercased", () => {
    assert.equal(mediaExtension("references/maren-kest/head-front.PNG"), ".png");
    assert.equal(mediaExtension("artifacts/cover.jpeg"), ".jpeg");
    assert.equal(mediaExtension("artifacts/board.webp"), ".webp");
    assert.equal(mediaExtension("artifacts/loop.gif"), ".gif");
  });

  it("reads a Windows path the same as a portable one", () => {
    assert.equal(mediaExtension("references\\maren-kest\\head-front.png"), ".png");
  });

  it("is empty where there is none, and a leading dot is not one", () => {
    assert.equal(mediaExtension("artifacts/README"), "");
    assert.equal(mediaExtension(".gitignore"), "");
    // Not an extension: a name that happens to end in a dotted word is not a file type.
    assert.equal(mediaExtension("artifacts/v1.2 final draft"), "");
  });
});

describe("the name a picture saves under", () => {
  it("is the file's own name when nothing better is offered", () => {
    assert.equal(downloadFileName("artifacts/key-art.png"), "key-art.png");
    assert.equal(downloadFileName("references/maren-kest/takes/tk_1/portrait.jpg"), "portrait.jpg");
  });

  it("prefers the name the screen offered, and keeps the file's own extension", () => {
    assert.equal(downloadFileName("references/maren-kest/mp_7.jpg", "Maren Kest main photo"), "Maren Kest main photo.jpg");
    // The format is the file's, never the offer's: a JPEG asked for as a PNG is still a JPEG.
    assert.equal(downloadFileName("artifacts/still.webp", "cover.png"), "cover.png.webp");
  });

  it("does not double an extension the offered name already carries", () => {
    assert.equal(downloadFileName("artifacts/cover.png", "cover.png"), "cover.png");
    assert.equal(downloadFileName("artifacts/cover.png", "COVER.PNG"), "COVER.png");
  });

  it("takes out anything that could reach out of the folder that was chosen", () => {
    assert.equal(downloadFileName("artifacts/a.png", "../../etc/passwd"), "etc passwd.png");
    assert.equal(downloadFileName("artifacts/a.png", "sub\\dir\\name"), "sub dir name.png");
    assert.equal(downloadFileName("artifacts/a.png", 'a:b*c?d"e<f>g|h'), "a b c d e f g h.png");
  });

  it("takes out control bytes no filesystem stores", () => {
    const raw = `look${String.fromCharCode(0)}at${String.fromCharCode(31)}this${String.fromCharCode(127)}`;
    assert.equal(downloadFileName("artifacts/a.png", raw), "lookatthis.png");
    // A newline is whitespace as well as a control byte, so it collapses to a gap, not to nothing.
    assert.equal(downloadFileName("artifacts/a.png", `two${String.fromCharCode(10)}words`), "two words.png");
  });

  it("prefixes the device names Windows will not take", () => {
    assert.equal(downloadFileName("artifacts/a.png", "CON"), "_CON.png");
    assert.equal(downloadFileName("artifacts/a.png", "com1"), "_com1.png");
    // A real name that merely starts the same way is nobody's device.
    assert.equal(downloadFileName("artifacts/a.png", "Connor"), "Connor.png");
  });

  it("never lands trailing dots or spaces, which Windows silently strips", () => {
    assert.equal(downloadFileName("artifacts/a.png", "  a name.  "), "a name.png");
  });

  it("falls back to something rather than nothing", () => {
    assert.equal(downloadFileName("artifacts/a.png", "..."), "a.png");
    assert.equal(downloadFileName("", ""), "image");
    assert.equal(downloadFileName("artifacts/....png", "   "), "image.png");
  });

  it("keeps the whole path short enough for the folder that will be in front of it", () => {
    const saved = downloadFileName("artifacts/a.png", "x".repeat(400));
    assert.equal(saved.length, 124);
    assert.ok(saved.endsWith(".png"), "and the extension survives the trim");
  });
});
