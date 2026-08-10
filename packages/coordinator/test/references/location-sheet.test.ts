import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodePng, solidImage, type RgbaImage } from "../../src/references/png.js";
import {
  composeLocationSheet,
  fitLabel,
  normalizeLabel,
  panelLabel,
  PANEL_HEIGHT,
  PANEL_IMAGE_HEIGHT,
  SHEET_WIDTH,
} from "../../src/references/location-sheet.js";

/** A distinguishable flat image, so a panel's pixels can be identified after composition. */
function swatch(width: number, height: number, rgb: [number, number, number]): RgbaImage {
  return solidImage(width, height, [rgb[0], rgb[1], rgb[2], 255]);
}

const RED = swatch(1600, 900, [200, 40, 40]);
const BLUE = swatch(800, 450, [40, 60, 200]);
const TALL = swatch(600, 1200, [40, 200, 90]);

const px = (img: RgbaImage, x: number, y: number): [number, number, number, number] => {
  const p = (y * img.width + x) * 4;
  return [img.pixels[p]!, img.pixels[p + 1]!, img.pixels[p + 2]!, img.pixels[p + 3]!];
};

describe("the location sheet is assembled, not generated (#243)", () => {
  it("stacks one panel per view at the stated geometry", () => {
    const sheet = composeLocationSheet([
      { id: "v1", name: "Establishing view", image: RED },
      { id: "v2", name: "Reverse angle", image: BLUE },
    ]);
    assert.equal(sheet.width, SHEET_WIDTH);
    assert.equal(sheet.height, PANEL_HEIGHT * 2, "one 960px panel per view, in one column");

    const img = decodePng(sheet.png);
    assert.equal(img.width, 1600);
    assert.equal(img.height, 1920);
    // Panel 1 fills its image area exactly — 1600x900 needs no letterboxing.
    assert.deepEqual(px(img, 800, 450), [200, 40, 40, 255]);
    // Its label band sits directly beneath, in the darker ink.
    assert.deepEqual(px(img, 1500, PANEL_IMAGE_HEIGHT + 30), [12, 12, 14, 255]);
    // Panel 2 begins one panel down.
    assert.deepEqual(px(img, 800, PANEL_HEIGHT + 450), [40, 60, 200, 255]);
  });

  it("contains rather than crops, and letterboxes onto the panel ground", () => {
    // A tall 600x1200 view fits by height: 450 wide, centred, with ground either side.
    const sheet = composeLocationSheet([{ id: "v1", name: "Establishing view", image: TALL }]);
    const img = decodePng(sheet.png);
    assert.deepEqual(px(img, 800, 450), [40, 200, 90, 255], "the view is centred");
    assert.deepEqual(px(img, 20, 450), [24, 24, 26, 255], "and letterboxed, never cropped to fill");
    assert.deepEqual(px(img, 1580, 450), [24, 24, 26, 255]);
  });

  it("labels panels by position, in the face it can actually draw", () => {
    const sheet = composeLocationSheet([
      { id: "v1", name: "Establishing view", image: RED },
      { id: "v2", name: "Reverse angle", image: BLUE },
      { id: "v3", name: "Day", image: BLUE },
    ]);
    assert.deepEqual(sheet.labels, [
      "PANEL 01 - ESTABLISHING VIEW",
      "PANEL 02 - REVERSE ANGLE",
      "PANEL 03 - DAY",
    ]);

    // Normalization: accents decompose, case folds, spacing collapses, and anything the face
    // cannot draw becomes a question mark rather than a hole.
    assert.equal(normalizeLabel("  Café   Rouge "), "CAFE ROUGE");
    assert.equal(normalizeLabel("Ojuelegba — dusk"), "OJUELEGBA ? DUSK", "an em dash is not in the face");
    assert.equal(panelLabel(9, "Tenth"), "PANEL 10 - TENTH");

    // Ink actually lands in the label band: some pixel there is lit.
    const img = decodePng(sheet.png);
    let lit = 0;
    for (let x = 24; x < 700; x += 1) {
      for (let y = PANEL_IMAGE_HEIGHT + 16; y < PANEL_IMAGE_HEIGHT + 44; y += 1) {
        if (px(img, x, y)[0] === 237) lit += 1;
      }
    }
    assert.ok(lit > 100, `expected drawn glyphs in the label band, saw ${lit} lit pixels`);
  });

  it("truncates a long name at a whole glyph and says it did", () => {
    const long = "A".repeat(200);
    const fitted = fitLabel(normalizeLabel(long), SHEET_WIDTH - 48);
    assert.ok(fitted.endsWith("..."), "a dropped tail is stated, not silently lost");
    assert.ok(fitted.length < long.length);
    // Short labels are left exactly alone.
    assert.equal(fitLabel("PANEL 01 - DAY", SHEET_WIDTH - 48), "PANEL 01 - DAY");
  });

  it("is byte-identical for identical views in identical order, and changes when they do not", () => {
    const panels = [
      { id: "v1", name: "Establishing view", image: RED },
      { id: "v2", name: "Reverse angle", image: BLUE },
    ];
    const a = composeLocationSheet(panels);
    const b = composeLocationSheet(panels.map((p) => ({ ...p, image: solidImage(p.image.width, p.image.height, [p.image.pixels[0]!, p.image.pixels[1]!, p.image.pixels[2]!, 255]) })));
    assert.equal(a.file, b.file, "the filename is the content, so a rebuild is idempotent");
    assert.deepEqual(Buffer.from(a.png), Buffer.from(b.png));

    // Order is content: reversing the panels is a different sheet.
    const reversed = composeLocationSheet([panels[1]!, panels[0]!]);
    assert.notEqual(reversed.file, a.file);
    // So is a rename, even with identical pixels.
    const renamed = composeLocationSheet([{ ...panels[0]!, name: "Wide" }, panels[1]!]);
    assert.notEqual(renamed.file, a.file);
    // And so is a different id, because a view's identity is part of what the sheet claims.
    const reidentified = composeLocationSheet([{ ...panels[0]!, id: "vX" }, panels[1]!]);
    assert.notEqual(reidentified.file, a.file);

    assert.match(a.file, /^location-sheet-[0-9a-f]{12}\.png$/);
  });

  it("names the file after the rendered sheet, not after the bytes that went into it", () => {
    // Two source images with byte-identical buffers and different dimensions: 40x20 and 20x40
    // are both 3200 bytes of the same colour, and they compose to visibly different panels —
    // one letterboxed left and right, the other top and bottom. A digest taken over the source
    // pixels alone could not tell them apart, so both sheets would claim the same filename and
    // whichever was written second would be served under the first one's digest.
    const wide = solidImage(40, 20, [10, 20, 30, 255]);
    const tall = solidImage(20, 40, [10, 20, 30, 255]);
    assert.deepEqual(Buffer.from(wide.pixels), Buffer.from(tall.pixels), "the source buffers really are identical");

    const a = composeLocationSheet([{ id: "v1", name: "Establishing view", image: wide }]);
    const b = composeLocationSheet([{ id: "v1", name: "Establishing view", image: tall }]);
    assert.notDeepEqual(Buffer.from(a.png), Buffer.from(b.png), "and they really do compose differently");
    assert.notEqual(a.file, b.file, "so they must not share a name");
  });

  it("composes one panel and six, and refuses none", () => {
    const one = composeLocationSheet([{ id: "v1", name: "Establishing view", image: RED }]);
    assert.equal(one.height, PANEL_HEIGHT);
    assert.equal(decodePng(one.png).height, PANEL_HEIGHT);

    const six = composeLocationSheet(
      Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, name: `View ${i}`, image: BLUE })),
    );
    assert.equal(six.height, PANEL_HEIGHT * 6);
    assert.equal(six.labels.length, 6);
    assert.equal(six.labels[5], "PANEL 06 - VIEW 5");

    assert.throws(() => composeLocationSheet([]), /at least one view/);
  });
});
