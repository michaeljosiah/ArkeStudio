import {
  CONTROL_REGISTRY,
  remedyAbsenceStatement,
  type ClientState,
  type DiagnosticsSnapshot,
  type Finding,
} from "@arke-studio/contracts";
import type { AppLog } from "./app-log.js";
import { redactDeep, scrubAbsolutePaths, type SecretRegistry } from "./redact.js";

/**
 * The diagnostics bundle (SPEC-008 R-6, amended by SPEC-032 R-38): app state a support thread
 * can read — versions, health, provider *status*, routing, runtime figures, the redacted log
 * tail, and the findings — and nothing else. No key material (everything passes the redaction
 * boundary on the way out) and no world content: not a sheet, not a canon line, not a path
 * inside a world.
 *
 * Built from an enumerated field set (SPEC-032 R-31): a field reaches the export because it
 * was named below, never because it was not excluded. Adding one is the reviewed act. That is
 * the property the paste-safety guarantee actually rests on — the redaction boundary is a
 * seen-secrets denylist plus a field-name heuristic, and a secret it never saw, in a field not
 * named like a credential, passes straight through it. Redaction is the second line, for the
 * one thing enumeration cannot vouch for: free text quoted from another subsystem (R-32).
 *
 * The findings ride in the one bundle rather than in a second export beside it (R-38): a
 * second artifact answering the same question is the epic's first bound decision — a fact in
 * two places can disagree with itself — applied to the export instead of the store. The
 * existing action in Settings · About, the redaction on the way out, and the fact that it is
 * transmitted nowhere are all unchanged.
 */
export async function buildDiagnosticsBundle(
  state: ClientState,
  log: AppLog | null,
  registry: SecretRegistry,
  findings: DiagnosticsSnapshot | null = null,
): Promise<Record<string, unknown>> {
  const bundle = {
    generatedAt: new Date().toISOString(),
    app: {
      version: state.app.version,
      health: state.app.health,
      // Status only — configured/validation/probes; the schema itself carries no key (R-6).
      providers: state.app.providers,
      routing: state.app.routing,
      spend: state.app.spend,
      runtime: state.app.runtime,
      voiceRuntime: state.app.voiceRuntime,
      drift: state.app.drift,
      manifestVersion: state.app.manifest?.manifestVersion ?? null,
      jobCount: state.app.jobs.length,
      ledgerEntries: state.app.ledger.length,
    },
    findings: findings === null ? null : exportedFindings(findings),
    // Deliberately absent: worlds, world names, sheets, canon, productions, file paths.
    recentLog: log ? await log.tail(100) : [],
  };
  // Secrets and credential-shaped fields first, then absolute paths (SPEC-032 R-28 — a new
  // rule this bundle used to satisfy by construction alone): subsystem text in the log tail
  // routinely embeds the install's own paths, and every one carries the account name.
  return scrubPathsDeep(redactDeep(bundle, registry)) as Record<string, unknown>;
}

/**
 * The findings as somebody with no product to resolve anything against must read them
 * (SPEC-032 R-39): a remedy carries where its control lives in the product's own words —
 * resolved here, at export time, through the same registry the view reads — rather than as an
 * identifier alone. Enumerated field by field, the same discipline as the rest of the bundle.
 */
function exportedFindings(snapshot: DiagnosticsSnapshot) {
  return {
    derivedAt: snapshot.derivedAt,
    checked: snapshot.checked,
    sources: snapshot.sources,
    findings: snapshot.findings.map((finding) => ({
      kind: finding.kind,
      occurrence: finding.occurrence,
      severity: finding.severity,
      title: finding.title,
      cause: finding.cause,
      facts: finding.facts,
      ...(finding.note !== undefined ? { note: finding.note } : {}),
      // The re-measure control resolves like every other remedy: a bare identifier is exactly
      // the illegibility R-39 forbids, and staleness is the common case in a support bundle —
      // it is pulled long after the facts were measured.
      ...(finding.stale !== undefined
        ? {
            stale: {
              facts: finding.stale.facts,
              remeasure:
                finding.stale.remeasure === null ? null : resolvedControl(finding.stale.remeasure),
            },
          }
        : {}),
      consequences: finding.consequences,
      firstSeen: finding.firstSeen,
      remedy: exportedRemedy(snapshot, finding),
    })),
  };
}

/** A control with its words (R-39): the id for a machine, the label and place for a reader. */
function resolvedControl(remedy: NonNullable<Finding["remedy"]>) {
  const control = CONTROL_REGISTRY[remedy.control];
  return {
    control: remedy.control,
    label: control.label,
    place: control.place,
    ...(remedy.target !== undefined ? { target: remedy.target } : {}),
  };
}

/**
 * Three remedy readings, told apart in the export itself: a control with its words, the stated
 * absence (R-25), or — for a suppressed consequence — nothing, because its remedy is the
 * cause's and the edge pointing at it says so.
 */
function exportedRemedy(snapshot: DiagnosticsSnapshot, finding: Finding) {
  if (finding.remedy !== null) return resolvedControl(finding.remedy);
  const absence = remedyAbsenceStatement(snapshot, finding);
  return absence === null ? null : { absent: absence };
}

/** Every string in the export passes the path rule, wherever a future field puts one. */
function scrubPathsDeep(value: unknown): unknown {
  if (typeof value === "string") return scrubAbsolutePaths(value);
  if (Array.isArray(value)) return value.map(scrubPathsDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubPathsDeep(entry);
    }
    return out;
  }
  return value;
}
