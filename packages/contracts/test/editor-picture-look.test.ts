import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTimelineCommands, buildFfmpegArgs, buildRenderPlan, canonicalJson, compileTrustedTimelineSteps, describeTimelineCommand, finishTrustedTimelineSteps,
  ModelEditorRequestSchema, PRESETS, productionExportFingerprint, ProductionTimelineSchema, redoTimelineHistory, TimelineCommandSchema, TimelinePictureLookSchema,
  timelinePictureLookFilters, timelineUsesCompositor, undoTimelineHistory, windowPlan,
  type ProductionTimeline, type ReadinessWorld, type RenderPlan, type RenderPlanInput, type TimelineClipCommand, type TimelinePictureLook } from "../src/index.js";
import { NO_TEXT_EXPORT_PATHS, RENDER_PLAN_NO_TEXT_CASES, type RenderPlanNoTextCase } from "./fixtures/render-plan-no-text-cases.js";

/**
 * A cut's picture look (SPEC-038 R-45..R-50): the record, the one command, and the chains the
 * export adds. The films are the ones `render-plan-no-text-cases.ts` plans, because they reach
 * every way a picture is made today and none of them has a look: each is planned and encoded with
 * one and without, and the difference has to be the look and nothing else.
 */

const FILM: TimelinePictureLook = { grade: "film" }, LIGHT: TimelinePictureLook = { grain: "light" }, BOTH: TimelinePictureLook = { grade: "film", grain: "medium" };
const caseNamed = (name: string): RenderPlanNoTextCase => { const found = RENDER_PLAN_NO_TEXT_CASES.find(row => row.name === name); assert.ok(found, name); return found; };
const ready = (entry: RenderPlanNoTextCase): ProductionTimeline | null => entry.args.timeline?.status === "ready" ? entry.args.timeline.timeline : null;
/** A saved cut of takes and slates with nothing the compositor draws, and edits in its Undo already. */
const plain = (): ProductionTimeline => ready(caseNamed("plain cut, review-cut"))!;
const look = (value: TimelinePictureLook | null): TimelineClipCommand => ({ kind: "set-picture-look", look: value });
const apply = (base: ProductionTimeline, ...commands: TimelineClipCommand[]) => applyTimelineCommands(base, commands, { effectAuthority: "human" });
const saved = (value: ProductionTimeline) => ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(value)));
const lastEntry = (value: ProductionTimeline) => { const entry = value.history.undo.at(-1); assert.ok(entry?.kind === "change"); return entry; };
/** The same film with a look on its record, at the revision it was: what differs between the two plans is the look alone. */
const withLook = (entry: RenderPlanNoTextCase, value: TimelinePictureLook): RenderPlanInput => ({ ...entry.args, timeline: { status: "ready", timeline: { ...ready(entry)!, pictureLook: value } } });
const planOf = (args: RenderPlanInput): RenderPlan => { const result = buildRenderPlan(args); if (!result.ok) throw new Error(result.reason); return result.plan; };

test("a look is a film grade, light or medium grain, or both, and a record holds one or no key at all", () => {
  for (const value of [FILM, LIGHT, { grain: "medium" }, BOTH]) assert.equal(TimelinePictureLookSchema.safeParse(value).success, true, JSON.stringify(value));
  for (const wrong of [{}, { grade: "noir" }, { grain: "heavy" }, { grade: "film", grain: "off" }, { grade: "film", strength: 1 }, { grade: null }, null, "film"]) {
    assert.equal(TimelinePictureLookSchema.safeParse(wrong).success, false, JSON.stringify(wrong));
  }
  assert.equal(TimelineCommandSchema.safeParse({ kind: "set-picture-look", look: BOTH }).success, true);
  assert.equal(TimelineCommandSchema.safeParse({ kind: "set-picture-look", look: null }).success, true, "null clears it");
  for (const wrong of [{ kind: "set-picture-look" }, { kind: "set-picture-look", look: {} }, { kind: "set-picture-look", look: FILM, clipId: "cl_sh-1" }]) {
    assert.equal(TimelineCommandSchema.safeParse(wrong).success, false, JSON.stringify(wrong));
  }
  const raw = JSON.parse(JSON.stringify(plain()));
  assert.equal(ProductionTimelineSchema.safeParse({ ...raw, pictureLook: LIGHT }).success, true);
  // A title's source already has a `look`; the timeline's is never a bare one.
  for (const wrong of [{ pictureLook: {} }, { pictureLook: null }, { pictureLook: { grade: "film", grain: "heavy" } }, { look: FILM }]) {
    assert.equal(ProductionTimelineSchema.safeParse({ ...raw, ...wrong }).success, false, JSON.stringify(wrong));
  }
  // It is set in the Inspector. Arke's requests are an allowlist, and this is not on it.
  assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Grade the film", commands: [{ kind: "set-picture-look", look: FILM }] }).success, false);
});

test("the command sets, changes and clears the whole look, one action and one revision each, and touches no clip", () => {
  const base = plain();
  assert.equal("pictureLook" in base, false);
  const graded = apply(base, look(FILM));
  assert.deepEqual(graded.pictureLook, FILM);
  assert.equal(graded.revision, base.revision + 1);
  assert.deepEqual([graded.tracks, graded.mix], [base.tracks, base.mix]);
  assert.deepEqual([lastEntry(graded).label, lastEntry(graded).pictureLook, lastEntry(graded).clips, lastEntry(graded).tracks], ["Change the look", { before: null, after: FILM }, [], []]);

  const both = apply(graded, look(BOTH));
  assert.deepEqual(both.pictureLook, BOTH);
  assert.deepEqual(lastEntry(both).pictureLook, { before: FILM, after: BOTH });

  const cleared = apply(both, look(null));
  assert.equal("pictureLook" in cleared, false, "a cleared look leaves no key behind");
  assert.deepEqual([lastEntry(cleared).label, lastEntry(cleared).pictureLook], ["Clear the look", { before: BOTH, after: null }]);
  assert.deepEqual([look(LIGHT), look(null)].map(describeTimelineCommand), ["Change the look", "Clear the look"]);

  // Every record it writes reads back as itself, with its history replayed against it.
  for (const value of [graded, both, cleared]) assert.equal(canonicalJson(saved(value)), canonicalJson(value));

  // Beside another edit it is still one action, and the entry holds both.
  const batch = apply(base, look(LIGHT), { kind: "set-mix", mix: { duckingDb: -6 } });
  assert.equal(batch.revision, base.revision + 1);
  assert.deepEqual([lastEntry(batch).label, lastEntry(batch).pictureLook, lastEntry(batch).mix?.after.duckingDb], ["2 edits", { before: null, after: LIGHT }, -6]);
});

test("the look the film already has, and clearing a film that has none, are no edit", () => {
  const base = plain(), graded = apply(base, look(BOTH));
  const outcome = (timeline: ProductionTimeline, ...commands: TimelineClipCommand[]) =>
    finishTrustedTimelineSteps(timeline, compileTrustedTimelineSteps(timeline, [{ id: "look", authority: "human", commands }])).kind;
  assert.equal(outcome(base, look(null)), "unchanged");
  assert.equal(outcome(graded, look(BOTH)), "unchanged");
  assert.equal(outcome(graded, look({ grain: "medium", grade: "film" })), "unchanged", "in whatever order its parts were sent");
  assert.equal(outcome(apply(base, look(LIGHT)), look({ grade: undefined, grain: "light" })), "unchanged", "a part sent as undefined is a part not sent");
  assert.equal(outcome(base, look(FILM), look(null)), "unchanged", "set and cleared in one batch");
  assert.equal(outcome(graded, look(FILM)), "changed", "one part taken away is a change");
  assert.throws(() => apply(graded, look(BOTH)), /changes nothing/);
  assert.throws(() => apply(base, look(null)), /changes nothing/);
});

test("Undo and Redo restore the look exactly, and a record whose look is not where its history left it is refused", () => {
  const cleared = saved(apply(apply(apply(plain(), look(FILM)), look(BOTH)), look(null)));
  const back = [cleared];
  for (let step = 0; step < 3; step++) back.push(saved(undoTimelineHistory(back.at(-1)!)));
  assert.deepEqual(back.map(value => value.pictureLook), [undefined, BOTH, FILM, undefined]);
  assert.equal("pictureLook" in back[3]!, false, "undone to a film with none, the key is gone");
  assert.deepEqual(back[3]!.tracks, plain().tracks);
  const forward = [back[3]!];
  for (let step = 0; step < 3; step++) forward.push(saved(redoTimelineHistory(forward.at(-1)!)));
  assert.deepEqual(forward.map(value => value.pictureLook), [undefined, FILM, BOTH, undefined]);
  assert.equal("pictureLook" in forward[3]!, false);
  assert.equal(canonicalJson(forward[3]!.history), canonicalJson(cleared.history));

  // The film is graded and grained; its newest Undo entry says so. A record that disagrees is not that film.
  const both = back[1]!, { pictureLook: _gone, ...stripped } = JSON.parse(JSON.stringify(both));
  const refused = ProductionTimelineSchema.safeParse(stripped);
  assert.equal(refused.success, false);
  assert.match(refused.error!.issues.map(issue => issue.message).join(" "), /not in its redo position for the look|not in its undo position for the look/);
  assert.throws(() => undoTimelineHistory({ ...both, pictureLook: LIGHT }), /not in its undo position for the look/);
  assert.throws(() => redoTimelineHistory({ ...both, pictureLook: LIGHT }), /not in its redo position for the look/);
});

test("the plan carries the look only when the film has one, and is otherwise the plan it was", () => {
  let recorded = 0;
  for (const entry of RENDER_PLAN_NO_TEXT_CASES) {
    const before = planOf(entry.args);
    assert.equal("pictureLook" in before, false, entry.name);
    // A production with no saved timeline has no record to hold one.
    if (ready(entry) === null) continue;
    assert.deepEqual(planOf(withLook(entry, BOTH)), { ...before, pictureLook: BOTH }, entry.name);
    recorded++;
  }
  assert.equal(recorded, RENDER_PLAN_NO_TEXT_CASES.length - 1);

  // A look is laid over the picture, whichever renderer drew it: it is never the reason for the compositor.
  const cut = caseNamed("plain cut, review-cut"), finished: ProductionTimeline = { ...plain(), pictureLook: BOTH };
  assert.equal(timelineUsesCompositor(finished), false);
  assert.equal(planOf(withLook(cut, BOTH)).effectRender, undefined);
  // One episode is the whole film's plan cut to its frames, and so is any other window: the look goes with it.
  const episode = planOf(withLook(caseNamed("everything, one episode, master"), LIGHT));
  assert.deepEqual([episode.scope.kind, episode.pictureLook], ["episode", LIGHT]);
  assert.deepEqual(windowPlan(planOf(withLook(cut, FILM)), 1, 2, { kind: "production" }).pictureLook, FILM);
});

// The chain, spelled out here and not read from the source, so a change to it is a change to this file too.
const GRADE = "eq=saturation=0.86,curves=r='0/0 0.25/0.228 0.5/0.5 0.75/0.765 1/0.97':g='0/0 0.25/0.235 0.5/0.5 0.75/0.755 1/0.955':b='0/0 0.25/0.247 0.5/0.5 0.75/0.74 1/0.925',format=yuv444p,gblur=sigma=0.55";
const BLEND = "[lookPicture][lookGrain]blend=c0_mode=overlay:c0_opacity=0.5:c1_mode=normal:c1_opacity=1:c2_mode=normal:c2_opacity=1:shortest=1,format=yuv420p[look]";
const plate = (width: number, height: number, rate: number, strength: number) =>
  `color=c=gray:s=${width / 2}x${height / 2}:r=${rate},format=gray,lutyuv=y=128,noise=alls=${strength}:allf=t+u:all_seed=7,gblur=sigma=0.6,scale=${width}:${height}:flags=bicubic,format=yuv444p[lookGrain]`;
/** What the export adds for a look, reading the picture labelled `from`. */
function chains(value: TimelinePictureLook, from: string, width: number, height: number, rate: number): string[] {
  if (value.grain === undefined) return [`[${from}]${GRADE},format=yuv420p[look]`];
  return [`[${from}]${value.grade ? GRADE : "format=yuv444p"}[lookPicture]`, plate(width, height, rate, value.grain === "light" ? 32 : 48), BLEND];
}

test("the export lays the look over the finished picture, before the first subtitle, and asks FFmpeg for nothing else it did not ask for before", () => {
  const { worldDir, outFile, slateFont } = NO_TEXT_EXPORT_PATHS;
  const argsOf = (entry: RenderPlanNoTextCase, plan: RenderPlan) => entry.effectAlpha === undefined
    ? buildFfmpegArgs(plan, worldDir, outFile, slateFont) : buildFfmpegArgs(plan, worldDir, outFile, slateFont, entry.effectAlpha);
  const reached = { burned: 0, composited: 0, cut: 0 };
  for (const entry of RENDER_PLAN_NO_TEXT_CASES) {
    const timeline = ready(entry);
    if (timeline === null) continue;
    const before = planOf(entry.args), plainArgs = argsOf(entry, before);
    const graphAt = plainArgs.indexOf("-filter_complex") + 1, mapAt = plainArgs.indexOf("-map") + 1, parts = plainArgs[graphAt]!.split(";");
    // The picture is whole where the first subtitle is drawn, or else where the sound begins.
    const subtitle = parts.findIndex(part => part.endsWith("[st0]")), sound = parts.findIndex(part => /^\[\d+:a\]/.test(part));
    const at = subtitle >= 0 ? subtitle : sound >= 0 ? sound : parts.length;
    const from = subtitle >= 0 ? /^\[([^\]]+)\]drawtext=/.exec(parts[subtitle]!)![1]! : plainArgs[mapAt]!.slice(1, -1);
    const size = PRESETS[entry.args.preset];
    for (const value of [FILM, LIGHT, BOTH]) {
      const expected = [...plainArgs], rest = parts.slice(at);
      // The first subtitle is drawn on the look, and the film is still mapped from the last of them.
      if (subtitle >= 0) rest[0] = rest[0]!.replace(`[${from}]drawtext=`, "[look]drawtext=");
      else expected[mapAt] = "[look]";
      expected[graphAt] = [...parts.slice(0, at), ...chains(value, from, size.width, size.height, before.frameRate), ...rest].join(";");
      assert.deepEqual(argsOf(entry, planOf(withLook(entry, value))), expected, `${entry.name}, ${JSON.stringify(value)}`);
    }
    // Set and cleared again, the film is asked for exactly as it was before it had one.
    const cleared = apply(apply(timeline, look(BOTH)), look(null));
    assert.deepEqual(argsOf(entry, planOf({ ...entry.args, timeline: { status: "ready", timeline: cleared } })), plainArgs, entry.name);
    if (subtitle >= 0) reached.burned++;
    if (before.effectRender) reached.composited++; else reached.cut++;
  }
  assert.ok(reached.burned > 0 && reached.composited > 0 && reached.cut > 0, "burned-in subtitles, the compositor's picture and a plain cut are all among the films");
});

test("the grain's plate is half the frame on even sides at the film's rate, and stronger for medium", () => {
  assert.deepEqual(timelinePictureLookFilters(BOTH, 1080, 1920, 30, "ov3", "look"), chains(BOTH, "ov3", 1080, 1920, 30));
  assert.deepEqual(timelinePictureLookFilters(FILM, 1280, 720, 25, "out", "look"), [`[out]${GRADE},format=yuv420p[look]`]);
  // Half of 1278 by 718 is 639 by 359, which no 4:2:0 frame can be: each side goes to the nearest even figure.
  const odd = timelinePictureLookFilters(LIGHT, 1278, 718, 24, "out", "finish");
  assert.equal(odd[0], "[out]format=yuv444p[finishPicture]");
  assert.match(odd[1]!, /^color=c=gray:s=640x360:r=24,format=gray,lutyuv=y=128,noise=alls=32:allf=t\+u:all_seed=7,gblur=sigma=0\.6,scale=1278:718:flags=bicubic,format=yuv444p\[finishGrain\]$/);
  assert.match(odd[2]!, /^\[finishPicture\]\[finishGrain\]blend=.*:shortest=1,format=yuv420p\[finish\]$/);
  assert.match(timelinePictureLookFilters({ grain: "medium" }, 1920, 1080, 24, "out", "look")[1]!, /^color=c=gray:s=960x540:r=24,.*noise=alls=48:/);
});

test("an export made before the look changed no longer stands for the film", () => {
  const world: ReadinessWorld = { meta: { worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC" }, sheets: [], props: [], artifacts: [], referenceKits: [] };
  const film = (timeline: ProductionTimeline) => productionExportFingerprint(world, { ...caseNamed("plain cut, review-cut").args.production, timeline: { status: "ready", timeline } });
  const base = plain(), graded = apply(base, look(FILM));
  assert.notEqual(film(graded), film(base));
  assert.notEqual(film(apply(graded, look(BOTH))), film(graded));
  assert.equal(film(apply(graded, look(null))), film(base), "cleared, it is the film that was exported");
});
