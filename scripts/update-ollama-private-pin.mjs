import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import { OLLAMA_VERSION, SETUP_CATALOGUE } from "../packages/coordinator/src/setup/catalogue.ts";
import { RuntimeContentVerifier } from "../packages/coordinator/src/local-ai/runtime-content.ts";

assert(process.argv[2], "Usage: node --import tsx scripts/update-ollama-private-pin.mjs <verified-source.zip> [--write]");
const archive = resolve(process.argv[2]), spec = SETUP_CATALOGUE.find(row => row.id === "ollama-runtime").spec;
assert.equal(spec.kind, "tree"); assert.match(spec.file.sha256, /^[a-f0-9]{64}$/);
const hash = createHash("sha256"); for await (const chunk of createReadStream(archive)) hash.update(chunk);
assert.equal(hash.digest("hex"), spec.file.sha256, "runtime archive must match the catalogue pin before member inspection");
const zip = await new Promise((done, fail) => yauzl.open(archive, { lazyEntries: true }, (error, value) => error ? fail(error) : done(value)));
const files = []; let entries = 0, bytes = 0;
await new Promise((done, fail) => {
  zip.on("error", fail); zip.on("end", done);
  zip.on("entry", entry => { void (async () => {
    assert(++entries <= 1024); const type = (entry.externalFileAttributes >>> 16) & 0o170000;
    assert(type === 0 || type === 0o100000 || type === 0o040000, "linked runtime members are unsupported");
    assert(!entry.fileName.includes("\\") && !entry.fileName.startsWith("/") && !entry.fileName.includes(":") && !entry.fileName.split("/").some(part => part === ".." || part === "."));
    if (!entry.fileName.endsWith("/")) {
      const input = await new Promise((resolveStream, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolveStream(stream)));
      const digest = createHash("sha256"); let size = 0;
      for await (const chunk of input) { size += chunk.length; bytes += chunk.length; assert(size <= 1024 ** 3 && bytes <= 4 * 1024 ** 3); digest.update(chunk); }
      assert.equal(size, entry.uncompressedSize); assert(size > 0); files.push({ path: entry.fileName, bytes: size, sha256: digest.digest("hex") });
    }
    zip.readEntry();
  })().catch(error => { zip.close(); fail(error); }); }); zip.readEntry();
});
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const pin = { version: OLLAMA_VERSION, arch: "x64", archiveSha256: spec.file.sha256, files };
new RuntimeContentVerifier(process.cwd(), pin);
const target = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/coordinator/src/local-ai/ollama-private-pin-x64.json");
if (process.argv.includes("--write")) await writeFile(target, JSON.stringify(pin, null, 2) + "\n");
else assert.deepEqual(JSON.parse(await readFile(target, "utf8")), pin, "committed runtime pin differs from the verified archive");
process.stdout.write(`Ollama ${OLLAMA_VERSION} x64: ${files.length} verified files, ${bytes} bytes; ${process.argv.includes("--write") ? "pin written" : "pin matches"}.\n`);
