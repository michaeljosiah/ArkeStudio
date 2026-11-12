import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelWorldChatActionSchema, newId, ulid, type ConversationId, type EpisodeScriptBlock } from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { createProduction } from "../../src/productions/ops.js";
import { readDramaSource, saveEpisodeScript } from "../../src/productions/audio-drama.js";
import { stageWorldChatProductionAuthoredAction } from "../../src/world-chat/production-authoring.js";
import { ConversationActionPreparationError } from "../../src/arke-actions/lifecycle.js";
import { productionRecord } from "../../src/world-chat/production-record.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/** Arke's episode script (SPEC-057 R-9, R-54): staged whole as a proposal, kept or discarded by the author. */
const CLOCK = "2026-10-18T12:00:00.000Z";
async function drama(blocks: EpisodeScriptBlock[]) {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  const id = await createProduction(store, { title: "Low Water", medium: "story", productionKind: "audio-drama" });
  if (blocks.length > 0) await saveEpisodeScript(store, id, { episode: 1, title: "The tide turns", blocks, baseHash: null });
  return { store, id, gate: new ProposalManager(store), intent: { actionId: newId("act"), conversationId: newId("cv") as ConversationId } };
}

describe("Arke's episode script (SPEC-057 R-54)", () => {
  it("is a model action Arke can name, with blocks that need no id", () => {
    const parsed = ModelWorldChatActionSchema.safeParse({
      kind: "production-episode-script", productionId: "low-water", episode: 1, baseHash: null, checkReceiptIds: [`check_${ulid()}`],
      blocks: [{ kind: "heading", place: "The quay" }, { kind: "dialogue", speaker: "maren-kest", words: "Climb." }],
    });
    assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
  });

  it("stages the whole script as a proposal, keeping unchanged ids, and writes nothing until it is kept", async () => {
    const scene: EpisodeScriptBlock = { id: ulid(), kind: "heading", place: "The bell tower" };
    const line: EpisodeScriptBlock = { id: ulid(), kind: "dialogue", speaker: "maren-kest", words: "Bray. Bray, look." };
    const { store, id, gate, intent } = await drama([scene, line]);
    const baseHash = store.getBundle().productions.find((p) => p.meta.id === id)!.episodeScripts![0]!.hash;
    const proposal = await stageWorldChatProductionAuthoredAction(store, gate, intent, {
      kind: "world-chat-production-episode-script", worldId: store.worldId,
      action: { kind: "production-episode-script", productionId: id, episode: 1, baseHash, checkReceiptIds: [], blocks: [
        { id: scene.id, kind: "heading", place: "The bell tower" },
        { kind: "ambience", heard: "Wind in the stair.", until: "new-1" },
        { id: line.id, kind: "dialogue", speaker: "maren-kest", words: "Bray. Bray, look — the stairs." },
        { id: "new-1", kind: "dialogue", speaker: "bray", words: "I see them." },
      ] },
    });
    assert.equal(proposal.kind, "episode-script");
    const before = store.getBundle().productions.find((p) => p.meta.id === id)!.episodeScripts![0]!.script;
    assert.equal(before.blocks.length, 2, "the script is untouched while the draft waits");
    const staged = store.getBundle().proposals.find((entry) => entry.proposal.id === proposal.id)!;
    const drafted = Object.values(staged.episodeScripts ?? {})[0]!;
    assert.deepEqual(drafted.blocks.map((block) => block.id).slice(0, 1), [scene.id]);
    assert.equal(drafted.blocks[2]!.id, line.id, "a rewritten line keeps its id");
    const bed = drafted.blocks[1]!;
    assert.ok(bed.kind === "ambience" && bed.until === drafted.blocks[3]!.id, "the bed's until follows Arke's key to the new block's ULID");
    assert.equal((await gate.accept(proposal.id)).status, "accepted");
    const after = store.getBundle().productions.find((p) => p.meta.id === id)!.episodeScripts![0]!.script;
    assert.equal(after.blocks.length, 4);
  });

  it("refuses a script for a production that is not an audio drama, and one whose relations are broken", async () => {
    const { store, id, gate, intent } = await drama([]);
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, {
      kind: "world-chat-production-episode-script", worldId: store.worldId,
      action: { kind: "production-episode-script", productionId: "the-ledger-of-nights", episode: 1, baseHash: null, checkReceiptIds: [], blocks: [{ kind: "heading", place: "x" }] },
    }), /not an audio drama/);
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, {
      kind: "world-chat-production-episode-script", worldId: store.worldId,
      action: { kind: "production-episode-script", productionId: id, episode: 1, baseHash: null, checkReceiptIds: [],
        blocks: [{ kind: "dialogue", speaker: "maren-kest", words: "Cut off", cut: true }] },
    }));
  });
});

describe("codex round 1 on PR 1874", () => {
  it("refuses a draft written from a script that has changed since it was read", async () => {
    const scene: EpisodeScriptBlock = { id: ulid(), kind: "heading", place: "The bell tower" };
    const { store, id, gate, intent } = await drama([scene]);
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, {
      kind: "world-chat-production-episode-script", worldId: store.worldId,
      action: { kind: "production-episode-script", productionId: id, episode: 1, baseHash: "sha256:what-arke-read", checkReceiptIds: [], blocks: [] },
    }), /changed since it was read/);
  });
});

describe("codex round 2 on PR 1874", () => {
  it("stages one draft of a script at a time, and none placing a sound the production cannot use", async () => {
    const scene: EpisodeScriptBlock = { id: ulid(), kind: "heading", place: "The quay" };
    const { store, id, gate, intent } = await drama([scene]);
    const baseHash = store.getBundle().productions.find((p) => p.meta.id === id)!.episodeScripts![0]!.hash;
    const stage = (blocks: unknown[]) => stageWorldChatProductionAuthoredAction(store, gate, intent, {
      kind: "world-chat-production-episode-script", worldId: store.worldId,
      action: { kind: "production-episode-script", productionId: id, episode: 1, baseHash, checkReceiptIds: [], blocks: blocks as never },
    });
    await assert.rejects(stage([{ id: scene.id, kind: "heading", place: "The quay" }, { kind: "sound", heard: "A bell.", soundArtifact: "ar_01ARZ3NDEKTSV4RRFFQ69G5FAV" }]), /cannot use/);
    await stage([{ id: scene.id, kind: "heading", place: "The quay, at night" }]);
    await assert.rejects(stage([{ id: scene.id, kind: "heading", place: "The quay, at dawn" }]), /is waiting/);
  });
});

describe("codex round 2 on PR 1878", () => {
  it("gives a hashless pin the chapter's hash at its version, and keeps that text", async () => {
    const { store, id, gate, intent } = await drama([]);
    const story = store.getBundle().productions.find((p) => p.meta.id === "the-ledger-of-nights")!;
    const chapter = story.chapters[0]!;
    const proposal = await stageWorldChatProductionAuthoredAction(store, gate, intent, {
      kind: "world-chat-production-episode-script", worldId: store.worldId,
      action: { kind: "production-episode-script", productionId: id, episode: 1, baseHash: null, checkReceiptIds: [],
        blocks: [{ kind: "heading", place: "The quay", source: { story: story.meta.id, chapter: chapter.id, version: chapter.version ?? 1 } }] },
    });
    const staged = Object.values(store.getBundle().proposals.find((entry) => entry.proposal.id === proposal.id)!.episodeScripts ?? {})[0]!;
    const pin = staged.blocks[0]!.kind === "heading" ? staged.blocks[0]!.source : undefined;
    assert.equal(pin?.hash, chapter.hash);
    assert.ok((await readDramaSource(store, id, chapter.hash!)).length > 0, "the pinned text is kept when the draft is staged");
  });
});

describe("issue 1883: a new drama's pilot", () => {
  it("lists the planned episodes with no script for Arke, written with baseHash null, and no scene episodes", async () => {
    const { store, id } = await drama([]);
    const record = productionRecord(store.getBundle(), id) as { unwrittenEpisodes?: { episodes: number[]; baseHash: null }; episodes?: unknown };
    assert.deepEqual(record.unwrittenEpisodes?.episodes, [1, 2, 3, 4, 5, 6]);
    assert.equal(record.unwrittenEpisodes?.baseHash, null);
    // The read to cite (issue 1888): Arke cited get_production, a context read, and was refused.
    assert.match((record.unwrittenEpisodes as { howToWrite?: string } | undefined)?.howToWrite ?? "", /get_production_metadata receipt/);
    assert.equal(record.episodes, undefined, "an empty scene-episode list read as no episodes to write");
    await saveEpisodeScript(store, id, { episode: 1, title: "", blocks: [{ id: ulid(), kind: "heading", place: "The quay" }], baseHash: null });
    assert.deepEqual((productionRecord(store.getBundle(), id) as { unwrittenEpisodes: { episodes: number[] } }).unwrittenEpisodes.episodes, [2, 3, 4, 5, 6]);
  });

  it("refuses in words Arke can act on, which the lifecycle passes on", async () => {
    const { store, id, gate, intent } = await drama([]);
    const stage = (baseHash: string | null) => stageWorldChatProductionAuthoredAction(store, gate, intent, {
      kind: "world-chat-production-episode-script", worldId: store.worldId,
      action: { kind: "production-episode-script", productionId: id, episode: 1, baseHash, checkReceiptIds: [], blocks: [] },
    });
    await assert.rejects(stage("sha256:guessed"), (error) => error instanceof ConversationActionPreparationError && /no script yet\. Write it with baseHash null/.test(error.message));
    await saveEpisodeScript(store, id, { episode: 1, title: "", blocks: [], baseHash: null });
    await assert.rejects(stage(null), /already has a script\. Name the baseHash/);
  });
});
