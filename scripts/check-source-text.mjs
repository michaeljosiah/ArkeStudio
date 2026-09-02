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
const corrupted = files.filter((file) => readFileSync(join(root, file)).includes(0));

if (corrupted.length > 0) {
  console.error(`Tracked source files contain NUL bytes:\n${corrupted.join("\n")}`);
  process.exit(1);
}
