import assert from "node:assert/strict";
import { it } from "node:test";
import { FrameSchema, JobSchema, type ClientState } from "@arke-studio/contracts";
import { SnapshotPages } from "../src/snapshot-pages.js";
import { scanWorld } from "../src/world/scan.js";
import { FIXTURE_WORLD, WORLD_ID } from "./world/helpers.js";
import { emptyClientState } from "./client-state.js";

const at = "2026-11-01T00:00:00Z";
const job = JobSchema.parse({ id: "jb_" + "0".repeat(26), idempotencyKey: "0".repeat(26), worldId: WORLD_ID,
  target: { kind: "voice-preview" }, capability: "voice-tts", provider: "test", model: "voice", params: { text: "a long provider request".repeat(100) },
  estimatedMicroUsd: 1, status: "succeeded", createdAt: at, updatedAt: at });

it("keeps large snapshots below 3 MB, pages complete provenance/history, then sends only changed rows", async () => {
  const scanned = await scanWorld(FIXTURE_WORLD);
  const world = scanned.bundle;
  const jobs = Array.from({ length: 5000 }, (_, i) => ({ ...job, id: "jb_" + String(i).padStart(26, "0") }));
  const ledger = jobs.map(row => ({ ts: at, worldId: WORLD_ID, jobId: row.id, provider: "test", model: "voice", outcome: "succeeded" as const, estimatedMicroUsd: 1, actualMicroUsd: 1 }));
  world.artifacts = jobs.map((row, i) => ({ id: "ar_" + String(i).padStart(26, "0"), kind: "image" as const, file: `${i}.png`, hash: "sha256:" + "a".repeat(64), origin: { by: "system" as const, producedBy: "test" }, links: [], created: at,
    generation: { source: "founding" as const, jobId: row.id, genesisId: "fixture", target: "picture", label: "Picture", prompt: "A picture. ".repeat(245), provider: "test", model: "image", params: {}, links: [], estimatedMicroUsd: 1, costMicroUsd: 1 } }));
  const state = emptyClientState({ jobs, ledger }, { world }), sender = new SnapshotPages();
  const pages = [...sender.prepare(state)];
  for (const page of pages) {
    const frame = FrameSchema.parse({ kind: "snapshot-page", seq: 1, snapshot: 1, page });
    assert(Buffer.byteLength(JSON.stringify(frame)) < 1.1 * 1024 ** 2);
  }
  for (const collection of ["artifacts", "jobs", "ledger"] as const) assert.equal(pages.filter(page => page.collection === collection).reduce((sum, page) => sum + page.rows.length, 0), 5000);
  const snapshot = { kind: "snapshot", seq: 100, collectionSnapshot: 1, state: { ...state, app: { ...state.app, jobs: [], ledger: [] }, world: { ...world, artifacts: [] } } };
  const snapshotBytes = Buffer.byteLength(JSON.stringify(FrameSchema.parse(snapshot)));
  assert(snapshotBytes < 3_000_000, `snapshot was ${snapshotBytes} bytes`);
  const artifactPage = pages.find(page => page.collection === "artifacts")!;
  assert(artifactPage.collection === "artifacts");
  assert.deepEqual(artifactPage.rows[0]!.generation, world.artifacts[0]!.generation, "full provenance remains available");
  const unchanged = [...sender.prepare(structuredClone(state))];
  assert.equal(unchanged.reduce((sum, page) => sum + page.rows.length, 0), 0);
  const changed: ClientState = { ...state, app: { ...state.app, jobs: state.app.jobs.map((row, i) => i === 123 ? { ...row, status: "failed" } : row) } };
  const updates = [...sender.prepare(changed)];
  assert.deepEqual(updates.filter(page => page.rows.length).map(page => [page.collection, page.offset, page.rows.length]), [["jobs", 123, 1]]);
  sender.reset(); assert([...sender.prepare(changed)].filter(page => page.rows.length).every(page => page.offset !== 0 || page.reset));
  console.log(`Large-world wire snapshot: ${snapshotBytes} bytes; ${pages.length} pages for 15,000 complete rows.`);
});
