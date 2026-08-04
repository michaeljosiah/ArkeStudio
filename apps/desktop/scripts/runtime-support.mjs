import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

export function assertSha256(path, expected, label) {
  const actual = sha256(path);
  if (actual !== expected.toUpperCase()) throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual}`);
}

export function peArchitecture(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error(`${path} is not a PE executable`);
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 6 > bytes.length || bytes.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error(`${path} has no PE header`);
  const machine = bytes.readUInt16LE(pe + 4);
  if (machine === 0x8664) return "x64";
  if (machine === 0xaa64) return "arm64";
  throw new Error(`${path} has unsupported PE machine 0x${machine.toString(16)}`);
}

export function assertPeArchitecture(path, arch) {
  const actual = peArchitecture(path);
  if (actual !== arch) throw new Error(`${path} is ${actual}, expected ${arch}`);
}

export function manifestFor(root, metadata) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name !== "runtime-manifest.json") {
        files.push({
          path: relative(root, path).replaceAll("\\", "/"),
          size: statSync(path).size,
          sha256: sha256(path),
        });
      }
    }
  };
  visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ...metadata, files };
}

export function verifyManifest(root) {
  const path = join(root, "runtime-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const file of manifest.files ?? []) {
    const full = join(root, ...file.path.split("/"));
    if (!statSync(full).isFile()) throw new Error(`${file.path} is not a staged file`);
    if (statSync(full).size !== file.size) throw new Error(`${file.path} size does not match its manifest`);
    assertSha256(full, file.sha256, file.path);
  }
  const actual = manifestFor(root, {}).files.map((file) => file.path);
  const listed = (manifest.files ?? []).map((file) => file.path).sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(actual) !== JSON.stringify(listed)) throw new Error("runtime manifest does not list every staged file");
  return manifest;
}
