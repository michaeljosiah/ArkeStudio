import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import type { ClientState, ModelInfo } from "@arke-studio/contracts";
import { Composer } from "../src/components/composer.js";
import { ModelChip } from "../src/components/model-chip.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The composer's tool row as a browser lays it out (local.16). linkedom lays nothing out, and the
 * row's failures were all geometry: in the 302 production dock the mic's reason wrapped to four
 * lines over the editor, the model's name was cut to F…, and the effort chip ran under send. So the
 * real composer, with the real stylesheets, is rendered at the dock's widths in headless Chrome and
 * its boxes are read back. Without a Chrome on the machine the test is skipped, not passed.
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

const MODELS: ModelInfo[] = [
  // OpenCode's Zen default, as the installed app had it: variants and no default among them.
  { id: "fledge", provider: "opencode", providerName: "OpenCode Zen", displayName: "Fledge Alpha Free", isDefault: true, variants: { names: ["low", "medium", "high"] } },
  { id: "gpt-5.4", provider: "openai", providerName: "OpenAI", displayName: "GPT-5.4", variants: { names: ["minimal", "low", "medium", "high", "xhigh"], default: "high" } },
];

function state(): ClientState {
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      health: { ...FIXTURE_STATE.app.health, harness: { status: "healthy" } },
      harnessModelStatus: { status: "ready" },
      harnessModels: MODELS,
    },
  };
}

type Box = { l: number; r: number; t: number; b: number; w: number };
type Row = {
  key: string;
  width: number;
  composer: Box;
  editor: Box;
  controls: { label: string | null; box: Box; visible: string[] }[];
  inline: string[];
};

/** The chapter dock's composer for each case and width, measured once the fonts are in. */
async function measure(chrome: string, cases: { key: string; value: string | undefined; set: boolean; variant?: string }[], widths: number[]): Promise<Row[]> {
  const s = state();
  // Dictation off, as in the installed app: the reason that used to be written into the row.
  __setStateForTest(s, { voiceSidecar: { state: "unavailable", detail: "the dictation model has not been downloaded" } });
  let body = "";
  try {
    for (const c of cases) {
      for (const width of widths) {
        const chip = <ModelChip state={s} value={c.value} set={c.set} onPick={() => {}} onVariant={() => {}} {...(c.variant === undefined ? {} : { variant: c.variant })} />;
        const html = renderToString(<Composer value="" onChange={() => {}} onSubmit={() => {}} placeholder="Ask about chapter 01" modelControl={chip} onAttach={() => {}} onDictate={() => {}} />);
        // The dock's own frame (fidelity.css: .fy-arke__foot pads 14 a side here, and the dock has a 1px rule), sized so the composer is `width`.
        body += `<section data-key="${c.key}" data-width="${width}"><div class="fy-sw" data-screen="chapter" style="display:block;height:auto;min-height:0"><aside class="fy-arke" data-dock="conversation" data-conversation-first="true" style="width:${width + 29}px;height:auto;position:static"><div class="fy-arke__foot">${html}</div></aside></div></section>`;
      }
    }
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
  const script = `document.fonts.ready.then(() => {
    const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; };
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const rows = [...document.querySelectorAll("section")].map((section) => ({
      key: section.dataset.key, width: Number(section.dataset.width),
      composer: box(section.querySelector(".fy-cx")), editor: box(section.querySelector(".fy-cx__editorwrap")),
      controls: [...section.querySelectorAll(".fy-cx__bar button")].map((el) => ({
        label: el.getAttribute("aria-label"), box: box(el),
        visible: [...el.querySelectorAll(".fy-mchip__name, .fy-mchip__gauge, :scope > svg")].filter(shown).map((part) => part.tagName === "svg" ? "chevron" : part.classList.contains("fy-mchip__gauge") ? "gauge" : "name:" + part.textContent + ":" + part.getBoundingClientRect().width.toFixed(1)),
      })),
      inline: [...section.querySelectorAll(".fy-cx *")].filter((el) => shown(el) && [...el.childNodes].some((node) => node.nodeType === 3 && /Dictation/.test(node.textContent))).map((el) => el.textContent),
    }));
    const out = document.createElement("pre");
    out.id = "rows";
    out.textContent = JSON.stringify(rows);
    document.body.append(out);
  });`;
  const dir = mkdtempSync(join(tmpdir(), "arke-composer-row-"));
  try {
    const file = join(dir, "composer.html");
    writeFileSync(file, `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>${stylesheets()}
*,*::before,*::after{animation:none!important;transition:none!important}body{margin:0;padding:16px}</style></head><body>${body}<script>${script}</script></body></html>`);
    const args = ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${join(dir, "profile")}`, "--window-size=1200,900", "--virtual-time-budget=5000", "--dump-dom", pathToFileURL(file).href];
    // The runner's Chrome on Linux has no usable sandbox under Ubuntu's user-namespace policy; the page is our own file.
    if (process.platform === "linux") args.unshift("--no-sandbox");
    const dom = await new Promise<string>((resolve, reject) => {
      execFile(chrome, args, { encoding: "utf8", maxBuffer: 64e6, timeout: 90_000 }, (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout)));
    });
    const json = dom.match(/<pre id="rows">([\s\S]*?)<\/pre>/)?.[1];
    assert.ok(json, "Chrome rendered the page and measured it");
    return JSON.parse(json.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")) as Row[];
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const chrome = findChrome();

describe("the composer's tool row in the production dock (local.16)", { skip: chrome === null ? "no Chrome to lay the row out" : false }, () => {
  it("keeps send whole and clear, the name readable, and no reason written over the editor, at 302, 331 and 430", async () => {
    const rows = await measure(chrome!, [
      { key: "zen", value: undefined, set: false },
      { key: "gpt", value: "openai/gpt-5.4", set: true, variant: "high" },
      { key: "gpt-highest", value: "openai/gpt-5.4", set: true, variant: "xhigh" },
    ], [302, 331, 430]);
    assert.equal(rows.length, 9);
    for (const row of rows) {
      const at = `${row.key} at ${row.width}`;
      assert.ok(Math.abs(row.composer.w - row.width) < 1, `${at}: the composer is the width asked for (${row.composer.w})`);
      assert.deepEqual(row.inline, [], `${at}: why dictation is off is not written in the composer`);
      const send = row.controls.find((control) => control.label === "Send")!;
      assert.ok(send.box.w >= 24 && send.box.r <= row.composer.r - 1, `${at}: send is whole and inside the composer`);
      for (const control of row.controls.filter((candidate) => candidate !== send)) {
        assert.ok(control.box.r <= send.box.l, `${at}: ${control.label} ends at ${control.box.r}, before send at ${send.box.l}`);
        assert.ok(control.box.t >= row.editor.b - 1, `${at}: ${control.label} stays in the tool row, under the editor`);
      }
      const model = row.controls.find((control) => control.label === "Language model")!;
      const name = model.visible.find((part) => part.startsWith("name:"))!;
      assert.ok(Number(name.split(":").at(-1)) >= 39.5, `${at}: the model keeps a readable prefix (${name})`);
    }
  });

  it("says the effort's value without its chevron when narrow, and draws Effort as its glyph", async () => {
    const rows = await measure(chrome!, [
      { key: "zen", value: undefined, set: false },
      { key: "gpt", value: "openai/gpt-5.4", set: true, variant: "high" },
    ], [302, 430]);
    const effort = (key: string, width: number) => rows.find((row) => row.key === key && row.width === width)!.controls.find((control) => control.label === "Effort")!;
    assert.deepEqual(effort("zen", 302).visible, ["gauge"], "no default to name: the glyph alone, its name on the press");
    assert.ok(effort("zen", 302).box.w <= 32.5);
    assert.deepEqual(effort("zen", 430).visible.map((part) => part.split(":")[0] === "name" ? part.split(":").slice(0, 2).join(":") : part), ["name:Effort", "chevron"], "with room, the word, as 195 draws it");
    assert.deepEqual(effort("gpt", 302).visible.map((part) => part.split(":").slice(0, 2).join(":")), ["name:High"], "the value and nothing else");
    assert.deepEqual(effort("gpt", 430).visible.map((part) => part.split(":")[0] === "name" ? part.split(":").slice(0, 2).join(":") : part), ["name:High", "chevron"], "195b's chip, with room");
  });
});
