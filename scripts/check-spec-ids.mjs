import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = join(dirname(fileURLToPath(import.meta.url)), "../docs/specifications");
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
