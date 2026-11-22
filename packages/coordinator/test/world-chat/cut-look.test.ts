import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelWorldChatAction, WorldBundle, WorldChatCheckReceipt } from "@arke-studio/contracts";
import { cutLookProblem } from "../../src/world-chat/cut-look.js";
import { scanWorld } from "../../src/world/scan.js";
import { FIXTURE_WORLD } from "../world/helpers.js";

/**
 * Look before changing a shot beside a take (design turn 286). On the installed app Arke planned a
 * shot beside a take from the words alone and asked the person what the take showed; a sentence
 * did not stop it, so the turn is checked.
 */

async function world(): Promise<WorldBundle> {
  const scanned = (await scanWorld(FIXTURE_WORLD)).bundle;
  // Shot 5 of the fixture's scene 2 has a take; shots 4, 6 and 7 have none.
  return {
    ...scanned,
    productions: scanned.productions.map((p) =>
      p.meta.id !== "saltlight" ? p : { ...p, selections: { ...p.selections, sh_05: { acceptedTakeId: "tk_01J8F0000000000000000000C5", trimInSec: 0 } } } as typeof p,
    ),
  };
}

const scene = (...commands: unknown[]) =>
  ({ kind: "production-scene-command", productionId: "saltlight", sceneId: "sc_02", commands, checkReceiptIds: [] }) as unknown as ModelWorldChatAction;
const receipt = (tool: string, querySummary?: string) =>
  ({ id: `check_${tool}`, runId: "run_x", tool, status: "complete", consulted: [], at: "2026-11-22T00:00:00.000Z", ...(querySummary ? { querySummary } : {}) }) as unknown as WorldChatCheckReceipt;
const LOOKED = [receipt("read-skill", "continuity-across-cuts@v3"), receipt("sample-video", "Sampled video frames: production-take:x")];

describe("a change to a shot beside a take needs a look at the cut first (design turn 286)", () => {
  it("refuses a picture change beside a take made without the skill or a look, and says what to do", async () => {
    const problem = cutLookProblem(await world(), [scene({ kind: "edit-shot", shotId: "sh_06", change: { description: "She is already walking away." } })], []);
    assert.ok(problem);
    assert.match(problem, /^Shot 6 has a take or stands beside one/);
    assert.match(problem, /call read_skill for continuity-across-cuts/);
    assert.match(problem, /look with sample_video at the frames either side of its cuts/);
    assert.match(problem, /Do not rely on an earlier turn's look/);
  });

  it("asks only for what is missing", async () => {
    const onlyRead = cutLookProblem(await world(), [scene({ kind: "edit-shot", shotId: "sh_05", change: { camera: "close" } })], [LOOKED[0]!]);
    assert.doesNotMatch(onlyRead!, /read_skill/);
    assert.match(onlyRead!, /sample_video/);
  });

  it("lets the change through once the skill was read and frames were looked at this turn", async () => {
    assert.equal(cutLookProblem(await world(), [scene({ kind: "edit-shot", shotId: "sh_06", change: { description: "x" } })], LOOKED), null);
  });

  it("an insert beside a take, a prompt override and a Stage edit are picture changes too", async () => {
    const bundle = await world();
    assert.match(cutLookProblem(bundle, [scene({ kind: "insert-shot", at: { after: "sh_05" }, shot: { title: "t", description: "d" } })], [])!, /Shot 5/);
    assert.ok(cutLookProblem(bundle, [scene({ kind: "set-prompt-override", shotId: "sh_04", text: "x" })], []));
    assert.ok(cutLookProblem(bundle, [scene({ kind: "edit-stage", shotId: "sh_06", staging: null })], []));
  });

  it("leaves alone what cannot change a cut: a title, a shot two away from any take, a book", async () => {
    const bundle = await world();
    assert.equal(cutLookProblem(bundle, [scene({ kind: "edit-shot", shotId: "sh_06", change: { title: "Her back", notes: "n" } })], []), null);
    assert.equal(cutLookProblem(bundle, [scene({ kind: "edit-shot", shotId: "sh_07", change: { description: "x" } })], []), null);
    const book = { kind: "production-scene-command", productionId: "the-ledger-of-nights", sceneId: "sc_02", commands: [{ kind: "edit-shot", shotId: "sh_06", change: { description: "x" } }], checkReceiptIds: [] } as unknown as ModelWorldChatAction;
    assert.equal(cutLookProblem(bundle, [book], []), null);
  });

  it("a look from another skill does not count", async () => {
    const problem = cutLookProblem(await world(), [scene({ kind: "edit-shot", shotId: "sh_06", change: { description: "x" } })],
      [receipt("read-skill", "some-other-skill@v1"), receipt("sample-video")]);
    assert.match(problem!, /read_skill/);
  });
});
