import {
  BLOCKING_FINDINGS,
  LETTERING_NORMALIZATION_VERSION,
  LetteringVerificationSchema,
  panelRects,
  type ComicPage,
  type ComicReading,
  type LetteringFinding,
  type LetteringThresholds,
  type LetteringVerification,
  type PageBox,
  type PageTextRegion,
} from "./graphic-novel.js";

/**
 * The lettering check (SPEC-064 R-29 – R-32): what a page reader saw, compared with the words the
 * script says are on the page. Pure, so the Studio can explain a finding with the same function
 * the coordinator judged it with.
 */

const FOLD: Array<[RegExp, string]> = [
  [/[‘’‛′]/gu, "'"], [/[“”‟″]/gu, '"'],
  [/[‐-―−]/gu, "-"], [/…/gu, "..."],
];

/**
 * Case, punctuation and their typographic variants fold away (R-29): a balloon set in capitals, or
 * a curly quote for a straight one, is how a comic looks, not a different word. Letters and digits
 * are what is compared. Unlike the audio comparison, which keeps punctuation reviewable, lettering
 * styled by a model has no punctuation the author could have meant differently and still read alike.
 */
export function normalizeLettering(text: string): string {
  let out = text.normalize("NFKC");
  for (const [pattern, to] of FOLD) out = out.replace(pattern, to);
  return out.toLocaleLowerCase("en").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

/** 1 − edit distance over the longer length: 1 is identical, 0 shares nothing. */
export function letteringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[b.length]! / Math.max(a.length, b.length);
}

/** Words of one region, `from` inclusive to `to` exclusive. */
interface Span { region: number; from: number; to: number }
interface Candidate { text: string; normalized: string; box?: PageBox; spans: Span[] }

/**
 * Readers split one balloon over lines and merge two neighbours into one block. A candidate is a
 * region, two adjacent regions joined, or a run of words inside a region about the item's length,
 * so neither habit reads as a missing or extra balloon. Each names the words it would use, so two
 * items never claim the same words and what nothing claims is still checked (codex on PR 2220).
 */
function candidatesFor(item: string, regions: readonly PageTextRegion[], tokens: readonly string[][]): Candidate[] {
  const out: Candidate[] = [];
  const words = item.split(" ").length;
  regions.forEach((region, index) => {
    const own = tokens[index]!;
    const box = region.box ? { box: region.box } : {};
    out.push({ text: region.text, normalized: own.join(" "), ...box, spans: [{ region: index, from: 0, to: own.length }] });
    if (own.length > words) {
      for (let size = Math.max(1, words - 1); size <= words + 1; size++) {
        for (let from = 0; from + size <= own.length; from++) {
          const run = own.slice(from, from + size).join(" ");
          out.push({ text: run, normalized: run, ...box, spans: [{ region: index, from, to: from + size }] });
        }
      }
    }
    const next = regions[index + 1];
    if (next) {
      const joined = region.box && next.box ? { box: union(region.box, next.box) } : {};
      out.push({ text: `${region.text} ${next.text}`, normalized: [...own, ...tokens[index + 1]!].join(" "), ...joined,
        spans: [{ region: index, from: 0, to: own.length }, { region: index + 1, from: 0, to: tokens[index + 1]!.length }] });
    }
  });
  return out;
}

function union(a: PageBox, b: PageBox): PageBox {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** A page edge within this margin has cut the words off (R-30). */
const EDGE = 0.004;

function touchesEdge(box: PageBox): boolean {
  return box.x <= EDGE || box.y <= EDGE || box.x + box.w >= 1 - EDGE || box.y + box.h >= 1 - EDGE;
}

/** Where a box falls in reading order: its panel first, then down the panel, then across. */
function readingKey(box: PageBox, page: Pick<ComicPage, "layout">, reading: ComicReading): [number, number, number] {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const rects = panelRects(page, reading);
  const panel = rects.findIndex((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
  return [panel < 0 ? rects.length : panel, Math.round(cy * 20), reading === "rtl" ? -cx : cx];
}

function before(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

export interface LetteringCheckInput {
  page: ComicPage;
  reading: ComicReading;
  regions: readonly PageTextRegion[];
  thresholds: LetteringThresholds;
  reader: { id: string; version: string };
  at: string;
  /** Whether the reader reports balloon tails; none do yet, so speakers go unchecked (R-30). */
  tails?: boolean;
}

export function compareLettering(input: LetteringCheckInput): LetteringVerification {
  const { page, reading, regions, thresholds } = input;
  const items = page.panels.flatMap((panel) => panel.lettering);
  const findings: LetteringFinding[] = [];
  const tokens = regions.map((region) => normalizeLettering(region.text).split(" ").filter(Boolean));
  const claimed = tokens.map((own) => own.map(() => false));
  const free = (candidate: Candidate) => candidate.spans.every((span) => claimed[span.region]!.slice(span.from, span.to).every((taken) => !taken));
  const placed: Array<{ item: string; key: [number, number, number] }> = [];
  let total = 0;
  for (const item of items) {
    const expected = normalizeLettering(item.text);
    let best: { candidate: Candidate; similarity: number } | undefined;
    for (const candidate of candidatesFor(expected, regions, tokens)) {
      if (!free(candidate)) continue;
      const similarity = letteringSimilarity(expected, candidate.normalized);
      if (!best || similarity > best.similarity) best = { candidate, similarity };
    }
    const similarity = best?.similarity ?? 0;
    total += similarity;
    if (!best || similarity < thresholds.missing) {
      findings.push({ id: `missing:${item.id}`, kind: "missing", item: item.id, expected: item.text });
      continue;
    }
    for (const span of best.candidate.spans) for (let i = span.from; i < span.to; i++) claimed[span.region]![i] = true;
    if (similarity < thresholds.exact) {
      findings.push({ id: `altered:${item.id}`, kind: "altered", item: item.id, expected: item.text, found: best.candidate.text,
        similarity: round(similarity), ...(best.candidate.box ? { box: best.candidate.box } : {}) });
    }
    const box = best.candidate.box;
    if (box) {
      if (touchesEdge(box)) findings.push({ id: `clipped:${item.id}`, kind: "clipped", item: item.id, expected: item.text, box });
      placed.push({ item: item.id, key: readingKey(box, page, reading) });
    }
  }
  // An item read earlier on the page than the one written before it is out of order (R-9).
  for (let i = 1; i < placed.length; i++) {
    if (before(placed[i]!.key, placed[i - 1]!.key)) {
      const text = items.find((item) => item.id === placed[i]!.item)?.text;
      findings.push({ id: `order:${placed[i]!.item}`, kind: "order", item: placed[i]!.item, ...(text ? { expected: text } : {}) });
    }
  }
  // Words no item claimed are words the script never wrote, wherever the reader put them.
  regions.forEach((region, index) => {
    const left: string[][] = [[]];
    tokens[index]!.forEach((token, i) => { if (claimed[index]![i]) left.push([]); else left.at(-1)!.push(token); });
    left.filter((run) => run.length > 0).forEach((run, n) => {
      // A stray mark the reader read as one character is noise, not words the model invented.
      if (run.join("").length < 2) return;
      findings.push({ id: `extra:${index}${n ? `:${n}` : ""}`, kind: "extra", found: run.length === tokens[index]!.length ? region.text : run.join(" "), ...(region.box ? { box: region.box } : {}) });
    });
  });
  const extras = findings.filter((finding) => finding.kind === "extra").length;
  const score = items.length || extras ? round(total / Math.max(1, items.length) * (items.length / (items.length + extras))) : 1;
  return LetteringVerificationSchema.parse({
    status: "compared", reader: input.reader, normalizationVersion: LETTERING_NORMALIZATION_VERSION,
    thresholds, score, findings, speaker: input.tails ? "checked" : "not-checked", regions: [...regions], at: input.at,
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The findings that stop an accept (R-31). */
export function blockingFindings(verification: LetteringVerification | undefined): LetteringFinding[] {
  return verification?.status === "compared" ? verification.findings.filter((finding) => BLOCKING_FINDINGS.has(finding.kind)) : [];
}

/**
 * Whether a take may be accepted as it stands (R-32, R-33): a completed comparison with nothing
 * blocking. Anything else — never checked, unavailable, or blocking — needs the author's override,
 * because silence is not clearance.
 */
export function takePasses(verification: LetteringVerification | undefined): boolean {
  return verification?.status === "compared" && blockingFindings(verification).length === 0;
}
