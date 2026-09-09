import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = join(dirname(fileURLToPath(import.meta.url)), "../docs/specifications");

// The specification set is not published with the code — it lives in the private document set,
// and docs/specifications is a junction into it on machines that hold one. So its absence is the
// normal case in CI and for outside contributors, and only its presence means there is something
// to check. Failing here would make lint red for everyone who simply does not have the specs.
if (!existsSync(directory)) process.exit(0);

const seen = new Map();
for (const file of readdirSync(directory, { recursive: true }).filter(file => file.endsWith(".md")).sort()) {
  const text = readFileSync(join(directory, file), "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const id = frontmatter?.match(/^specId:\s*["']?(SPEC-\d+)["']?\s*(?:#.*)?$/m)?.[1];
  if (!id) continue;
  if (seen.has(id)) {
    console.error(`Duplicate specId ${id}: ${seen.get(id)} and ${file}`);
    process.exitCode = 1;
  } else seen.set(id, file);
}
