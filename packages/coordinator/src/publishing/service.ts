import { createHash, randomUUID } from "node:crypto";
import { open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CreatorPackagePreviewSchema, CreatorPublicationSchema, CreatorPublishingFormSchema, type CreatorPackagePreview, type CreatorPublication, type CreatorPublishingForm, type CreatorPublishingState } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { readWorldPackageRelease } from "../productions/world-package.js";
import { toExtendedLength } from "../world/paths.js";
import { AonikPublishingApi, AonikReceiptSchema, AonikUploadSchema, PublishingRefusal, type AonikUpload, type CreatorAccount } from "./api.js";
import { CreatorSignInRequired } from "./account.js";
import { savePublishingFile, PublishingSerial } from "./files.js";
import { freezePlayerEdition } from "./frozen.js";
import { serializeFileMutation } from "../world/atomic.js";

const PendingSchema = z.object({ actor: z.string().regex(/^[a-f0-9]{64}$/), preview: CreatorPackagePreviewSchema, worldId: z.string(), productionId: z.string() }).strict();
const RecordSchema = PendingSchema.extend({ publication: CreatorPublicationSchema, declaration: z.record(z.unknown()),
  operationId: z.string().uuid(), submitOperationId: z.string().uuid(), remote: AonikReceiptSchema.nullable(), uploadId: z.string().uuid().nullable(),
  replacement: z.object({ receiptId: z.string().uuid(), expectedRevisionId: z.string().uuid(), expectedVersion: z.string() }).nullable(),
}).strict();
type Saved = z.infer<typeof RecordSchema>;
export interface CreatorPublishingPort {
  list(worldId: string): Promise<CreatorPublishingState>;
  prepare(store: WorldStore, productionId: string, exportId: string): Promise<CreatorPublishingState>;
  submit(worldId: string, candidateId: string, form: CreatorPublishingForm, replace?: string): Promise<CreatorPublishingState>;
  control(worldId: string, id: string, action: "pause" | "resume" | "cancel" | "refresh"): Promise<CreatorPublishingState>;
  onChange(listener: (worldId: string, state: CreatorPublishingState) => void): () => void;
  stop(): Promise<void>;
}

export class CreatorPublishingService implements CreatorPublishingPort {
  private readonly changes = new Set<(worldId: string, state: CreatorPublishingState) => void>();
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly writes = new PublishingSerial();
  private readonly lifetime = new AbortController();
  private readonly unsubscribe: () => void;
  private stopped = false;
  private readonly jobs = new Set<Promise<unknown>>();
  private job<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new CreatorSignInRequired());
    const result = Promise.resolve().then(work); this.jobs.add(result);
    void result.finally(() => this.jobs.delete(result)).catch(() => {}); return result;
  }
  constructor(private readonly root: string, private readonly account: CreatorAccount, private readonly api: AonikPublishingApi) {
    let actor = account.actorKey();
    this.unsubscribe = account.onChange(() => { const next = account.actorKey(); if (next !== actor) { for (const task of this.active.values()) task.controller.abort(); actor = next; } });
  }
  onChange(listener: (worldId: string, state: CreatorPublishingState) => void): () => void { this.changes.add(listener); return () => this.changes.delete(listener); }
  private owner(): string { const actor = this.account.actorKey(); if (!actor || !/^[a-f0-9]{64}$/.test(actor) || this.stopped) throw new CreatorSignInRequired(); return actor; }
  private path(actor: string, id: string) { z.string().uuid().parse(id); return join(this.root, "receipts", actor, id + ".json"); }
  private candidate(actor: string, id: string) { z.string().uuid().parse(id); return join(this.root, "candidates", actor, id + ".json"); }
  private package(id: string) { z.string().uuid().parse(id); return join(this.root, "packages", id + ".zip"); }
  private async persist(record: Saved) { record.publication.updatedAt = new Date().toISOString(); await this.writes.run(() => savePublishingFile(this.path(record.actor, record.publication.id), JSON.stringify(record))); }
  private async load(worldId: string, id: string): Promise<Saved> {
    const actor = this.owner(); const file = await readFile(this.path(actor, id), "utf8"); if (file.length > 2097152) throw new PublishingRefusal("invalid-receipt", "The saved receipt cannot be read.");
    const record = RecordSchema.parse(JSON.parse(file)); if (record.actor !== actor || record.worldId !== worldId) throw new PublishingRefusal("receipt-unavailable", "No receipt is available in this creator scope."); return record;
  }
  async list(worldId: string): Promise<CreatorPublishingState> {
    const actor = this.account.actorKey(); if (!actor) return { configured: true, scopeId: null, publications: [], refusal: "Sign in to submit an edition or see your receipts." };
    const publications: CreatorPublication[] = [];
    const files = (await readdir(join(this.root, "receipts", actor)).catch(() => [] as string[])).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).slice(0, 1000);
    for (const file of files) { const record = await this.load(worldId, file.slice(0, -5)).catch(() => null); if (record) publications.push(record.publication); }
    if (actor !== this.account.actorKey()) throw new CreatorSignInRequired();
    return { configured: true, scopeId: actor, publications: publications.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), refusal: null };
  }
  private async publish(worldId: string) { if (this.stopped) return; const state = await this.list(worldId); if (state.scopeId !== this.account.actorKey()) return; for (const listener of this.changes) listener(worldId, state); }
  async prepare(store: WorldStore, productionId: string, exportId: string): Promise<CreatorPublishingState> {
    return this.job(() => this.prepareEdition(store, productionId, exportId));
  }
  private async prepareEdition(store: WorldStore, productionId: string, exportId: string): Promise<CreatorPublishingState> {
    const actor = this.owner(); const preview = await freezePlayerEdition(store, productionId, exportId, this.root, this.api.configuration, this.lifetime.signal);
    if (actor !== this.owner()) throw new CreatorSignInRequired();
    const current = this.account.current(); preview.creatorDisplayName = current.kind === "signed-in" ? current.person.name : "";
    const saved = { actor, preview, worldId: store.worldId, productionId };
    await savePublishingFile(this.candidate(actor, preview.candidateId), JSON.stringify(saved));
    const state = await this.list(store.worldId); if (actor !== this.owner()) throw new CreatorSignInRequired();
    return { ...state, preview };
  }
  async submit(worldId: string, candidateId: string, form: CreatorPublishingForm, replace?: string): Promise<CreatorPublishingState> {
    const actor = this.owner();
    return this.job(() => serializeFileMutation(this.path(actor, candidateId), () => { if (this.owner() !== actor) throw new CreatorSignInRequired(); return this.admit(worldId, candidateId, form, replace); }));
  }
  private async admit(worldId: string, candidateId: string, form: CreatorPublishingForm, replace?: string): Promise<CreatorPublishingState> {
    form = CreatorPublishingFormSchema.parse(form); const actor = this.owner();
    const candidate = PendingSchema.parse(JSON.parse(await readFile(this.candidate(actor, candidateId), "utf8")));
    if (candidate.actor !== actor || candidate.worldId !== worldId) throw new PublishingRefusal("edition-unavailable", "Prepare this edition in the current creator scope.");
    const p = candidate.preview;
    let replacement: Saved["replacement"] = null;
    if (replace) { const old = await this.load(worldId, replace); if (!old.remote || old.productionId !== candidate.productionId) throw new PublishingRefusal("receipt-unavailable", "Choose the current receipt for this production."); replacement = { receiptId: old.remote.id, expectedRevisionId: old.remote.revision.id, expectedVersion: old.remote.version }; }
    // The candidate UUID is also its one durable local request: two windows cannot allocate two submissions.
    const existing = await this.load(worldId, candidateId).catch(() => null);
    if (existing) {
      if (JSON.stringify(existing.declaration) !== JSON.stringify(this.declaration(existing.operationId, p, form)) || JSON.stringify(existing.replacement) !== JSON.stringify(replacement)) throw new PublishingRefusal("intent-changed", "This confirmation already belongs to different details. Prepare a fresh submission.");
      if (existing.publication.transfer !== "complete" && existing.publication.transfer !== "superseded") this.start(existing); return this.list(worldId);
    }
    const operationId = randomUUID();
    const record: Saved = { ...candidate, operationId, submitOperationId: randomUUID(), declaration: this.declaration(operationId, p, form), remote: null, uploadId: null, replacement,
      publication: { id: candidateId, worldId, productionId: candidate.productionId, exportId: p.exportId, title: form.title, edition: p.edition, packageSha256: p.sha256, packageBytes: p.bytes,
        receiptId: null, revisionId: null, revisionNumber: null, status: "awaiting-upload", transfer: "pending", receivedBytes: 0, updatedAt: new Date().toISOString(), message: null, decisions: [] } };
    await this.persist(record); this.start(record); return this.list(worldId);
  }
  private declaration(id: string, p: CreatorPackagePreview, form: CreatorPublishingForm): Record<string, unknown> {
    return { clientRequestId: id, channelKey: p.channelKey, title: form.title, creatorDisplayName: form.creatorDisplayName, summary: form.summary, language: form.language,
      worldId: p.worldId, edition: p.edition, packageFileName: p.fileName, declaredPackageBytes: p.bytes, declaredPackageSha256: p.sha256,
      rightsDeclarationVersion: p.rightsDeclarationVersion, distributionPermissionGranted: true,
      editorialMaterial: { audience: form.audience, ageRating: form.ageRating, releaseKind: p.kind, artworkAssetId: p.artworkAssetId, attribution: form.attribution,
        rightsEvidence: [{ rightsBasis: form.rightsBasis, evidenceReference: form.evidenceReference, assetIds: p.assets.map(a => a.id).sort() }] } };
  }
  private start(record: Saved) {
    if (this.active.has(record.publication.id) || this.stopped) return;
    const controller = new AbortController();
    const done = this.transfer(record, controller.signal).catch(async error => {
      record.publication.transfer = "paused";
      record.publication.message = controller.signal.aborted ? "Upload paused. Resume the saved edition when ready." : error instanceof CreatorSignInRequired ? error.message : error instanceof PublishingRefusal ? error.message : "The saved submission could not be confirmed. Refresh or resume it before making another request.";
      await this.persist(record); await this.publish(record.worldId);
    }).finally(() => this.active.delete(record.publication.id));
    void done.catch(() => { /* A failed local flush remains an unacknowledged saved intent, never a new remote request. */ });
    this.active.set(record.publication.id, { controller, done });
  }
  private scoped(record: Saved, signal: AbortSignal) { if (signal.aborted || this.stopped || this.owner() !== record.actor) throw new CreatorSignInRequired(); }
  private async exactFile(record: Saved, signal: AbortSignal) {
    const file = await open(toExtendedLength(this.package(record.preview.candidateId)), "r");
    try { const hash = createHash("sha256"); let bytes = 0; for await (const chunk of file.createReadStream({ autoClose: false, signal })) { bytes += (chunk as Buffer).length; hash.update(chunk as Buffer); if (bytes > record.preview.bytes) throw new Error("Changed frozen file"); }
      if (bytes !== record.preview.bytes || hash.digest("hex") !== record.preview.sha256) throw new PublishingRefusal("edition-changed", "The saved frozen edition changed. Prepare a new submission.");
      return file;
    } catch (error) { await file.close(); throw error; }
  }
  private async partHead(record: Saved, signal: AbortSignal) {
    if (record.preview.kind !== "part") return;
    const read = await readWorldPackageRelease(this.package(record.preview.candidateId)); if (!read?.manifest.part) throw new PublishingRefusal("part-invalid", "The part cannot be read.");
    const feed = z.object({ version: z.literal(2), serial: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), worlds: z.array(z.object({ id: z.string(), productions: z.array(z.object({ id: z.string() }).passthrough()).default([]), package: z.object({ edition: z.string(), fingerprint: z.string(), parts: z.array(z.unknown()).default([]) }).passthrough().optional() }).passthrough()) }).parse(await this.api.catalogue(signal));
    const world = feed.worlds.find(w => w.id === read.manifest.id); const base = world?.package; const part = read.manifest.part;
    if (!base || base.fingerprint !== part.fingerprint || base.edition !== part.follows || base.parts.length + 1 !== part.number || !world?.productions.some(p => p.id === read.manifest.productions[0]?.id)) throw new PublishingRefusal("part-head-changed", "This part does not follow AONIK's published edition and next part. Export a part from the current released base.");
  }
  private accept(record: Saved, input: unknown) {
    const remote = AonikReceiptSchema.parse(input); const p = record.preview;
    if (remote.channelKey !== p.channelKey || remote.revision.worldId !== p.worldId || remote.revision.declaredPackageSha256 !== p.sha256 || remote.revision.declaredPackageBytes !== p.bytes || remote.revision.edition !== p.edition) throw new PublishingRefusal("receipt-mismatch", "The service receipt does not identify this frozen edition.");
    if ((record.remote && (remote.id !== record.remote.id || remote.revision.id !== record.remote.revision.id)) || (record.replacement && remote.id !== record.replacement.receiptId) || (!record.replacement && remote.clientRequestId !== record.operationId)) throw new PublishingRefusal("revision-changed", "The receipt now names another revision. Refresh it before continuing.");
    record.remote = remote; Object.assign(record.publication, { receiptId: remote.id, revisionId: remote.revision.id, revisionNumber: remote.revision.number, status: remote.status });
  }
  private async transfer(record: Saved, signal: AbortSignal) {
    this.scoped(record, signal);
    // An accepted receipt is authoritative even if its part has since advanced the public head.
    if (record.remote) {
      this.accept(record, await this.api.request(`/publishing/submissions/${record.remote.id}`, "GET", undefined, signal));
      if (!["awaiting-upload", "uploaded", "held"].includes(record.remote.status)) { record.publication.transfer = "complete"; record.publication.message = null; record.publication.receivedBytes = record.preview.bytes; await this.persist(record); await this.publish(record.worldId); return; }
    }
    const file = await this.exactFile(record, signal);
    try {
      await this.partHead(record, signal); this.scoped(record, signal);
      record.publication.transfer = "uploading"; record.publication.message = null; await this.persist(record); await this.publish(record.worldId);
      if (!record.remote) {
        if (record.replacement) this.accept(record, await this.api.request(`/publishing/submissions/${record.replacement.receiptId}/revisions`, "POST", { operationId: record.operationId, expectedRevisionId: record.replacement.expectedRevisionId, expectedVersion: record.replacement.expectedVersion, declaration: record.declaration }, signal));
        else { const response = z.object({ submission: AonikReceiptSchema }).parse(await this.api.request("/publishing/submissions", "POST", record.declaration, signal)); this.accept(record, response.submission); }
        await this.persist(record);
      }
      if (!["awaiting-upload", "uploaded", "held"].includes(record.remote!.status)) { record.publication.transfer = "complete"; await this.persist(record); await this.publish(record.worldId); return; }
      const base = `/publishing/submissions/${record.remote!.id}/uploads`;
      let upload = AonikUploadSchema.parse(await this.api.request(base, "POST", undefined, signal)); record.uploadId = upload.id;
      const session = { id: upload.id, partSizeBytes: upload.partSizeBytes };
      const checkUpload = (next: AonikUpload) => { if (next.id !== session.id || next.partSizeBytes !== session.partSizeBytes || next.revisionId !== record.remote!.revision.id || next.receivedBytes > record.preview.bytes || next.totalParts !== Math.ceil(record.preview.bytes / next.partSizeBytes) || next.missingParts.some(p => p > next.totalParts)) throw new PublishingRefusal("upload-mismatch", "The upload session does not match this edition."); };
      checkUpload(upload);
      record.publication.receivedBytes = upload.receivedBytes; await this.persist(record);
      if (upload.status !== "uploaded") {
        for (const part of [...new Set(upload.missingParts)].sort((a, b) => a - b)) {
          this.scoped(record, signal); const offset = (part - 1) * upload.partSizeBytes; const bytes = Buffer.alloc(Math.min(upload.partSizeBytes, record.preview.bytes - offset));
          const read = await file.read(bytes, 0, bytes.length, offset); if (read.bytesRead !== bytes.length) throw new PublishingRefusal("edition-changed", "The frozen edition is incomplete.");
          upload = AonikUploadSchema.parse(await this.api.request(`${base}/${upload.id}/parts/${part}`, "PUT", bytes, signal, createHash("sha256").update(bytes).digest("hex")));
          checkUpload(upload);
          record.publication.receivedBytes = upload.receivedBytes; await this.persist(record); await this.publish(record.worldId);
        }
        upload = AonikUploadSchema.parse(await this.api.request(`${base}/${upload.id}/complete`, "POST", undefined, signal));
        checkUpload(upload);
      }
      if (upload.status !== "uploaded") throw new PublishingRefusal("upload-pending", "The server is still reconciling this upload. Resume the saved request later.");
      await this.partHead(record, signal); this.scoped(record, signal);
      await this.api.request(`/publishing/submissions/${record.remote!.id}/submit`, "POST", { revisionId: record.remote!.revision.id, operationId: record.submitOperationId }, signal);
      this.accept(record, await this.api.request(`/publishing/submissions/${record.remote!.id}`, "GET", undefined, signal));
      record.publication.transfer = "complete"; record.publication.receivedBytes = record.preview.bytes; await this.persist(record); await this.publish(record.worldId);
    } finally { await file.close(); }
  }
  async control(worldId: string, id: string, action: "pause" | "resume" | "cancel" | "refresh"): Promise<CreatorPublishingState> {
    const actor = this.owner();
    return this.job(() => serializeFileMutation(this.path(actor, id), () => { if (actor !== this.owner()) throw new CreatorSignInRequired(); return this.controlReceipt(worldId, id, action); }));
  }
  private async controlReceipt(worldId: string, id: string, action: "pause" | "resume" | "cancel" | "refresh"): Promise<CreatorPublishingState> {
    const running = this.active.get(id);
    if (action === "pause" || action === "cancel") { running?.controller.abort(); if (running) await running.done; }
    let record = await this.load(worldId, id);
    // A terminal progress file can become visible just before its task releases ownership.
    if (running && !["pending", "uploading"].includes(record.publication.transfer)) { await running.done; record = await this.load(worldId, id); }
    if (action === "resume") { if (!["superseded", "complete"].includes(record.publication.transfer) && !this.active.has(id)) { record.publication.transfer = "pending"; record.publication.message = null; await this.persist(record); this.start(record); } }
    else if (action === "cancel") {
      if (record.remote && !["awaiting-upload", "uploaded", "held"].includes(record.remote.status)) throw new PublishingRefusal("already-submitted", "This edition is already submitted. Refresh its receipt to see its review status.");
      if (record.remote && record.uploadId) await this.api.request(`/publishing/submissions/${record.remote.id}/uploads/${record.uploadId}`, "DELETE", undefined, this.lifetime.signal);
      record.publication.transfer = "cancelled"; record.publication.message = "Upload cancelled. The receipt and exact edition are retained."; await this.persist(record);
    } else if (action === "refresh" && record.remote && !this.active.has(id)) {
      const remote = AonikReceiptSchema.parse(await this.api.request(`/publishing/submissions/${record.remote.id}`, "GET", undefined, this.lifetime.signal));
      if (remote.revision.id !== record.remote.revision.id) { record.publication.transfer = "superseded"; record.publication.message = "A newer revision is now attached to this receipt."; }
      else { this.accept(record, remote); const history = z.object({ items: z.array(z.object({ revisionId: z.string().uuid(), decision: z.string(), message: z.string(), decidedAt: z.string() }).passthrough()).max(100) }).parse(await this.api.request(`/publishing/submissions/${remote.id}/decisions?page=1&pageSize=100`, "GET", undefined, this.lifetime.signal)); record.publication.decisions = history.items.map(({ revisionId, decision, message, decidedAt }) => ({ revisionId, decision, message, decidedAt })); }
      if (record.publication.transfer !== "superseded" && !["awaiting-upload", "uploaded", "held"].includes(remote.status)) { record.publication.transfer = "complete"; record.publication.receivedBytes = record.preview.bytes; record.publication.message = null; }
      await this.persist(record);
    }
    await this.publish(worldId); return this.list(worldId);
  }
  async stop(): Promise<void> { this.stopped = true; this.lifetime.abort(); this.unsubscribe(); for (const task of this.active.values()) task.controller.abort(); await Promise.allSettled([...this.jobs, ...[...this.active.values()].map(task => task.done)]); await this.writes.drain(); this.changes.clear(); }
}
