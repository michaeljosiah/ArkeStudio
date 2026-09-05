import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactSidecarSchema, SelectionsSchema, type ProductionBundle, type Take } from "@arke-studio/contracts";
import {
  BOUNDARY_METHOD,
  boundaryFrameArgs,
  chainBoundaryFrame,
  clearShotFrame,
  createBoundaryFrameMaker,
  type BoundaryFrameMaker,
} from "../../src/takes/boundary.js";
import { fileDrawnFrame } from "../../src/takes/drawn-frame.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Boundary frames (issue 154): the durable still an accepted clip seeds the next shot with.
 * Extraction is bounded and total; filing is an image artifact with provenance plus the
 * selection update, in one commit; every failure is a named reason and no lost accept.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

const take = (id: string, over: Partial<Take> = {}): Take => ({
  id,
  coversShots: ["sh_1"],
  kind: "clip",
  provider: "fal",
  model: "seedance-2.0",
  provenance: { canonRevision: 1, sheets: {} },
  references: [],
  params: {},
  cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
  dispatchedAt: CLOCK(),
  media: "clip.mp4",
  ...over,
});

async function open(): Promise<{ dir: string; store: WorldStore; production: ProductionBundle }> {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  const production = store.getBundle().productions[0]!;
  return { dir, store, production };
}

async function landClip(dir: string, productionId: string, takeId: string): Promise<void> {
  const takeDir = join(dir, "productions", productionId, "takes", takeId);
  await mkdir(takeDir, { recursive: true });
  await writeFile(join(takeDir, "clip.mp4"), Buffer.from("fake-mp4-bytes"));
}

async function expectBoundaryFrom(
  store: WorldStore,
  dir: string,
  productionId: string,
  sourceShotId: string,
  followingShotId: string,
  acceptedTakeId: string,
  mediaTakeId = acceptedTakeId,
): Promise<void> {
  await store.ownedWrite(async () => {
    const path = join(dir, "productions", productionId, "selections.json");
    const selections = JSON.parse(await readFile(path, "utf8")) as Record<string, Record<string, unknown>>;
    selections[sourceShotId] = { ...selections[sourceShotId], acceptedTakeId };
    selections[followingShotId] = { ...selections[followingShotId], startFrameTakeId: mediaTakeId };
    await writeFile(path, JSON.stringify(selections, null, 2), "utf8");
  });
}

/** A maker that "extracts" by writing a real PNG, and records what it was asked. */
function fakeMaker(calls: Array<{ input: string; atSec: number | null }>): BoundaryFrameMaker {
  return {
    write: async (input, output, atSec) => {
      calls.push({ input, atSec });
      await writeFile(output, encodePng(solidImage(4, 4, [255, 0, 0, 255])));
      return { ok: true };
    },
  };
}

describe("boundary-frame extraction (issue 154)", () => {
  it("asks for the last frame of a clip and the exact out-point of a segment, never downscaled", () => {
    const end = boundaryFrameArgs("in.mp4", "out.png", null);
    assert.ok(end.includes("-sseof") && end.includes("-0.5"), "end-of-clip seeks from the end");
    assert.ok(end.includes("-update"), "every decoded frame overwrites, so the last one stands");
    assert.ok(!end.includes("-frames:v"), "capping at one frame would keep the first, not the last");
    const at = boundaryFrameArgs("in.mp4", "out.png", 6);
    assert.ok(at.includes("-ss") && at.includes("5.950"), "a segment seeks just short of its out-point");
    assert.ok(at.includes("-frames:v"), "one frame at the cut is the picture the next shot opens on");
    for (const args of [end, at]) assert.ok(!args.some((a) => a.includes("scale")), "full resolution, not a poster");
  });

  it("maps the runner's three failure shapes to named reasons", async () => {
    const outcomes: Array<[{ code: number; stdout: string; stderr: string; timedOut: boolean } | "throw", string]> = [
      [{ code: 1, stdout: "", stderr: "boom", timedOut: false }, "process-failed"],
      [{ code: 0, stdout: "", stderr: "", timedOut: true }, "timeout"],
      ["throw", "process-failed"],
    ];
    for (const [result, expected] of outcomes) {
      const maker = createBoundaryFrameMaker({
        run: async () => {
          if (result === "throw") throw new Error("spawn failed");
          return result;
        },
      });
      const outcome = await maker.write("in.mp4", "out.png", null);
      assert.ok(!outcome.ok && outcome.reason === expected);
    }
  });

  it("files the still as an image artifact with extraction provenance and points the selection at it", async () => {
    const { dir, store, production } = await open();
    const accepted = take("tk_01J8E0000000000000000000B1");
    await landClip(dir, production.meta.id, accepted.id);
    await expectBoundaryFrom(store, dir, production.meta.id, "sh_1", "sh_2", accepted.id);
    const calls: Array<{ input: string; atSec: number | null }> = [];
    const result = await chainBoundaryFrame(
      store,
      { ...production, takes: [accepted] },
      { take: accepted, sourceShotId: "sh_1", followingShotId: "sh_2", maker: fakeMaker(calls), clock: CLOCK },
    );
    assert.ok(result.ok, `expected success, got ${result.ok ? "" : result.reason}`);
    // A chain that was skipped for a protected frame carries no artifact to assert on.
    assert.ok(!("skipped" in result), "expected a chained frame, not a skip");
    const chained = result as { ok: true; artifactId: string; followingShotId: string };
    assert.equal(calls[0]!.atSec, null, "a plain clip is cut at its own end");

    const sidecarFiles = await import("node:fs/promises").then((fs) => fs.readdir(join(dir, "artifacts")));
    const sidecarName = sidecarFiles.find((f) => f.startsWith("boundary-sh_2-") && f.endsWith(".json"))!;
    const sidecar = ArtifactSidecarSchema.parse(
      JSON.parse(await readFile(join(dir, "artifacts", sidecarName), "utf8")),
    );
    assert.equal(sidecar.kind, "image");
    assert.equal(sidecar.id, chained.artifactId);
    assert.match(sidecar.hash, /^sha256:[0-9a-f]{16}$/);
    assert.deepEqual(sidecar.boundaryExtraction, {
      sourceTakeId: accepted.id,
      mediaTakeId: accepted.id,
      atSec: null,
      method: BOUNDARY_METHOD,
    });
    const bytes = await readFile(join(dir, "artifacts", sidecar.file));
    assert.ok(bytes.byteLength > 0, "the artifact's bytes exist beside the sidecar");

    const selections = SelectionsSchema.parse(
      JSON.parse(await readFile(join(dir, "productions", production.meta.id, "selections.json"), "utf8")),
    );
    assert.equal(selections["sh_2"]!.startFrameArtifactId, chained.artifactId);
  });

  it("a pass segment cuts from the pass media at the segment's out-point", async () => {
    const { dir, store, production } = await open();
    const pass = take("tk_01J8E0000000000000000000P1", { coversShots: ["sh_1", "sh_2"] });
    const segment = take("tk_01J8E0000000000000000000S1", {
      segment: { passTakeId: pass.id, inSec: 0, outSec: 6 },
    });
    delete (segment as { media?: string }).media; // a segment take has no media of its own
    await landClip(dir, production.meta.id, pass.id);
    await expectBoundaryFrom(store, dir, production.meta.id, "sh_1", "sh_2", segment.id, pass.id);
    const calls: Array<{ input: string; atSec: number | null }> = [];
    const result = await chainBoundaryFrame(
      store,
      { ...production, takes: [pass, segment] },
      { take: segment, sourceShotId: "sh_1", followingShotId: "sh_2", maker: fakeMaker(calls), clock: CLOCK },
    );
    assert.ok(result.ok);
    assert.equal(calls[0]!.atSec, 6, "the cut is the segment boundary, not the pass's end");
    assert.ok(calls[0]!.input.includes(pass.id), "the decoded file is the pass clip");
    const sidecarFiles = await import("node:fs/promises").then((fs) => fs.readdir(join(dir, "artifacts")));
    const sidecarName = sidecarFiles.find((f) => f.startsWith("boundary-sh_2-") && f.endsWith(".json"))!;
    const sidecar = ArtifactSidecarSchema.parse(
      JSON.parse(await readFile(join(dir, "artifacts", sidecarName), "utf8")),
    );
    assert.equal(sidecar.boundaryExtraction!.sourceTakeId, segment.id);
    assert.equal(sidecar.boundaryExtraction!.mediaTakeId, pass.id);
  });

  it("does not install a boundary frame after a newer accept replaces its source", async () => {
    const { dir, store, production } = await open();
    const older = take("tk_01J8E0000000000000000000B4");
    const newer = take("tk_01J8E0000000000000000000B5");
    await landClip(dir, production.meta.id, older.id);
    await expectBoundaryFrom(store, dir, production.meta.id, "sh_1", "sh_2", older.id);
    const maker: BoundaryFrameMaker = {
      write: async (_input, output) => {
        await writeFile(output, encodePng(solidImage(4, 4, [255, 0, 0, 255])));
        await expectBoundaryFrom(store, dir, production.meta.id, "sh_1", "sh_2", newer.id);
        return { ok: true };
      },
    };
    const result = await chainBoundaryFrame(
      store,
      { ...production, takes: [older, newer] },
      { take: older, sourceShotId: "sh_1", followingShotId: "sh_2", maker, clock: CLOCK },
    );
    assert.ok(!result.ok && /newer accepted take/.test(result.reason));
    const selections = SelectionsSchema.parse(
      JSON.parse(await readFile(join(dir, "productions", production.meta.id, "selections.json"), "utf8")),
    );
    assert.equal(selections["sh_2"]?.startFrameTakeId, newer.id);
    assert.equal(selections["sh_2"]?.startFrameArtifactId, undefined);
    const artifacts = await import("node:fs/promises").then((fs) => fs.readdir(join(dir, "artifacts")));
    assert.equal(artifacts.some((file) => file.startsWith("boundary-sh_2-")), false);
  });

  it("every refusal is a named reason, spends nothing, and leaves the selection alone", async () => {
    const { dir, store, production } = await open();
    const accepted = take("tk_01J8E0000000000000000000B2");
    await landClip(dir, production.meta.id, accepted.id);
    const bundle = { ...production, takes: [accepted] };
    const selectionsPath = join(dir, "productions", production.meta.id, "selections.json");
    const before = await readFile(selectionsPath, "utf8").catch(() => null);

    const unconfigured = await chainBoundaryFrame(store, bundle, {
      take: accepted,
      sourceShotId: "sh_1",
      followingShotId: "sh_2",
      maker: undefined,
      clock: CLOCK,
    });
    assert.ok(!unconfigured.ok && unconfigured.reason === "not-configured");

    const failing: BoundaryFrameMaker = { write: async () => ({ ok: false, reason: "timeout" }) };
    const failed = await chainBoundaryFrame(store, bundle, {
      take: accepted,
      sourceShotId: "sh_1",
      followingShotId: "sh_2",
      maker: failing,
      clock: CLOCK,
    });
    assert.ok(!failed.ok && failed.reason.includes(accepted.id), "the failure names its source take");

    const still = take("tk_01J8E0000000000000000000B3", { media: "frame.png" });
    const notFootage = await chainBoundaryFrame(store, { ...production, takes: [still] }, {
      take: still,
      sourceShotId: "sh_1",
      followingShotId: "sh_2",
      maker: failing,
      clock: CLOCK,
    });
    assert.ok(!notFootage.ok && notFootage.reason.includes("not footage"));

    const after = await readFile(selectionsPath, "utf8").catch(() => null);
    assert.equal(after, before, "no refusal wrote a selection");
  });

  it("declines before decoding anything when the following shot owns its frame", async () => {
    const { dir, store, production } = await open();
    const accepted = take("tk_01J8E0000000000000000000B6", { coversShots: ["sh_04"] });
    await landClip(dir, production.meta.id, accepted.id);
    await expectBoundaryFrom(store, dir, production.meta.id, "sh_04", "sh_05", accepted.id);

    // The following shot is given its own picture — a drawn frame, no extraction provenance.
    const drawn = take("tk_01J8E0000000000000000000B7", {
      kind: "frame",
      media: "frame.png",
      coversShots: ["sh_05"],
    });
    const takeDir = join(dir, "productions", production.meta.id, "takes", drawn.id);
    await mkdir(takeDir, { recursive: true });
    await writeFile(join(takeDir, "frame.png"), encodePng(solidImage(4, 4, [0, 255, 0, 255])));
    const filed = await fileDrawnFrame(store, production, {
      take: drawn,
      shotId: "sh_05",
      producedBy: "test:drawn",
    });
    assert.ok(filed.ok && !("superseded" in filed), JSON.stringify(filed));

    const calls: Array<{ input: string; atSec: number | null }> = [];
    const result = await chainBoundaryFrame(
      store,
      { ...production, takes: [accepted, drawn] },
      { take: accepted, sourceShotId: "sh_04", followingShotId: "sh_05", maker: fakeMaker(calls), clock: CLOCK },
    );
    assert.ok(result.ok && "skipped" in result && result.skipped === "following-shot-has-own-frame");
    // The point of the early check: the common "drew the frames first" path pays for no ffmpeg run.
    assert.equal(calls.length, 0, "nothing was extracted");
  });

  it("a build with no maker still yields the no-op answer for a protected frame", async () => {
    // Ownership is checked before requiring ffmpeg: with the frame already owned there is no
    // extraction to be unconfigured about, and `not-configured` here would log an unavailable
    // for an operation that needed nothing.
    const { dir, store, production } = await open();
    const accepted = take("tk_01J8E0000000000000000000C1", { coversShots: ["sh_04"] });
    await landClip(dir, production.meta.id, accepted.id);
    await expectBoundaryFrom(store, dir, production.meta.id, "sh_04", "sh_05", accepted.id);
    const drawn = take("tk_01J8E0000000000000000000C2", {
      kind: "frame",
      media: "frame.png",
      coversShots: ["sh_05"],
    });
    const takeDir = join(dir, "productions", production.meta.id, "takes", drawn.id);
    await mkdir(takeDir, { recursive: true });
    await writeFile(join(takeDir, "frame.png"), encodePng(solidImage(4, 4, [0, 255, 0, 255])));
    const filed = await fileDrawnFrame(store, production, {
      take: drawn,
      shotId: "sh_05",
      producedBy: "test:drawn",
    });
    assert.ok(filed.ok, JSON.stringify(filed));

    const result = await chainBoundaryFrame(
      store,
      { ...production, takes: [accepted, drawn] },
      { take: accepted, sourceShotId: "sh_04", followingShotId: "sh_05", maker: undefined, clock: CLOCK },
    );
    assert.ok(result.ok && "skipped" in result && result.skipped === "following-shot-has-own-frame");
  });

  it("declines inside the gate when a drawn frame lands while extraction is in flight", async () => {
    const { dir, store, production } = await open();
    const accepted = take("tk_01J8E0000000000000000000B8", { coversShots: ["sh_04"] });
    await landClip(dir, production.meta.id, accepted.id);
    await expectBoundaryFrom(store, dir, production.meta.id, "sh_04", "sh_05", accepted.id);

    const drawn = take("tk_01J8E0000000000000000000B9", {
      kind: "frame",
      media: "frame.png",
      coversShots: ["sh_05"],
    });
    const takeDir = join(dir, "productions", production.meta.id, "takes", drawn.id);
    await mkdir(takeDir, { recursive: true });
    await writeFile(join(takeDir, "frame.png"), encodePng(solidImage(4, 4, [0, 255, 0, 255])));

    // The race: the frame is filed after the early check passes, during the extraction itself.
    const calls: Array<{ input: string; atSec: number | null }> = [];
    const maker: BoundaryFrameMaker = {
      write: async (input, output, atSec) => {
        calls.push({ input, atSec });
        await writeFile(output, encodePng(solidImage(4, 4, [255, 0, 0, 255])));
        const filed = await fileDrawnFrame(store, production, {
          take: drawn,
          shotId: "sh_05",
          producedBy: "test:drawn-mid-flight",
        });
        assert.ok(filed.ok && !("superseded" in filed), JSON.stringify(filed));
        return { ok: true };
      },
    };
    const result = await chainBoundaryFrame(
      store,
      { ...production, takes: [accepted, drawn] },
      { take: accepted, sourceShotId: "sh_04", followingShotId: "sh_05", maker, clock: CLOCK },
    );
    assert.ok(result.ok && "skipped" in result && result.skipped === "following-shot-has-own-frame");
    assert.equal(calls.length, 1, "the extraction did run — this is the in-gate catch, not the early one");

    // The drawn frame stands; no boundary artifact was installed over it.
    const selections = SelectionsSchema.parse(
      JSON.parse(await readFile(join(dir, "productions", production.meta.id, "selections.json"), "utf8")),
    );
    const filedId = selections["sh_05"]?.startFrameArtifactId;
    assert.ok(filedId !== undefined);
    const files = await import("node:fs/promises").then((fs) => fs.readdir(join(dir, "artifacts")));
    assert.equal(files.some((file) => file.startsWith("boundary-sh_05-")), false);
  });

  /*
   * Issue 851. Nothing in the frame family ever took a frame off a shot, so a still an accept
   * chained on could only be displaced by drawing over it. Both pointers go — a take pointer
   * left standing beside a cleared picture is a second answer to what the shot opens on — and
   * the artifact stays on the shelf, because it is still the record of where the last shot ended.
   */
  it("clearing a shot's frame drops both pointers and keeps the artifact", async () => {
    const { dir, store, production } = await open();
    const accepted = take("tk_01J8E0000000000000000000C1");
    await landClip(dir, production.meta.id, accepted.id);
    await expectBoundaryFrom(store, dir, production.meta.id, "sh_1", "sh_2", accepted.id);
    const chained = await chainBoundaryFrame(
      store,
      { ...production, takes: [accepted] },
      { take: accepted, sourceShotId: "sh_1", followingShotId: "sh_2", maker: fakeMaker([]), clock: CLOCK },
    );
    assert.ok(chained.ok && "artifactId" in chained);
    const artifactId = chained.artifactId;

    const cleared = await clearShotFrame(store, production.meta.id, "sh_2");
    assert.ok(cleared.ok && cleared.cleared);
    const selections = SelectionsSchema.parse(
      JSON.parse(await readFile(join(dir, "productions", production.meta.id, "selections.json"), "utf8")),
    );
    assert.equal(selections["sh_2"]?.startFrameArtifactId ?? null, null);
    assert.equal(selections["sh_2"]?.startFrameTakeId ?? null, null);
    assert.ok(
      store.getBundle().artifacts.some((artifact) => artifact.id === artifactId),
      "the still stays filed; only the pointer went",
    );

    const again = await clearShotFrame(store, production.meta.id, "sh_2");
    assert.ok(again.ok && !again.cleared, "a shot with no frame is already where the caller wanted it");
  });
});
