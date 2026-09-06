import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  GraphSceneSchema,
  isGraphScene,
  linearizeSceneFlow,
  migrateLegacyScene,
  newId,
  orderedShots,
  StoryOverviewSchema,
  legacySceneView,
  type CandidateId,
  type ConversationId,
  type GraphScene,
  type MessageId,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { describeEntryContext } from "../../src/world-chat/entry-context.js";
import { evaluateReadiness } from "../../src/world-chat/readiness.js";
import {
  episodesFence,
  sceneScriptFence,
  sceneScriptTargetId,
  seasonFence,
  storyFence,
} from "../../src/world-chat/target-reads.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { wrapUp } from "../../src/world-chat/wrapup.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";

/**
 * Production-scoped threads (SPEC-023 R-20, issue #400): the same durable conversation, entered
 * at a production, an episode, or a scene — with typed candidates that materialise through the
 * narrative-domain proposal kinds and land through the same gate as everything else.
 */

const AT = "2026-08-19T10:00:00Z";
const NOW = () => AT;

/** The gate's accept outcome as a word, so a failure reads as its status not a crash. */
const accepted = (o: { status: string }): string => o.status;

function candidate(over: Partial<WorldChangeCandidate>): WorldChangeCandidate {
  return {
    id: newId("cand") as CandidateId,
    conversationId: newId("cv") as ConversationId,
    revision: 1,
    status: "live",
    settledness: "settled",
    subject: { kind: "new", label: "Development" },
    title: "A development decision",
    rationale: "They said so.",
    sourceMessageIds: [],
    evidence: [
      {
        kind: "message",
        messageId: newId("msg") as MessageId,
        quote: "make it so",
        start: 0,
        end: 10,
        purpose: "intent",
      },
    ],
    checks: {
      state: "complete",
      basedOnCanonRevision: 42,
      required: [],
      completed: [],
      consulted: [],
      likelyDuplicates: [],
      possibleAmendments: [],
      contradictionCandidates: [],
      explanation: "The entry context carries the current records.",
    },
    createdAt: AT,
    updatedAt: AT,
    ...over,
  } as WorldChangeCandidate;
}

async function world() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: NOW });
  closeOnCleanup(() => store.close());
  const gate = new ProposalManager(store);
  const conversationId = newId("cv") as ConversationId;
  const log = new WorldChatStore(conversationDir(dir, conversationId));
  await log.create(conversationId, AT);
  await log.append(
    { type: "conversation.created", title: "Development", entryContext: { kind: "production", productionId: "saltlight" } },
    { at: AT },
  );
  return { dir, store, gate, conversationId, log };
}

async function withCandidates(log: WorldChatStore, candidates: WorldChangeCandidate[]): Promise<number> {
  const turnId = newId("turn");
  await log.append(
    {
      type: "turn.completed",
      message: {
        id: newId("msg") as MessageId,
        turnId,
        role: "studio",
        text: "Noted.",
        attachmentIds: [],
        createdAt: AT,
      },
      run: {
        id: newId("run"),
        turnId,
        basedOnConversationSeq: 1,
        status: "completed",
        adapter: "fake",
        harnessCleanup: "not-required",
        contextDigest: `sha256:${"a".repeat(64)}`,
        startedAt: AT,
        endedAt: AT,
      },
      receipts: [],
      candidates,
      groups: [],
      tombstones: [],
    },
    { at: AT },
  );
  const { events } = await log.read();
  return events[events.length - 1]!.seq;
}

/** A valid graph whose stable identities cannot be mistaken for deterministic projections. */
function withAuthoredSceneIdentities(scene: GraphScene): GraphScene {
  const nodeIds = new Map(
    scene.flow.nodes.map((node, index) => [node.id, `sfn_authored-${node.kind}-${index + 1}`]),
  );
  const grouped = scene.flow.nodes.filter((node) => node.kind === "shot")[1]!;
  return GraphSceneSchema.parse({
    ...scene,
    boards: {
      splits: [grouped.shot.id],
      merges: [],
      prompts: [{ members: [grouped.shot.id], text: "Keep the lamps together." }],
    },
    flow: {
      ...scene.flow,
      entryNodeId: nodeIds.get(scene.flow.entryNodeId)!,
      exitNodeId: nodeIds.get(scene.flow.exitNodeId)!,
      nodes: scene.flow.nodes.map((node) => ({ ...node, id: nodeIds.get(node.id)! })).reverse(),
      edges: scene.flow.edges.map((edge, index) => ({
        ...edge,
        id: `sfe_authored-${index + 1}`,
        from: { ...edge.from, nodeId: nodeIds.get(edge.from.nodeId)! },
        to: { ...edge.to, nodeId: nodeIds.get(edge.to.nodeId)! },
      })).reverse(),
      storyboardGroups: [{
        id: "sbg_authored-lamps",
        title: "The lamps",
        shotNodeIds: [nodeIds.get(grouped.id)!],
      }],
    },
  });
}

type TestWorld = Awaited<ReturnType<typeof world>>;

async function installAuthoredVerse(w: TestWorld): Promise<void> {
  const production = w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
  const legacy = legacySceneView(production.scenes.find((scene) => scene.id === "sc_04")!);
  const authored = withAuthoredSceneIdentities(migrateLegacyScene(legacy));
  const setup = await w.gate.stage({
    kind: "scene-edit",
    summary: "Author the scene flow",
    source: "test",
    targets: [{
      path: "productions/saltlight/scenes/04-the-verse-rises.json",
      content: `${JSON.stringify(authored, null, 2)}\n`,
    }],
  });
  assert.equal(accepted(await w.gate.accept(setup.id)), "accepted");
}

async function readStagedGraphScene(
  dir: string,
  proposal: { id: string; targets: Array<{ path: string }> },
): Promise<GraphScene> {
  const target = proposal.targets.find((candidate) => candidate.path.includes("/scenes/"));
  assert.ok(target, "the proposal stages a scene target");
  const raw = await readFile(join(dir, ".proposals", proposal.id, ...target.path.split("/")), "utf8");
  const scene = GraphSceneSchema.parse(JSON.parse(raw));
  assert.equal("shots" in scene, false, "staged scene content has one graph authority and no top-level shots[]");
  return scene;
}

describe("production-scoped threads (issue 400)", () => {
  it("the entry context narrates the current production records into the turn", async () => {
    const { store } = await world();
    const bundle = store.getBundle();
    const production = describeEntryContext({ kind: "production", productionId: "saltlight" }, bundle);
    assert.match(production, /Production Chat thread for the production "Saltlight"/);
    assert.match(production, /The overview is v\d/, "the current overview travels in the narration");
    const scene = describeEntryContext(
      { kind: "scene", productionId: "saltlight", sceneId: "sc_04" },
      bundle,
    );
    assert.match(scene, /scene thread for "The verse rises"/);
    assert.match(scene, /no script yet/, "the scene's current state is narrated");
    // Found by asking (2026-08-21): a person in this thread asked what happens shot by shot, and
    // the studio could only say how many shots there were. A scene whose shots are invisible to
    // its own thread cannot be talked about, which is what the thread is for.
    assert.match(scene, /Its shots, in order:/, "the shots travel, not just their count");
    assert.match(scene, /sh_12 #12/, "each one named by id and number");
    assert.match(scene, /Maren at the rail/, "and by title, so it can be referred to");
    assert.match(scene, /Every shot inherits:/, "with what the scene hands down to all of them");
  });

  it("every thread is told what kind of thing is being made, and its numbers", async () => {
    // Found by asking (2026-08-21): a season thread proposed seven excellent episodes that read
    // like short-film beats, because nothing had told it they were forty-five-second vertical
    // ones. The kind and its numbers were on disk from creation and reached no turn.
    const { store } = await world();
    const bundle = store.getBundle();
    const production = describeEntryContext({ kind: "production", productionId: "saltlight" }, bundle);
    assert.match(production, /one continuous piece, not episodes/, "a one-off says so");
    assert.match(production, /It delivers in /, "and names the frame it delivers in");
  });

  it("an overview candidate wraps up as a story-overview proposal and lands through the gate", async () => {
    const w = await world();
    const before = w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.story!;
    const seq = await withCandidates(w.log, [
      candidate({
        classification: "development.overview",
        target: { kind: "production", productionId: "saltlight" },
        title: "The overview finds its spine",
        draft: { logline: "One night on the Vigil, the verse rises early — and answers." },
      } as Partial<WorldChangeCandidate>),
    ]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-1",
      expectedConversationSeq: seq,
      now: NOW,
    });
    assert.equal(result.proposalIds.length, 1);
    const staged = (await w.gate.listOpen()).find((p) => p.kind === "story-overview");
    assert.ok(staged, "the proposal kind is the narrative-domain one, not worldbuilding");

    const untouched = w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.story!;
    assert.deepEqual(untouched, before, "talking and wrapping up write nothing live");

    const accepted = await w.gate.accept(staged.id);
    assert.equal(accepted.status, "accepted");
    const after = await scanWorld(w.dir);
    const story = after.bundle.productions.find((p) => p.meta.id === "saltlight")!.story!;
    assert.equal(story.logline, "One night on the Vigil, the verse rises early — and answers.");
    assert.equal(story.version, before.version + 1, "acceptance versions story.json like any accept");
    StoryOverviewSchema.parse(story);
  });

  /**
   * A shot, changed by the conversation that is about it.
   *
   * The seam the workspace stopped at: the scene thread was told its shots in full and could
   * describe exactly what one should become, and then the person had to go and type it into the
   * storyboard. A shot has no file, so this stages as the scene edit it is.
   */
  describe("a shot the conversation settled", () => {
    it("amends only the fields it carries, and leaves everything else exactly as it was", async () => {
      const w = await world();
      const before = w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
      const live = orderedShots(before.scenes.find((s) => s.id === "sc_04")!).find((s) => s.id === "sh_12")!;
      assert.ok(live.camera, "the fixture shot has a camera, which this amendment does not mention");

      const seq = await withCandidates(w.log, [
        candidate({
          classification: "development.shot",
          target: { kind: "shot", productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12" },
          title: "She holds the rail a beat longer",
          draft: { title: "The held rail", durationSec: 6, intent: "Held, not slow — she is deciding whether to have heard it." },
        } as Partial<WorldChangeCandidate>),
      ]);
      await wrapUp({
        store: w.store,
        gate: w.gate,
        conversationId: w.conversationId,
        requestId: "req-shot-1",
        expectedConversationSeq: seq,
        now: NOW,
      });
      const staged = (await w.gate.listOpen()).find((p) => p.kind === "scene-edit");
      assert.ok(staged, "a shot rides the scene-edit kind — it lives in the scene's file");
      const proposed = await readStagedGraphScene(w.dir, staged);
      const proposedShot = orderedShots(proposed).find((shot) => shot.id === "sh_12")!;
      assert.equal(proposedShot.durationSec, 6, "the staged graph already carries the amendment");
      assert.equal(proposedShot.camera, live.camera, "semantic editing carries fields the draft omitted");
      assert.equal(accepted(await w.gate.accept(staged.id)), "accepted");

      const after = await scanWorld(w.dir);
      const shot = orderedShots(
        after.bundle.productions.find((p) => p.meta.id === "saltlight")!.scenes.find((s) => s.id === "sc_04")!,
      ).find((s) => s.id === "sh_12")!;
      assert.equal(shot.durationSec, 6, "what was settled landed");
      assert.equal(shot.title, "The held rail", "the shot name lands independently of the change label");
      assert.match(shot.intent ?? "", /Held, not slow/);
      assert.equal(shot.camera, live.camera, "and what nobody mentioned is untouched");
      assert.equal(shot.description, live.description);
      assert.equal(shot.number, live.number, "the number is not the conversation's to move");
      assert.equal(shot.id, live.id);
    });

    it("amends a graph-backed shot through canonical order without replacing flow identities", async () => {
      const w = await world();
      const production = w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
      const legacy = legacySceneView(production.scenes.find((scene) => scene.id === "sc_04")!);
      const targetShot = legacy.shots[1]!;
      await installAuthoredVerse(w);

      const before = w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!
        .scenes.find((scene) => scene.id === "sc_04")!;
      assert.ok(isGraphScene(before));
      const beforeSequence = linearizeSceneFlow(before);
      assert.ok(beforeSequence.kind === "linear");
      assert.deepEqual(
        beforeSequence.shots.map((pair) => pair.shot.id),
        legacy.shots.map((shot) => shot.id),
        "edge order, not reversed node storage order, is canonical",
      );
      const authoredNodeId = beforeSequence.shots[1]!.nodeId;
      assert.match(authoredNodeId, /^sfn_authored-/, "the fixture carries a custom shot-node identity");

      const seq = await withCandidates(w.log, [
        candidate({
          classification: "development.shot",
          target: {
            kind: "shot",
            productionId: "saltlight",
            sceneId: "sc_04",
            shotId: targetShot.id,
          },
          title: "The lamps hold",
          draft: { camera: "CU · locked to the last lamp" },
        } as Partial<WorldChangeCandidate>),
      ]);
      await wrapUp({
        store: w.store,
        gate: w.gate,
        conversationId: w.conversationId,
        requestId: "req-graph-shot",
        expectedConversationSeq: seq,
        now: NOW,
      });
      const staged = (await w.gate.listOpen()).find((proposal) => proposal.kind === "scene-edit");
      assert.ok(staged, "materialisation accepts the graph instead of requiring shots[] on the record");
      const proposed = await readStagedGraphScene(w.dir, staged);
      const proposedSequence = linearizeSceneFlow(proposed);
      assert.ok(proposedSequence.kind === "linear");
      assert.equal(proposedSequence.shots[1]!.shot.camera, "CU · locked to the last lamp");
      assert.equal(proposedSequence.shots[1]!.nodeId, authoredNodeId);
      assert.equal(proposed.flow.entryNodeId, before.flow.entryNodeId);
      assert.equal(proposed.flow.exitNodeId, before.flow.exitNodeId);
      assert.deepEqual(
        proposed.flow.nodes.map((node) => node.id).sort(),
        before.flow.nodes.map((node) => node.id).sort(),
        "every existing node keeps its identity",
      );
      assert.deepEqual(
        [...proposed.flow.edges].sort((left, right) => left.id.localeCompare(right.id)),
        [...before.flow.edges].sort((left, right) => left.id.localeCompare(right.id)),
        "an amendment keeps every existing edge and its authored id",
      );
      assert.deepEqual(proposed.flow.storyboardGroups, before.flow.storyboardGroups);
      assert.deepEqual(proposed.boards, before.boards, "authored board identity is carried unchanged");
      assert.deepEqual(proposed.board, before.board, "the compiled board reference is not part of the shot edit");
      assert.equal(accepted(await w.gate.accept(staged.id)), "accepted");

      const raw = await readFile(
        join(w.dir, "productions", "saltlight", "scenes", "04-the-verse-rises.json"),
        "utf8",
      );
      const after = GraphSceneSchema.parse(JSON.parse(raw));
      const afterSequence = linearizeSceneFlow(after);
      assert.ok(afterSequence.kind === "linear");
      assert.deepEqual(
        afterSequence.shots.map((pair) => pair.shot.id),
        beforeSequence.shots.map((pair) => pair.shot.id),
      );
      assert.equal(afterSequence.shots[1]!.shot.camera, "CU · locked to the last lamp");
      assert.equal(afterSequence.shots[1]!.nodeId, authoredNodeId);
      assert.deepEqual(after.flow, proposed.flow, "acceptance lands the graph that was staged");
      assert.deepEqual(after.boards, proposed.boards);
    });

    it("adds a shot at the end, with an id minted past every scene in the production", async () => {
      const w = await world();
      const production = w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
      const highest = production.scenes
        .flatMap((s) => orderedShots(s))
        .reduce((a, s) => Math.max(a, Number(s.id.replace(/^sh_0*/, "")) || 0), 0);
      const sceneBefore = legacySceneView(production.scenes.find((s) => s.id === "sc_04")!);

      const seq = await withCandidates(w.log, [
        candidate({
          classification: "development.shot",
          target: { kind: "shot", productionId: "saltlight", sceneId: "sc_04" },
          title: "One more, on the water",
          draft: {
            title: "The water answers",
            description: "The harbour goes flat, and something under it moves.",
            durationSec: 4,
          },
        } as Partial<WorldChangeCandidate>),
      ]);
      await wrapUp({
        store: w.store,
        gate: w.gate,
        conversationId: w.conversationId,
        requestId: "req-shot-2",
        expectedConversationSeq: seq,
        now: NOW,
      });
      const staged = (await w.gate.listOpen()).find((p) => p.kind === "scene-edit")!;
      const proposed = await readStagedGraphScene(w.dir, staged);
      const proposedShots = orderedShots(proposed);
      assert.deepEqual(
        proposedShots.slice(0, -1).map((shot) => shot.id),
        sceneBefore.shots.map((shot) => shot.id),
        "insertion preserves every existing shot identity and order",
      );
      const proposedShot = proposedShots[proposedShots.length - 1]!;
      assert.equal(proposedShot.title, "The water answers");
      assert.equal(
        Number(proposedShot.id.replace(/^sh_0*/, "")),
        highest + 1,
        "the staged id clears every shot in the production",
      );
      assert.equal(accepted(await w.gate.accept(staged.id)), "accepted");

      const after = await scanWorld(w.dir);
      const scene = legacySceneView(
        after.bundle.productions.find((p) => p.meta.id === "saltlight")!.scenes.find((s) => s.id === "sc_04")!,
      );
      assert.equal(scene.shots.length, sceneBefore.shots.length + 1, "it went on the end");
      const added = scene.shots[scene.shots.length - 1]!;
      assert.equal(added.title, "The water answers");
      assert.equal(
        Number(added.id.replace(/^sh_0*/, "")),
        highest + 1,
        "the id clears every shot in the production — takes key by bare shot id",
      );
      assert.deepEqual(
        scene.shots.map((shot) => shot.number),
        scene.shots.map((_shot, index) => index + 1),
        "semantic insertion derives display numbers from graph order",
      );
    });

    it("refuses a new shot with nothing in it, and one naming a shot the scene does not have", async () => {
      const w = await world();
      const thin = await withCandidates(w.log, [
        candidate({
          classification: "development.shot",
          target: { kind: "shot", productionId: "saltlight", sceneId: "sc_04" },
          title: "A shot with only a duration",
          draft: { durationSec: 3 },
        } as Partial<WorldChangeCandidate>),
      ]);
      await wrapUp({
        store: w.store,
        gate: w.gate,
        conversationId: w.conversationId,
        requestId: "req-shot-3",
        expectedConversationSeq: thin,
        now: NOW,
      }).catch(() => undefined);
      assert.equal(
        (await w.gate.listOpen()).filter((p) => p.kind === "scene-edit").length,
        0,
        "a shot with no title and no description is a placeholder, and the storyboard has a button for that",
      );

      const w2 = await world();
      const missing = await withCandidates(w2.log, [
        candidate({
          classification: "development.shot",
          target: { kind: "shot", productionId: "saltlight", sceneId: "sc_04", shotId: "sh_404" },
          title: "Amending a ghost",
          draft: { intent: "whatever" },
        } as Partial<WorldChangeCandidate>),
      ]);
      await wrapUp({
        store: w2.store,
        gate: w2.gate,
        conversationId: w2.conversationId,
        requestId: "req-shot-4",
        expectedConversationSeq: missing,
        now: NOW,
      }).catch(() => undefined);
      assert.equal((await w2.gate.listOpen()).filter((p) => p.kind === "scene-edit").length, 0);
    });
  });

  it("a scene-script candidate stages a graph and edits only its script", async () => {
    const w = await world();
    await installAuthoredVerse(w);
    const before = w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!
      .scenes.find((scene) => scene.id === "sc_04")!;
    assert.ok(isGraphScene(before));
    const seq = await withCandidates(w.log, [
      candidate({
        classification: "development.scene-script",
        target: { kind: "scene", productionId: "saltlight", sceneId: "sc_04" },
        title: "The verse rises gets its blocks",
        draft: {
          blocks: [
            { id: "blk_the-empty-page", kind: "action", text: "Maren opens the ledger to the 14th." },
            { id: "blk_at-bells", kind: "dialogue", speaker: "maren-kest", text: "That page was here at bells." },
          ],
        },
      } as Partial<WorldChangeCandidate>),
    ]);
    await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-2",
      expectedConversationSeq: seq,
      now: NOW,
    });
    const staged = (await w.gate.listOpen()).find((p) => p.kind === "scene-edit");
    assert.ok(staged, "script proposals ride the scene-edit kind");
    const proposed = await readStagedGraphScene(w.dir, staged);
    assert.equal(proposed.script?.blocks.length, 2);
    assert.deepEqual(
      proposed,
      { ...before, script: proposed.script },
      "script materialisation preserves graph, node, edge, board, and scene identity",
    );
    const accepted = await w.gate.accept(staged.id);
    assert.equal(accepted.status, "accepted");
    const raw = await readFile(
      join(w.dir, "productions", "saltlight", "scenes", "04-the-verse-rises.json"),
      "utf8",
    );
    const scene = GraphSceneSchema.parse(JSON.parse(raw));
    assert.equal(scene.script?.blocks.length, 2, "the blocks landed inside the scene file");
    assert.deepEqual(scene.flow, before.flow, "the accepted script edit keeps every flow identity");
    assert.deepEqual(scene.boards, before.boards);
  });

  it("an episode candidate creates a stem-stable episode file through the episode-edit kind", async () => {
    const w = await world();
    const seq = await withCandidates(w.log, [
      candidate({
        classification: "development.episode",
        target: { kind: "episode", productionId: "saltlight" },
        title: "Episode three: the missing night",
        draft: { title: "The missing night", order: 3, promise: { opens: "The page is gone." } },
      } as Partial<WorldChangeCandidate>),
    ]);
    await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-3",
      expectedConversationSeq: seq,
      now: NOW,
    });
    const staged = (await w.gate.listOpen()).find((p) => p.kind === "episode-edit");
    assert.ok(staged);
    assert.equal(staged.targets[0]!.path, "productions/saltlight/episodes/the-missing-night.json");
    const accepted = await w.gate.accept(staged.id);
    assert.equal(accepted.status, "accepted");
    const after = await scanWorld(w.dir);
    const episode = after.bundle.productions.find((p) => p.meta.id === "saltlight")!.episodes[0]!;
    assert.equal(episode.id, "ep_the-missing-night", "identity from the slug, never the position");
    assert.equal(episode.order, 3);
  });

  it("an episode may only list scenes that exist — a guessed membership is refused (round 3)", async () => {
    // Driven live 2026-08-22: a wrap-up decided "this episode has two scenes" and wrote their
    // guessed ids straight into the membership list. Nothing had created them and nothing ever
    // would — scene records are made from the episode page — so the board promised scenes it
    // could not open.
    const w = await world();
    const seq = await withCandidates(w.log, [
      candidate({
        classification: "development.episode",
        target: { kind: "episode", productionId: "saltlight" },
        title: "Episode four, with invented scenes",
        draft: {
          title: "The invented pair",
          order: 4,
          scenes: ["sc_the-wrong-shape", "sc_the-true-answer"],
        },
      } as Partial<WorldChangeCandidate>),
    ]);
    const outcome = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-scenes",
      expectedConversationSeq: seq,
      now: NOW,
    }).catch((err: unknown) => err);
    // Whether the wrap-up throws whole or degrades per candidate, the invented episode must
    // never stage: its path is derived from its title, so its absence is the refusal.
    const staged = (await w.gate.listOpen()).filter((p) => p.kind === "episode-edit");
    assert.ok(
      !staged.some((p) => p.targets.some((t) => t.path.includes("the-invented-pair"))),
      `the guessed membership never reaches a proposal (outcome: ${outcome instanceof Error ? outcome.message : "settled"})`,
    );
  });

  it("a membership naming a real scene stages normally", async () => {
    // A fresh world: the refused candidate above stays undecided in its conversation, and a
    // second wrap there would re-materialise it and refuse again — correctly.
    const w = await world();
    const seq = await withCandidates(w.log, [
      candidate({
        classification: "development.episode",
        target: { kind: "episode", productionId: "saltlight" },
        title: "Episode five, honest membership",
        draft: { title: "The honest one", order: 5, scenes: ["sc_04"] },
      } as Partial<WorldChangeCandidate>),
    ]);
    await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-scenes-2",
      expectedConversationSeq: seq,
      now: NOW,
    });
    const ok = (await w.gate.listOpen()).find(
      (p) => p.kind === "episode-edit" && p.targets[0]!.path.includes("the-honest-one"),
    );
    assert.ok(ok, "a membership naming a real scene stages normally");
  });

  it("a production change cannot land together with world changes", async () => {
    const w = await world();
    const groupId = newId("grp");
    const seq = await withCandidates(w.log, [
      candidate({
        classification: "development.overview",
        target: { kind: "production", productionId: "saltlight" },
        groupId,
        draft: { logline: "A grouped overview." },
      } as Partial<WorldChangeCandidate>),
      candidate({
        classification: "canon.create",
        groupId,
        title: "Bells may pass sideways",
        checks: {
          state: "complete",
          basedOnCanonRevision: 42,
          required: ["canon-search"],
          completed: ["canon-search"],
          consulted: [],
          likelyDuplicates: [],
          possibleAmendments: [],
          contradictionCandidates: [],
          explanation: "Nothing like it exists.",
        },
        draft: { type: "lore", title: "The bells", statement: "The bells may pass sideways.", links: [] },
      } as Partial<WorldChangeCandidate>),
    ]);
    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-4",
          expectedConversationSeq: seq,
          now: NOW,
        }),
      /cannot land together with world changes/,
      "world facts cross over separately — the guide's fourth gate rule",
    );
    assert.equal(
      (await w.gate.listOpen()).filter((p) => p.kind !== "sheet-edit").length,
      1,
      "nothing new was staged (only the fixture's own proposal remains)",
    );
  });

  /*
   * The Episode Chat half of "an accept that changes nothing should say so".
   *
   * These records are written as the draft merged onto what is live, so a draft restating what
   * the record already says merges to exactly itself — and the file still differs, because the
   * committer stamps `version`. Accepted, that is a version cut and a history snapshot over a
   * record nobody changed, reported to the person as saved.
   *
   * Judged by performing the same merge materialise writes from, so the check cannot drift from
   * the file. The arcs case below is why that matters.
   */
  it("holds back an overview that restates the story the production already has", async () => {
    const w = await world();
    const live = w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.story!;
    const restated = candidate({
      classification: "development.overview",
      target: { kind: "production", productionId: "saltlight" },
      draft: { logline: live.logline, spine: live.spine },
    } as Partial<WorldChangeCandidate>);
    const readiness = evaluateReadiness([restated], w.store.getBundle());
    assert.deepEqual(readiness.carried, [], "it never becomes a proposal");
    assert.deepEqual(readiness.notCarried.map((n) => n.reason), ["changes-nothing"]);
  });

  it("carries an overview that changes one line of it", async () => {
    const w = await world();
    const live = w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.story!;
    const moved = candidate({
      classification: "development.overview",
      target: { kind: "production", productionId: "saltlight" },
      draft: { logline: live.logline, spine: "A tide-caller finally asks why it has never cost her." },
    } as Partial<WorldChangeCandidate>);
    assert.equal(evaluateReadiness([moved], w.store.getBundle()).carried.length, 1);
  });

  it("holds back a shot amendment that restates the shot", async () => {
    const w = await world();
    const scene = legacySceneView(w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.scenes[0]!);
    const shot = scene.shots[0]!;
    const restated = candidate({
      classification: "development.shot",
      target: { kind: "shot", productionId: "saltlight", sceneId: scene.id, shotId: shot.id },
      draft: { title: shot.title, description: shot.description },
    } as Partial<WorldChangeCandidate>);
    assert.equal(
      evaluateReadiness([restated], w.store.getBundle()).notCarried[0]?.reason,
      "changes-nothing",
    );
  });

  it("carries a shot amendment that moves the camera, leaving the rest of the shot alone", async () => {
    const w = await world();
    const scene = legacySceneView(w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.scenes[0]!);
    const shot = scene.shots[0]!;
    const moved = candidate({
      classification: "development.shot",
      target: { kind: "shot", productionId: "saltlight", sceneId: scene.id, shotId: shot.id },
      draft: { title: shot.title, camera: "WIDE · handheld, from the water" },
    } as Partial<WorldChangeCandidate>);
    assert.equal(evaluateReadiness([moved], w.store.getBundle()).carried.length, 1);
  });

  it("refuses a whole scene-script replacement without a complete current target receipt", async () => {
    const w = await world();
    const production = w.store.getBundle().productions.find((entry) => entry.meta.id === "saltlight")!;
    const scene = production.scenes[0]!;
    const replacement = candidate({
      classification: "development.scene-script",
      target: { kind: "scene", productionId: "saltlight", sceneId: scene.id },
      draft: { blocks: [{ id: "blk_replacement", kind: "action", text: "A different opening." }] },
    } as Partial<WorldChangeCandidate>);
    replacement.checks = { ...replacement.checks, targetReads: [] };

    assert.equal(
      evaluateReadiness([replacement], w.store.getBundle()).notCarried[0]?.reason,
      "incomplete-read",
    );

    replacement.checks = {
      ...replacement.checks,
      targetReads: [{
        checkId: newId("check"),
        target: { requirement: "scenes", id: sceneScriptTargetId("saltlight", scene.id) },
        observedRevisionOrDigest: sceneScriptFence(production, scene.id),
      }],
    };
    assert.equal(evaluateReadiness([replacement], w.store.getBundle()).carried.length, 1);

    replacement.checks.targetReads![0]!.observedRevisionOrDigest = `v${scene.version}:sha256:${"0".repeat(64)}`;
    assert.equal(
      evaluateReadiness([replacement], w.store.getBundle()).notCarried[0]?.reason,
      "incomplete-read",
      "a receipt for an older script cannot authorize replacing the current one",
    );
  });

  it("requires complete reads before replacing overview, season or episode member lists", async () => {
    const w = await world();
    const bundle = w.store.getBundle();
    const production = bundle.productions.find((entry) => entry.meta.id === "saltlight")!;
    const episode = {
      id: "ep_receipt",
      version: 1,
      order: 1,
      title: "Receipt episode",
      scenes: [production.scenes[0]!.id],
    };
    production.episodes.push(episode);
    const replacements = [
      {
        candidate: candidate({
          classification: "development.overview",
          target: { kind: "production", productionId: "saltlight" },
          draft: { acts: [{ title: "A newly ordered act" }] },
        } as Partial<WorldChangeCandidate>),
        target: { requirement: "story" as const, id: "saltlight" },
        observedRevisionOrDigest: storyFence(production),
      },
      {
        candidate: candidate({
          classification: "development.season",
          target: { kind: "production", productionId: "saltlight" },
          draft: { arcs: [{ id: "arc_receipt", title: "A newly ordered arc" }] },
        } as Partial<WorldChangeCandidate>),
        target: { requirement: "seasons" as const, id: "saltlight" },
        observedRevisionOrDigest: seasonFence(production),
      },
      {
        candidate: candidate({
          classification: "development.episode",
          target: { kind: "episode", productionId: "saltlight", episodeId: episode.id },
          draft: { scenes: episode.scenes.length > 0 ? [] : [production.scenes[0]!.id] },
        } as Partial<WorldChangeCandidate>),
        target: { requirement: "episodes" as const, id: "saltlight" },
        observedRevisionOrDigest: episodesFence(production),
      },
    ];

    for (const replacement of replacements) {
      replacement.candidate.checks = { ...replacement.candidate.checks, targetReads: [] };
      assert.equal(evaluateReadiness([replacement.candidate], bundle).notCarried[0]?.reason, "incomplete-read");
      replacement.candidate.checks = {
        ...replacement.candidate.checks,
        targetReads: [{
          checkId: newId("check"),
          target: replacement.target,
          observedRevisionOrDigest: replacement.observedRevisionOrDigest,
        }],
      };
      assert.equal(evaluateReadiness([replacement.candidate], bundle).carried.length, 1);
    }
  });

  it("never holds back a new shot or a new episode — a creation always writes", async () => {
    const w = await world();
    const scene = legacySceneView(w.store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.scenes[0]!);
    const added = candidate({
      classification: "development.shot",
      target: { kind: "shot", productionId: "saltlight", sceneId: scene.id },
      draft: { title: "The water disagrees", description: "@maren-kest reads the rail." },
    } as Partial<WorldChangeCandidate>);
    const born = candidate({
      classification: "development.episode",
      target: { kind: "episode", productionId: "saltlight" },
      draft: { title: "Count It Again" },
    } as Partial<WorldChangeCandidate>);
    assert.equal(evaluateReadiness([added, born], w.store.getBundle()).carried.length, 2);
  });

  /*
   * The arcs rule, which is the whole reason the check performs the merge instead of describing
   * it. Arcs merge by id, so a draft restating one arc's note leaves the setup/turn/payoff
   * placements the board authored exactly where they were. A check that compared the draft's arcs
   * to the live arcs wholesale would call this pair the wrong way round in both directions.
   */
  const withSeason = (arcs: Array<Record<string, unknown>>) =>
    ({
      canon: [],
      sheets: [],
      proposals: [],
      series: [],
      productions: [
        {
          meta: { id: "saltlight" },
          story: null,
          scenes: [],
          episodes: [],
          season: { version: 2, question: "What does the verse cost?", arcs },
        },
      ],
    }) as never;

  const seasonArcs = (arcs: Array<Record<string, unknown>>) =>
    candidate({
      classification: "development.season",
      target: { kind: "production", productionId: "saltlight" },
      draft: { arcs },
    } as Partial<WorldChangeCandidate>);

  it("holds back a season draft that restates an arc, placements and all", () => {
    const live = [{ id: "arc_1", note: "Maren stops not-asking.", setup: "ep_1", payoff: "ep_4" }];
    const restated = seasonArcs([{ id: "arc_1", note: "Maren stops not-asking." }]);
    assert.equal(evaluateReadiness([restated], withSeason(live)).notCarried[0]?.reason, "changes-nothing");
  });

  it("carries a season draft that changes an arc's note, and never mistakes the merge for one", () => {
    const live = [{ id: "arc_1", note: "Maren stops not-asking.", setup: "ep_1", payoff: "ep_4" }];
    const moved = seasonArcs([{ id: "arc_1", note: "Maren asks, and is answered." }]);
    const readiness = evaluateReadiness([moved], withSeason(live));
    assert.equal(readiness.carried.length, 1, "a real change must never be held back as empty");
    assert.deepEqual(readiness.notCarried, []);
  });

  it("carries a season draft that adds an arc beside the one already there", () => {
    const live = [{ id: "arc_1", note: "Maren stops not-asking.", setup: "ep_1" }];
    const added = seasonArcs([{ id: "arc_1", note: "Maren stops not-asking." }, { id: "arc_2", note: "Bray pays." }]);
    assert.equal(evaluateReadiness([added], withSeason(live)).carried.length, 1);
  });

  it("a series candidate against a series that does not exist is held back as target-missing", async () => {
    const w = await world();
    const missing = candidate({
      classification: "development.series",
      target: { kind: "series", seriesId: "bell-watch" },
      draft: { engine: "Every episode answers one bell." },
    } as Partial<WorldChangeCandidate>);
    const readiness = evaluateReadiness([missing], w.store.getBundle());
    assert.equal(readiness.carried.length, 0, "nothing carries against a series that is not there");
    assert.deepEqual(
      readiness.notCarried.map((n) => n.reason),
      ["target-missing"],
      "held back by name, never a crash — a Series is created with its first season, not from a conversation",
    );
  });
});
