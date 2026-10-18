import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { DomainEvent } from "@arke-studio/contracts";
import { journalRecord, voiceCatalogueSummary } from "../src/journal-record.js";
import { Coordinator } from "../src/coordinator.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { tempDir } from "./tmp.js";

// Issue 1845: 1,248 whole catalogues, ~1.5 MB each, made up most of a 2.6 GB coordinator.jsonl.
const AT = "2026-10-17T14:26:50.000Z";
const voice = (provider: string, voiceId: string) => ({ provider, model: `${provider}-model`, voiceId, label: voiceId, attributes: [], local: provider === "kokoro", canClone: false });

it("journals a voice catalogue as its count, providers and digest, not the list", () => {
  const event = { at: AT, type: "voice.catalogue", errors: ["google: HTTP 402"],
    voices: [{ ...voice("kokoro", "bm_george"), usedBy: [] }, { ...voice("google", "Kore"), usedBy: ["Ife"] }, { ...voice("google", "Puck"), usedBy: [] }] } as DomainEvent;
  const record = journalRecord(event);
  assert.equal(record["voices"], undefined, "the list itself stays out of the journal");
  assert.deepEqual(record["errors"], ["google: HTTP 402"], "what went wrong is still journalled");
  const summary = record["voicesSummary"] as ReturnType<typeof voiceCatalogueSummary>;
  assert.equal(summary.count, 3);
  assert.deepEqual(summary.providers, { kokoro: 1, google: 2 });
  assert.match(summary.digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(record).includes("bm_george"), "no voice row reaches the record");
});

it("gives the same digest to the same voices in any order and a new one when the list changes", () => {
  const a = voiceCatalogueSummary([voice("google", "Kore"), voice("kokoro", "bm_george")]);
  const b = voiceCatalogueSummary([voice("kokoro", "bm_george"), voice("google", "Kore")]);
  const c = voiceCatalogueSummary([voice("kokoro", "bm_george")]);
  assert.equal(a.digest, b.digest);
  assert.notEqual(a.digest, c.digest);
});

it("journals the founding conversation's voices without the catalogue it carries", () => {
  const event = { at: AT, type: "genesis.voices", genesisId: "g1",
    voices: { catalogue: [voice("kokoro", "bm_george")], plans: [], candidates: [], selections: [], rejected: ["x"], problems: [], attempts: {} } } as DomainEvent;
  const record = journalRecord(event) as { voices: Record<string, unknown> };
  assert.equal(record.voices["catalogue"], undefined);
  assert.deepEqual(record.voices["rejected"], ["x"], "the founding decisions are kept whole");
  assert.equal((record.voices["catalogueSummary"] as { count: number }).count, 1);
});

it("journals every other event unchanged", () => {
  const event = { at: AT, type: "appearance.changed", appearance: "dark" } as unknown as DomainEvent;
  assert.equal(journalRecord(event), event);
});

it("a catalogue request reaches coordinator.jsonl as a summary while the client still gets every voice", async () => {
  const root = await tempDir("catalogue-journal-");
  const changeLogPath = join(root, "changes.jsonl");
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ provider: new FsWorldProvider(root), adapter: null, appRoot: root, appVersion: "test", changeLogPath, observeEvent: e => events.push(e),
    voice: { localPresets: [], cloudSources: [], sidecar: { health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
      listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
      synthesize: async () => Buffer.alloc(0), transcribe: async () => "" } } });
  const send = (message: unknown) => (coordinator as unknown as { handleClientMessage(message: unknown): Promise<void> }).handleClientMessage(message);
  try {
    await coordinator.start();
    await send({ kind: "voice-catalogue" });
  } finally {
    await coordinator.stop();
  }
  const delivered = events.findLast(e => e.type === "voice.catalogue") as Extract<DomainEvent, { type: "voice.catalogue" }>;
  assert.ok(delivered.voices.some(v => v.voiceId === "bm_george"), "the picker still receives the voices");
  const journalled = (await readFile(changeLogPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event?: Record<string, unknown> })
    .find(record => record.event?.["type"] === "voice.catalogue")?.event;
  assert.ok(journalled, "the request is journalled");
  assert.equal(journalled["voices"], undefined);
  assert.equal((journalled["voicesSummary"] as { count: number }).count, delivered.voices.length);
});
