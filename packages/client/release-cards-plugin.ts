import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * The release cards a build carries (SPEC-016 R-19; design turn 136), chosen before the bundler
 * sees them. A glob over `docs/releases` would make Vite emit every picture in the release
 * history and only then keep eight at runtime, so the installer would grow with every tag
 * (codex, PR 1087). This plugin reads the cards itself, orders them, keeps the newest eight and
 * generates `src/lib/release-cards.ts` in their image — eight imports, no more — leaving the
 * checked-in stub for the test runner, which has no bundler and injects its own cards.
 *
 * It imports nothing from the client or from contracts, on purpose. Vite loads its config in
 * plain Node, outside the bundler, and the contracts package is TypeScript source whose `.js`
 * specifiers Node cannot resolve — the first CI build failed exactly there, while a Windows
 * junction had let esbuild bundle the same import locally. The reading below is the small part
 * of `src/lib/release-notes.ts` this needs, kept in step with it by the plugin test.
 */
export const BUNDLED_CARDS = 8;

export interface BundledSource {
  tag: string;
  notes: string;
  /** Absolute path of the picture the front matter names, when it is there. */
  picture: string | null;
}

const PICTURE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp)$/i;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** The front matter and a paragraph, the way the client reads a card; null when it would not. */
function readCard(raw: string): { picture: string | null } | null {
  const match = FRONT_MATTER.exec(raw);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!.toLowerCase()] = field[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  const title = fields["title"];
  const date = fields["date"];
  if (!title || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  if (match[2]!.trim().length === 0) return null;
  return { picture: fields["picture"] ?? null };
}

/** Version order as SemVer states it; the same rule as contracts' `compareVersions`. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [core = "", ...rest] = version.replace(/^v/, "").split("-");
    const pre = rest.length > 0 ? rest.join("-") : null;
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const difference = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  const ours = left.pre.split(".");
  const theirs = right.pre.split(".");
  for (let i = 0; i < Math.min(ours.length, theirs.length); i += 1) {
    const x = ours[i]!;
    const y = theirs[i]!;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ours.length - theirs.length;
}

/** Every readable card under `docs`, newest first, at most `limit` of them. */
export function newestCards(docs: string, limit = BUNDLED_CARDS): BundledSource[] {
  if (!existsSync(docs)) return [];
  const found: Array<{ version: string; source: BundledSource }> = [];
  for (const tag of readdirSync(docs)) {
    const dir = join(docs, tag);
    const file = join(dir, "notes.md");
    if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
    const notes = readFileSync(file, "utf8");
    const card = readCard(notes);
    if (!card) continue;
    const named = card.picture !== null && PICTURE.test(card.picture) ? join(dir, card.picture) : null;
    const picture = named !== null && existsSync(named) && statSync(named).isFile() ? named : null;
    found.push({ version: tag.replace(/^v/, ""), source: { tag, notes, picture } });
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
