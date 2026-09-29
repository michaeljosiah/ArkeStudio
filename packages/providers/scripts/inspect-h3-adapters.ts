import { open, mkdir, writeFile, rename, unlink, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve, join } from "node:path";
import { HEARMEMAN_ADAPTERS } from "../src/comfyui/hearmeman.generated.js";

// Read tensor headers only; this is structural evidence, not GPU compatibility approval.
const [modelsDir, outputDir, downloadFlag] = process.argv.slice(2);
if (!modelsDir || !outputDir) throw new Error("Usage: inspect-h3-adapters.ts <models directory> <report directory>");
if (downloadFlag && downloadFlag !== "--download") throw new Error("The only optional argument is --download");
const directory = resolve(outputDir);
await mkdir(directory, { recursive: true });
async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function download(url: string, sha256: string, bytes: number): Promise<string> {
  const dir = join(directory, "weights");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${sha256}.safetensors`);
  if (await stat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; })) {
    if (await digest(file) !== sha256) throw new Error("Existing validation weight has the wrong digest; it was kept");
    return file;
  }
  const stage = `${file}.${process.pid}.part`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
  let received = 0;
  const hash = createHash("sha256");
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > bytes) { callback(new Error("Download exceeds pinned size")); return; }
        hash.update(chunk); callback(null, chunk);
      },
    }), createWriteStream(stage, { flags: "wx" }));
    if (received !== bytes || hash.digest("hex") !== sha256) throw new Error("Downloaded size or SHA-256 differs from the pin");
    await rename(stage, file);
    return file;
  } catch (error) { await unlink(stage).catch(() => {}); throw error; }
}
type Tensor = { dtype: string; shape: number[]; data_offsets: number[] };
type Header = Record<string, Tensor | Record<string, string>>;
function headerLength(bytes: Buffer): number {
  const length = Number(bytes.readBigUInt64LE());
  if (!Number.isSafeInteger(length) || length <= 0 || length > 16 * 1024 * 1024) throw new Error("Invalid safetensors header length");
  return length;
}
async function localHeader(file: string): Promise<Header> {
  const handle = await open(file, "r");
  try {
    const size = Buffer.alloc(8);
    if ((await handle.read(size, 0, 8, 0)).bytesRead !== 8) throw new Error("Truncated safetensors prefix");
    const data = Buffer.alloc(headerLength(size));
    if ((await handle.read(data, 0, data.length, 8)).bytesRead !== data.length) throw new Error("Truncated safetensors header");
    return JSON.parse(data.toString("utf8"));
  } finally { await handle.close(); }
}
async function range(url: string, start: number, end: number): Promise<Buffer> {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(60_000) });
  if (response.status !== 206 || !response.headers.get("content-range")?.startsWith(`bytes ${start}-${end}/`)) {
    await response.body?.cancel();
    throw new Error(`Server did not honor the bounded range (${response.status})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== end - start + 1) throw new Error("Truncated range response");
  return bytes;
}
const bases: Record<string, Header> = {};
for (const file of ["minimax_h3_fl2va_pruned_int8_convrot.safetensors", "minimax_h3_ref2va_pruned_int8_convrot.safetensors"]) {
  bases[file] = await localHeader(join(modelsDir, "diffusion_models", file));
}
await writeFile(join(directory, "base-headers.json"), JSON.stringify(bases, null, 2));
const results: object[] = [];
let failures = 0;
for (const release of HEARMEMAN_ADAPTERS) {
  const url = `https://huggingface.co/${release.source.repository}/resolve/${release.source.revision}/${release.source.file}`;
  try {
    console.log(`${downloadFlag ? "Verifying downloaded bytes" : "Reading header"}: ${release.source.file}`);
    const file = downloadFlag ? await download(url, release.source.sha256, release.source.bytes) : null;
    const header: Header = file ? await localHeader(file) : JSON.parse((await range(url, 8, 7 + headerLength(await range(url, 0, 7)))).toString("utf8"));
    await writeFile(join(directory, `${release.id}.header.json`), JSON.stringify(header, null, 2));
    const entries = Object.entries(header).filter(([key]) => key !== "__metadata__") as [string, Tensor][];
    const result = { id: release.id, sha256: release.source.sha256, file: release.source.file,
      bytesVerified: !!file, tensorCount: entries.length, dtypes: [...new Set(entries.map(([, tensor]) => tensor.dtype))],
      sampleKeys: entries.slice(0, 4).map(([key, tensor]) => ({ key, shape: tensor.shape })), status: "header-read" };
    results.push(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    failures += 1;
    results.push({ id: release.id, status: "header-unavailable", reason: error instanceof Error ? error.message : String(error) });
    console.error(`${release.id}: header unavailable`);
  }
  await writeFile(join(directory, "inventory-report.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
}
if (failures) process.exitCode = 1;
