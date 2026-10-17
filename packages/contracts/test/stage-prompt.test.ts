import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STAGE_FRAMED_HEIGHT,
  stageBriefForRouting,
  stageBriefWithFollow,
  stageRoutingCitations,
  stageShotSize,
  stagingFollowLine,
  stagingPromptClause,
  type ResolvedShotStaging,
} from "../src/index.js";

// The lobby of design turn 229: Ade waits in an armchair, Ife crosses from the lifts and leans in.
const lobby = (): ResolvedShotStaging => ({
  version: 1,
  cast: [{ sheetId: "ade", x: 1.3, z: 0.05, pose: "sit" }, { sheetId: "ife", x: 3.55, z: -2.5 }],
  sets: [{ name: "armchair", x: 1.3, z: 0.05, w: .86, h: .9, d: .8 }, { name: "lifts", x: 3.98, z: -2.5, w: .2, h: 2.4, d: 3.4 }],
  keys: [{ t: 0, p: [1.15, 1.3, 3.3], l: [1.3, 1.2, -0.3], easeOut: .25 }, { t: 4, p: [1.3, 1.3, 2.6], l: [1.3, 1.2, -0.3], easeIn: .25 }],
  performances: [{ sheetId: "ife", keys: [{ t: 0, x: 3.55, z: -2.5 }, { t: 2.6, x: 1.35, z: -0.62 }, { t: 3.2, x: 1.35, z: -0.62 }] }],
});
const names: Record<string, string> = { ade: "Ade", ife: "Ife" };
const nameOf = (id: string) => names[id] ?? id;

describe("the blockout written for a video model (issue 1817)", () => {
  it("names the shot size from the band its framed height falls in", () => {
    for (const [size, fraction] of Object.entries(STAGE_FRAMED_HEIGHT)) assert.equal(stageShotSize(fraction * 1.8, 1.8), size);
    assert.equal(stageShotSize(.6 * 1.8, 1.8), "close-up", "between two bands, the nearer on a log scale");
  });

  it("says the camera, then the action in time order, with no coordinates", () => {
    const clause = stagingPromptClause(lobby(), nameOf, 4, { aspect: "9:16", lens: "40 mm" });
    const lines = clause.split("\n");
    assert.equal(lines[0], "0.0–4.0 s · Wide on Ade, from the front, eye level, dolly, ending medium, easing in and out.");
    assert.match(clause, /^0\.0–4\.0 s · Ade sits at the armchair\.$/m);
    assert.match(clause, /^0\.0–2\.6 s · Ife walks from the lifts to Ade\.$/m);
    assert.match(clause, /^2\.6–4\.0 s · Ife stands at Ade\.$/m);
    assert.doesNotMatch(clause, /\(-?\d+\.\d+, -?\d+\.\d+|world|metres|\dm\b/);
    assert.doesNotMatch(clause, /@Video/, "no follow line without a riding video");
  });

  it("closes with the follow line only when the blockout video rides, worded by the choice", () => {
    const action = stagingPromptClause(lobby(), nameOf, 4, { video: "Video 1", follow: "camera-action" });
    assert.equal(action.split("\n").at(-1), "Follow @Video 1 precisely for camera position, movement, timing and blocking.");
    const camera = stagingPromptClause(lobby(), nameOf, 4, { video: "Video 1", follow: "camera" });
    assert.equal(camera.split("\n").at(-1), stagingFollowLine("Video 1", "camera"));
    assert.match(camera, /placeholders; do not copy their poses or body mechanics\.$/);
  });

  it("rewrites only the Stage's own follow line when the choice changes", () => {
    const brief = `A lobby at night.\n\n${stagingPromptClause(lobby(), nameOf, 4, { video: "Video 2", follow: "camera-action" })}`;
    const swapped = stageBriefWithFollow(brief, "camera");
    assert.equal(swapped.replace(stagingFollowLine("Video 2", "camera"), stagingFollowLine("Video 2", "camera-action")), brief);
    assert.equal(stageBriefWithFollow(swapped, "camera-action"), brief, "and back again");
    const authored = "Use @Video 1 as you like.";
    assert.equal(stageBriefWithFollow(authored, "camera"), authored, "an author's own line is theirs");
  });

  it("keeps the brief's References and follow lines in step with what rides after a model switch", () => {
    const references = [
      { token: "Image 1", kind: "image" as const, sheetId: "ade", label: "Ade", detail: "Ade", ride: "when-supported" as const },
      { token: "Image 2", kind: "image" as const, sheetId: "ife", label: "Ife", detail: "Ife", ride: "when-supported" as const },
      { token: "Video 1", kind: "video" as const, label: "Shot 1 · playblast", detail: "the blockout", ride: "when-supported" as const },
    ] as unknown as Parameters<typeof stageRoutingCitations>[0];
    const clause = (video?: string) => stagingPromptClause(lobby(), nameOf, 4, video === undefined ? {} : { video, follow: "camera" });
    const all = stageRoutingCitations(references, ["Image 1", "Image 2", "Video 1"], nameOf);
    assert.deepEqual(all, { cited: ["@Image 1 Ade", "@Image 2 Ife", "@Video 1 the blockout"], video: "Video 1" });
    const onVideo = `A lobby at night.\n\nReferences: ${all.cited.join(" · ")}.\n\n${clause("Video 1")}`;
    // An image route: the playblast no longer rides, so neither its citation nor its follow line stays.
    const pictures = stageRoutingCitations(references, ["Image 1", "Image 2"], nameOf);
    const onImages = stageBriefForRouting(onVideo, { ...pictures, follow: "camera" });
    assert.equal(onImages, `A lobby at night.\n\nReferences: @Image 1 Ade · @Image 2 Ife.\n\n${clause()}`);
    assert.doesNotMatch(onImages, /@Video/);
    // And back: the citation returns and the follow line closes the timed lines again.
    assert.equal(stageBriefForRouting(onImages, { ...all, follow: "camera" }), onVideo);
    // Nothing rides: the References paragraph goes; something rides again: it is written before the timed lines.
    const bare = stageBriefForRouting(onImages, { cited: [], video: null, follow: "camera" });
    assert.equal(bare, `A lobby at night.\n\n${clause()}`);
    assert.equal(stageBriefForRouting(bare, { ...all, follow: "camera" }), onVideo);
    assert.equal(stageBriefForRouting(onVideo, { ...all, follow: "camera" }), onVideo, "a route that changes nothing changes nothing");
    const authored = "Make it moody. Use @Video 1 for the camera.";
    assert.equal(stageBriefForRouting(authored, { ...pictures, follow: "camera" }), authored, "a brief without the Stage's lines is the author's");
  });

  it("puts a shot's lines on a board's clock", () => {
    const clause = stagingPromptClause(lobby(), nameOf, 4, { offset: 8 });
    assert.match(clause, /^8\.0–12\.0 s · /);
    assert.match(clause, /^8\.0–10\.6 s · Ife walks/m);
  });
});
