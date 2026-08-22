import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  newId,
  SceneSchema,
  StoryOverviewSchema,
  type CandidateId,
  type ConversationId,
  type MessageId,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { describeEntryContext } from "../../src/world-chat/entry-context.js";
import { evaluateReadiness } from "../../src/world-chat/readiness.js";
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

  it("a scene-script candidate rewrites the whole scene with its blocks, gated as scene-edit", async () => {
    const w = await world();
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
    const accepted = await w.gate.accept(staged.id);
    assert.equal(accepted.status, "accepted");
    const raw = await readFile(
      join(w.dir, "productions", "saltlight", "scenes", "04-the-verse-rises.json"),
      "utf8",
    );
    const scene = SceneSchema.parse(JSON.parse(raw));
    assert.equal(scene.script?.blocks.length, 2, "the blocks landed inside the scene file");
    assert.equal(scene.shots.length > 0, true, "the shots the scene already had are untouched");
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
