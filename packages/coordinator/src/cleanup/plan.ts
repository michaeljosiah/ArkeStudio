import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldWork } from "node:timers/promises";
import {
  AUDIOBOOK_CREDITS_ID, CLEANUP_CLASSES, CLEANUP_HOLD_DAYS, CLEANUP_TICKED, audiobookTextHash, chapterMix, cleanupAction, mixKey,
  type AudiobookReader, type CleanupClass, type CleanupItem, type CleanupPlan, type CleanupProblem,
} from "@arke-studio/contracts";
import { BenchStore, sessionDir } from "../bench/store.js";
import { planAudiobook, type AudiobookPlan } from "../productions/audiobook.js";
import { anyNarrator } from "../productions/audiobook-listening.js";
import { RENDER_VERSION } from "../productions/audiobook-mix.js";
import { chapterTiming } from "../productions/audiobook-timing.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { namedElsewhere, takeCensus } from "./census.js";

/** A file as planned: its identity stays in memory with the plan, never in the ledger (R-19, R-20). */
export interface PlannedFile { path: string; size: number; mtimeMs: number; dev: number; ino: number; nlink: number }
export interface PlannedItem {
  view: CleanupItem;
  action: "link" | "clear" | "hold";
  files: PlannedFile[];
  keep?: PlannedFile;
  /** A held unit moves as one: a take's media folder, an export's folder (R-27). */
  unit?: string;
  sidecar?: { path: string; text: string };
  bench?: { sessionId: string; takeId: string };
}
export interface Planned { plan: CleanupPlan; items: Map<string, PlannedItem>; madeAtMs: number; putBack: Array<{ sessionId: string; takeId: string }> }

export interface PlanDeps {
  appRoot: string | null;
  now(): number;
  newPlanId(): string;
  /** Play's narrator for a chapter, beside the listening view's own (R-34). */
  playNarrator?(productionId: string, chapterId: string): Promise<AudiobookReader | null>;
  signal: AbortSignal;
}

const DAY = 86_400_000;
const GRACE_MS = 10 * 60_000;
const QUICK = 64 * 1024;
const MIX_NAME = /^r(\d+)-([0-9a-f]+)(?:-\d+-\d+)?\.wav$/;

async function list(dir: string, signal: AbortSignal, prefix = ""): Promise<Array<{ path: string; info: Stats }>> {
  const out: Array<{ path: string; info: Stats }> = [];
  let since = performance.now();
  const walk = async (abs: string, rel: string): Promise<void> => {
    let handle;
    try { handle = await opendir(toExtendedLength(abs), { bufferSize: 64 }); } catch { return; }
    for await (const entry of handle) {
      signal.throwIfAborted();
      const childAbs = join(abs, entry.name), childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const info = await lstat(toExtendedLength(childAbs)).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(childAbs, childRel);
      else if (info.isFile()) out.push({ path: childRel, info });
      if (performance.now() - since > 50) { await yieldWork(); since = performance.now(); }
    }
  };
  await walk(dir, prefix);
  return out;
}

const planned = (path: string, info: Stats): PlannedFile => ({ path, size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino, nlink: info.nlink });
/** Bytes these files leave with no name (R-9): a file with a name outside the item frees nothing. */
const freed = (files: readonly PlannedFile[]) => {
  const seen = new Map<string, { size: number; names: number; nlink: number }>();
  for (const file of files) {
    const key = `${file.dev}:${file.ino}`, row = seen.get(key) ?? { size: file.size, names: 0, nlink: file.nlink };
    row.names++; seen.set(key, row);
  }
  return [...seen.values()].reduce((sum, row) => sum + (row.names >= row.nlink ? row.size : 0), 0);
};

/** The first and last 64 KiB and the size: enough to pair copies, never to link them (R-21 reads all of both). */
async function quickHash(abs: string, size: number): Promise<string | null> {
  const handle = await open(toExtendedLength(abs), "r").catch(() => null);
  if (!handle) return null;
  try {
    const hash = createHash("sha256").update(String(size)), head = Buffer.alloc(Math.min(QUICK, size));
    await handle.read(head, 0, head.length, 0); hash.update(head);
    if (size > QUICK) { const tail = Buffer.alloc(Math.min(QUICK, size - QUICK)); await handle.read(tail, 0, tail.length, size - tail.length); hash.update(tail); }
    return hash.digest("hex");
  } catch { return null; } finally { await handle.close(); }
}

const short = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

interface Sidecar { id: string; file: string; production?: string; retired?: unknown; hash?: string; generation?: { source?: string; chapterId?: string; productionId?: string; textHash?: string; costMicroUsd?: number } }

export async function computePlan(store: WorldStore, deps: PlanDeps): Promise<Planned> {
  const dir = store.dir, signal = deps.signal, now = deps.now();
  const items = new Map<string, PlannedItem>();
  const problems: CleanupProblem[] = [];
  const stopped = new Map<CleanupClass, string>();
  let next = 1;
  const add = (cls: CleanupClass, item: Omit<PlannedItem, "view" | "action">, view: Omit<CleanupItem, "id" | "class" | "ticked" | "bytes"> & { bytes?: number }, ticked = CLEANUP_TICKED.has(cls)) => {
    const id = `ci_${next++}`;
    items.set(id, { ...item, action: cleanupAction(cls), view: { id, class: cls, ticked, bytes: view.bytes ?? freed(item.files), ...view } });
  };

  // ---- What the world holds -------------------------------------------------------------
  const artifactFiles = await list(join(dir, "artifacts"), signal, "artifacts");
  const media = new Map(artifactFiles.filter(f => !f.path.endsWith(".json") && !/\.tmp-[0-9A-Z]+$/i.test(f.path)).map(f => [f.path.slice("artifacts/".length), f]));
  const sidecars: Sidecar[] = [];
  let unreadableSidecar: string | null = null;
  for (const f of artifactFiles.filter(f => f.path.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(await readFile(toExtendedLength(join(dir, f.path)), "utf8")) as Sidecar;
      if (typeof parsed.id === "string" && typeof parsed.file === "string") sidecars.push(parsed);
    } catch { unreadableSidecar ??= f.path; }
  }
  const sidecarByFile = new Map(sidecars.map(s => [s.file, s])), sidecarById = new Map(sidecars.map(s => [s.id, s]));
  const census = await takeCensus(dir, deps.appRoot, new Set([...media.keys(), ...(await topExports(dir))]), signal);
  const censusStop = census.unreadable ?? unreadableSidecar;

  // ---- Problems the records show (R-42) ----------------------------------------------------
  const noSidecar = [...media.entries()].filter(([file]) => !sidecarByFile.has(file));
  if (noSidecar.length) problems.push({ kind: "no-sidecar", label: "Artifacts · No record", count: noSidecar.length, bytes: noSidecar.reduce((s, [, f]) => s + f.info.size, 0) });
  const gone = sidecars.filter(s => !media.has(s.file));
  const goneLive = gone.filter(s => s.retired === undefined && s.generation?.source !== "audiobook");
  if (goneLive.length) problems.push({ kind: "missing-media", label: "Artifacts · File gone", count: goneLive.length, bytes: null });
  const retiredWithoutMedia = gone.filter(s => s.retired !== undefined).length;
  const strays = artifactFiles.filter(f => /\.tmp-[0-9A-Z]+$/i.test(f.path));
  if (strays.length) problems.push({ kind: "stray", label: "Stray file", count: strays.length, bytes: strays.reduce((s, f) => s + f.info.size, 0) });

  // ---- Bench sessions ----------------------------------------------------------------------
  const sessionsRoot = join(dir, ".sessions");
  const sessionIds: string[] = [];
  try { for await (const entry of await opendir(toExtendedLength(sessionsRoot))) if (entry.isDirectory() && /^sess_[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.name)) sessionIds.push(entry.name); } catch { /* No Bench yet. */ }
  const sessionMedia = await list(sessionsRoot, signal, ".sessions");
  const benchUnreadable: string[] = [];
  const lastCopies: PlannedFile[] = [], putBack: Planned["putBack"] = [];
  for (const sessionId of sessionIds) {
    signal.throwIfAborted();
    const store_ = new BenchStore(sessionDir(dir, sessionId as never));
    const session = await store_.fold().catch(() => null);
    const events = await store_.read().catch(() => null);
    if (!session || !events) { benchUnreadable.push(sessionId); continue; }
    const out = session.takes.some(t => t.status === "allocating" || t.status === "queued" || t.status === "running");
    const own = session.subject === undefined && !events.some(e => e.requestId?.startsWith("pic:"));
    const riding = new Set(session.tokenRegistry.filter(t => t.source.source === "take").map(t => (t.source as { takeId: string }).takeId));
    for (const take of session.takes) {
      const files = sessionMedia.filter(f => f.path.startsWith(`.sessions/${sessionId}/media/${take.id}/`));
      // A kept take whose artifact is gone: its session file is the last copy (R-42, R-44).
      if (take.keptArtifactId && !sidecarById.has(take.keptArtifactId)) { lastCopies.push(...files.map(f => planned(f.path, f.info))); if (files.length) putBack.push({ sessionId, takeId: take.id }); continue; }
      if (!own || out || take.status !== "succeeded" || take.disposition === "filed" || take.keptArtifactId) continue;
      if (!take.completedAt || now - Date.parse(take.completedAt) < 7 * DAY || riding.has(take.id)) continue;
      if (namedElsewhere(census.named.get(take.id), `sess:${sessionId}`) || !files.length) continue;
      add("unkept-bench-takes", { files: files.map(f => planned(f.path, f.info)), unit: `.sessions/${sessionId}/media/${take.id}`, bench: { sessionId, takeId: take.id } },
        { label: `Take ${take.n} · ${session.title?.trim() || "Bench"}`, paths: files.map(f => f.path) });
    }
  }
  if (lastCopies.length) problems.push({ kind: "last-copy", label: "Bench pictures · Last copy · artifact gone", count: new Set(lastCopies.map(f => f.path.split("/").slice(0, 4).join("/"))).size, bytes: lastCopies.reduce((s, f) => s + f.size, 0), putBack: true });
  if (benchUnreadable.length) stopped.set("unkept-bench-takes", "Stopped · Bench session unreadable");
  // A take nothing seemed to name is only known so when every holder was read (R-8; Codex on PR 3052).
  if (census.unreadable ?? unreadableSidecar) stopped.set("unkept-bench-takes", `Stopped · ${census.unreadable ?? unreadableSidecar} unreadable`);
  const lastCopyPaths = new Set(lastCopies.map(f => f.path));

  // ---- Phase 1: copies become links (R-32, R-33) ------------------------------------------
  const referenceTakes = (await list(join(dir, "references"), signal, "references")).filter(f => /^references\/[^/]+\/takes\//.test(f.path));
  const pool = [
    ...[...media.entries()].filter(([file]) => sidecarByFile.has(file)).map(([, f]) => ({ ...f, role: 0 })),
    ...referenceTakes.filter(f => !f.path.endsWith(".json")).map(f => ({ ...f, role: 1 })),
    ...sessionMedia.filter(f => /^\.sessions\/[^/]+\/media\//.test(f.path) && !lastCopyPaths.has(f.path)).map(f => ({ ...f, role: 2 })),
  ].filter(f => f.info.size >= 4096 && !/\.tmp-[0-9A-Z]+$/i.test(f.path));
  const bySize = new Map<number, typeof pool>();
  for (const f of pool) { const group = bySize.get(f.info.size) ?? []; group.push(f); bySize.set(f.info.size, group); }
  for (const group of bySize.values()) {
    if (group.length < 2 || !group.some(f => f.role < 2)) continue;
    const byHash = new Map<string, typeof pool>();
    for (const f of group) { const h = await quickHash(join(dir, f.path), f.info.size); if (h) { const g = byHash.get(h) ?? []; g.push(f); byHash.set(h, g); } }
    for (const copies of byHash.values()) {
      const keep = copies.filter(f => f.role < 2).sort((a, b) => a.role - b.role || a.info.mtimeMs - b.info.mtimeMs)[0];
      if (!keep) continue;
      for (const copy of copies) {
        // Artifacts are records of their own: two never become one here.
        if (copy === keep || copy.role === 0 || (copy.info.dev === keep.info.dev && copy.info.ino === keep.info.ino)) continue;
        const cls: CleanupClass = copy.role === 2 ? "bench-copies" : "reference-copies";
        add(cls, { files: [planned(copy.path, copy.info)], keep: planned(keep.path, keep.info) }, { label: copy.path.split("/").at(-1)!, paths: [copy.path] });
      }
    }
  }

  // ---- Narration: kept takes, mixes (R-34, R-40) ------------------------------------------
  const bundle = store.getBundle();
  const productions = new Set(sidecars.filter(s => s.generation?.source === "audiobook" && s.generation.productionId).map(s => s.generation!.productionId!));
  const mixFolders = await list(join(dir, ".cache", "audiobook-mix"), signal, ".cache/audiobook-mix");
  for (const f of mixFolders) { const prod = f.path.split("/")[2]; if (prod && prod !== "decode") productions.add(prod); }
  const plans = new Map<string, AudiobookPlan | null>();
  const currentText = new Map<string, Set<string>>(); // production/chapter → text hashes of current blocks
  let formerShapes = 0, formerChapters = new Set<string>(), emptyTakes = 0, lostCurrent = 0;
  const keptBack = new Set<string>(); // production/chapterFile whose renders may hold lost narration
  let narrationStop: string | null = null;
  for (const productionId of productions) {
    const production = bundle.productions.find(p => p.meta.id === productionId);
    for (const chapter of production?.chapters ?? []) {
      signal.throwIfAborted();
      let plan: AudiobookPlan | null = null;
      try { plan = await planAudiobook(store, productionId, chapter.id, { narrator: await anyNarrator(store, productionId, chapter.id) }); } catch { plan = null; }
      plans.set(`${productionId}/${chapter.file}`, plan);
      if (!plan || plan.record === "unreadable") { if (plan?.record === "unreadable") narrationStop ??= "Stopped · Chapter record unreadable"; continue; }
      currentText.set(`${productionId}/${chapter.id}`, new Set(plan.blocks.map(b => audiobookTextHash(b.block.text))));
      const record = plan.record;
      if (!record) continue;
      const current = new Set(plan.blocks.map(b => b.block.key));
      for (const [key, take] of Object.entries(record.takes)) {
        const sidecar = sidecarById.get(take.artifactId);
        const file = sidecar ? media.get(sidecar.file) : undefined;
        if (!file) {
          // A reaction (`x<n>`) is planned apart from the blocks, so its key is current too (Codex on PR 3052).
          if (current.has(key) || /^x\d+$/.test(key)) { lostCurrent++; keptBack.add(`${productionId}/${chapter.file}`); }
          else { formerShapes++; formerChapters.add(chapter.id); }
        } else if (file.info.size <= 44) {
          // Filed empty, its sidecar naming the empty header's own hash, it never held audio and holds nothing back.
          const bytes = await readFile(toExtendedLength(join(dir, file.path))).catch(() => null);
          const filedEmpty = !!bytes && !!sidecar?.hash && `sha256:${createHash("sha256").update(bytes).digest("hex")}`.startsWith(sidecar.hash);
          emptyTakes++;
          if (!filedEmpty && (current.has(key) || /^x\d+$/.test(key))) keptBack.add(`${productionId}/${chapter.file}`);
        }
      }
    }
  }
  if (lostCurrent) problems.push({ kind: "missing-media", label: "Narration · File gone", count: lostCurrent, bytes: null });
  if (formerShapes) problems.push({ kind: "former-shapes", label: `Narration before joins · No audio · ${formerChapters.size} chapter${formerChapters.size === 1 ? "" : "s"}`, count: formerShapes, bytes: null });
  if (emptyTakes) problems.push({ kind: "header-only", label: "Narration · Empty audio", count: emptyTakes, bytes: emptyTakes * 44 });

  // Chapter mixes: a render whose name matches no current mix of its chapter is old (R-34).
  const mixGroups = new Map<string, typeof mixFolders>();
  for (const f of mixFolders) {
    const parts = f.path.split("/");
    if (parts.length !== 5 || parts[2] === "decode") continue;
    const k = `${parts[2]}/${parts[3]}`, g = mixGroups.get(k) ?? []; g.push(f); mixGroups.set(k, g);
  }
  let keptBackBytes = 0, keptBackCount = 0;
  for (const [k, files] of mixGroups) {
    const [productionId, chapterFile] = k.split("/") as [string, string];
    const production = bundle.productions.find(p => p.meta.id === productionId);
    const chapter = production?.chapters.find(c => c.file === chapterFile);
    const renders = files.filter(f => MIX_NAME.test(f.path.split("/").at(-1)!) && now - f.info.mtimeMs > GRACE_MS);
    if (keptBack.has(k)) { keptBackCount += renders.length; keptBackBytes += renders.reduce((s, f) => s + f.info.size, 0); continue; }
    let keys: Set<string> | null = new Set();
    // The credits are a chapter of their own that no production lists: their renders are never called old.
    if (chapterFile === AUDIOBOOK_CREDITS_ID) keys = null;
    else if (production && chapter) {
      const plan = plans.get(k);
      try {
        if (!plan || plan.record === "unreadable") throw new Error("unreadable");
        keys.add(mixKey(chapterMix(chapterTiming(store, plan, "skip"))));
        const play = await deps.playNarrator?.(productionId, chapter.id);
        if (play) keys.add(mixKey(chapterMix(chapterTiming(store, await planAudiobook(store, productionId, chapter.id, { narrator: play }), "skip"))));
      } catch { keys = null; }
    }
    for (const f of renders) {
      const [, version, key] = MIX_NAME.exec(f.path.split("/").at(-1)!)!;
      // When a chapter's keys cannot be worked out, none of its renders counts as old.
      const old = !production || (!chapter && chapterFile !== AUDIOBOOK_CREDITS_ID) || (keys !== null && (Number(version) !== RENDER_VERSION || !keys.has(key!)));
      add(old ? "stale-mixes" : "current-mixes", { files: [planned(f.path, f.info)] },
        { label: `${chapter?.title?.trim() || chapterFile}${/-\d+-\d+\.wav$/.test(f.path) ? " · part" : ""}`, paths: [f.path] });
    }
  }
  if (keptBackCount) problems.push({ kind: "kept-back", label: "Chapter mixes · May hold lost narration", count: keptBackCount, bytes: keptBackBytes });
  // The Audio Studio's mixes and music renders: made again when played (R-34), offered and not ticked.
  for (const folder of [".cache/audio-studio", ".cache/music"]) {
    const files = (await list(join(dir, ...folder.split("/")), signal, folder)).filter(f => now - f.info.mtimeMs > GRACE_MS);
    const entries = new Map<string, typeof files>();
    for (const f of files) { const stem = f.path.replace(/\.[^./]+$/, ""), g = entries.get(stem) ?? []; g.push(f); entries.set(stem, g); }
    for (const [stem, group] of entries) {
      if (!group.some(f => /\.(wav|mp3|m4a|flac|ogg)$/i.test(f.path))) continue;
      add("current-mixes", { files: group.map(f => planned(f.path, f.info)) }, { label: `${folder.endsWith("music") ? "Music" : "Audio Studio"} · ${stem.split("/").at(-1)!.slice(0, 40)}`, paths: group.map(f => f.path) });
    }
  }

  // ---- Phase 2: old exports (R-36) ---------------------------------------------------------
  const exportsStop = censusStop ? `Stopped · ${censusStop} unreadable` : null;
  if (exportsStop) stopped.set("old-exports", exportsStop);
  else {
    const units = await exportUnits(dir, signal);
    const groups = new Map<string, ExportUnit[]>();
    for (const unit of units) { const g = groups.get(unit.group) ?? []; g.push(unit); groups.set(unit.group, g); }
    for (const group of groups.values()) {
      group.sort((a, b) => b.madeMs - a.madeMs);
      for (const older of group.slice(1)) {
        // A newer unit of its kind covers it when it holds every file the older one holds (R-36).
        const cover = group.find(newer => newer.madeMs > older.madeMs && older.names.every(name => newer.names.includes(name)));
        if (!cover || namedElsewhere(census.files.get(older.top)) || (keptBack.size > 0 && /^audiobook-|-video-/.test(older.top))) continue;
        add("old-exports", { files: older.files, ...(older.folder ? { unit: `exports/${older.top}` } : {}) }, { label: `${older.kind} · ${short(older.madeMs)}`, covers: `Newer: ${cover.kind} · ${short(cover.madeMs)}`, paths: older.files.map(f => f.path) });
      }
    }
  }

  // ---- Phase 3: unused artifacts and unkept narration, after the census (R-38 – R-40) -------
  if (censusStop) { stopped.set("unused-artifacts", `Stopped · ${censusStop} unreadable`); stopped.set("audiobook-takes", `Stopped · ${censusStop} unreadable`); }
  else {
    if (narrationStop) stopped.set("audiobook-takes", narrationStop);
    const titles = new Map(bundle.productions.map(p => [p.meta.id, p.meta.title?.trim() || p.meta.id]));
    for (const sidecar of sidecars) {
      const file = media.get(sidecar.file);
      if (!file || sidecar.retired !== undefined) continue;
      const tags = census.named.get(sidecar.id), names = census.files.get(sidecar.file);
      if (namedElsewhere(tags, `side:${sidecar.id}`) || namedElsewhere(names, `side:${sidecar.id}`)) continue;
      const audiobook = sidecar.generation?.source === "audiobook";
      if (audiobook) {
        if (narrationStop) continue;
        const g = sidecar.generation!;
        // The take a block's words would find again on the shelf, at no cost, stays (R-40).
        if (g.textHash && currentText.get(`${g.productionId}/${g.chapterId}`)?.has(g.textHash)) continue;
      }
      const sidecarPath = `artifacts/${sidecar.file}.json`;
      const text = await readFile(toExtendedLength(join(dir, sidecarPath)), "utf8").catch(() => null);
      if (text === null) continue;
      add(audiobook ? "audiobook-takes" : "unused-artifacts", { files: [planned(file.path, file.info)], sidecar: { path: sidecarPath, text } }, {
        // Filing writes a change-log line for every artifact: a name found only there is history, not a holder (R-39).
        label: sidecar.file, paths: [file.path, sidecarPath],
        group: sidecar.production ? titles.get(sidecar.production) ?? sidecar.production : "World",
        ...(audiobook && sidecar.generation?.costMicroUsd !== undefined ? { costMicroUsd: Math.round(sidecar.generation.costMicroUsd) } : {}),
      }, false);
    }
  }

  // ---- The plan ----------------------------------------------------------------------------
  const all = [...items.values()];
  const plan: CleanupPlan = {
    id: deps.newPlanId(), madeAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(),
    classes: CLEANUP_CLASSES.map(cls => {
      const mine = all.filter(i => i.view.class === cls), why = stopped.get(cls);
      return { class: cls, state: why ? "stopped" as const : "offered" as const, ...(why ? { stoppedBy: why } : {}),
        items: why ? 0 : mine.length, bytes: why ? 0 : mine.reduce((s, i) => s + i.view.bytes, 0), holdDays: CLEANUP_HOLD_DAYS[cls] };
    }),
    items: all.filter(i => !stopped.has(i.view.class)).map(i => i.view),
    problems, retiredWithoutMedia,
  };
  for (const [id, item] of items) if (stopped.has(item.view.class)) items.delete(id);
  return { plan, items, madeAtMs: now, putBack };
}

interface ExportUnit { top: string; folder: boolean; group: string; kind: string; madeMs: number; names: string[]; files: PlannedFile[] }

async function topExports(dir: string): Promise<string[]> {
  const names: string[] = [];
  try { for await (const entry of await opendir(toExtendedLength(join(dir, "exports")))) names.push(entry.name); } catch { /* none */ }
  return names;
}

const KINDS: Array<[RegExp, string]> = [
  [/^audiobook-/, "Audiobook"], [/-video-\d{8}/, "Chapter videos"], [/-master-\d{14}\.mp4$/, "Music video"],
  [/\.docx$/, "Manuscript"], [/\.epub$/, "EPUB"], [/-player-.*\.zip$/, "Player edition"], [/-guide-.*\.zip$/, "Guide"],
  [/-story-.*\.zip$/, "Story"], [/-comic-.*\.zip$/, "Comic"], [/\.(mp4|mov|webm)$/, "Video"],
];

/**
 * Every unit Made lists, read from `exports/` itself: a folder, or a file with its Player record.
 * Units of one kind share a name once dates and ids are taken out of it. Never offered: parts
 * (a newer whole edition gathers them), receipts, and what nothing newer covers.
 */
async function exportUnits(dir: string, signal: AbortSignal): Promise<ExportUnit[]> {
  const units: ExportUnit[] = [];
  for (const top of await topExports(dir)) {
    if (top.startsWith(".") || top.endsWith(".zip.json") || /-part-/.test(top) || /\.tmp-[0-9A-Z]+$/i.test(top)) continue;
    const abs = join(dir, "exports", top), info = await lstat(toExtendedLength(abs)).catch(() => null);
    if (!info || info.isSymbolicLink()) continue;
    let files: Array<{ path: string; info: Stats }>;
    if (info.isDirectory()) files = await list(abs, signal, `exports/${top}`);
    else {
      files = [{ path: `exports/${top}`, info }];
      const record = await lstat(toExtendedLength(`${abs}.json`)).catch(() => null);
      if (top.endsWith(".zip")) { if (!record) continue; files.push({ path: `exports/${top}.json`, info: record }); }
    }
    if (!files.length) continue;
    const group = top.replace(/(?:ab_|ex_)?[0-9A-HJKMNP-TV-Z]{26}/g, "#").replace(/\d{8,14}(?:-[a-z0-9]{6})?/g, "#").replace(/-v\d+/g, "");
    units.push({ top, folder: info.isDirectory(), group, kind: KINDS.find(([re]) => re.test(top))?.[1] ?? "Export", madeMs: Math.max(...files.map(f => f.info.mtimeMs)),
      names: files.map(f => f.path.slice(`exports/${top}`.length) || "."), files: files.map(f => planned(f.path, f.info)) });
  }
  return units;
}

/**
 * The census taken again after the confirm, before anything is held (R-21): a plan can be minutes
 * old, and a picture placed in a chapter since then is named only in that chapter's record. A hold
 * whose subject a record names now is dropped, and every hold is dropped when a record cannot be
 * read (Codex on PR 3052).
 */
export async function namedSince(dir: string, appRoot: string | null, items: readonly PlannedItem[], signal: AbortSignal): Promise<Set<PlannedItem>> {
  const holds = items.filter(item => item.action === "hold");
  if (!holds.length) return new Set();
  const subjects = holds.map(item => {
    if (item.sidecar) {
      const sidecar = (() => { try { return JSON.parse(item.sidecar!.text) as { id?: string; file?: string }; } catch { return {}; } })();
      return { item, ids: sidecar.id ? [sidecar.id] : [], files: sidecar.file ? [sidecar.file] : [], own: sidecar.id ? [`side:${sidecar.id}`] : [] };
    }
    if (item.bench) return { item, ids: [item.bench.takeId], files: [] as string[], own: [`sess:${item.bench.sessionId}`] };
    return { item, ids: [] as string[], files: [item.files[0]!.path.split("/")[1]!], own: [] as string[] };
  });
  const census = await takeCensus(dir, appRoot, new Set(subjects.flatMap(subject => subject.files)), signal);
  if (census.unreadable) return new Set(holds);
  return new Set(subjects.filter(subject => subject.ids.some(id => namedElsewhere(census.named.get(id), ...subject.own))
    || subject.files.some(file => namedElsewhere(census.files.get(file), ...subject.own))).map(subject => subject.item));
}
