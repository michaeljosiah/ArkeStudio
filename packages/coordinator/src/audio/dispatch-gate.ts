import { AudioDispatchClearanceSchema, AudioQcReportSchema, type AudioAttestation, type AudioDispatchClearance,
  type AudioQcReport, type AudioRightsEvent, type AudioRightsScope } from "@arke-studio/contracts";
import { effectiveAudioRights } from "./rights.js";
import { AUDIO_ANALYZER_VERSION, AUDIO_POLICY_VERSION, audioHash } from "./qc.js";

/** Route transport/budget validation remains #111. This gate checks the exact bytes and
 * current reusable evidence; a queued clearance is a snapshot, never permission by itself. */
export function clearAudioDispatch(input: {
  bytes: Uint8Array; hash: string; report: AudioQcReport; scope: AudioRightsScope;
  rights: readonly AudioRightsEvent[]; warningCodes: readonly string[]; attestations: readonly AudioAttestation[];
  requiredAttestations: readonly AudioAttestation["kind"][]; statementVersion: number;
  acknowledgementId?: string;
}): AudioDispatchClearance {
  const report = AudioQcReportSchema.parse(input.report);
  if (audioHash(input.bytes) !== input.hash || report.sourceHash !== input.hash) throw new Error("audio-source-changed");
  if (report.analyzer.version !== AUDIO_ANALYZER_VERSION || report.analyzer.policyVersion !== AUDIO_POLICY_VERSION) {
    throw new Error("audio-qc-stale");
  }
  if (report.technical.sizeBytes !== input.bytes.length) throw new Error("audio-qc-stale");
  const checks = Object.values(report.checks);
  if (checks.some(c => c.outcome === "hard-incompatibility") ||
    [report.checks.decode, report.checks.duration, report.checks.technicalFormat].some(c => c.outcome !== "pass")) {
    throw new Error("audio-qc-incompatible");
  }
  const warnings = checks.filter(c => c.outcome === "warning").map(c => c.code);
  if (warnings.some(code => !input.warningCodes.includes(code))) throw new Error("audio-warning-unacknowledged");
  const attestations = input.attestations.filter(a => a.audioHash === input.hash && a.statementVersion === input.statementVersion);
  if (input.requiredAttestations.some(kind => !attestations.some(a => a.kind === kind))) {
    throw new Error("audio-attestation-required");
  }
  const rights = effectiveAudioRights(input.rights, input.hash, input.scope).find(event =>
    event.statementVersion === input.statementVersion && (input.acknowledgementId === undefined || event.id === input.acknowledgementId));
  if (!rights) throw new Error("audio-rights-required");
  return AudioDispatchClearanceSchema.parse({ audioHash: input.hash, scope: input.scope,
    acknowledgementId: rights.id, statementVersion: input.statementVersion, quality: report,
    warningCodes: warnings, attestations });
}
