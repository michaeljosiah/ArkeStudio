import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { AudiobookDoor, ChapterSummary, ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The audiobook page's hero never clips its presses (design turn 199, rule 2). What shipped in
 * 0.5.x drew the head at a fixed height, and at about 1800 by 1180 the third press, Read the book,
 * was cut off by its bottom edge. linkedom lays nothing out, so the real page — the whole App at
 * the route, with every stylesheet main.tsx loads — is laid out in headless Chrome at 1440 by 900,
 * 1100 by 790 and a 720 main column, and every press's box is read back against the hero's. Without
 * a Chrome on the machine the measured half is skipped; the stylesheet half always runs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../src");

function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((path): path is string => path !== undefined && path !== "" && existsSync(path)) ?? null;
}

/** Every stylesheet main.tsx loads, in its order; the fonts' own files by absolute URL. */
function stylesheets(): string {
  const require = createRequire(import.meta.url);
  const main = readFileSync(join(SRC, "main.tsx"), "utf8");
  let css = "";
  for (const match of main.matchAll(/^import "([^"]+\.css)";/gm)) {
    const spec = match[1]!;
    let file: string;
    try {
      file = spec.startsWith("./") ? join(SRC, spec) : require.resolve(spec);
    } catch {
      continue;
    }
    let text = readFileSync(file, "utf8");
    if (!spec.startsWith("./")) {
      const base = pathToFileURL(dirname(file)).href;
      text = text.replace(/url\(\.\/([^)]+)\)/g, (_all, rel: string) => `url(${base}/${rel})`);
    }
    css += `\n${text}`;
  }
  return css;
}

const AT = "2026-10-05T09:00:00.000Z";
const stamp = { chapterVersion: 6, hash: "h", updatedAt: AT, takes: 91, flagged: 0 };
const CHAPTERS: ChapterSummary[] = [
  { id: "chapter-1", file: "chapter-1", order: 1, title: "Chapter 1", status: "drafted", version: 6, words: 3240, synopsis: "Ade and Tunde's easy, longstanding friendship opens a night at a club.", audiobook: stamp },
  { id: "untitled", file: "untitled", order: 2, title: "Untitled", status: "planned", version: 1, words: 0 },
];

function state(): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      productions: [
        ...world.productions,
        { ...salt, meta: { ...salt.meta, id: "inkbound", format: "story" as const, title: "Na love or Juju" }, story: { ...(salt.story ?? { version: 1 }), version: 3 }, chapters: CHAPTERS, audiobook: { schemaVersion: 1 as const, reading: "cast" as const } },
      ],
    },
  };
}

// The drawn book: chapter 1 part read, chapter 2 planned, two speakers with no voice under Cast and
// a cloud narrator, so Read the book carries its count, its price and its warning word — the
// longest the third press gets.
const DOOR: AudiobookDoor = {
  reading: "cast",
  voices: [
    { name: "Ife's voice", voice: { label: "Ife's voice", provider: "google", local: false }, state: "narrator", blocks: 155 },
    { sheet: "maren-kest", name: "Adeyemi \"Ade\" Akinola", state: "no voice", blocks: 31 },
    { sheet: "odile-sarn", name: "Tunde", state: "no voice", blocks: 32 },
  ],
  unattributed: 0,
  rows: [
    { chapterId: "chapter-1", file: "chapter-1", order: 1, title: "Chapter 1", version: 6, planned: false, total: 171, made: 91, stale: 0, flagged: 0, notMade: 80, seconds: 700 },
    { chapterId: "untitled", file: "untitled", order: 2, title: "Untitled", version: 1, planned: true, total: 0, made: 0, stale: 0, flagged: 0, notMade: 0, seconds: 0 },
  ],
  price: { chapters: 1, blocks: 80, cloudBlocks: 80, characters: 9000, estimatedMicroUsd: 800, voices: [{ label: "Ife's voice", provider: "google", narrator: true, local: false, characters: 9000, estimatedMicroUsd: 800 }] },
};

type Box = { l: number; r: number; t: number; b: number };
type Measured = { width: number; height: number; hero: Box; maxHeight: string; heightRule: string; presses: { label: string; box: Box }[] };

/** The page at one window size, laid out by Chrome. */
async function measure(chrome: string, width: number, height: number): Promise<Measured> {
  __setStateForTest(state(), { audiobookDoor: { inkbound: { door: DOOR, requestId: "01J8F3K2QW9VZX4N7M0RTYB6D1" } } });
  let html: string;
  try {
    html = renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/inkbound/story/audiobook`]}>
        <App />
      </MemoryRouter>,
    );
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
  const script = `document.fonts.ready.then(() => {
    const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
    const hero = document.querySelector('[data-testid="audiobook-hero"]');
    const out = document.createElement("pre");
    out.id = "measured";
    out.textContent = JSON.stringify(hero === null ? null : {
      width: innerWidth, height: innerHeight, hero: box(hero), maxHeight: getComputedStyle(hero).maxHeight, heightRule: hero.style.height,
      presses: [...document.querySelectorAll('[data-testid="audiobook-presses"] button')].map((el) => ({ label: el.getAttribute("aria-label") || el.textContent, box: box(el) })),
    });
    document.body.append(out);
  });`;
  const dir = mkdtempSync(join(tmpdir(), "arke-abshow-"));
  try {
    const file = join(dir, "page.html");
    writeFileSync(file, `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>${stylesheets()}
*,*::before,*::after{animation:none!important;transition:none!important}html,body,#root{height:100%;margin:0}</style></head><body><div id="root">${html}</div><script>${script}</script></body></html>`);
    const args = ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${join(dir, "profile")}`, `--window-size=${width},${height}`, "--virtual-time-budget=5000", "--dump-dom", pathToFileURL(file).href];
    // The runner's Chrome on Linux has no usable sandbox under Ubuntu's user-namespace policy; the page is our own file.
    if (process.platform === "linux") args.unshift("--no-sandbox");
    const dom = await new Promise<string>((resolve, reject) => {
      execFile(chrome, args, { encoding: "utf8", maxBuffer: 64e6, timeout: 90_000 }, (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout)));
    });
    const json = dom.match(/<pre id="measured">([\s\S]*?)<\/pre>/)?.[1];
    assert.ok(json, "Chrome rendered the page and measured it");
    const measured = JSON.parse(json.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")) as Measured | null;
    assert.ok(measured, "the audiobook hero is on the page");
    return measured;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** The declarations of every rule whose selector list names `selector` exactly. */
function declarations(css: string, selector: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: string[] = [];
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.split(",").some((part) => part.trim() === selector)) found.push(match[2]!);
  }
  return found;
}

const chrome = findChrome();

describe("the audiobook hero never clips its presses (design turn 199, rule 2)", () => {
  it("gives the hero no fixed or maximum height, and wraps its presses", () => {
    const css = readFileSync(join(SRC, "screens/audiobook-show.css"), "utf8");
    const hero = declarations(css, ".fy-abshow__hero");
    assert.ok(hero.length > 0, "the hero has its rule");
    for (const body of hero) {
      assert.doesNotMatch(body, /(^|;|\s)(height|max-height)\s*:/, `no fixed or maximum height: ${body}`);
      assert.doesNotMatch(body, /overflow\s*:\s*(hidden|clip)/, "the hero itself clips nothing; the backdrop clips in its own layer");
    }
    assert.ok(declarations(css, ".fy-abshow__acts").some((body) => /flex-wrap\s*:\s*wrap/.test(body)), "the presses wrap");
    assert.ok(declarations(css, ".fy-abshow__btn").some((body) => /flex\s*:\s*none/.test(body) && /white-space\s*:\s*nowrap/.test(body)), "a press is never squeezed or broken: it moves to the next line whole");
  });

  for (const [width, height, what] of [
    [1440, 900, "1440 by 900"],
    [1100, 790, "1100 by 790"],
    [985, 790, "a 720 main column"],
  ] as const) {
    it(`lays every press inside the hero at ${what}`, { skip: chrome === null ? "no Chrome to lay the page out" : false }, async () => {
      const measured = await measure(chrome!, width, height);
      assert.equal(measured.maxHeight, "none");
      assert.deepEqual(measured.presses.map((press) => press.label), ["Listen", "Export", "Read the book · 1 chapter · up to $0.0008 · 2 no voice", "More"]);
      for (const press of measured.presses) {
        const inside = press.box.l >= measured.hero.l - 0.5 && press.box.r <= measured.hero.r + 0.5 && press.box.t >= measured.hero.t - 0.5 && press.box.b <= measured.hero.b + 0.5;
        assert.ok(inside, `${what}: ${press.label} at ${JSON.stringify(press.box)} lies inside the hero ${JSON.stringify(measured.hero)}`);
        assert.ok(press.box.r - press.box.l >= 44 - 0.5 && press.box.b - press.box.t >= 44 - 0.5, `${what}: ${press.label} is whole, 44 high`);
      }
    });
  }
});
