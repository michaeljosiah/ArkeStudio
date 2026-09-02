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

  it("merges dirty fields into a present proposal without accepting its unread content", async () => {
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
    const message = editMessage(sections, ["Essence"]);

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
