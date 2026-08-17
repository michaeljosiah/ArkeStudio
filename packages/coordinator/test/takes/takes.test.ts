import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildExportPlan,
  buildFfmpegArgs,
  deriveCut,
  type ExportPlan,
  type Job,
} from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { readChanges } from "../../src/world/change-writer.js";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import { exportWorld, runExport, type FfmpegRunner } from "../../src/takes/export.js";
import { acceptTake, rejectTake } from "../../src/takes/review.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";
const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  return { dir, store };
}

function passJob(landed: string): Job {
  return {
    id: "jb_01J8E0000000000000000000P1",
    idempotencyKey: "01J8E1000000000000000000P1",
    worldId: WORLD,
    productionId: "saltlight",
    target: { kind: "scene-pass", id: "sc_04", coversShots: ["sh_12", "sh_13", "sh_14"] },
    capability: "video",
    provider: "fal",
    model: "seedance-2.0",
    params: {
      prompt: "the pass prompt",
      references: ["references/maren-kest/model-sheet-v4.png"],
      shotPlan: [
        { shotId: "sh_12", number: 12, startSec: 0, endSec: 6 },
        { shotId: "sh_13", number: 13, startSec: 6, endSec: 12 },
        { shotId: "sh_14", number: 14, startSec: 12, endSec: 19.5 },
      ],
      provenance: { canonRevision: 42, sheets: { "maren-kest": 4, "the-vigil": 2 } },
    },
    estimatedMicroUsd: 422507,
    status: "succeeded",
    providerJobId: "fal_p1",
    attempt: 1,
    landing: { dir: "productions/saltlight/incoming/sc_04-pass-1" },
    landedFiles: [landed],
    error: null,
    createdAt: "2026-08-01T11:00:00Z",
    updatedAt: "2026-08-01T11:05:00Z",
  };
}

async function landPass(dir: string): Promise<string> {
  const rel = "productions/saltlight/incoming/sc_04-pass-1/output-1.mp4";
  await mkdir(join(dir, "productions/saltlight/incoming/sc_04-pass-1"), { recursive: true });
  await writeFile(join(dir, rel), Buffer.from("fake-mp4-bytes-fake-mp4-bytes"));
  return rel;
}

describe("pass segmentation (R-3..R-5, D2..D4, §3.2)", () => {
  it("one media file, three range takes, boundaries from the plan, allocated costs sum exactly", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), 400000);
    assert.equal(takes.length, 4, "the pass plus three segments");
    const [pass, ...segments] = takes;

    // One media file is stored (R-3): only the pass's directory holds media.
    const takesRoot = join(dir, "productions", "saltlight", "takes");
    let mediaCount = 0;
    for (const id of takes.map((t) => t.id)) {
      const entries = await readdir(join(takesRoot, id));
      mediaCount += entries.filter((f) => f.endsWith(".mp4")).length;
    }
    assert.equal(mediaCount, 1);
    assert.equal(pass!.media, "output-1.mp4");
    const incoming = await readdir(join(dir, "productions/saltlight/incoming")).catch(() => []);
    assert.equal(incoming.length, 0, "the landing dir is consumed");

    // Boundaries match the shot plan exactly — never inspection (R-4, D3).
    assert.deepEqual(
      segments.map((s) => [s.coversShots[0], s.segment!.inSec, s.segment!.outSec]),
      [
        ["sh_12", 0, 6],
        ["sh_13", 6, 12],
        ["sh_14", 12, 19.5],
      ],
    );
    for (const s of segments) assert.equal(s.segment!.passTakeId, pass!.id);

    // The pass carries the real charge; segments carry allocated shares summing to it (R-5, D4).
    assert.equal(pass!.cost.actualMicroUsd, 400000);
    assert.notEqual(pass!.cost.allocated, true);
    const shares = segments.map((s) => s.cost.actualMicroUsd!);
    assert.equal(shares.reduce((a, b) => a + b, 0), 400000, "shares sum exactly — the remainder lands on the last");
    for (const s of segments) assert.equal(s.cost.allocated, true, "divided, and marked so");
    await store.close();
  });
});

describe("immutability and review (R-1, R-2, R-6..R-11, D1, D5, D6, §3.2)", () => {
  it("a rejected take is byte-identical; two decisions coexist and the later governs", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), 400000);
    const segment = takes[1]!;
    const takePath = join(dir, "productions", "saltlight", "takes", segment.id, "take.json");
    const before = await readFile(takePath);

    let production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await rejectTake(store, production, {
      takeId: segment.id,
      shotId: "sh_12",
      by: "user",
      citation: { sheet: "maren-kest", field: "appearance", note: "coat drifted" },
    });
    assert.deepEqual(await readFile(takePath), before, "the take record is unchanged (R-1)");

    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: segment.id, shotId: "sh_12", by: "user" });
    const reviews = (await readFile(join(dir, "productions/saltlight/reviews.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { takeId: string; decision: string });
    const mine = reviews.filter((r) => r.takeId === segment.id);
    assert.equal(mine.length, 2, "append-only: the earlier decision is not erased (R-6)");
    assert.equal(mine[mine.length - 1]!.decision, "accept", "the later governs");
    await store.close();
  });

  it("a trim belongs to the footage it was measured against, so a new take resets it (#253)", async () => {
    // Codex round 1 P1. The reset was written *before* the spread of the existing selection, so a
    // nonzero trim from the old media survived onto the newly selected take — the cut would start
    // at an unrelated moment while the coordinator's own event reported a zero trim.
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), null);
    let production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;

    await acceptTake(store, production, { takeId: takes[0]!.id, shotId: "sh_12", by: "user" });
    // The user trims into the footage they selected.
    const withTrim = JSON.parse(
      await readFile(join(dir, "productions/saltlight/selections.json"), "utf8"),
    ) as Record<string, { acceptedTakeId?: string; trimInSec?: number }>;
    withTrim["sh_12"] = { ...withTrim["sh_12"], trimInSec: 4.25 };
    await writeFile(
      join(dir, "productions/saltlight/selections.json"),
      JSON.stringify(withTrim, null, 2),
      "utf8",
    );
    await store.reload();

    // Re-accepting the same take changes nothing about the footage, so the in-point stands.
    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: takes[0]!.id, shotId: "sh_12", by: "user" });
    assert.equal(
      store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.selections["sh_12"]?.trimInSec,
      4.25,
      "same take, same footage, same in-point",
    );

    // A different take is different footage: 4.25s into one clip is not 4.25s into another.
    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: takes[1]!.id, shotId: "sh_12", by: "user" });
    const after = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.selections["sh_12"];
    assert.equal(after?.acceptedTakeId, takes[1]!.id);
    assert.equal(after?.trimInSec, 0, "the in-point is reset, not carried onto unrelated footage");
    await store.close();
  });

  it("rejecting requires a cited sheet and field, and touches no selection (R-10)", async () => {
    const { dir, store } = await open();
    const production = store.getBundle().productions[0]!;
    await assert.rejects(
      () =>
        rejectTake(store, production, {
          takeId: "tk_01J8A0000000000000000000A1",
          by: "user",
          citation: { sheet: "maren-kest", field: "" },
        }),
      /requires a cited sheet and field/,
    );
    const selectionsBefore = await readFile(join(dir, "productions/saltlight/selections.json"), "utf8");
    await rejectTake(store, production, {
      takeId: "tk_01J8A0000000000000000000A1",
      shotId: "sh_12",
      by: "user",
      citation: { sheet: "maren-kest", field: "appearance" },
    });
    const selectionsAfter = await readFile(join(dir, "productions/saltlight/selections.json"), "utf8");
    assert.equal(selectionsAfter, selectionsBefore, "any existing selection stays untouched");
    await store.close();
  });

  it("accepting creates no proposal, bumps no scene version, and is ONE commit (R-8, R-9, D6, D7)", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), null);
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const proposalsBefore = store.getBundle().proposals.length;
    const sceneVersionBefore = production.scenes.find((s) => s.id === "sc_04")!.version;

    await acceptTake(store, production, { takeId: takes[1]!.id, shotId: "sh_12", by: "user" });

    const after = store.getBundle();
    assert.equal(after.proposals.length, proposalsBefore, "no proposal (R-8)");
    assert.equal(
      after.productions.find((p) => p.meta.id === "saltlight")!.scenes.find((s) => s.id === "sc_04")!.version,
      sceneVersionBefore,
      "no scene version bump — selections are operational, scenes are gated",
    );
    // One commit (R-9, D6): the last change records for reviews + selections share a commitId.
    const changes = await readChanges(join(dir, "changes.jsonl"));
    const tail = changes.slice(-2) as Array<{ commitId: string; entity: string }>;
    assert.equal(tail[0]!.commitId, tail[1]!.commitId, "decision and selection landed atomically");
    assert.ok(tail.some((c) => c.entity.includes("reviews")));
    assert.ok(tail.some((c) => c.entity.includes("selections")));
    await store.close();
  });

  it("continuity chains from the PASS for a segment (R-12, D8)", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), null);
    const [pass, seg12] = takes;
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: seg12!.id, shotId: "sh_12", by: "user" });
    const selections = JSON.parse(await readFile(join(dir, "productions/saltlight/selections.json"), "utf8")) as Record<
      string,
      { startFrameTakeId?: string }
    >;
    assert.equal(
      selections["sh_13"]?.startFrameTakeId,
      pass!.id,
      "the following shot's start frame comes from the pass, not the segment — no duplicated frame",
    );
    await store.close();
  });
});

describe("the derived cut (R-14..R-16, D9, §3.2)", () => {
  it("changes with a selection immediately; gaps carry labels and durations", async () => {
    const { store } = await open();
    let production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const before = deriveCut(production);
    assert.ok(before.entries.length > 0);
    const covered = before.entries.find((e) => e.shot.id === "sh_12");
    assert.ok(covered?.takeId, "the fixture selection covers sh_12");
    const gap = before.entries.find((e) => e.takeId === null);
    assert.ok(gap, "gaps exist and are entries, not omissions");
    assert.match(gap!.label, /SHOT \d+/);
    assert.ok(gap!.durationSec > 0);

    // Accept a different take for sh_12: the cut reflects it with no reconciliation step.
    await acceptTake(store, production, { takeId: "tk_01J8A0000000000000000000A1", shotId: "sh_12", by: "user" });
    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const after = deriveCut(production);
    assert.equal(after.entries.find((e) => e.shot.id === "sh_12")!.takeId, "tk_01J8A0000000000000000000A1");
    await store.close();
  });

  it("a segment resolves to the pass media with its range", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), null);
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: takes[2]!.id, shotId: "sh_13", by: "user" });
    const cut = deriveCut(store.getBundle().productions.find((p) => p.meta.id === "saltlight")!);
    const entry = cut.entries.find((e) => e.shot.id === "sh_13")!;
    assert.ok(entry.media!.path.includes(takes[0]!.id), "the pass's media, not a segment file");
    assert.equal(entry.media!.inSec, 6);
    assert.equal(entry.media!.outSec, 12);
    await store.close();
  });
});

describe("exports (R-19..R-22, D10..D12, §3.2)", () => {
  it("gaps become labelled slates and the whole plan is one encode", async () => {
    const { store } = await open();
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const plan = buildExportPlan(deriveCut(production), "review-cut");
    const slates = plan.items.filter((i) => i.type === "slate");
    assert.ok(slates.length > 0);
    assert.match((slates[0] as { label: string }).label, /SHOT \d+ .*s/);

    const args = buildFfmpegArgs(plan, "/world", "/world/out.mp4");
    assert.equal(args.filter((a) => a === "-filter_complex").length, 1, "exactly one encode (D11)");
    assert.ok(args.join(" ").includes(`concat=n=${plan.items.length}`));
    assert.ok(args.some((a) => a.includes("drawtext")), "slates carry their labels");
    await store.close();
  });

  it("a finished export appears whole; a cancelled one leaves no partial file (R-21)", async () => {
    const worldDir = await tempDir("arke-export-");
    const plan: ExportPlan = { preset: "review-cut", items: [{ type: "slate", label: "SHOT 1 · 4.0s", durationSec: 4 }], totalSec: 4 };
    const okRunner: FfmpegRunner = {
      run: async (args) => {
        await writeFile(args[args.length - 1]!, "rendered");
      },
    };
    const done = runExport(worldDir, (stage) => buildFfmpegArgs(plan, worldDir, stage), "review.mp4", okRunner, () => {});
    const result = await done.done;
    assert.equal(result.status, "done");
    assert.ok(await stat(join(worldDir, "exports", "review.mp4")));

    let release: () => void = () => {};
    const slowRunner: FfmpegRunner = {
      run: (args, _p, signal) =>
        new Promise((resolvePromise, reject) => {
          void writeFile(args[args.length - 1]!, "partial");
          release = () => reject(new Error("killed"));
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const cancelled = runExport(worldDir, (stage) => buildFfmpegArgs(plan, worldDir, stage), "cancelled.mp4", slowRunner, () => {});
    cancelled.cancel();
    const cancelledResult = await cancelled.done;
    release();
    assert.equal(cancelledResult.status, "cancelled");
    await assert.rejects(() => stat(join(worldDir, "exports", "cancelled.mp4")), "no partial file is visible");
    const stage = await readdir(join(worldDir, ".cache", "exports")).catch(() => [] as string[]);
    assert.ok(!stage.includes("cancelled.mp4"), "the stage is cleaned");
  });

  it("a world export reopens identically elsewhere — history kept, caches dropped (R-22, D12)", async () => {
    const { dir, store } = await open();
    // A versioned commit first, so `.history/` exists to travel.
    const { ProposalManager } = await import("../../src/gate/proposals.js");
    const { stageSheetRename } = await import("../../src/sheets/authoring.js");
    const gate = new ProposalManager(store);
    const staged = await stageSheetRename(store, gate, { path: "characters/maren-kest.md", name: "Maren Kest of the Vigil" });
    await gate.accept(staged.id);
    const sourceBundle = store.getBundle();
    await store.close(); // release the lock so the copy carries no live lock semantics

    const target = join(await tempDir("arke-worldexp-"), "the-undersong");
    await exportWorld(dir, target);

    const entries = await readdir(target);
    assert.ok(entries.includes(".history"), "the version record travels (D12)");
    assert.ok(!entries.includes(".index"), "derived state stays behind");
    assert.ok(!entries.includes(".proposals"));
    assert.ok(!entries.includes("world.lock"));

    const reopened = await WorldStore.open(target, { clock: CLOCK });
    const bundle = reopened.getBundle();
    assert.equal(bundle.meta.worldId, sourceBundle.meta.worldId);
    assert.equal(bundle.sheets.length, sourceBundle.sheets.length);
    assert.equal(bundle.canon.length, sourceBundle.canon.length);
    assert.equal(bundle.productions.length, sourceBundle.productions.length);
    assert.deepEqual(
      bundle.productions[0]!.takes.map((t) => t.id).sort(),
      sourceBundle.productions[0]!.takes.map((t) => t.id).sort(),
    );
    await reopened.close();
  });
});

// ---------------------------------------------------------------------------
// Arrival-time motion QC (#248): measured before the take exists, and never able
// to cost one. Every case injects a fake analyzer — ffmpeg is not on CI.
// ---------------------------------------------------------------------------

describe("take QC at arrival (#248)", () => {
  const QC = {
    method: "adjacent-framemd5-v1",
    scope: "source-media",
    status: "degraded",
    nominalFps: 24,
    effectiveFps: 14,
    duplicateFrames: 10,
    duplicateRatio: 0.416667,
    sampledFrames: 25,
    thresholdRatio: 0.8,
  } as const;

  const shotJob = (landed: string): Job => ({
    ...passJob(landed),
    target: { kind: "shot", id: "sh_12", coversShots: ["sh_12"] },
    params: { ...passJob(landed).params, shotPlan: undefined },
  });

  it("records source-media QC once on a per-shot take", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const calls: string[] = [];
    const takes = await recordTakesFromJob(store, shotJob(landed), 400000, {
      analyzer: {
        analyze: async (file) => {
          calls.push(file);
          return { ok: true, qc: QC };
        },
      },
    });
    assert.equal(calls.length, 1, "analyzed once, against the landed file");
    assert.match(calls[0]!, /output-1\.mp4$/);
    assert.deepEqual(takes[0]!.qc, QC);

    // Persisted, not merely returned: the record on disk is what review will read.
    const onDisk = JSON.parse(
      await readFile(join(dir, "productions", "saltlight", "takes", takes[0]!.id, "take.json"), "utf8"),
    );
    assert.deepEqual(onDisk.qc, QC);
    await store.close();
  });

  it("copies one pass analysis to the pass and every virtual segment", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    let analyses = 0;
    const takes = await recordTakesFromJob(store, passJob(landed), 400000, {
      analyzer: {
        analyze: async () => {
          analyses += 1;
          return { ok: true, qc: QC };
        },
      },
    });
    assert.equal(analyses, 1, "the backing media is measured once, not once per segment");
    assert.equal(takes.length, 4);
    for (const take of takes) {
      assert.deepEqual(take.qc, QC, "the same source-media record travels to every segment");
    }
    await store.close();
  });

  it("QC timeout and analyzer exceptions never fail take finalization", async () => {
    const { dir, store } = await open();

    for (const [label, analyzer, expected] of [
      ["timeout", { analyze: async () => ({ ok: false as const, reason: "timeout" as const }) }, "timeout"],
      ["throws", { analyze: () => Promise.reject(new Error("spawn failed")) }, "process-failed"],
    ] as const) {
      const landed = await landPass(dir);
      const reasons: string[] = [];
      const takes = await recordTakesFromJob(store, shotJob(landed), 400000, {
        analyzer,
        onQcUnavailable: (reason) => reasons.push(reason),
      });
      assert.equal(takes.length, 1, `${label}: the paid take is still written`);
      assert.equal(takes[0]!.qc, undefined, `${label}: absent means not measured, never "measured clean"`);
      assert.deepEqual(reasons, [expected], `${label}: the reason is reported, not swallowed`);
    }

    // Even the reporting is allowed to fail: a diagnostic must not cost a generation.
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, shotJob(landed), 400000, {
      analyzer: { analyze: async () => ({ ok: false as const, reason: "malformed-output" as const }) },
      onQcUnavailable: () => {
        throw new Error("the log is on fire");
      },
    });
    assert.equal(takes.length, 1, "a throwing callback still leaves the take recorded");
    assert.equal(takes[0]!.qc, undefined);

    // No analyzer at all is the ordinary state, reported as such.
    const noneLanded = await landPass(dir);
    const noneReasons: string[] = [];
    const none = await recordTakesFromJob(store, shotJob(noneLanded), 400000, {
      onQcUnavailable: (reason) => noneReasons.push(reason),
    });
    assert.equal(none[0]!.qc, undefined);
    assert.deepEqual(noneReasons, ["not-configured"]);
    await store.close();
  });

  it("non-video takes never invoke QC", async () => {
    const { dir, store } = await open();
    let analyses = 0;
    const analyzer = {
      analyze: async () => {
        analyses += 1;
        return { ok: true as const, qc: QC };
      },
    };
    const reasons: string[] = [];

    const stills = await landPass(dir);
    const image = await recordTakesFromJob(
      store,
      { ...shotJob(stills), capability: "image" },
      400000,
      { analyzer, onQcUnavailable: (reason) => reasons.push(reason) },
    );
    assert.equal(image[0]!.qc, undefined);

    const voiceLanded = await landPass(dir);
    const voice = await recordTakesFromJob(
      store,
      { ...shotJob(voiceLanded), capability: "voice-tts", target: { kind: "voice-line", id: "vl_1", coversShots: [] } },
      400000,
      { analyzer, onQcUnavailable: (reason) => reasons.push(reason) },
    );
    assert.equal(voice[0]!.qc, undefined);

    assert.equal(analyses, 0, "a still and a voice line have no motion to measure");
    assert.deepEqual(reasons, [], "and nothing to explain, so nothing is logged");
    await store.close();
  });

  /**
   * A read that records neither its words nor its voice (found driving the installed app,
   * 2026-08-17). `prompt` was only ever read from `params.prompt`, and a synthesis job calls
   * its words `text` — so a landed line said nothing about itself, and the voice could only be
   * recovered from the sheet, which recasting would silently rewrite under every old take.
   */
  it("a spoken take records the line it read and the voice that read it", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(
      store,
      {
        ...shotJob(landed),
        capability: "voice-tts",
        target: { kind: "voice-line", id: "sh_12", coversShots: ["sh_12"] },
        params: { text: "the verse, under the water", voiceId: "af_bella" },
      },
      0,
    );
    assert.equal(takes[0]!.prompt, "the verse, under the water");
    assert.deepEqual(takes[0]!.params, { voiceId: "af_bella" });
    // On disk, not merely returned — the take is what a later reader has.
    const written = JSON.parse(
      await readFile(join(dir, "productions", "saltlight", "takes", takes[0]!.id, "take.json"), "utf8"),
    );
    assert.equal(written.prompt, "the verse, under the water");
    await store.close();
  });
});
