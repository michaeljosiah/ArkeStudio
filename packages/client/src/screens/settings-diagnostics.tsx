import { useNavigate } from "react-router";
import {
  CONTROL_REGISTRY,
  FINDING_SEVERITY_RANK,
  consequencesOf,
  primaryFindings,
  remedyAbsenceStatement,
  type DiagnosticsSnapshot,
  type Finding,
  type FindingSeverity,
} from "@arke-studio/contracts";
import { cx } from "../components/ui.js";
import { useDiagnostics } from "../lib/store.js";

/**
 * Settings · Diagnostics (SPEC-032 §1.10, design turn 111): the one surface that shows the
 * findings. Severity bands in a fixed order, causes above the consequences they explain, each
 * with the control that resolves it — resolved through the contract registry, so this screen
 * renders where a control lives without knowing anything the derivation did not tell it (R-24).
 *
 * It renders the snapshot and computes nothing of its own: no join is re-made here, and no
 * fact another group already states appears unless a join made it a finding (R-36, decision 2).
 * Pressing a remedy navigates to the control's own place — the mutation happens there, behind
 * whatever gate that control already carries (R-23).
 */

/** Band order and labels (turn 111): the state word is the contract's, the label the product's. */
const BANDS: ReadonlyArray<{ severity: FindingSeverity; label: string }> = [
  { severity: "blocking", label: "BLOCKING" },
  { severity: "degraded", label: "DEGRADED" },
  { severity: "advisory", label: "ADVISORY" },
  { severity: "unknown", label: "UNKNOWN" },
  { severity: "unmeasured", label: "NOT MEASURED" },
];

/** Checks by name, in the product's words, keyed by the rule kinds `checked` carries (R-10). */
const CHECK_WORDS: Record<string, string> = {
  "work-held-by-engine": "held work",
  "queue-paused-credential": "queues",
  "component-disk-short": "disk",
  "comfyui-recipe-weights-missing": "model files",
  "comfyui-recipe-digest-mismatch": "file digests",
  "comfyui-engine-unavailable": "engine",
  "comfyui-models-folder-unmapped": "models folder",
  "waiting-on-component": "waiting downloads",
  "hardware-unmeasured": "hardware",
  "provider-repeated-faults": "provider faults",
  "spend-above-previous": "spend",
};

const timeOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "measured 2 h ago" — formatting happens here and only here (R-7). */
function ageOf(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < 60 * 60 * 1000) return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
  return `${Math.round(ms / (60 * 60 * 1000))} h ago`;
}

function dotClass(severity: FindingSeverity): string {
  if (severity === "blocking") return "fy-diag__dot--bad";
  if (severity === "degraded") return "fy-set__dot--warn";
  return "";
}

/** The remedy as the registry states it: the control's label, with its place beside it. */
function Remedy({ finding, snapshot }: { finding: Finding; snapshot: DiagnosticsSnapshot }) {
  const navigate = useNavigate();
  if (finding.remedy === null) {
    const absence = remedyAbsenceStatement(snapshot, finding);
    return absence === null ? null : <span className="fy-diag__place">{absence}</span>;
  }
  const control = CONTROL_REGISTRY[finding.remedy.control];
  const target = finding.remedy.target;
  const to =
    "targetParam" in control && target !== undefined
      ? `${control.route}${control.route.includes("?") ? "&" : "?"}${control.targetParam}=${encodeURIComponent(target)}`
      : control.route;
  return (
    <>
      <span className="fy-diag__place">{control.place}</span>
      <button type="button" className="fy-diag__go" onClick={() => navigate(to)}>
        {control.label}
      </button>
    </>
  );
}

function FindingRow({ finding, snapshot, now }: { finding: Finding; snapshot: DiagnosticsSnapshot; now: number }) {
  const explains = consequencesOf(snapshot, finding);
  const stale = finding.stale;
  return (
    <div className="fy-set__row fy-set__row--stack" data-testid="diag-finding" data-kind={finding.kind}>
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <span className={cx("fy-set__dot", dotClass(finding.severity))} />
        <span className="fy-diag__title">{finding.title}</span>
        <span style={{ flex: 1 }} />
        {finding.firstSeen !== snapshot.derivedAt && (
          <span className="fy-diag__meta">since {timeOf(finding.firstSeen)}</span>
        )}
        <Remedy finding={finding} snapshot={snapshot} />
      </div>
      <div className="fy-set__why">
        <span className={cx("fy-set__dot", dotClass(finding.severity))} style={{ width: 5, height: 5 }} />
        <span>{finding.cause.statement}</span>
        {finding.note !== undefined && <span className="fy-diag__meta"> · {finding.note}</span>}
        {finding.cause.redacted === true && <span className="fy-diag__chip">redacted</span>}
      </div>
      {stale !== undefined && (
        <div className="fy-set__why">
          <span className="fy-set__dot" style={{ width: 5, height: 5 }} />
          <span className="fy-diag__meta">
            {stale.facts.join(", ")} measured{" "}
            {ageOf(finding.facts.find((f) => stale.facts.includes(f.name))?.measuredAt ?? finding.firstSeen, now)}
          </span>
          {stale.remeasure !== null && <StaleRemeasure control={stale.remeasure.control} />}
        </div>
      )}
      {explains.length > 0 && (
        <div className="fy-diag__explains">
          <div className="fy-diag__meta" style={{ letterSpacing: "0.14em" }}>
            ▾ EXPLAINS {explains.length}
          </div>
          {explains.map((consequence) => (
            <div key={consequence.occurrence} className="fy-diag__sub" data-testid="diag-consequence">
              <span className="fy-set__dot fy-set__dot--warn" style={{ width: 5, height: 5 }} />
              <span>{consequence.title}</span>
              <span className="fy-diag__meta">{consequence.cause.statement}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StaleRemeasure({ control }: { control: keyof typeof CONTROL_REGISTRY }) {
  const navigate = useNavigate();
  const entry = CONTROL_REGISTRY[control];
  return (
    <button type="button" className="fy-set__link" onClick={() => navigate(entry.route)}>
      {entry.label}
    </button>
  );
}

export function SettingsDiagnosticsScreen() {
  const snapshot = useDiagnostics();
  const now = Date.now();
  if (snapshot === null) {
    return (
      <div data-screen="settings-diagnostics" className="fy-set">
        <div className="fy-diag__head">
          <div className="fy-rt__eyebrow">DIAGNOSTICS</div>
          <span style={{ flex: 1 }} />
          <span className="fy-diag__meta">not derived yet</span>
        </div>
      </div>
    );
  }
  const primaries = primaryFindings(snapshot);
  const bands = BANDS.map((band) => ({
    ...band,
    findings: primaries.filter((f) => f.severity === band.severity),
  })).filter((band) => band.findings.length > 0);
  const checks = snapshot.checked.map((kind) => CHECK_WORDS[kind] ?? kind);
  return (
    <div data-screen="settings-diagnostics" className="fy-set">
      <div className="fy-diag__head">
        <div className="fy-rt__eyebrow">DIAGNOSTICS</div>
        <span style={{ flex: 1 }} />
        <span className="fy-diag__meta">
          {snapshot.checked.length} checks · as of {timeOf(snapshot.derivedAt)}
        </span>
      </div>
      {bands.length === 0 ? (
        <div className="fy-diag__empty" data-testid="diag-empty">
          <div className="fy-diag__emptytitle">Nothing to report</div>
          <div className="fy-diag__meta" style={{ maxWidth: 560, textAlign: "center", lineHeight: 1.8 }}>
            {snapshot.checked.length} checks · {checks.join(" · ")}
          </div>
        </div>
      ) : (
        // The snapshot arrives sorted; the bands only make the order visible (R-36).
        [...bands]
          .sort((a, b) => FINDING_SEVERITY_RANK[a.severity] - FINDING_SEVERITY_RANK[b.severity])
          .map((band) => (
            <div key={band.severity}>
              <div className="fy-diag__band">
                <span
                  className={cx(
                    "fy-rt__eyebrow",
                    band.severity === "blocking" && "fy-diag__band--bad",
                    band.severity === "degraded" && "fy-diag__band--warn",
                  )}
                >
                  {band.label} · {band.findings.length}
                </span>
              </div>
              {band.findings.map((finding) => (
                <FindingRow key={`${finding.kind}:${finding.occurrence}`} finding={finding} snapshot={snapshot} now={now} />
              ))}
            </div>
          ))
      )}
    </div>
  );
}
