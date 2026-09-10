import { orderReleases, parseReleaseCard, type ReleaseCard } from "./release-notes.js";

/**
 * The release cards the build carries (SPEC-016 R-19): every `docs/releases/<tag>/notes.md` with
 * the picture beside it, gathered by the bundler at build time and never fetched. The newest
 * eight ride along, so What's new reads as a history rather than one card.
 */
const BUNDLED = 8;

let injected: ReleaseCard[] | null = null;
let gathered: ReleaseCard[] | null = null;

export function bundledReleases(): ReleaseCard[] {
  if (injected) return injected;
  if (gathered === null) gathered = gather();
  return gathered;
}

function gather(): ReleaseCard[] {
  // The globs below are resolved by Vite, in dev and in the build. Under node's test runner there
  // is no bundler: `import.meta.env` is absent, the list is empty, and a test injects its own.
  if (!(import.meta as { env?: unknown }).env) return [];
  const notes = import.meta.glob("../../../../docs/releases/*/notes.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const pictures = import.meta.glob("../../../../docs/releases/*/picture.{jpg,jpeg,png,webp}", {
    query: "?url",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const pictureOf = (dir: string): string | null =>
    Object.entries(pictures).find(([path]) => path.startsWith(`${dir}/`))?.[1] ?? null;
  const cards: ReleaseCard[] = [];
  for (const [path, raw] of Object.entries(notes)) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const tag = dir.slice(dir.lastIndexOf("/") + 1);
    const card = parseReleaseCard(tag, raw, pictureOf(dir));
    if (card) cards.push(card);
  }
  return orderReleases(cards).slice(0, BUNDLED);
}

export function __setReleasesForTest(cards: ReleaseCard[] | null): void {
  injected = cards ? orderReleases(cards).slice(0, BUNDLED) : null;
}
