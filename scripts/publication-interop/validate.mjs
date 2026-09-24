import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import JSZip from "jszip";
import { Manifest, GuidedNavigationDocument } from "@readium/shared";

// Resolve upstream schema references only within these pinned official repositories.
const revisions = {
  "webpub-manifest": "9bcf48e3108c567d1d3eb2e7ab0f847d62725691",
  "guided-navigation": "f5cb2b2d064e62dce16058da3460875224f30f20",
};
const sources = [];
class MissingSchema extends Error {}
async function loadSchema(uri) {
  const url = new URL(uri);
  const [, repository, ...path] = url.pathname.split("/");
  const opds = url.hostname === "specs.opds.io" && url.pathname.startsWith("/schema/");
  assert.ok(opds || url.hostname === "readium.org" && revisions[repository] && path[0] === "schema", uri);
  const source = opds
    ? `https://raw.githubusercontent.com/opds-community/specs/8fda670fc72f110abcf68ad5d26e99ecfeeabf03${url.pathname}`
    : `https://raw.githubusercontent.com/readium/${repository}/${revisions[repository]}/${path.join("/")}`;
  const response = await fetch(source);
  if (response.status === 404 && repository === "guided-navigation" && path.join("/") === "schema/object.schema.json") {
    sources.push({ source, status: 404 });
    throw new MissingSchema(`The pinned upstream schema references missing object.schema.json: ${source}`);
  }
  assert.equal(response.status, 200, source);
  const text = await response.text();
  sources.push({ source, sha256: createHash("sha256").update(text).digest("hex") });
  return JSON.parse(text);
}
const folder = process.argv[2];
assert.ok(folder, "Usage: node validate.mjs <generated fixture directory>");
const read = async name => JSON.parse(await readFile(join(folder, name), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true, loadSchema });
addFormats(ajv);
const publication = await ajv.compileAsync(await loadSchema("https://readium.org/webpub-manifest/schema/publication.schema.json"));
let navigation;
let guidedSchema = "passed";
try { navigation = await ajv.compileAsync(await loadSchema("https://readium.org/guided-navigation/schema/document.schema.json")); }
catch (error) { if (!(error instanceof MissingSchema)) throw error; guidedSchema = error.message; }
for (const name of ["readium-book.json", "readium-audio.json"]) {
  const value = await read(name);
  assert.ok(publication(value), JSON.stringify(publication.errors));
  const parsed = Manifest.deserialize(value)?.serialize();
  assert.ok(parsed, "Readium must consume the manifest");
  assert.deepEqual(parsed.readingOrder.map(item => item.href), value.readingOrder.map(item => item.href));
}
const guide = await read("guided.json");
if (navigation) assert.ok(navigation(guide), JSON.stringify(navigation.errors));
assert.deepEqual(GuidedNavigationDocument.deserialize(guide)?.serialize(), guide);
assert.equal(Manifest.deserialize(await read("publication.json")), undefined, "The SDK's RWPM parser is not a W3C manifest processor");
for (const [archiveName, manifestName, looseName, key] of [
  ["readium.audiobook", "manifest.json", "readium-audio.json", "href"],
  ["w3c.lpf", "publication.json", "publication.json", "url"],
]) {
  const archive = await JSZip.loadAsync(await readFile(join(folder, archiveName)), { checkCRC32: true });
  const manifest = JSON.parse(await archive.file(manifestName).async("string"));
  assert.deepEqual(manifest, await read(looseName));
  for (const item of [...manifest.readingOrder, ...manifest.resources]) {
    const name = item[key];
    assert.match(name, /^[a-z0-9-]+\.[a-z0-9]+$/);
    assert.deepEqual(await archive.file(name).async("nodebuffer"), await readFile(join(folder, name)));
  }
}
// Negative controls prove schema checks are active, rather than permissive deserialization.
assert.equal(publication({ readingOrder: [] }), false);
if (navigation) assert.equal(navigation({ guided: [{}] }), false);
const result = { readiumShared: "2.5.1", readiumManifests: 2, guidedAnchors: guide.guided.length,
  directW3cDeserialization: "unsupported", packageClosure: ["readium.audiobook", "w3c.lpf"], guidedSchema, negativeControls: navigation ? 2 : 1, sources };
await writeFile(join(folder, "schema-results.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
