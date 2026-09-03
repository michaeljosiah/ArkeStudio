import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ulid, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../src/coordinator.js";
import { proposeEpisode, proposeSeason } from "../src/productions/ops.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { MarkdownFile, sha256 } from "../src/world/text-files.js";
import { makeTempRoot, WORLD_ID } from "./world/helpers.js";
import { closeOnCleanup } from "./tmp.js";

const CLOCK = "2026-09-03T12:00:00.000Z";
type Result = Extract<DomainEvent, { type: "single-act.result" }>;

async function harness(options: { derivedLook?: boolean } = {}) {
  const made = await makeTempRoot();
  if (options.derivedLook) {
    await rm(join(made.worldDir, "art-direction", "art-direction.json"));
  }
  const provider = new FsWorldProvider(made.root, { clock: () => CLOCK });
  closeOnCleanup(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  for (const proposal of await provider.gate()!.listOpen()) await provider.gate()!.discard(proposal.id);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(made.root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
  });
  const send = (msg: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
  return { ...made, provider, events, send };
}

function resultFor(events: DomainEvent[], requestId: string): Result {
  const result = events.find(
    (event): event is Result => event.type === "single-act.result" && event.requestId === requestId,
  );
  assert.ok(result, "the initiating press receives one correlated result");
  return result;
}

async function undo(h: Awaited<ReturnType<typeof harness>>, result: Result): Promise<Result> {
  assert.ok(result.undo, `${result.operation} carries its reachable undo`);
  const requestId = ulid();
  await h.send({
    kind: "undo-single-act",
    worldId: WORLD_ID,
    requestId,
    operation: result.operation,
    path: result.path,
    undo: result.undo,
  });
  const answer = resultFor(h.events, requestId);
  assert.equal(answer.disposition, "undone");
  return answer;
}

describe("remaining single-act decisions (SPEC-040)", () => {
  it("accepts canon create, amendment and settlement on press with their R-24 undos", async () => {
    const h = await harness();
    const store = h.provider.openStore()!;

    const createId = ulid();
    await h.send({
      kind: "stage-canon-entry",
      worldId: WORLD_ID,
      requestId: createId,
      entryType: "rule",
      title: "The bell answers slack water",
      statement: "The bell answers only while the harbor tide is still.",
    });
    const created = resultFor(h.events, createId);
    assert.equal(created.disposition, "accepted");
    assert.equal(created.undo?.kind, "retire");
    assert.ok((created.ripples?.length ?? 0) > 0, "authoritative canon ripples are disclosed");
    assert.equal((await h.provider.gate()!.listOpen()).length, 0, "success leaves nothing in Approvals");
    await undo(h, created);
    assert.equal(store.getBundle().canon.find((entry) => `canon/${entry.id}.md` === created.path)?.retired, true);

    const beforeAmend = store.getBundle().canon.find((entry) => entry.id === "CANON-002")!;
    const amendId = ulid();
    await h.send({
      kind: "stage-canon-amendment",
      worldId: WORLD_ID,
      requestId: amendId,
      entryId: beforeAmend.id,
      statement: "A tide-caller must stand in the water she moves.",
    });
    const amended = resultFor(h.events, amendId);
    assert.equal(amended.disposition, "accepted");
    assert.equal(amended.undo?.kind, "restore-version");
    assert.equal(amended.undo?.path, "canon/CANON-002.md");
    await undo(h, amended);
    assert.equal(store.getBundle().canon.find((entry) => entry.id === "CANON-002")?.body, beforeAmend.body);

    const threadBefore = store.getBundle().canon.find((entry) => entry.id === "CANON-044")!;
    const settleId = ulid();
    await h.send({
      kind: "settle-thread",
      worldId: WORLD_ID,
      requestId: settleId,
      entryId: threadBefore.id,
      resolvedType: "lore",
      statement: "The Chorister learned the verse from the god in winter.",
    });
    const settled = resultFor(h.events, settleId);
    assert.equal(settled.disposition, "accepted");
    await undo(h, settled);
    assert.equal(store.getBundle().canon.find((entry) => entry.id === "CANON-044")?.status, "open");
    await h.provider.close();
  });

  it("accepts rename, lock, duplicate and guest promotion with inverse or retirement undo", async () => {
    const h = await harness();
    const store = h.provider.openStore()!;
    const path = "characters/maren-kest.md";
    const original = store.getBundle().sheets.find((sheet) => sheet.id === "maren-kest")!;

    const mismatchedUndo = ulid();
    await h.send({
      kind: "undo-single-act",
      worldId: WORLD_ID,
      requestId: mismatchedUndo,
      operation: "canon-create",
      path,
      undo: { kind: "retire", path },
    });
    assert.equal(resultFor(h.events, mismatchedUndo).disposition, "refused");
    assert.notEqual(store.getBundle().sheets.find((sheet) => sheet.id === original.id)?.retired, true);

    const renameId = ulid();
    await h.send({ kind: "rename-sheet", worldId: WORLD_ID, requestId: renameId, path, name: "Maren of the Harbor" });
    const renamed = resultFor(h.events, renameId);
    assert.deepEqual(renamed.undo, { kind: "rename-sheet", path, name: original.name });
    await undo(h, renamed);
    assert.equal(store.getBundle().sheets.find((sheet) => sheet.id === original.id)?.name, original.name);

    const statusId = ulid();
    const nextStatus = original.status === "locked" ? "sketch" : "locked";
    await h.send({ kind: "set-sheet-status", worldId: WORLD_ID, requestId: statusId, path, status: nextStatus });
    const status = resultFor(h.events, statusId);
    assert.deepEqual(status.undo, { kind: "set-sheet-status", path, status: original.status });
    await undo(h, status);
    assert.equal(store.getBundle().sheets.find((sheet) => sheet.id === original.id)?.status, original.status);

    const duplicateId = ulid();
    await h.send({ kind: "duplicate-sheet", worldId: WORLD_ID, requestId: duplicateId, path, newName: "Maren's Echo" });
    const duplicated = resultFor(h.events, duplicateId);
    assert.equal(duplicated.disposition, "accepted");
    assert.equal(duplicated.undo?.kind, "retire");
    await undo(h, duplicated);
    assert.equal(store.getBundle().sheets.find((sheet) => `characters/${sheet.id}.md` === duplicated.path)?.retired, true);

    const guestPath = "characters/bray-half-hitch.md";
    const raw = await readFile(join(h.worldDir, guestPath), "utf8");
    const guest = MarkdownFile.parse(raw);
    guest.setData({ production: "saltlight" });
    await store.commit({
      kind: "test-guest",
      source: "test",
      files: [{ path: guestPath, action: "replace", content: guest.serialize(), baseHash: sha256(raw) }],
    });
    const promoteId = ulid();
    await h.send({ kind: "promote-guest", worldId: WORLD_ID, requestId: promoteId, path: guestPath });
    const promoted = resultFor(h.events, promoteId);
    assert.equal(store.getBundle().sheets.find((sheet) => sheet.id === "bray-half-hitch")?.production, undefined);
    await undo(h, promoted);
    assert.equal(store.getBundle().sheets.find((sheet) => sheet.id === "bray-half-hitch")?.retired, true);
    assert.equal((await h.provider.gate()!.listOpen()).length, 0);
    await h.provider.close();
  });

  it("accepts existing story, season and episode edits and restores each outgoing version", async () => {
    const h = await harness();
    const store = h.provider.openStore()!;
    const gate = h.provider.gate()!;

    const storyBefore = store.getBundle().productions.find((p) => p.meta.id === "the-ledger-of-nights")!.story!;
    const storyId = ulid();
    await h.send({
      kind: "propose-story-overview",
      worldId: WORLD_ID,
      requestId: storyId,
      productionId: "the-ledger-of-nights",
      logline: "One ledger answers across four watches.",
    });
    const story = resultFor(h.events, storyId);
    assert.equal(story.disposition, "accepted");
    await undo(h, story);
    assert.equal(store.getBundle().productions.find((p) => p.meta.id === "the-ledger-of-nights")?.story?.logline, storyBefore.logline);

    const seasonSetup = await proposeSeason(store, gate, {
      productionId: "saltlight",
      source: "test",
      season: { question: "Who rings the bell?" },
    });
    assert.equal((await gate.accept(seasonSetup.proposalId)).status, "accepted");
    const seasonId = ulid();
    await h.send({
      kind: "propose-season",
      worldId: WORLD_ID,
      requestId: seasonId,
      productionId: "saltlight",
      ending: "Maren rings it herself.",
    });
    const season = resultFor(h.events, seasonId);
    assert.equal(season.disposition, "accepted");
    await undo(h, season);
    assert.equal(store.getBundle().productions.find((p) => p.meta.id === "saltlight")?.season?.ending, undefined);

    const episodeSetup = await proposeEpisode(store, gate, {
      productionId: "saltlight",
      source: "test",
      episode: { title: "The first bell", scenes: [] },
    });
    assert.equal((await gate.accept(episodeSetup.proposalId)).status, "accepted");
    const episodeId = ulid();
    await h.send({
      kind: "propose-episode",
      worldId: WORLD_ID,
      requestId: episodeId,
      productionId: "saltlight",
      episodeId: "ep_the-first-bell",
      promise: { opens: "The rope moves by itself." },
    });
    const episode = resultFor(h.events, episodeId);
    assert.equal(episode.disposition, "accepted");
    await undo(h, episode);
    assert.equal(store.getBundle().productions.find((p) => p.meta.id === "saltlight")?.episodes[0]?.promise, undefined);
    assert.equal((await gate.listOpen()).length, 0);
    await h.provider.close();
  });

  it("merges into a present draft and reports an art-direction refusal without stranding it", async () => {
    const h = await harness();
    const store = h.provider.openStore()!;
    const gate = h.provider.gate()!;
    const live = await readFile(join(h.worldDir, "canon", "CANON-002.md"), "utf8");
    const stagedDoc = MarkdownFile.parse(live);
    stagedDoc.setData({ title: "Unread Studio title" });
    const existing = await gate.stage({
      kind: "canon-edit",
      summary: "Studio draft",
      source: "chat:studio",
      targets: [{ path: "canon/CANON-002.md", content: stagedDoc.serialize() }],
    });
    const amendId = ulid();
    await h.send({
      kind: "stage-canon-amendment",
      worldId: WORLD_ID,
      requestId: amendId,
      entryId: "CANON-002",
      statement: "The form's statement joins the draft.",
    });
    const merged = resultFor(h.events, amendId);
    assert.equal(merged.disposition, "merged");
    assert.equal(merged.proposalId, existing.id);
    assert.equal(store.getBundle().canon.find((entry) => entry.id === "CANON-002")?.body, MarkdownFile.parse(live).body.trim());
    const proposed = MarkdownFile.parse(await readFile(join(h.worldDir, ".proposals", existing.id, "canon", "CANON-002.md"), "utf8"));
    assert.equal(proposed.data["title"], "Unread Studio title");
    assert.equal(proposed.body.trim(), "The form's statement joins the draft.");
    await gate.discard(existing.id);

    const originalGate = h.provider.gate.bind(h.provider);
    h.provider.gate = () => gate;
    const originalAccept = gate.accept.bind(gate);
    gate.accept = async () => ({ status: "stale", stalePaths: ["art-direction.json"] });
    const lookId = ulid();
    await h.send({
      kind: "set-art-direction",
      worldId: WORLD_ID,
      requestId: lookId,
      description: "Cold silver daylight and salt-softened shadows.",
      masterLook: null,
    });
    gate.accept = originalAccept;
    h.provider.gate = originalGate;
    const refused = resultFor(h.events, lookId);
    assert.equal(refused.disposition, "refused");
    assert.equal(refused.reason, "the world moved underneath it — art-direction.json changed while this was being written");
    assert.equal((await gate.listOpen()).length, 0, "the refused press leaves no proposal as its only trace");
    await h.provider.close();
  });

  it("returns a world's first authored look to its derived state", async () => {
    const h = await harness({ derivedLook: true });
    const before = h.provider.openStore()!.getBundle().artDirection.description;
    const requestId = ulid();
    await h.send({
      kind: "set-art-direction",
      worldId: WORLD_ID,
      requestId,
      description: "Cold silver daylight and salt-softened shadows.",
      masterLook: null,
    });
    const changed = resultFor(h.events, requestId);
    assert.deepEqual(changed.undo, {
      kind: "restore-derived-art-direction",
      path: "art-direction/art-direction.json",
    });
    await undo(h, changed);
    const restored = h.provider.openStore()!.getBundle().artDirection;
    assert.equal(restored.derived, true);
    assert.equal(restored.description, before);
    await h.provider.close();
  });
});
