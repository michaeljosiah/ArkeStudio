import { useEffect, useState } from "react";
import { RecoveryAdvancedSettingsSchema, type ArtifactTransferSettings } from "@arke-studio/contracts";
import { setRecoveryAdvanced, useStore } from "../lib/store.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { Button, Input } from "./ui.js";
import { RecoveryCacheMaintenanceControls } from "./recovery-cache-maintenance.js";

export function RecoveryAdvancedControls() {
  const { state, connection, recoveryCommandResults } = useStore(), policy = state?.app.recoveryPolicy;
  const current = JSON.stringify(policy?.advanced ?? RecoveryAdvancedSettingsSchema.parse({}));
  const [draft, setDraft] = useState(() => RecoveryAdvancedSettingsSchema.parse(JSON.parse(current)));
  const [pending, setPending] = useState<string | null>(null), [message, setMessage] = useState("");
  useEffect(() => setDraft(RecoveryAdvancedSettingsSchema.parse(JSON.parse(current))), [current]);
  const result = pending ? recoveryCommandResults[pending] : undefined;
  useEffect(() => {
    if (!pending) return;
    if (connection !== "open") { setPending(null); setMessage("Reconnect and check the saved settings. This change was not sent again."); return; }
    if (result) { setPending(null); setMessage(result.status === "saved" ? "Saved on this PC." : "The change could not be saved. Check recovery status."); return; }
    const timer = setTimeout(() => { setPending(null); setMessage("Saving could not be confirmed. Check the saved settings before trying again."); }, 30_000);
    return () => clearTimeout(timer);
  }, [pending, result, connection]);
  const valid = RecoveryAdvancedSettingsSchema.safeParse(draft);
  const disabled = isRemoteSession() || connection !== "open" || !policy?.accepting || pending !== null;
  const number = (field: keyof ArtifactTransferSettings, value: string) => setDraft(previous => ({ ...previous,
    artifactTransfer: { ...previous.artifactTransfer, [field]: Number(value) } }));
  const fields = [
    ["maxFiles", "Files per result", 1, 256], ["maxFileMiB", "Maximum file size (MiB)", 1, 2048],
    ["maxTotalMiB", "Maximum total result (MiB)", 1, 8192], ["timeoutMinutes", "FAL retrieval timeout (minutes)", 1, 240],
  ] as const;
  return <details className="fy-recovery-advanced">
    <summary>Advanced recovery settings</summary>
    <p className="fy-diag__meta">These preferences apply on this PC. Saving changed result limits retries held result downloads once, without generating again. Active transfers keep their admitted limits.</p>
    <label className="fy-set__row">
      <span className="fy-set__name fy-set__name--wide"><span className="fy-set__title" style={{ display: "block" }}>Check storage before submitting generation</span>
        <span className="fy-set__caps" style={{ display: "block" }}>Recommended. Turn off to manage submission headroom yourself. Storage warnings remain; saving completed results can still wait for space.</span></span>
      <input type="checkbox" checked={draft.checkStorageBeforeSubmission} disabled={disabled}
        onChange={event => setDraft(previous => ({ ...previous, checkStorageBeforeSubmission: event.target.checked }))} />
    </label>
    <p className="fy-diag__meta">Result limits default to 64 files, 1,024 MiB per file and 4,096 MiB total. Larger results use more RAM and disk. The buffered implementation supports up to 2,048 MiB per file and 8,192 MiB total. FAL retrieval defaults to 30 minutes.</p>
    {fields.map(([field, title, min, max]) => <label className="fy-set__row" key={field}>
      <span className="fy-set__name fy-set__name--wide"><span className="fy-set__title">{title}</span></span>
      <Input aria-label={title} type="number" min={min} max={max} step={1} value={draft.artifactTransfer[field]} disabled={disabled}
        onChange={event => number(field, event.target.value)} style={{ width: 110 }} />
    </label>)}
    {!valid.success && <p role="status" className="fy-diag__meta">Use whole numbers within the displayed limits. The total result limit must cover the per-file limit.</p>}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Button disabled={disabled || !valid.success || JSON.stringify(draft) === current} onClick={() => {
        if (!valid.success) return;
        const id = setRecoveryAdvanced(valid.data); setPending(id); setMessage(id ? "Saving…" : "Reconnect before saving.");
      }}>Save advanced settings</Button>
      <Button disabled={disabled} onClick={() => setDraft(RecoveryAdvancedSettingsSchema.parse({}))}>Use default values</Button>
    </div>
    {message && <p role="status" className="fy-diag__meta">{message}</p>}
    <p className="fy-diag__meta">Credential protection, creative-file retention, confirmed GPU cleanup and prevention of duplicate paid submissions always apply.</p>
    <RecoveryCacheMaintenanceControls />
  </details>;
}
