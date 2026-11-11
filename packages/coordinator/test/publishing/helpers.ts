import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid, type AccountState } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import type { WorldStore } from "../../src/world/store.js";
import { CreatorPublishingService } from "../../src/publishing/service.js";
import { AonikPublishingApi } from "../../src/publishing/api.js";
import { parseAonikConfiguration } from "../../src/publishing/config.js";
import { readWorldPackageRelease } from "../../src/productions/world-package.js";

export class FakeCreator {
  actor = "a".repeat(64);
  readonly listeners = new Set<(state: AccountState) => void>();
  current(): AccountState { return { kind: "signed-in", person: { name: "Synthetic creator", email: "creator@example.invalid", picture: null }, plan: { name: "Creator", paid: false }, session: "ok", creatorScope: this.actor }; }
  actorKey() { return this.actor; }
  async bearer() { return "synthetic-creator-access-token"; }
  onChange(listener: (state: AccountState) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  switch() { this.actor = "b".repeat(64); for (const listener of this.listeners) listener(this.current()); }
}
export async function publishingFixture(kind = "world", partSize?: number) {
  const root = await tempDir("arke-aonik-"); const worldDir = join(root, "world"); await mkdir(join(worldDir, "exports"), { recursive: true });
  const exportId = "ap_" + ulid(); const file = join(worldDir, "exports", `garden-2026-11-03-${exportId}.zip`);
  const source = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/aonik-publishing", kind + ".zip"); await copyFile(source, file);
  const bytes = await readFile(file); const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(file + ".json", JSON.stringify({ kind: "arke-player", exportId, exportedAt: "2026-11-03T12:00:00Z", productionId: "story", title: "Lantern Garden", bytes: bytes.length, sha256, holds: "Synthetic test edition", chapters: 0, pictures: 1, book: true }));
  const store = { dir: worldDir, worldId: ulid() } as WorldStore;
  const configuration = parseAonikConfiguration({ apiBaseUrl: "https://aonik.example.invalid", issuer: "https://issuer.example.invalid", clientId: "studio-public-client", scope: "openid profile", tenantId: randomUUID(), channelKey: "arke-worlds-test", rightsDeclarationVersion: "synthetic-v1", permissionText: "Synthetic fixture distribution only." });
  const account = new FakeCreator(); const api = new FixtureApi(configuration.tenantId, partSize ?? (kind === "part" ? 8192 : 1024)); const transport = new AonikPublishingApi(configuration, account, api.fetch);
  if (kind === "part") { const read = (await readWorldPackageRelease(file))!; api.catalogue = { version: 2, serial: 55, worlds: [{ id: read.manifest.id, package: { edition: read.manifest.part!.follows, fingerprint: read.manifest.part!.fingerprint, parts: [] }, productions: [{ id: read.manifest.productions[0]!.id }] }] }; }
  const service = new CreatorPublishingService(join(root, "cloud"), account, transport);
  return { root, store, file, bytes, sha256, exportId, account, api, transport, service, restart: () => new CreatorPublishingService(join(root, "cloud"), account, transport) };
}
export const form = { title: "Lantern Garden", creatorDisplayName: "Synthetic creator", summary: "A synthetic test edition", language: "en", audience: "general" as const, ageRating: "All ages", attribution: "Synthetic test assets", rightsBasis: "Author-created synthetic fixtures", evidenceReference: "test-fixture-provenance", distributionPermissionGranted: true as const };
export async function settled(service: CreatorPublishingService, worldId: string) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const result = await service.list(worldId); if (result.publications.length && result.publications.every(p => !["pending", "uploading"].includes(p.transfer))) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Publishing did not settle");
}

export class FixtureApi {
  readonly requests: { path: string; method: string; body: unknown }[] = [];
  readonly parts = new Map<number, Buffer>();
  readonly receipts = new Map<string, Record<string, any>>();
  readonly declarations = new Map<string, string>();
  readonly revisions = new Map<string, Record<string, any>>();
  readonly uploadId = randomUUID();
  failure: "create" | "part" | "submit" | "revision" | "no-party" | null = null;
  catalogue: unknown = { version: 2, serial: 52, worlds: [] };
  constructor(readonly tenant: string, readonly partSize = 1024) {}
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const path = url.pathname; const method = init?.method ?? "GET";
    if (path.endsWith("catalogue.json")) return Response.json(this.catalogue);
    const headers = new Headers(init?.headers); assert.equal(headers.get("Authorization"), "Bearer synthetic-creator-access-token"); assert.equal(headers.get("X-Tenant-Id"), this.tenant);
    assert.equal(init?.redirect, "error");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body; this.requests.push({ path, method, body });
    if (this.failure === "no-party") return Response.json({ code: "no-party" }, { status: 403 });
    if (path === "/publishing/submissions" && method === "POST") {
      const d = body as Record<string, any>; let receipt = this.receipts.get(d.clientRequestId);
      if (receipt) assert.equal(this.declarations.get(d.clientRequestId), JSON.stringify(d), "one request ID must keep exact declaration arguments");
      else { receipt = { id: randomUUID(), clientRequestId: d.clientRequestId, channelKey: d.channelKey, status: "awaiting-upload", createdAt: new Date().toISOString(), version: "server-v1", revision: { id: randomUUID(), number: 1, title: d.title, worldId: d.worldId, edition: d.edition, declaredPackageBytes: d.declaredPackageBytes, declaredPackageSha256: d.declaredPackageSha256 } }; this.receipts.set(d.clientRequestId, receipt); this.declarations.set(d.clientRequestId, JSON.stringify(d)); }
      if (this.failure === "create") { this.failure = null; throw new TypeError("simulated lost response"); }
      return Response.json({ inserted: true, submission: receipt });
    }
    const receipt = [...this.receipts.values()].find(r => path.includes(r.id)); assert.ok(receipt, "request must identify its recorded receipt");
    if (path.endsWith("/revisions")) {
      const revision = body as Record<string, any>; assert.equal(revision.operationId, revision.declaration.clientRequestId); assert.equal("receiptId" in revision, false);
      const prior = this.revisions.get(revision.operationId);
      if (prior) assert.equal(JSON.stringify(prior), JSON.stringify(revision));
      else { assert.equal(revision.expectedRevisionId, receipt.revision.id); assert.equal(revision.expectedVersion, receipt.version); this.revisions.set(revision.operationId, revision); receipt.version = "server-v2"; receipt.status = "awaiting-upload"; receipt.revision = { ...receipt.revision, id: randomUUID(), number: receipt.revision.number + 1 }; this.parts.clear(); }
      if (this.failure === "revision") { this.failure = null; throw new TypeError("simulated revision response loss"); }
      return Response.json(receipt);
    }
    if (path.endsWith("/decisions")) return Response.json({ page: 1, pageSize: 100, items: [{ id: randomUUID(), revisionId: receipt.revision.id, decision: "approve", message: "Ready for independent publication", decidedAt: new Date().toISOString() }] });
    const upload = () => ({ id: this.uploadId, revisionId: receipt.revision.id, status: receipt.status === "uploaded" ? "uploaded" : "open", partSizeBytes: this.partSize, totalParts: Math.ceil(receipt.revision.declaredPackageBytes / this.partSize), receivedBytes: [...this.parts.values()].reduce((n, b) => n + b.length, 0), expiresAt: new Date(Date.now() + 3600000).toISOString(), missingParts: Array.from({ length: Math.ceil(receipt.revision.declaredPackageBytes / this.partSize) }, (_, i) => i + 1).filter(p => !this.parts.has(p)) });
    if (path.endsWith("/uploads")) return Response.json(upload());
    if (path.includes("/parts/")) {
      const part = Number(path.split("/").at(-1)); const bytes = Buffer.from(body as Uint8Array);
      assert.equal(headers.get("Content-Length"), String(bytes.length)); assert.equal(headers.get("X-Part-Sha256"), createHash("sha256").update(bytes).digest("hex")); this.parts.set(part, bytes);
      if (this.failure === "part") { this.failure = null; throw new TypeError("simulated part response loss"); } return Response.json(upload());
    }
    if (path.endsWith("/complete")) { assert.equal(upload().missingParts.length, 0); const all = Buffer.concat([...this.parts].sort(([a], [b]) => a - b).map(([, b]) => b)); assert.equal(createHash("sha256").update(all).digest("hex"), receipt.revision.declaredPackageSha256); receipt.status = "uploaded"; return Response.json(upload()); }
    if (path.endsWith("/submit")) { assert.equal((body as Record<string, unknown>).revisionId, receipt.revision.id); receipt.status = "validating"; if (this.failure === "submit") { this.failure = null; throw new TypeError("simulated submit response loss"); } return Response.json({ status: "pending" }); }
    if (method === "DELETE") { this.parts.clear(); return new Response(null, { status: 204 }); }
    if (method === "GET") return Response.json(receipt);
    throw new Error("Unexpected test route: " + path);
  };
}
