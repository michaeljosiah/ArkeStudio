import assert from "node:assert/strict";
import { it } from "node:test";
import type { AudioRightsEvent } from "@arke-studio/contracts";
import { clearAudioDispatch } from "../../src/audio/dispatch-gate.js";
import { effectiveAudioRights } from "../../src/audio/rights.js";
import { analyzePcmWav, audioHash } from "../../src/audio/qc.js";
import { wav } from "./helpers.js";

const bytes = wav([1000, -1000]);
const hash = audioHash(bytes);
const at = "2026-09-05T12:00:00Z";
const acknowledgement: AudioRightsEvent = { schemaVersion: 1, action: "acknowledge", id: "rights-1", audioHash: hash,
  basis: "authorized", scopes: ["cloud-reference-upload"], statementVersion: 1, at };
const input = () => ({ bytes, hash, report: analyzePcmWav(bytes), scope: "cloud-reference-upload" as const,
  rights: [acknowledgement], warningCodes: [], attestations: [{ audioHash: hash, kind: "single-speaker" as const,
    statementVersion: 1, acknowledgedAt: at }], requiredAttestations: ["single-speaker" as const], statementVersion: 1 });

it("clears exact bytes and freezes independent rights quality and attestations", () => {
  const clearance = clearAudioDispatch(input());
  assert.equal(clearance.acknowledgementId, "rights-1");
  assert.equal(clearance.quality.checks.multipleSpeakers.outcome, "unavailable");
  assert.notEqual(clearance.quality, input().report);
});
it("withdrawal blocks future dispatch with a previously valid frozen acknowledgement", () => {
  const frozen = clearAudioDispatch(input());
  const withdrawal: AudioRightsEvent = { schemaVersion: 1, action: "withdraw", acknowledgementId: "rights-1", audioHash: hash, at };
  assert.throws(() => clearAudioDispatch({ ...input(), rights: [acknowledgement, withdrawal], acknowledgementId: frozen.acknowledgementId }), /rights-required/);
  assert.equal(effectiveAudioRights([acknowledgement], hash, "voice-cloning").length, 0);
  assert.equal(effectiveAudioRights([acknowledgement], audioHash(wav([2])), "cloud-reference-upload").length, 0);
});
it("changed bytes stale policy wrong attestations and missing rights fail independently", () => {
  assert.throws(() => clearAudioDispatch({ ...input(), bytes: wav([1]) }), /source-changed/);
  const stale = input(); stale.report.analyzer.policyVersion = 2;
  assert.throws(() => clearAudioDispatch(stale), /qc-stale/);
  assert.throws(() => clearAudioDispatch({ ...input(), attestations: [] }), /attestation/);
  assert.throws(() => clearAudioDispatch({ ...input(), rights: [] }), /rights/);
});
it("warnings cannot be satisfied by attestations and unavailable decode cannot pass", () => {
  const warned = input(); warned.report.checks.silence = { outcome: "warning", code: "boundary-silence" };
  assert.throws(() => clearAudioDispatch(warned), /warning/);
  assert.equal(clearAudioDispatch({ ...warned, warningCodes: ["boundary-silence"] }).warningCodes[0], "boundary-silence");
  const unavailable = input(); unavailable.report.checks.decode = { outcome: "unavailable", code: "failed" };
  assert.throws(() => clearAudioDispatch(unavailable), /incompatible/);
});
