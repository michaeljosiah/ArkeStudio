import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  agentForPurpose,
  ulid,
  type ClientMessage,
  type DomainEvent,
  type HarnessAdapter,
} from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../src/coordinator.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { MarkdownFile } from "../src/world/text-files.js";
import { makeTempRoot, WORLD_ID } from "./world/helpers.js";
import { closeOnCleanup } from "./tmp.js";

const CLOCK = "2026-09-03T12:00:00.000Z";
const MAREN = "characters/maren-kest.md";

type SheetResult = Extract<DomainEvent, { type: "sheet.edit-result" }>;

async function harness() {
  const made = await makeTempRoot();
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
  return { ...made, provider, coordinator, events, send };
}

function editMessage(
  sections: Array<{ heading: string; body: string }>,
  dirtyHeadings: string[],
): Extract<ClientMessage, { kind: "stage-sheet-edit" }> {
  return {
    kind: "stage-sheet-edit",
    worldId: WORLD_ID,
    requestId: ulid(),
    path: MAREN,
    summary: "Edit Maren Kest",
    sections,
    dirtyHeadings,
  };
}

function resultFor(events: DomainEvent[], requestId: string): SheetResult {
  const result = events.find(
    (event): event is SheetResult => event.type === "sheet.edit-result" && event.requestId === requestId,
  );
  assert.ok(result, "the form press receives one correlated result");
  return result;
}

describe("sheet form inline decisions (SPEC-040)", () => {
  for (const fullForm of [false, true]) it(`preserves omitted and unchanged sections when saving ${fullForm ? "a full form" : "one section"}`, async () => {
    const h = await harness();
    const path = "locations/the-quiet-ward.md";
    const before = h.provider.openStore()!.getBundle().sheets.find(sheet => sheet.id === "the-quiet-ward")!;
    const customs = { heading: "Customs", body: "Visitors leave the passage clear." };
    const sections = fullForm ? before.sections.map(section => section.heading === "Customs" ? customs : { ...section, body: "Stale form text must not overwrite this section." }) : [customs];
    const message = { ...editMessage(sections, ["Customs"]), path };
    await h.send(message);
    assert.equal(resultFor(h.events, message.requestId).disposition, "accepted");
    const after = h.provider.openStore()!.getBundle().sheets.find(sheet => sheet.id === before.id)!;
    assert.equal(after.version, before.version + 1);
    assert.deepEqual(after.sections, before.sections.map(section => section.heading === "Customs" ? customs : section));
    assert.deepEqual(after.canonRules, before.canonRules);
    assert.deepEqual(after.links, before.links);
    await h.provider.close();
  });

  it("saves a role alone without changing prose and clears an explicitly named section", async () => {
    const h = await harness();
    const before = h.provider.openStore()!.getBundle().sheets.find(sheet => sheet.id === "maren-kest")!;
    const role = { ...editMessage([{ heading: "Essence", body: "Stale and ignored." }], []), role: "Harbour witness" };
    await h.send(role);
    assert.equal(resultFor(h.events, role.requestId).disposition, "accepted");
    let after = h.provider.openStore()!.getBundle().sheets.find(sheet => sheet.id === before.id)!;
    assert.equal(after.role, role.role);
    assert.deepEqual(after.sections, before.sections);
    const clear = editMessage([{ heading: "Essence", body: "" }], ["Essence"]);
    await h.send(clear);
    assert.equal(resultFor(h.events, clear.requestId).disposition, "accepted");
    after = h.provider.openStore()!.getBundle().sheets.find(sheet => sheet.id === before.id)!;
    assert.equal(after.sections.find(section => section.heading === "Essence")?.body, "");
    assert.deepEqual(after.sections.filter(section => section.heading !== "Essence"), before.sections.filter(section => section.heading !== "Essence"));
    await h.provider.close();
  });

  it("refuses unknown, missing, duplicate and empty section changes without staging or deleting content", async () => {
    const h = await harness();
    const before = await readFile(join(h.worldDir, MAREN), "utf8");
    for (const [sections, dirty] of [
      [[{ heading: "Typo", body: "No" }], ["Typo"]],
      [[{ heading: "Essence", body: "No" }], ["Appearance"]],
      [[{ heading: "Essence", body: "One" }, { heading: "Essence", body: "Two" }], ["Essence"]],
      [[{ heading: "Essence", body: "No" }], []],
    ] as Array<[Array<{ heading: string; body: string }>, string[]]>) {
      const message = editMessage(sections, dirty);
      await h.send(message);
      assert.equal(resultFor(h.events, message.requestId).disposition, "refused");
      assert.equal(await readFile(join(h.worldDir, MAREN), "utf8"), before);
      assert.equal((await h.provider.gate()!.listOpen()).length, 0);
    }
    await h.provider.close();
  });

  it("stages and accepts in one command, discloses ripples, and can undo", async () => {
    const h = await harness();
    const before = h.provider.openStore()!.getBundle().sheets.find((sheet) => sheet.id === "maren-kest")!;
    const sections = before.sections.map((section) =>
      section.heading === "Essence" ? { ...section, body: "She hears the harbor answer back." } : section,
    );
    const message = editMessage(sections, ["Essence"]);

    await h.send(message);

    const result = resultFor(h.events, message.requestId);
    assert.equal(result.disposition, "accepted");
    assert.equal(result.undoVersion, before.version);
    assert.ok((result.ripples ?? []).length > 0, "authoritative nonempty ripples return to the initiating form");
    const world = h.provider.openStore()!.getBundle();
    assert.equal(world.sheets.find((sheet) => sheet.id === "maren-kest")?.version, before.version + 1);
    assert.equal(world.proposals.some((proposal) => proposal.proposal.targets.some((target) => target.path === MAREN)), false);

    const undoRequest = ulid();
    await h.send({
      kind: "restore-sheet-version",
      worldId: WORLD_ID,
      requestId: undoRequest,
      path: MAREN,
      version: before.version,
    });
    assert.equal(resultFor(h.events, undoRequest).disposition, "restored");
    const restored = h.provider.openStore()!.getBundle().sheets.find((sheet) => sheet.id === "maren-kest")!;
    assert.equal(restored.sections.find((section) => section.heading === "Essence")?.body, before.sections.find((section) => section.heading === "Essence")?.body);
    await h.provider.close();
  });

  for (const partial of [false, true]) it(`merges dirty fields from ${partial ? "a partial form" : "a full form"} without accepting unread proposal content`, async () => {
    const h = await harness();
    const store = h.provider.openStore()!;
    const gate = h.provider.gate()!;
    const live = await readFile(join(h.worldDir, MAREN), "utf8");
    const draft = MarkdownFile.parse(live);
    draft.setBody(
      draft.sections().map((section) => `## ${section.heading}\n${section.heading === "Appearance" ? "Unread Studio appearance." : section.body}`).join("\n\n"),
    );
    const proposal = await gate.stage({
      kind: "sheet-edit",
      summary: "Studio draft",
      source: "chat:studio",
      targets: [{ path: MAREN, content: draft.serialize() }],
    });
    const sheet = store.getBundle().sheets.find((one) => one.id === "maren-kest")!;
    const sections = sheet.sections.map((section) =>
      section.heading === "Essence" ? { ...section, body: "Form-authored essence." } : section,
    );
    const message = editMessage(partial ? sections.filter(section => section.heading === "Essence") : sections, ["Essence"]);

    await h.send(message);

    const result = resultFor(h.events, message.requestId);
    assert.equal(result.disposition, "merged");
    assert.equal(result.proposalId, proposal.id);
    assert.equal(store.getBundle().sheets.find((one) => one.id === "maren-kest")?.version, sheet.version, "nothing was accepted");
    const proposed = MarkdownFile.parse(await readFile(join(h.worldDir, ".proposals", proposal.id, MAREN), "utf8"));
    assert.equal(proposed.sections().find((section) => section.heading === "Essence")?.body, "Form-authored essence.");
    assert.equal(proposed.sections().find((section) => section.heading === "Appearance")?.body, "Unread Studio appearance.");

    const refused = editMessage([...sections, { heading: "Not offered", body: "Keep this input." }], ["Not offered"]);
    await h.send(refused);
    const refusal = resultFor(h.events, refused.requestId);
    assert.equal(refusal.disposition, "refused");
    assert.equal(refusal.reason, "That field is not one this proposal offers for editing.");
    assert.ok(h.events.some((event) => event.type === "proposal.blocked" && event.proposalId === proposal.id));
    assert.equal((await gate.readManifest(proposal.id)).draftRevision, 2, "the refused form changed no draft state");
    await h.provider.close();
  });
});

describe("sheet-from-a-sentence decision ownership", () => {
  it("records the ordinary destination card, while settle=true remains cardless", async () => {
    const h = await harness();
    await h.send({
      kind: "create-sheet-from-sentence",
      worldId: WORLD_ID,
      sheetType: "location",
      name: "The Attended Quay",
      sentence: "A quay whose ropes remember every departing ship.",
    });
    const attended = (await h.provider.gate()!.listOpen()).find((proposal) => proposal.summary.includes("Attended Quay"));
    assert.ok(attended);
    assert.equal(attended.origin?.surface, "sheet-list");
    assert.deepEqual(attended.decision, {
      mode: "attended",
      owner: { kind: "surface", surface: "sheet-list", targetPath: attended.targets[0]!.path },
    });
    await h.provider.gate()!.discard(attended.id);

    await h.send({
      kind: "create-sheet-from-sentence",
      worldId: WORLD_ID,
      sheetType: "location",
      name: "The Settled Quay",
      sentence: "A quay founded by the Begin press.",
      settle: true,
    });
    assert.equal(
      (await h.provider.gate()!.listOpen()).some((proposal) => proposal.summary.includes("Settled Quay")),
      false,
      "the founding-build path accepts without leaving a card",
    );
    await h.provider.close();
  });
});

function brokenAdapter(): HarnessAdapter {
  return {
    id: "broken",
    capabilities: () => new Set(),
    readiness: () => ({ ready: true }),
    async createSession() {
      throw new Error("no session");
    },
    async sendMessage() {
      throw new Error("no session");
    },
    async dispatchAsync() {
      throw new Error("no session");
    },
    streamEvents() {
      return { [Symbol.asyncIterator]: async function* () {} };
    },
  } as HarnessAdapter;
}

describe("Studio proposal kind follows its target", () => {
  it("stages canon as canon-edit and rejects unsupported paths", async () => {
    const made = await makeTempRoot();
    const provider = new FsWorldProvider(made.root, { clock: () => CLOCK });
    await provider.loadWorld(WORLD_ID);
    for (const proposal of await provider.gate()!.listOpen()) await provider.gate()!.discard(proposal.id);
    const coordinator = new Coordinator({
      provider,
      adapter: brokenAdapter(),
      authoring: { agentForPurpose },
      changeLogPath: join(made.root, "logs", "changes.jsonl"),
      appVersion: "test",
      manifest: SHIPPED_MANIFEST,
    });
    await coordinator.start(0);
    const send = (msg: ClientMessage) =>
      (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
    try {
      await send({
        kind: "draft-with-studio",
        worldId: WORLD_ID,
        path: "canon/CANON-044.md",
        instruction: "Revise this thread.",
        summary: "Canon draft",
      });
      const proposals = await provider.gate()!.listOpen();
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0]?.kind, "canon-edit");
      assert.equal(proposals[0]?.origin?.surface, "canon-thread");
      assert.equal(proposals[0]?.decision?.mode, "attended");

      await send({
        kind: "draft-with-studio",
        worldId: WORLD_ID,
        path: "bible.md",
        instruction: "This target is unsupported.",
        summary: "Unsupported draft",
      });
      assert.equal((await provider.gate()!.listOpen()).length, 1, "an unsupported target stages nothing");

    } finally {
      await coordinator.stop();
      await provider.close();
    }
  });
});
