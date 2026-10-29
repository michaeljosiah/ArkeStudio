import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { encodePng, solidImage } from "../../src/references/png.js";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openPromise } from "yauzl";
import { deriveProductionReadiness, ulid, type ComicPage, type DomainEvent, type ManifestModel, type PageTextRegion } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { createChapter, createProduction } from "../../src/productions/ops.js";
import { saveComicScript, setComicSettings } from "../../src/productions/graphic-novel.js";
import type { PageReader } from "../../src/productions/graphic-novel-reader.js";
import { IMAGE, WORLD_ID, withHarness, type Harness } from "./picture-harness.js";

/**
 * A graphic novel as a book (SPEC-064 slice 5): readiness counts its pages and their lettering, and
 * the export writes CBZ and PDF from the accepted takes only when every page is cleared.
 */
const LETTERER: ManifestModel = { ...IMAGE, id: "letterer", displayName: "Letterer", limits: { aspects: ["2:3"], maxPromptChars: 8000, lettering: true } };
let n = 0;
const rid = () => `01J0000000000000000005${String((n += 1)).padStart(4, "0")}`;
const last = <T extends DomainEvent["type"]>(events: DomainEvent[], type: T) => events.filter((event): event is Extract<DomainEvent, { type: T }> => event.type === type).at(-1);

function reading(regions: PageTextRegion[]): () => void {
  const proto = Coordinator.prototype as unknown as { pageReader: (...args: unknown[]) => PageReader | null };
  const original = proto.pageReader;
  proto.pageReader = () => ({ precise: true, read: async () => ({ regions, reader: { id: "test", version: "1" } }) });
  return () => { proto.pageReader = original; };
}

async function book(h: Harness, pages = 2) {
  const store = h.store()!;
  const production = await createProduction(store, { title: "Low Water, drawn", medium: "story", productionKind: "graphic-novel" });
  const chapter = await createChapter(store, production, { title: "The tide", order: 1 });
  const script: ComicPage[] = Array.from({ length: pages }, () => ({ id: ulid(), layout: "splash", status: "ready" as const,
    panels: [{ id: ulid(), description: "Maren on the rail.", characters: [], lettering: [{ id: ulid(), kind: "caption" as const, text: "Where are you?" }] }] }));
  await saveComicScript(store, production, { chapter, pages: script, baseHash: null });
  const accept = async (page: ComicPage) => {
    await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
    const take = last(h.events, "comic.page-made")!.take!;
    await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take });
  };
  const readiness = () => {
    const world = store.getBundle();
    return deriveProductionReadiness(world, world.productions.find((p) => p.meta.id === production)!, []);
  };
  return { store, production, script, accept, readiness };
}

describe("a graphic novel as a book (SPEC-064 R-41, R-47, R-49)", () => {
  it("is held while a page has no accepted take, and says which", () =>
    withHarness(async (h) => {
      const restore = reading([{ text: "WHERE ARE YOU?" }]);
      try {
        const { production, script, accept, readiness } = await book(h);
        await accept(script[0]!);
        const pages = readiness().checks.find((check) => check.key === "pages")!;
        assert.deepEqual([pages.status, pages.completed, pages.total], ["missing", 1, 2]);
        await h.send({ kind: "export-comic", requestId: rid(), worldId: WORLD_ID, productionId: production, formats: ["cbz"] });
        const answer = last(h.events, "comic.exported")!.result;
        assert.ok(!answer.ok);
        assert.deepEqual(answer.blockers, ["page 2 · no accepted take"]);
      } finally { restore(); }
    }, { model: LETTERER }));

  it("writes a CBZ in reading order with ComicInfo, and a PDF read right to left", () =>
    withHarness(async (h) => {
      const restore = reading([{ text: "WHERE ARE YOU?" }]);
      try {
        const { store, production, script, accept, readiness } = await book(h);
        // Reading direction is part of a page's picture: set before the pages are made, or they are out of date.
        await setComicSettings(store, production, { reading: "rtl" });
        for (const page of script) await accept(page);
        assert.deepEqual(readiness().checks.filter((check) => check.key === "pages" || check.key === "lettering").map((check) => check.status), ["ready", "ready"]);
        // The harness lands a stub PNG; a PDF embeds real pictures, so each page gets one.
        for (const entry of store.getBundle().productions.find((p) => p.meta.id === production)!.comicPages ?? []) {
          for (const take of entry.record.takes) {
            const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === take.artifact)!;
            await writeFile(join(h.worldDir, "artifacts", artifact.file), encodePng(solidImage(40, 60, [200, 190, 170, 255])));
          }
        }
        await h.send({ kind: "export-comic", requestId: rid(), worldId: WORLD_ID, productionId: production, formats: ["cbz", "pdf"] });
        const answer = last(h.events, "comic.exported")!.result;
        assert.ok(answer.ok, !answer.ok ? answer.reason : "");
        const cbz = answer.files.find((file) => file.format === "cbz")!.file;
        const zip = await openPromise(join(h.worldDir, cbz), { lazyEntries: true });
        const names: string[] = [];
        zip.readEntry();
        await new Promise<void>((resolve) => { zip.on("entry", (entry) => { names.push(entry.fileName); zip.readEntry(); }); zip.on("end", resolve); });
        zip.close();
        assert.deepEqual(names, ["0001.png", "0002.png", "ComicInfo.xml"]);
        const pdf = await readFile(join(h.worldDir, answer.files.find((file) => file.format === "pdf")!.file));
        assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
        assert.match(pdf.toString("latin1"), /\/Direction \/R2L/);
      } finally { restore(); }
    }, { model: LETTERER }));
});
