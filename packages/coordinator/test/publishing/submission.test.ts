import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { form, publishingFixture, settled } from "./helpers.js";

describe("AONIK frozen-edition submissions", () => {
  it("uses only the selected frozen ZIP, with durable identity and exact part hashes", async () => {
    const h = await publishingFixture();
    try {
      const prepared = await h.service.prepare(h.store, "story", h.exportId); const p = prepared.preview!;
      assert.equal(p.sha256, h.sha256); assert.ok(p.assets.length); assert.ok(!JSON.stringify(p).includes(h.root));
      await writeFile(h.file, "PRIVATE SOURCE WORLD MUST NOT BE SENT");
      await h.service.submit(h.store.worldId, p.candidateId, form); const result = await settled(h.service, h.store.worldId);
      assert.equal(result.publications[0]!.transfer, "complete"); assert.equal(result.publications[0]!.status, "validating");
      assert.deepEqual(Buffer.concat([...h.api.parts.values()]), h.bytes);
      assert.ok(!JSON.stringify(result).includes("access-token"));
      const data = h.api.requests.find(r => r.path === "/publishing/submissions")!.body as Record<string, any>;
      assert.equal(data.worldId, "lantern-garden"); assert.notEqual(data.worldId, h.store.worldId);
      assert.equal(data.editorialMaterial.rightsEvidence[0].assetIds.length, p.assets.length);
      await h.service.control(h.store.worldId, p.candidateId, "refresh");
      assert.equal((await h.service.list(h.store.worldId)).publications[0]!.decisions[0]!.message, "Ready for independent publication");
    } finally { await h.service.stop(); }
  });
  for (const failure of ["create", "part", "submit"] as const) it(`reconciles ${failure} response loss after restart without changing intent`, async () => {
    const h = await publishingFixture(); h.api.failure = failure; const p = (await h.service.prepare(h.store, "story", h.exportId)).preview!;
    await h.service.submit(h.store.worldId, p.candidateId, form); const paused = await settled(h.service, h.store.worldId); assert.equal(paused.publications[0]!.transfer, "paused");
    await h.service.stop(); const resumed = h.restart();
    try {
      await resumed.control(h.store.worldId, p.candidateId, "resume"); const result = await settled(resumed, h.store.worldId); assert.equal(result.publications[0]!.transfer, "complete");
      assert.equal(h.api.receipts.size, 1); if (failure === "part") assert.equal(h.api.requests.filter(r => r.path.endsWith("/parts/1")).length, 1);
      if (failure === "submit") assert.equal(h.api.requests.filter(r => r.path.endsWith("/submit")).length, 1);
    } finally { await resumed.stop(); }
  });
  it("refuses changed confirmation arguments and allocates only one concurrent request", async () => {
    const h = await publishingFixture();
    try { const p = (await h.service.prepare(h.store, "story", h.exportId)).preview!; await Promise.all([h.service.submit(h.store.worldId, p.candidateId, form), h.service.submit(h.store.worldId, p.candidateId, form)]); await settled(h.service, h.store.worldId);
      assert.equal(h.api.receipts.size, 1); await assert.rejects(h.service.submit(h.store.worldId, p.candidateId, { ...form, title: "Changed intent" }), /different details/);
    } finally { await h.service.stop(); }
  });
  it("keeps creator scopes separate and pauses rather than faking a no-party success", async () => {
    const h = await publishingFixture();
    try { const p = (await h.service.prepare(h.store, "story", h.exportId)).preview!; h.api.failure = "no-party"; await h.service.submit(h.store.worldId, p.candidateId, form); const result = await settled(h.service, h.store.worldId); assert.match(result.publications[0]!.message!, /linked creator profile/); assert.equal(result.publications[0]!.receiptId, null);
      h.account.switch(); assert.equal((await h.service.list(h.store.worldId)).publications.length, 0); await assert.rejects(h.service.control(h.store.worldId, p.candidateId, "resume"));
    } finally { await h.service.stop(); }
  });
  it("refuses a changed frozen copy before sending any upload request", async () => {
    const h = await publishingFixture();
    try { const p = (await h.service.prepare(h.store, "story", h.exportId)).preview!; await writeFile(join(h.root, "cloud", "packages", p.candidateId + ".zip"), "changed"); await h.service.submit(h.store.worldId, p.candidateId, form); const result = await settled(h.service, h.store.worldId); assert.equal(h.api.requests.length, 0); assert.match(result.publications[0]!.message!, /frozen edition changed/); }
    finally { await h.service.stop(); }
  });
  it("checks a part against AONIK's actual base before creating the remote receipt", async () => {
    const h = await publishingFixture("part");
    try { const p = (await h.service.prepare(h.store, "story", h.exportId)).preview!; assert.equal(p.kind, "part"); h.api.catalogue = { version: 2, serial: 999, worlds: [] }; await h.service.submit(h.store.worldId, p.candidateId, form); const result = await settled(h.service, h.store.worldId); assert.match(result.publications[0]!.message!, /published edition and next part/); assert.equal(h.api.requests.length, 0); }
    finally { await h.service.stop(); }
  });
  it("does not upload a locally altered export which its sidecar no longer identifies", async () => {
    const h = await publishingFixture();
    try { const original = await readFile(h.file); original[100] = original[100]! ^ 1; await writeFile(h.file, original); await assert.rejects(h.service.prepare(h.store, "story", h.exportId), /changed/); assert.equal(h.api.requests.length, 0); }
    finally { await h.service.stop(); }
  });
  it("cancels an incomplete private upload and resumes the same retained request", async () => {
    const h = await publishingFixture(); try { h.api.failure = "part"; const p = (await h.service.prepare(h.store, "story", h.exportId)).preview!;
      await h.service.submit(h.store.worldId, p.candidateId, form); await settled(h.service, h.store.worldId); await h.service.control(h.store.worldId, p.candidateId, "cancel"); assert.equal(h.api.parts.size, 0); assert.equal((await h.service.list(h.store.worldId)).publications[0]!.transfer, "cancelled");
      await h.service.control(h.store.worldId, p.candidateId, "resume"); assert.equal((await settled(h.service, h.store.worldId)).publications[0]!.transfer, "complete"); assert.equal(h.api.receipts.size, 1);
    } finally { await h.service.stop(); }
  });
  it("reconciles a lost replacement response with a stable revision identity and supersedes the old local receipt", async () => {
    const h = await publishingFixture(); const first = (await h.service.prepare(h.store, "story", h.exportId)).preview!;
    await h.service.submit(h.store.worldId, first.candidateId, form); await settled(h.service, h.store.worldId); const remote = [...h.api.receipts.values()][0]!; remote.status = "changes-requested";
    await h.service.control(h.store.worldId, first.candidateId, "refresh"); const next = (await h.service.prepare(h.store, "story", h.exportId)).preview!;
    h.api.failure = "revision"; await h.service.submit(h.store.worldId, next.candidateId, form, first.candidateId); await settled(h.service, h.store.worldId); await h.service.stop();
    const resumed = h.restart(); try { await resumed.control(h.store.worldId, next.candidateId, "resume"); const result = await settled(resumed, h.store.worldId); assert.equal(result.publications.find(p => p.id === next.candidateId)!.revisionNumber, 2); assert.equal(h.api.revisions.size, 1); assert.equal(h.api.receipts.size, 1);
      await resumed.control(h.store.worldId, first.candidateId, "refresh"); assert.equal((await resumed.list(h.store.worldId)).publications.find(p => p.id === first.candidateId)!.transfer, "superseded");
      await assert.rejects(resumed.submit(h.store.worldId, next.candidateId, form), /different details/);
    } finally { await resumed.stop(); }
  });
  it("drains an admitted preparation before shutdown and cannot start later network work", async () => {
    const h = await publishingFixture(); const preparing = h.service.prepare(h.store, "story", h.exportId); const outcome = preparing.catch(() => null); await h.service.stop(); assert.equal(await outcome, null); assert.equal(h.api.requests.length, 0); await assert.rejects(h.service.prepare(h.store, "story", h.exportId));
  });
  it("reconciles an acknowledged remote submission through a read-only refresh after response loss", async () => {
    const h = await publishingFixture(); try { h.api.failure = "submit"; const p = (await h.service.prepare(h.store, "story", h.exportId)).preview!; await h.service.submit(h.store.worldId, p.candidateId, form); await settled(h.service, h.store.worldId);
      const writes = h.api.requests.filter(r => r.method !== "GET").length; await h.service.control(h.store.worldId, p.candidateId, "refresh"); const current = (await h.service.list(h.store.worldId)).publications[0]!; assert.equal(current.transfer, "complete"); assert.equal(current.status, "validating"); assert.equal(h.api.requests.filter(r => r.method !== "GET").length, writes);
    } finally { await h.service.stop(); }
  });
  it("submits a part only against the published head and does not replay an accepted confirmation", async () => {
    const h = await publishingFixture("part"); try { const p = (await h.service.prepare(h.store, "story", h.exportId)).preview!; await h.service.submit(h.store.worldId, p.candidateId, form); const result = await settled(h.service, h.store.worldId); assert.equal(result.publications[0]!.transfer, "complete", result.publications[0]!.message ?? undefined);
      h.api.catalogue = { version: 2, serial: 56, worlds: [] }; const requests = h.api.requests.length; await h.service.submit(h.store.worldId, p.candidateId, form); await h.service.control(h.store.worldId, p.candidateId, "resume"); assert.equal(h.api.requests.length, requests); assert.equal((await h.service.list(h.store.worldId)).publications[0]!.transfer, "complete");
    } finally { await h.service.stop(); }
  });
  it("exposes a crash-left uploading journal as resumable without replaying at startup", async () => {
    const h = await publishingFixture(); h.api.failure = "part"; const p = (await h.service.prepare(h.store, "story", h.exportId)).preview!;
    await h.service.submit(h.store.worldId, p.candidateId, form); await settled(h.service, h.store.worldId); await h.service.stop();
    const path = join(h.root, "cloud", "receipts", h.account.actorKey(), p.candidateId + ".json"); const saved = JSON.parse(await readFile(path, "utf8")); saved.publication.transfer = "uploading"; await writeFile(path, JSON.stringify(saved));
    const resumed = h.restart(); try { const requests = h.api.requests.length; assert.equal((await resumed.list(h.store.worldId)).publications[0]!.transfer, "paused"); assert.equal(h.api.requests.length, requests);
      await resumed.control(h.store.worldId, p.candidateId, "resume"); assert.equal((await settled(resumed, h.store.worldId)).publications[0]!.transfer, "complete"); assert.equal(h.api.receipts.size, 1);
    } finally { await resumed.stop(); }
  });
});
