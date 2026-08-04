import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";

export function mergeUpdateMetadata(x64Path, arm64Path, outputPath) {
  const x64 = parse(readFileSync(x64Path, "utf8"));
  const arm64 = parse(readFileSync(arm64Path, "utf8"));
  if (x64.version !== arm64.version) throw new Error("architecture update metadata versions differ");
  const files = [...(x64.files ?? []), ...(arm64.files ?? [])];
  const unique = [...new Map(files.map((file) => [file.url, file])).values()];
  if (!unique.some((file) => file.url.includes("x64")) || !unique.some((file) => file.url.includes("arm64"))) {
    throw new Error("merged update metadata must contain x64 and arm64 installers");
  }
  const preferred = unique.find((file) => file.url.includes("x64"));
  writeFileSync(
    outputPath,
    stringify({ ...x64, files: unique, path: preferred.url, sha512: preferred.sha512, releaseDate: new Date().toISOString() }),
  );
}

if (process.argv[1]?.endsWith("merge-update-metadata.mjs")) {
  mergeUpdateMetadata(process.argv[2], process.argv[3], process.argv[4]);
}
