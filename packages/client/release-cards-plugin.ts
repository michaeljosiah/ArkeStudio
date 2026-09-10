import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { compareVersions, parseReleaseCard } from "./src/lib/release-notes.js";

/**
 * The release cards a build carries (SPEC-016 R-19; design turn 136), chosen before the bundler
 * sees them. A glob over `docs/releases` would make Vite emit every picture in the release
 * history and only then keep eight at runtime, so the installer would grow with every tag
 * (codex, PR 1087). This plugin reads the cards itself, orders them, keeps the newest eight and
 * generates `src/lib/release-cards.ts` in their image — eight imports, no more — leaving the
 * checked-in stub for the test runner, which has no bundler and injects its own cards.
 */
export const BUNDLED_CARDS = 8;

export interface BundledSource {
  tag: string;
  notes: string;
  /** Absolute path of the picture the front matter names, when it is there. */
  picture: string | null;
}

const PICTURE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp)$/i;

/** Every readable card under `docs`, newest first, at most `limit` of them. */
export function newestCards(docs: string, limit = BUNDLED_CARDS): BundledSource[] {
  if (!existsSync(docs)) return [];
  const found: Array<{ version: string; source: BundledSource }> = [];
  for (const tag of readdirSync(docs)) {
    const dir = join(docs, tag);
    const file = join(dir, "notes.md");
    if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
    const notes = readFileSync(file, "utf8");
    const card = parseReleaseCard(tag, notes, (name) => {
      const path = join(dir, name);
      return PICTURE.test(name) && existsSync(path) && statSync(path).isFile() ? path : null;
    });
    if (!card) continue;
    found.push({ version: card.version, source: { tag, notes, picture: card.picture } });
  }
  return found
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, limit)
    .map((entry) => entry.source);
}

/** The generated module: one `?url` import per picture, then the rows. */
export function releaseCardsModule(cards: readonly BundledSource[], from: string): string {
  const specifier = (picture: string): string => {
    const rel = relative(from, picture).replace(/\\/g, "/");
    return `${rel.startsWith(".") ? rel : `./${rel}`}?url`;
  };
  const imports = cards
    .map((card, i) => (card.picture ? `import picture${i} from ${JSON.stringify(specifier(card.picture))};` : ""))
    .filter((line) => line.length > 0);
  const rows = cards.map(
    (card, i) =>
      `  { tag: ${JSON.stringify(card.tag)}, notes: ${JSON.stringify(card.notes)}, picture: ${card.picture ? `picture${i}` : "null"} },`,
  );
  return `${imports.join("\n")}\nexport const RELEASE_CARDS = [\n${rows.join("\n")}\n];\n`;
}

const same = (a: string, b: string): boolean =>
  a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

export function releaseCardsPlugin(options: { docs?: string; limit?: number } = {}): Plugin {
  const stub = resolve(fileURLToPath(new URL("./src/lib/release-cards.ts", import.meta.url)));
  const docs = options.docs ?? resolve(fileURLToPath(new URL("../../docs/releases", import.meta.url)));
  return {
    name: "arke-release-cards",
    enforce: "pre",
    load(id) {
      if (!same(id, stub)) return null;
      return releaseCardsModule(newestCards(docs, options.limit ?? BUNDLED_CARDS), dirname(stub));
    },
  };
}
