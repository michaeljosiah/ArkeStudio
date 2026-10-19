import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { WorldStore } from "../packages/coordinator/src/world/store.js";
import { scanWorld } from "../packages/coordinator/src/world/scan.js";
import { recordUploadedPropImage } from "../packages/coordinator/src/references/takes.js";
import { acceptPropStateReference } from "../packages/coordinator/src/references/props.js";
import { WORLD_EXPORT_EXCLUDED } from "../packages/coordinator/src/takes/export.js";
import { isStoryReleaseHistoryFile, isStoryReleaseLegacyChange, referencesStoryArtifact } from "../packages/coordinator/src/world/story-release-history.js";

// This assembles a new release directory; it never edits the author's live world.
const [sourceArg, outputArg, configArg] = process.argv.slice(2);
if (!sourceArg || !outputArg || !configArg) throw Error("Usage: node --import tsx scripts/package-story-world.mts SOURCE NEW_OUTPUT CONFIG");
const source = path.resolve(sourceArg), output = path.resolve(outputArg);
if (output === source || output.startsWith(source + path.sep)) throw Error("Output must be outside the source world");
await fs.mkdir(output); // Refuse an existing release rather than replacing it.
const target = path.join(output, "the-undersong"); await fs.mkdir(target);
const config = JSON.parse(await fs.readFile(configArg, "utf8"));
const selected = new Set<string>(config.productions);
const excluded = new Set([...WORLD_EXPORT_EXCLUDED, ".conversations", ".proposals", ".sessions", ".staging", ".commit", ".index"]);
const exists = async (p: string) => fs.access(p).then(() => true, () => false);
async function walk(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw Error("Linked source is not portable: " + e.name);
    const p = path.join(dir, e.name);
    if (e.isDirectory()) result.push(...await walk(p)); else result.push(p);
  }
  return result;
}
const copy = (from: string, to: string) => fs.cp(from, to, { recursive: true, filter: async p => {
  if ((await fs.lstat(p)).isSymbolicLink()) throw Error("Linked source is not portable");
  return !excluded.has(path.basename(p));
} });
for (const name of ["world.json", "world-art.png", "bible.md", "art-direction", "canon", "characters", "factions", "locations", "references", "voices"]) {
  if (await exists(path.join(source, name))) await copy(path.join(source, name), path.join(target, name));
}
for (const id of selected) await copy(path.join(source, "productions", id), path.join(target, "productions", id));
if (await exists(path.join(source, ".history"))) for (const file of await walk(path.join(source, ".history"))) {
  const rel = path.relative(path.join(source, ".history"), file).replaceAll("\\", "/");
  if (!isStoryReleaseHistoryFile(rel, selected)) continue;
  const destination = path.join(target, ".history", rel);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(file, destination);
}
const artifacts = new Map<string, any>(), byFile = new Map<string, any>();
for (const name of await fs.readdir(path.join(source, "artifacts"))) if (name.endsWith(".json")) {
  const a = JSON.parse(await fs.readFile(path.join(source, "artifacts", name), "utf8"));
  if (a.id && a.file) { artifacts.set(a.id, a); byFile.set(a.file, a); }
}
const wanted = new Set<string>(config.artifactIds);
function collect(text: string) {
  for (const m of text.matchAll(/\bar_[0-9A-HJKMNP-TV-Z]{26}\b/g)) if (artifacts.has(m[0])) wanted.add(m[0]);
  for (const [filename, artifact] of byFile) if (referencesStoryArtifact(text, filename)) wanted.add(artifact.id);
}
for (const file of await walk(target)) if (/\.(json|jsonl|md)$/.test(file)) collect(await fs.readFile(file, "utf8"));
await fs.mkdir(path.join(target, "artifacts"));
const copied = new Set<string>();
while ([...wanted].some(id => !copied.has(id))) for (const id of [...wanted]) {
  if (copied.has(id)) continue; copied.add(id);
  const a = artifacts.get(id); if (!a || path.basename(a.file) !== a.file) throw Error("Missing or unsafe artifact " + id);
  for (const suffix of ["", ".json"]) await fs.copyFile(path.join(source, "artifacts", a.file + suffix), path.join(target, "artifacts", a.file + suffix));
  collect(JSON.stringify(a));
}
const changes = [];
for (const line of (await fs.readFile(path.join(source, "changes.jsonl"), "utf8")).trim().split("\n")) {
  const change = JSON.parse(line);
  if (typeof change.path === "string") {
    const resolved = path.resolve(target, change.path);
    if (resolved.startsWith(target + path.sep) && await exists(resolved)) changes.push(line);
  } else if (isStoryReleaseLegacyChange(change.entity, selected)) changes.push(line);
}
await fs.writeFile(path.join(target, "changes.jsonl"), changes.join("\n") + "\n");
for (const name of config.exports) {
  if (path.basename(name) !== name) throw Error("Unsafe export name");
  await copy(path.join(source, "exports", name), path.join(target, "exports", name));
}
const store = await WorldStore.open(target);
try {
  for (const [propId, stateId, artifactId] of config.propBindings) {
    const state = store.getBundle().props.find(p => p.id === propId)?.states.find(s => s.id === stateId);
    if (!state) throw Error("Missing prop state"); if (state.reference) continue;
    const artifact = store.getBundle().artifacts.find(a => a.id === artifactId); if (!artifact) throw Error("Missing prop artwork");
    const bytes = await fs.readFile(path.join(target, "artifacts", artifact.file));
    const take = await recordUploadedPropImage(store, propId, stateId, artifact.file, bytes);
    const result = await acceptPropStateReference(store, { propId, stateId, selection: { source: "take", takeId: take.id } }, { artifactId });
    if (result.status !== "accepted") throw Error(result.reason);
  }
} finally { await store.close(); }
// Remove only runtime files created in this newly allocated release directory by validation.
for (const name of excluded) if (path.basename(name) === name) await fs.rm(path.join(target, name), { recursive: true, force: true });
await fs.writeFile(path.join(target, "DELIVERY-STATUS.md"), config.status + "\n");
const scan = await scanWorld(target); if (scan.bundle.problems.length) throw Error(JSON.stringify(scan.bundle.problems));
const files = [];
for (const file of (await walk(target)).sort()) {
  const digest = createHash("sha256"); for await (const chunk of createReadStream(file)) digest.update(chunk);
  files.push({ path: path.relative(target, file).replaceAll("\\", "/"), bytes: (await fs.stat(file)).size, sha256: digest.digest("hex") });
}
const manifest = { version: config.version, completion: "unfinished-audiobook-and-video", summary: config.status, files };
await fs.writeFile(path.join(target, "story-package.json"), JSON.stringify(manifest, null, 2));
const archive = path.join(output, config.archiveName), zip = new ZipFile();
const writing = pipeline(zip.outputStream, createWriteStream(archive, { flags: "wx" }));
let unpackedBytes = 0;
for (const file of (await walk(target)).sort()) {
  unpackedBytes += (await fs.stat(file)).size;
  zip.addFile(file, path.relative(target, file).replaceAll("\\", "/"), { compress: true, mtime: new Date("2026-10-19T00:00:00Z"), mode: 0o100644 });
}
zip.end(); await writing;
const digest = createHash("sha256"); for await (const chunk of createReadStream(archive)) digest.update(chunk);
const release = { archive, bytes: (await fs.stat(archive)).size, unpackedBytes, sha256: digest.digest("hex"), files: files.length + 1, scanProblems: 0 };
await fs.writeFile(path.join(output, "release.json"), JSON.stringify(release, null, 2)); console.log(release);
