import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync(
  "git",
  ["ls-files", "-z", "packages/*/src/**", "apps/*/src/**"],
  { cwd: root, encoding: "utf8" },
).split("\0").filter(Boolean);
// Bundled publication fonts are binary assets; their hashes are checked by the
// desktop packaging gate. Keep the NUL-byte check on source and font notices.
const corrupted = files.filter((file) =>
  !/^packages\/coordinator\/src\/publications\/fonts\/[^/]+\.ttf$/.test(file)
  && readFileSync(join(root, file)).includes(0));

if (corrupted.length > 0) {
  console.error(`Tracked source files contain NUL bytes:\n${corrupted.join("\n")}`);
  process.exit(1);
}
