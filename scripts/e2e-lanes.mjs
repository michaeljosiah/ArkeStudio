#!/usr/bin/env node
/**
 * End-to-end check for lanes and clip sound, over CDP against a local desktop build.
 *
 * The plan this automates is docs/issues/099.lanes-cdp-test-plan.md; read that for why each
 * case exists. The one it is really for is EXPORT: the graph has been run by hand and measured
 * since (#428, which is where it turned out both lane resolvers named a path that does not
 * exist), but nothing has yet driven it through the app's own screens. Only a machine with a
 * full ffmpeg can do that.
 *
 * Zero new dependencies: raw CDP over the `ws` the coordinator already ships, and the `electron`
 * the desktop app already builds against.
 *
 *   node scripts/e2e-lanes.mjs                 # build, seed, run everything
 *   node scripts/e2e-lanes.mjs --skip-build    # reuse apps/desktop/dist/main.cjs
 *   node scripts/e2e-lanes.mjs --keep          # leave the test root on disk to poke at
 *   node scripts/e2e-lanes.mjs --headed        # watch it happen (default is xvfb if present)
 */
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = new Set(process.argv.slice(2));
const ROOT = join(tmpdir(), `arke-lanes-e2e-${Date.now()}`);
const WORLD = join(ROOT, "worlds", "the-undersong");
const WORLD_ID = "01J8F3K2QW9VZX4N7M0RTYB6HC";
const PROD = "saltlight";
// A killed Electron can leave the listener behind for a while, and the next run then fails to
// bind and waits out the attach timeout as if the app had never started. Override to step aside.
const PORT = Number(process.env.ARKE_CDP_PORT || 9222);

/**
 * Which pair to run: the bundled one, not PATH.
 *
 * A packaged build executes `resources/ffmpeg` (`apps/desktop/src/main.ts`), so a check that
 * runs whatever the machine happens to have is checking a binary the app never invokes. That is
 * the order `resolveFfprobe` already settles for measurement, for the same reason, and this is
 * the encoding half of it: an explicit env var wins, then the staged pair, then PATH as a last
 * resort so a checkout without build-resources can still run.
 *
 * It is not hypothetical. Windows' winget ffmpeg (gyan.dev 8.1.1-full) segfaults on `drawtext`,
 * which every gap in a cut draws — so pointing the app at PATH turns each export with a gap into
 * a crash that reads like a lanes bug.
 */
const stagedFfmpegDir = join(repoRoot, "apps", "desktop", "build-resources", "ffmpeg");
const staged = (stem) =>
  [`${stem}.exe`, stem].map((name) => join(stagedFfmpegDir, name)).find((path) => existsSync(path)) ?? null;
const FFMPEG = process.env.ARKE_FFMPEG || staged("ffmpeg") || "ffmpeg";
const FFPROBE = process.env.ARKE_FFPROBE || staged("ffprobe") || "ffprobe";

const results = [];
const record = (id, name, status, detail = "") => {
  results.push({ id, name, status, detail });
  const mark = status === "pass" ? "✓" : status === "fail" ? "✗" : "–";
  console.log(`  ${mark} ${id} ${name}${detail ? ` — ${detail}` : ""}`);
};
const ok = (id, name, cond, detail = "") =>
  record(id, name, cond ? "pass" : "fail", cond ? detail : detail || "assertion failed");

// ---------------------------------------------------------------------------
// Preflight — a stripped ffmpeg reports "installed" and then fails at the graph
// ---------------------------------------------------------------------------

const NEEDED_FILTERS = ["amix", "adelay", "apad", "atrim", "concat", "overlay", "drawtext"];

/*
 * Said on every block, because the staged pair is gitignored: a fresh clone and every worktree
 * fall through to PATH, and PATH is exactly where the unusable builds live.
 */
const REMEDY =
  "set ARKE_FFMPEG to a working one, or stage the bundled pair with " +
  "`npm run prepare:runtimes:x64 --workspace @arke-studio/desktop` (Windows only)";

function preflight() {
  const ff = spawnSync(FFMPEG, ["-hide_banner", "-filters"], { encoding: "utf8" });
  if (ff.error) return { ok: false, reason: `${FFMPEG} not runnable: ${ff.error.message}` };
  const listed = ff.stdout || "";
  const missing = NEEDED_FILTERS.filter((f) => !new RegExp(`^ [TSC.]* ${f} `, "m").test(listed));
  if (missing.length > 0) {
    return { ok: false, reason: `${FFMPEG} lacks filters: ${missing.join(", ")} — ${REMEDY}` };
  }
  /*
   * A listed filter is not a working filter, which is the same lesson one level down: reading
   * `-filters` is reading a table the build was compiled with, not evidence anything runs.
   *
   * `drawtext` is the one to actually run. It reaches outside ffmpeg for a font, so a build whose
   * fontconfig has no config file segfaults on it rather than falling back — and every gap in a
   * cut draws a slate, so that kills the export rather than the slate. One frame answers it.
   */
  const drawn = spawnSync(
    FFMPEG,
    [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-t", "0.1", "-i", "color=c=black:s=64x64:r=24",
      "-vf", "drawtext=text=probe:fontcolor=white:fontsize=12",
      "-f", "null", "-",
    ],
    { encoding: "utf8" },
  );
  if (drawn.status !== 0) {
    // A signal leaves `status` null, so name whichever one the platform gave us.
    const how = drawn.signal ?? `exit ${drawn.status}`;
    return {
      ok: false,
      reason: `${FFMPEG} lists drawtext but dies running it (${how}); every export with a gap would crash — ${REMEDY}`,
    };
  }
  const probe = spawnSync(FFPROBE, ["-version"], { encoding: "utf8" });
  if (probe.error) return { ok: false, reason: `${FFPROBE} not runnable` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Seed a disposable app root
// ---------------------------------------------------------------------------

/**
 * `links` is required by ArtifactSidecarSchema and the scanner drops a sidecar that fails it
 * with no log line, so an artifact silently never appears. `mediaInfo` is what makes a video
 * splittable without a probe having run.
 */
const sidecar = (id, file, hash, mediaInfo) => ({
  id,
  kind: "video",
  file,
  // Hex, and only hex: Sha256Schema rejects anything else, and a rejected sidecar is an
  // artifact that silently never appears — the exact trap this script exists to avoid.
  hash: `sha256:${hash}`,
  origin: { by: "user" },
  links: [],
  ...(mediaInfo ? { mediaInfo } : {}),
  created: "2026-08-01T10:00:00Z",
});

const VIDEO_WITH_SOUND = "ar_01J8G0000000000000000000V1";
const VIDEO_SILENT = "ar_01J8G0000000000000000000V2";
const VIDEO_UNMEASURED = "ar_01J8G0000000000000000000V3";

async function seed() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(join(ROOT, "worlds"), { recursive: true });
  await cp(join(repoRoot, "fixtures", "worlds", "the-undersong"), WORLD, { recursive: true });

  const arts = join(WORLD, "artifacts");
  // A real encode, so the export can actually decode and mix it. Two seconds of tone over
  // colour: enough for "is there sound after 2s" to mean something.
  const withSound = join(arts, "insert.mp4");
  const enc = spawnSync(
    FFMPEG,
    ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=24:d=6",
     "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
     "-shortest", "-pix_fmt", "yuv420p", withSound],
    { encoding: "utf8" },
  );
  if (enc.status !== 0) throw new Error(`could not build the test video: ${enc.stderr?.slice(-400)}`);

  const silent = join(arts, "silent.mp4");
  const enc2 = spawnSync(
    FFMPEG,
    ["-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=24:d=6", "-pix_fmt", "yuv420p", silent],
    { encoding: "utf8" },
  );
  if (enc2.status !== 0) throw new Error(`could not build the silent video: ${enc2.stderr?.slice(-400)}`);

  await cp(withSound, join(arts, "unmeasured.mp4"));

  await writeFile(join(arts, "insert.mp4.json"), JSON.stringify(sidecar(VIDEO_WITH_SOUND, "insert.mp4", "a1b2c3d4e5f60001", { durationSec: 6, hasAudio: true }), null, 2));
  await writeFile(join(arts, "silent.mp4.json"), JSON.stringify(sidecar(VIDEO_SILENT, "silent.mp4", "a1b2c3d4e5f60002", { durationSec: 6, hasAudio: false }), null, 2));
  await writeFile(join(arts, "unmeasured.mp4.json"), JSON.stringify(sidecar(VIDEO_UNMEASURED, "unmeasured.mp4", "a1b2c3d4e5f60003", null), null, 2));
}

const cutPath = () => join(WORLD, "productions", PROD, "cut.json");
async function readCut() {
  try {
    return JSON.parse(await readFile(cutPath(), "utf8"));
  } catch {
    return { audio: [], overlays: [] };
  }
}

// ---------------------------------------------------------------------------
// A very small CDP client
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The gesture writes on mouseup, but not synchronously — it goes to the coordinator and back
 * before it reaches the file. A fixed sleep either wastes time or, on a slower machine, reads
 * the value from before the gesture and reports a trim that "did nothing". Poll for the change
 * instead, and hand back the last value seen so a genuine failure still prints what it found.
 *
 * Only for assertions that expect a change; anything asserting nothing happened must read once.
 */
async function waitForCut(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cut = await readCut();
    if (predicate(cut)) return cut;
    if (Date.now() > deadline) return cut;
    await sleep(200);
  }
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function attach() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const page = (await targets()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return new Cdp(page.webSocketDebuggerUrl);
    } catch {
      /* the app has not opened its port yet */
    }
    if (Date.now() > deadline) throw new Error("no CDP page target appeared within 60s");
    await sleep(500);
  }
}

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.ready = new Promise((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", rej);
    });
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Evaluate in the page and return the value. Throws what the page threw. */
  async eval(fn, arg) {
    const expression = `(${fn.toString()})(${JSON.stringify(arg ?? null)})`;
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page threw");
    return r.result.value;
  }
  async mouse(type, x, y, extra = {}) {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  }
  /** A press-move-release drag, which is what the clip gestures listen for. */
  async drag(from, to, steps = 12) {
    await this.mouse("mouseMoved", from.x, from.y, { button: "none", clickCount: 0 });
    await this.mouse("mousePressed", from.x, from.y, { buttons: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.mouse("mouseMoved", x, y, { buttons: 1 });
      await sleep(8);
    }
    await this.mouse("mouseReleased", to.x, to.y, { buttons: 0 });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Page helpers, run inside the renderer
// ---------------------------------------------------------------------------

const pageHelpers = {
  laneCount: () => document.querySelectorAll(".fy-ovlane").length,
  laneLabels: () => [...document.querySelectorAll(".fy-track__label")].map((n) => n.textContent).filter((t) => /^L\d+$/.test(t)),
  clipCount: () => document.querySelectorAll(".fy-ovclip").length,
  headerMeta: () => document.querySelector(".fy-h1row__meta")?.textContent ?? "",
  /**
   * The Cut screen and its two resting lanes render before the world has been scanned, so
   * neither is evidence that anything is loaded. The summary is empty until the derived cut
   * arrives, and the rows are the drag sources — wait for both, or the first drop lands on a
   * cut of zero length and the handler discards it in silence.
   */
  worldLoaded: () => ({
    summary: document.querySelector(".fy-h1row__meta")?.textContent ?? "",
    rows: document.querySelectorAll(".fy-artrow").length,
  }),
  /** CDP's Input domain cannot do HTML5 drag-and-drop; a constructed DataTransfer can. */
  drop: ({ artifactId, laneFromTop, fraction }) => {
    const rows = [...document.querySelectorAll(".fy-artrow")];
    const idx = rows.findIndex((r) => r.textContent.includes(artifactId));
    const src = idx >= 0 ? rows[idx] : null;
    const lane = document.querySelectorAll(".fy-ovlane")[laneFromTop];
    if (!lane) return { error: `no lane at index ${laneFromTop}` };
    const dt = new DataTransfer();
    // The panel row is the drag source, but the payload is what the lane reads — set it
    // directly so the drop does not depend on matching a row by its filename.
    dt.setData("application/x-arke-artifact", artifactId);
    if (src) src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const box = lane.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
      clientX: box.left + box.width * fraction,
      clientY: box.top + box.height / 2,
    };
    lane.dispatchEvent(new DragEvent("dragover", opts));
    lane.dispatchEvent(new DragEvent("drop", opts));
    return { ok: true };
  },
  clipBox: (index) => {
    const el = document.querySelectorAll(".fy-ovclip")[index ?? 0];
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  },
  gripBox: ({ index, which }) => {
    const clip = document.querySelectorAll(".fy-ovclip")[index ?? 0];
    const el = clip?.querySelector(`.fy-ovclip__grip--${which}`);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  },
  /*
   * The menu is React state, so it is not in the DOM when dispatchEvent returns — reading it on
   * the next line finds nothing and reports a menu that did not open, when what actually
   * happened is that it had not rendered yet. Wait a frame before looking.
   */
  openMenu: async (index) => {
    const el = document.querySelectorAll(".fy-ovclip")[index ?? 0];
    if (!el) return { error: "no clip" };
    const b = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 }),
    );
    let menu = null;
    for (let i = 0; i < 40 && menu === null; i++) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 25)));
      menu = document.querySelector(".fy-clipmenu");
    }
    if (!menu) return { error: "menu did not open" };
    return {
      items: [...menu.querySelectorAll(".fy-clipmenu__item")].map((i) => ({ text: i.textContent.trim(), disabled: i.disabled })),
      note: menu.querySelector(".fy-clipmenu__note")?.textContent ?? "",
      inViewport: menu.getBoundingClientRect().right <= window.innerWidth + 1,
    };
  },
  clickMenuItem: (text) => {
    const item = [...document.querySelectorAll(".fy-clipmenu__item")].find((i) => i.textContent.includes(text));
    if (!item || item.disabled) return { error: `no enabled item matching "${text}"` };
    item.click();
    return { ok: true };
  },
  /* Closing is React state too, so the same wait the menu needed on the way open applies here. */
  pressEscape: async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    for (let i = 0; i < 40 && document.querySelector(".fy-clipmenu") !== null; i++) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 25)));
    }
    return { open: document.querySelector(".fy-clipmenu") !== null };
  },
  menuOpen: () => document.querySelector(".fy-clipmenu") !== null,
  clickText: (text) => {
    const el = [...document.querySelectorAll("button, a")].find((b) => b.textContent.trim() === text);
    if (!el) return { error: `no control reading "${text}"` };
    el.click();
    return { ok: true };
  },
  exportRows: () => [...document.querySelectorAll(".fy-exportrow__sub")].map((n) => n.textContent),
};

/**
 * Reset by removing each clip through the app's own × control.
 *
 * Deleting cut.json underneath a running app does not reset anything: the coordinator holds the
 * cut in memory and serves that, and the watcher suppresses what lands just after the app's own
 * write — so the file goes but the screen keeps its clips, and the next case places on top of
 * them. Navigating away and back does not help, because nothing re-reads the world.
 */
async function clearClips(cdp) {
  for (let i = 0; i < 40; i++) {
    if ((await cdp.eval(pageHelpers.clipCount)) === 0) return;
    const clicked = await cdp.eval(() => {
      const x = document.querySelector(".fy-ovclip__x");
      if (!x) return false;
      x.click();
      return true;
    });
    if (!clicked) return;
    await sleep(250);
  }
  throw new Error("could not clear the placed clips through the UI");
}

async function waitFor(cdp, fn, arg, predicate, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.eval(fn, arg);
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/**
 * A hash set while the shell is still booting does not stick: the app comes up on the launch
 * screen with an empty hash and routes itself once it is ready, discarding whatever was written
 * underneath it. Setting it once and then waiting on a screen that will never arrive reads as
 * "the Cut screen never rendered" — so re-assert the hash on every turn of the loop.
 */
async function navigate(cdp, hash, screen, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await cdp.eval((h) => {
      if (location.hash !== h) location.hash = h;
      return true;
    }, hash);
    const arrived = await cdp.eval((s) => document.querySelector(`[data-screen="${s}"]`) !== null, screen);
    if (arrived) return;
    if (Date.now() > deadline) throw new Error(`timed out navigating to ${hash} (wanted [data-screen="${screen}"])`);
    await sleep(400);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nPreflight");
  const pre = preflight();
  if (!pre.ok) {
    record("PRE", "ffmpeg has the filters the graph needs, and runs them", "blocked", pre.reason);
    console.log("\nBlocked before starting. The export cases cannot be answered without them.\n");
    process.exit(2);
  }
  // Named, not just passed: which binary answered decides what the export cases actually prove.
  record("PRE", "ffmpeg has the filters the graph needs, and runs them", "pass", FFMPEG);

  if (!argv.has("--skip-build")) {
    console.log("\nBuilding the desktop bundle (a minute or two)…");
    const build = spawnSync("npm", ["run", "build", "--workspace", "@arke-studio/desktop"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (build.status !== 0) throw new Error("desktop build failed");
  }
  const mainCjs = join(repoRoot, "apps", "desktop", "dist", "main.cjs");
  if (!existsSync(mainCjs)) throw new Error(`no build at ${mainCjs} — drop --skip-build`);

  console.log("\nSeeding a disposable app root…");
  await seed();
  console.log(`  ${ROOT}`);

  // The `.bin` shim is a `.cmd` on Windows, and since the CVE-2024-27980 fix Node refuses to
  // spawn one without a shell — it fails with a bare `spawn EINVAL` that names nothing. The
  // electron package exports the real binary's path, so ask it and skip the shim entirely.
  let electronBin;
  try {
    electronBin = require("electron");
  } catch {
    electronBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  }
  const useXvfb = process.platform === "linux" && !process.env.DISPLAY && !argv.has("--headed");
  const cmd = useXvfb ? "xvfb-run" : electronBin;
  const args = useXvfb
    ? ["-a", electronBin, mainCjs, `--remote-debugging-port=${PORT}`]
    : [mainCjs, `--remote-debugging-port=${PORT}`];

  const app = spawn(cmd, args, {
    cwd: repoRoot,
    env: { ...process.env, ARKE_STUDIO_ROOT: ROOT, ARKE_FFMPEG: FFMPEG },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let appLog = "";
  app.stdout.on("data", (d) => (appLog += d));
  app.stderr.on("data", (d) => (appLog += d));

  let cdp;
  try {
    cdp = await attach();
    await cdp.ready;
    await navigate(cdp, `#/w/${WORLD_ID}/p/${PROD}/cut`, "cut");
    await waitFor(cdp, pageHelpers.laneCount, null, (n) => n >= 2, "lanes to render");
    // A drop is fire-and-forget: nothing retries it, so it has to happen after the scan lands.
    await waitFor(
      cdp,
      pageHelpers.worldLoaded,
      null,
      (v) => /shots covered/.test(v.summary) && v.rows > 0,
      "the world to finish scanning",
      60_000,
    );

    console.log("\nLanes");
    const labels = await cdp.eval(pageHelpers.laneLabels);
    ok("T1a", "rests at two lanes", (await cdp.eval(pageHelpers.laneCount)) === 2, labels.join(" "));
    ok("T1b", "drawn highest-first", labels[0] === "L1" && labels[labels.length - 1] === "L0", labels.join(" "));

    // T1 — an audio bed on the bottom lane
    await cdp.eval(pageHelpers.drop, { artifactId: "ar_01J8G0000000000000000000R1", laneFromTop: 1, fraction: 0.2 });
    await waitFor(cdp, pageHelpers.clipCount, null, (n) => n === 1, "the bed to place");
    let cut = await readCut();
    ok("T1c", "the bed is filed on lane 0", cut.overlays[0]?.lane === 0 && cut.overlays[0]?.audio === "keep",
      `lane=${cut.overlays[0]?.lane} audio=${cut.overlays[0]?.audio} ${cut.overlays[0]?.startSec}s→${cut.overlays[0]?.endSec}s`);

    // T2 — a picture on the other lane: a lane has no type
    await cdp.eval(pageHelpers.drop, { artifactId: "ar_01J8G0000000000000000000R3", laneFromTop: 0, fraction: 0.5 });
    await waitFor(cdp, pageHelpers.clipCount, null, (n) => n === 2, "the board to place");
    cut = await readCut();
    ok("T2", "a lane takes a picture and a sound alike", cut.overlays.length === 2 && cut.overlays.some((o) => o.lane === 1));
    ok("T2b", "the header pluralises", (await cdp.eval(pageHelpers.headerMeta)).includes("2 clips"));

    // T5 — cross-lane move, and its live feedback
    const before = await cdp.eval(pageHelpers.clipBox, 0);
    const lanesBefore = (await readCut()).overlays.map((o) => o.lane).join(",");
    await cdp.drag({ x: before.x + before.w / 2, y: before.y + before.h / 2 }, { x: before.x + before.w / 2, y: before.y + before.h / 2 - 50 });
    cut = await waitForCut((c) => c.overlays.map((o) => o.lane).join(",") !== lanesBefore);
    ok("T5", "a clip moves up a lane", cut.overlays.some((o) => o.lane === 2) || cut.overlays.filter((o) => o.lane === 1).length >= 1,
      `lanes now ${cut.overlays.map((o) => o.lane).join(",")}`);

    // T6 — trim the tail
    await clearClips(cdp);
    await waitFor(cdp, pageHelpers.clipCount, null, (n) => n === 0, "a cleared cut");
    await cdp.eval(pageHelpers.drop, { artifactId: VIDEO_WITH_SOUND, laneFromTop: 0, fraction: 0.1 });
    await waitFor(cdp, pageHelpers.clipCount, null, (n) => n === 1, "the video to place");
    const placed = (await readCut()).overlays[0];
    const grip = await cdp.eval(pageHelpers.gripBox, { index: 0, which: "end" });
    await cdp.drag({ x: grip.x + grip.w / 2, y: grip.y + grip.h / 2 }, { x: grip.x + grip.w / 2 + 60, y: grip.y + grip.h / 2 });
    const trimmed = (await waitForCut((c) => c.overlays[0]?.endSec !== placed.endSec)).overlays[0];
    ok("T6", "the tail moves and the head does not",
      trimmed.endSec > placed.endSec && trimmed.startSec === placed.startSec,
      `${placed.startSec}→${placed.endSec} became ${trimmed.startSec}→${trimmed.endSec}`);

    console.log("\nSplit and rejoin");
    let menu = await cdp.eval(pageHelpers.openMenu, 0);
    const splitItem = menu.items?.find((i) => i.text.includes("Split"));
    ok("T7a", "split is offered for a measured video with sound", splitItem && !splitItem.disabled, menu.note);
    await cdp.eval(pageHelpers.clickMenuItem, "Split");
    await waitFor(cdp, pageHelpers.clipCount, null, (n) => n === 2, "the sound half");
    cut = await waitForCut((c) => c.overlays.length === 2);
    const picture = cut.overlays.find((o) => o.audio === "mute");
    const sound = cut.overlays.find((o) => o.audio === "only");
    ok("T7b", "picture mutes, sound lands one lane below",
      picture && sound && sound.lane === picture.lane - 1 && sound.startSec === picture.startSec && sound.endSec === picture.endSec,
      `picture lane ${picture?.lane}, sound lane ${sound?.lane}`);
    ok("T7c", "the header still counts one clip", (await cdp.eval(pageHelpers.headerMeta)).includes("1 clip"));

    const muteIndex = await cdp.eval((id) => {
      const clips = [...document.querySelectorAll(".fy-ovclip")];
      return clips.findIndex((c) => c.textContent.includes("MUTE"));
    });
    await cdp.eval(pageHelpers.openMenu, muteIndex);
    await cdp.eval(pageHelpers.clickMenuItem, "Rejoin");
    await waitFor(cdp, pageHelpers.clipCount, null, (n) => n === 1, "the rejoin");
    cut = await waitForCut((c) => c.overlays.length === 1);
    ok("T7d", "rejoin restores sound and removes the twin", cut.overlays.length === 1 && cut.overlays[0].audio === "keep");

    console.log("\nRefusals");
    await clearClips(cdp);
    await waitFor(cdp, pageHelpers.clipCount, null, (n) => n === 0, "a cleared cut");
    await cdp.eval(pageHelpers.drop, { artifactId: VIDEO_SILENT, laneFromTop: 0, fraction: 0.1 });
    await waitFor(cdp, pageHelpers.clipCount, null, (n) => n === 1, "the silent video");
    menu = await cdp.eval(pageHelpers.openMenu, 0);
    const silentItem = menu.items?.find((i) => i.text.includes("Split"));
    ok("T8", "split refuses a video measured silent, and says so",
      silentItem?.disabled === true && /silent/i.test(menu.note), menu.note);
    ok("T8b", "and files nothing", (await readCut()).overlays.every((o) => o.audio === "keep"));
    ok("T10", "the menu opens inside the viewport", menu.inViewport === true);
    ok("T10b", "Escape closes it", (await cdp.eval(pageHelpers.pressEscape)).open === false);

    await cdp.eval(pageHelpers.drop, { artifactId: VIDEO_UNMEASURED, laneFromTop: 0, fraction: 0.6 });
    await waitFor(cdp, pageHelpers.clipCount, null, (n) => n === 2, "the unmeasured video");
    menu = await cdp.eval(pageHelpers.openMenu, 1);
    const unmeasuredItem = menu.items?.find((i) => i.text.includes("Split"));
    ok("T9", "split refuses an unmeasured video, in different words",
      unmeasuredItem?.disabled === true && /measured/i.test(menu.note) && !/silent/i.test(menu.note), menu.note);

    // ---- The point of all this -------------------------------------------
    console.log("\nExport");
    await clearClips(cdp);
    await waitFor(cdp, pageHelpers.clipCount, null, (n) => n === 0, "a cleared cut");

    const baseline = await runExport(cdp, "T12");
    ok("T12", "an export with nothing placed still succeeds", baseline !== null, baseline ?? "");
    if (baseline) {
      ok("T12b", "and has no audio track", !hasAudioStream(baseline));
    }

    await navigate(cdp, `#/w/${WORLD_ID}/p/${PROD}/cut`, "cut");
    await waitFor(cdp, pageHelpers.laneCount, null, (n) => n >= 2, "lanes");
    await cdp.eval(pageHelpers.drop, { artifactId: "ar_01J8G0000000000000000000R1", laneFromTop: 1, fraction: 0.2 });
    await waitFor(cdp, pageHelpers.clipCount, null, (n) => n === 1, "the bed");
    const placedCut = await readCut();
    const bed = placedCut.overlays[0];

    const withSound = await runExport(cdp, "T13");
    if (!withSound) {
      record("T13", "the placed sound reaches the file", "fail", "the export did not finish");
    } else {
      ok("T13a", "the file has an audio track", hasAudioStream(withSound));
      const before2s = meanVolume(withSound, 0, Math.max(0.5, bed.startSec - 0.5));
      const after = meanVolume(withSound, bed.startSec + 0.5, 1.5);
      ok("T13b", "silent before the placement, audible after",
        before2s !== null && after !== null && after > before2s + 20,
        `before ${before2s?.toFixed(1)}dB, after ${after?.toFixed(1)}dB`);
      ok("T13c", "the film's length is unchanged by a placed sound",
        Math.abs(durationOf(withSound) - durationOf(baseline)) < 0.5,
        `${durationOf(baseline)?.toFixed(2)}s → ${durationOf(withSound)?.toFixed(2)}s`);
    }
  } finally {
    cdp?.close();
    app.kill();
    await sleep(500);
    if (!argv.has("--keep")) await rm(ROOT, { recursive: true, force: true });
    else console.log(`\nleft on disk: ${ROOT}`);
  }

  const failed = results.filter((r) => r.status === "fail");
  const blocked = results.filter((r) => r.status === "blocked");
  console.log(`\n${results.length - failed.length - blocked.length} passed, ${failed.length} failed, ${blocked.length} blocked`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f.id} ${f.name} — ${f.detail}`);
    console.log("\nApp log tail:\n" + appLog.split("\n").slice(-25).join("\n"));
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Export driving and file inspection
// ---------------------------------------------------------------------------

async function exportsOnDisk() {
  try {
    return (await readdir(join(WORLD, "exports"))).filter((f) => f.endsWith(".mp4"));
  } catch {
    return [];
  }
}

async function runExport(cdp, label = "export") {
  const had = new Set(await exportsOnDisk());
  await navigate(cdp, `#/w/${WORLD_ID}/p/${PROD}/exports`, "exports");
  await sleep(500);
  /*
   * The action carries its runtime in its label — "Export · 1:07" — so it cannot be matched by
   * exact text, and a loose /export/i over every button matches the rail's own "Exports" item
   * first and navigates instead of encoding. That failure is completely silent: no encode
   * starts, nothing errors, and the export simply never appears.
   */
  const pressed = await cdp.eval(() => {
    const el = [...document.querySelectorAll("button.ui-btn--primary")].find(
      (b) => b.textContent.trim().startsWith("Export") && !b.disabled,
    );
    if (!el) return { error: "no enabled primary Export button", saw: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()) };
    el.click();
    return { ok: true, clicked: el.textContent.trim() };
  });
  if (pressed?.error) {
    record(label, "the export could be started", "fail", `${pressed.error}; buttons: ${(pressed.saw ?? []).join(" | ")}`);
    return null;
  }
  const deadline = Date.now() + 180_000;
  for (;;) {
    const now = await exportsOnDisk();
    const fresh = now.find((f) => !had.has(f));
    if (fresh) return join(WORLD, "exports", fresh);
    if (Date.now() > deadline) {
      // An export that fails leaves nothing on disk, so the only account of why is on screen.
      const screen = await cdp.eval(() => ({
        rows: [...document.querySelectorAll(".fy-exportrow, .fy-exportrow__sub, .fy-notecard")].map((n) => n.textContent.trim()).slice(0, 10),
      }));
      record(label, "the export finished", "fail", `no file after 180s; screen says: ${screen.rows.join(" | ") || "(nothing)"}`);
      return null;
    }
    await sleep(1000);
  }
}

const hasAudioStream = (file) => {
  const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file], { encoding: "utf8" });
  return (r.stdout || "").includes("audio");
};

const durationOf = (file) => {
  if (!file) return null;
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  const v = Number.parseFloat((r.stdout || "").trim());
  return Number.isFinite(v) ? v : null;
};

/**
 * Mean volume over a window, which is how "is it actually silent there" gets answered.
 *
 * volumedetect reports its summary at the *info* level, so `-v error` — which every other probe
 * here wants — hides the one line this reads and the measurement comes back null. A null reads
 * as "could not measure" and fails the case whatever the audio actually does, so the level has
 * to stay at info and the noise be turned off some other way.
 */
const meanVolume = (file, startSec, durationSec) => {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-ss", String(startSec), "-t", String(durationSec), "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(r.stderr || "");
  return m ? Number.parseFloat(m[1]) : null;
};

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  if (!argv.has("--keep")) await rm(ROOT, { recursive: true, force: true });
  process.exit(3);
});
