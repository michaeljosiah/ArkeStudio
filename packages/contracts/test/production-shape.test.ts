import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { legacyFormatFor, productionShape, resolveMedium } from "../src/production-shape.js";
import type { ProductionFormat, ProductionMedium } from "../src/world.js";

/**
 * The resolve rule, table-driven (SPEC-023 R-1/R-2/R-7, T-2): legacy worlds are never wrong,
 * only un-annotated, and an unknown kind must not change a production's behaviour.
 */

describe("productionShape resolves the legacy discriminator", () => {
  const table: Array<{
    meta: { format: ProductionFormat; medium?: ProductionMedium; kind?: string };
    medium: ProductionMedium;
    kind: string;
    capability: "image" | "video";
    episodic: boolean;
    label: string;
  }> = [
    { meta: { format: "story" }, medium: "story", kind: "book", capability: "video", episodic: false, label: "Story" },
    { meta: { format: "video" }, medium: "video", kind: "film", capability: "video", episodic: false, label: "Video" },
    { meta: { format: "stills" }, medium: "video", kind: "stills", capability: "image", episodic: false, label: "Stills" },
    {
      meta: { format: "video", medium: "video", kind: "microdrama" },
      medium: "video",
      kind: "microdrama",
      capability: "video",
      episodic: true,
      label: "Microdrama",
    },
    {
      meta: { format: "video", medium: "video", kind: "series" },
      medium: "video",
      kind: "series",
      capability: "video",
      episodic: true,
      label: "Series",
    },
    {
      // Turn 100: what a world written between turns 84 and 100 holds. It reads as a Video
      // production carrying the interactive kind, and keeps branching either way.
      meta: { format: "video", medium: "interactive-video" },
      medium: "video",
      kind: "interactive",
      capability: "video",
      episodic: false,
      label: "Interactive video",
    },
    {
      meta: { format: "video", medium: "video", kind: "interactive" },
      medium: "video",
      kind: "interactive",
      capability: "video",
      episodic: false,
      label: "Interactive video",
    },
  ];

  for (const row of table) {
    it(`${row.meta.format}/${row.meta.medium ?? "—"}/${row.meta.kind ?? "—"} → ${row.medium}:${row.kind}`, () => {
      const shape = productionShape(row.meta);
      assert.equal(shape.medium, row.medium);
      assert.equal(shape.kind, row.kind);
      assert.equal(shape.dispatchCapability, row.capability);
      assert.equal(shape.isEpisodic, row.episodic);
      assert.equal(shape.displayLabel, row.label);
      assert.equal(shape.hasChapters, row.medium === "story");
      assert.equal(shape.hasScenes, row.medium !== "story");
      assert.equal(shape.isBranching, row.kind === "interactive");
    });
  }

  it("the retired medium and the kind that replaced it are the same production (turn 100)", () => {
    const legacy = productionShape({ format: "video", medium: "interactive-video" });
    const current = productionShape({ format: "video", medium: "video", kind: "interactive" });
    assert.deepEqual(legacy, current, "a world written before turn 100 must not read differently");
    assert.equal(resolveMedium({ format: "video", medium: "interactive-video" }), "video");
  });

  it("a stored kind still wins over the retired medium", () => {
    // Nothing writes this pair, but a hand-edited world could: the kind is the newer field, so
    // it decides, and the production stops branching rather than half-branching.
    const shape = productionShape({ format: "video", medium: "interactive-video", kind: "microdrama" });
    assert.equal(shape.kind, "microdrama");
    assert.equal(shape.isBranching, false);
    assert.equal(shape.isEpisodic, true);
  });

  it("an unknown kind keeps its name but not its behaviour", () => {
    const shape = productionShape({ format: "video", medium: "video", kind: "docuseries" });
    assert.equal(shape.kind, "docuseries", "the stored kind survives for display");
    assert.equal(shape.kindLabel, "docuseries");
    assert.equal(shape.isEpisodic, false, "behaviour falls back to the medium default");
    assert.equal(shape.dispatchCapability, "video");
  });

  it("a linear season is never branching (turn 78, rule 3)", () => {
    assert.equal(productionShape({ format: "video", medium: "video", kind: "microdrama" }).isBranching, false);
  });

  it("the legacy write-back mapping never lies to an old reader", () => {
    assert.equal(legacyFormatFor("story"), "story");
    assert.equal(legacyFormatFor("video"), "video");
    assert.equal(legacyFormatFor("interactive-video"), "video");
    for (const format of ["story", "video", "stills"] as const) {
      assert.equal(resolveMedium({ format }), format === "story" ? "story" : "video");
    }
  });
});
