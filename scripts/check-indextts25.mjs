import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INDEXTTS25_MANIFEST as manifest, indexTtsManifestIssues, indexTtsBuildAvailability } from "../packages/providers/src/comfyui/indextts25.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const allowed = new Set(["--upstream", "--require-ready", "--models-dir", "--source-archive"]);
const options = {};
for (let at = 0; at < args.length; at++) {
  const flag = args[at];
  if (!allowed.has(flag)) throw new Error(`Unknown argument: ${flag}`);
  if (flag === "--models-dir" || flag === "--source-archive") {
    const path = args[++at];
    if (!path || path.startsWith("--")) throw new Error(`${flag} needs a path`);
    options[flag] = resolve(path);
  } else options[flag] = true;
}
const failures = indexTtsManifestIssues(manifest);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const lock = await readFile(join(root, manifest.python.lockFile));
if (hash(lock) !== manifest.python.lockSha256) failures.push("The Python lock content does not match its manifest digest");
const requirements = lock.toString().replaceAll(/\\\r?\n/g, " ").split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith("#"));
if (requirements.length !== manifest.python.packageCount || requirements.some(line => !/^[a-zA-Z0-9_.-]+==[^\s]+\s+--hash=sha256:[a-f0-9]{64}/.test(line))) {
  failures.push("Python lock entries must all have exact versions and hashes");
}
async function verifyFile(path, expected) {
  try {
    if ((await stat(path)).size !== expected.sizeBytes) throw new Error("size mismatch");
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(path)) digest.update(bytes);
    if (digest.digest("hex") !== expected.sha256) throw new Error("SHA-256 mismatch");
  } catch (error) { failures.push(`${path}: ${error.message}`); }
}
if (options["--source-archive"]) await verifyFile(options["--source-archive"], manifest.source.archive);
const files = manifest.models.flatMap(group => group.files);
if (options["--models-dir"] && failures.length === 0) {
  // Sequential streaming bounds memory and avoids saturating a user's model drive.
  for (const file of files) await verifyFile(join(options["--models-dir"], file.file), file);
}
if (options["--upstream"]) {
  for (const group of manifest.models) {
    const response = await fetch(`https://huggingface.co/api/models/${group.repository}/revision/${group.revision}?blobs=true`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Publisher metadata failed: ${response.status} (${group.name})`);
    const metadata = await response.json();
    if (metadata.sha !== group.revision) failures.push(`Publisher revision mismatch: ${group.name}`);
    for (const file of group.files) {
      const relative = file.file.slice(`TTS/IndexTTS/${group.name}/`.length);
      const published = metadata.siblings.find(row => row.rfilename === relative);
      if (!published || published.size !== file.sizeBytes) { failures.push(`Publisher file/size mismatch: ${file.file}`); continue; }
      let sha256 = published.lfs?.sha256;
      if (!sha256) {
        const response = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Publisher file failed: ${response.status} (${file.file})`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== file.sizeBytes) failures.push(`Downloaded size mismatch: ${file.file}`);
        sha256 = hash(bytes);
      }
      if (sha256 !== file.sha256) failures.push(`Publisher SHA-256 mismatch: ${file.file}`);
    }
  }
}
const availability = indexTtsBuildAvailability(manifest);
if (options["--require-ready"]) failures.push(...availability.issues);
console.log(`${files.length} IndexTTS 2.5 artifacts; ${files.reduce((sum, file) => sum + file.sizeBytes, 0)} bytes; ${manifest.python.packageCount} hash-locked Python candidates.`);
console.log(`Build availability: ${availability.status}`);
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else console.log("All requested integrity checks passed.");
