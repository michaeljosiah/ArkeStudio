import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { CreatorPackagePreviewSchema } from "@arke-studio/contracts";
import { parseAonikConfiguration } from "../../src/publishing/config.js";
import { writeWorldPackageZip } from "../../src/productions/world-package.js";
import { form, publishingFixture, settled } from "./helpers.js";

async function fixture(count: number, longNames = false) {
  const h = await publishingFixture("world", 8388608);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=", "base64");
  const picture = join(h.root, "picture.png"); await writeFile(picture, png);
  const assets: Record<string, { path: string; mediaType: string; byteLength: number; sha256: string }> = {};
  const files = new Map<string, string>();
  const assetId = (i: number) => "p" + String(i).padStart(longNames ? 63 : 1, "0");
  for (let i = 0; i < count - 1; i++) { const path = `pictures/p${i}.png`; assets[assetId(i)] = { path, mediaType: "image/png", byteLength: png.length, sha256: createHash("sha256").update(png).digest("hex") }; files.set(path, picture); }
  const comic = Buffer.from(JSON.stringify({ format: "arke-comic", version: 1, reading: "ltr", aspect: "1:1", language: "en", chapters: [{ title: "Colour Garden", pages: Array.from({ length: count - 1 }, (_, i) => ({ picture: assetId(i), alt: `Original colour field ${i}.` })) }] }));
  const document = join(h.root, "comic.json"); await writeFile(document, comic); files.set("comic.json", document);
  assets.comic = { path: "comic.json", mediaType: "application/vnd.arke.comic+json", byteLength: comic.length, sha256: createHash("sha256").update(comic).digest("hex") };
  await rm(h.file);
  await writeWorldPackageZip(JSON.stringify({ format: "arke-world-package", schemaVersion: 7, id: "colour-garden", edition: "capacity-v1", name: "Colour Garden", alone: true, productions: [{ id: "colour-garden", title: "Colour Garden", picture: assetId(0), comic: "comic" }], assets }), files, h.file);
  const bytes = await readFile(h.file); const sidecar = JSON.parse(await readFile(h.file + ".json", "utf8"));
  await writeFile(h.file + ".json", JSON.stringify({ ...sidecar, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
  return h;
}

it("keeps the standard asset ceiling and admits the explicit large inventory with complete grouped rights", async () => {
  const h = await fixture(2048);
  try {
    await assert.rejects(h.service.prepare(h.store, "story", h.exportId), /supported frozen|asset limits/);
    h.transport.configuration.capacityProfile = "large-v1";
    const preview = (await h.service.prepare(h.store, "story", h.exportId)).preview!;
    assert.equal(preview.assets.length, 2048); assert.equal(CreatorPackagePreviewSchema.safeParse(preview).success, true);
    await h.service.submit(h.store.worldId, preview.candidateId, form);
    assert.equal((await settled(h.service, h.store.worldId)).publications[0]!.transfer, "complete");
    const declaration = h.api.requests.find(r => r.path === "/publishing/submissions")!.body as { editorialMaterial: { rightsEvidence: Array<{ assetIds: string[] }> } };
    assert.deepEqual(declaration.editorialMaterial.rightsEvidence.map(group => group.assetIds.length), [1024, 1024]);
    assert.deepEqual(declaration.editorialMaterial.rightsEvidence.flatMap(group => group.assetIds), preview.assets.map(asset => asset.id).sort());
  } finally { await h.service.stop(); }
});

it("refuses the first asset over the large ceiling before creating a remote receipt", async () => {
  const h = await fixture(2049); h.transport.configuration.capacityProfile = "large-v1";
  try { await assert.rejects(h.service.prepare(h.store, "story", h.exportId), /asset limits/); assert.equal(h.api.requests.length, 0); }
  finally { await h.service.stop(); }
});

it("rejects unsupported profiles and package ceilings above the server profile", async () => {
  const h = await publishingFixture();
  try {
    assert.throws(() => parseAonikConfiguration({ ...h.transport.configuration, capacityProfile: "unbounded" }));
    assert.throws(() => parseAonikConfiguration({ ...h.transport.configuration, capacityProfile: "large-v1", maxPackageBytes: 1610612737 }), /1.5 GiB/);
    assert.equal(parseAonikConfiguration({ ...h.transport.configuration, capacityProfile: "large-v1", maxPackageBytes: 1610612736 }).maxPackageBytes, 1610612736);
  } finally { await h.service.stop(); }
});

it("refuses oversized rights metadata before any remote creation", async () => {
  const h = await fixture(2048, true); h.transport.configuration.capacityProfile = "large-v1";
  try {
    const preview = (await h.service.prepare(h.store, "story", h.exportId)).preview!;
    await assert.rejects(h.service.submit(h.store.worldId, preview.candidateId, form), /metadata limit/);
    assert.equal(h.api.requests.length, 0);
  } finally { await h.service.stop(); }
});
