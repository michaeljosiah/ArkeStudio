import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CreatorPublishingFormSchema, type CreatorPackagePreview, type CreatorPublishingForm, type CreatorPublishingState } from "@arke-studio/contracts";
import { cancelAccountSignIn, creatorPublishing, signInAccount, subscribeCreatorPublishing, useStore } from "../lib/store.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { OnYourPC } from "./on-your-pc.js";
import { Button, Input, Textarea } from "./ui.js";

function useCreatorPublishing(worldId: string, enabled = true) {
  const { state: app, connection } = useStore(); const account = app?.app.account;
  const scope = account?.kind === "signed-in" ? account.creatorScope ?? null : null;
  const [reply, setReply] = useState<CreatorPublishingState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setReply(null); setBusy(false);
    if (!enabled || isRemoteSession()) return;
    const off = subscribeCreatorPublishing(answer => { if (answer.worldId === worldId && answer.state.scopeId === scope) { setReply(answer.state); setBusy(false); } });
    if (connection === "open") creatorPublishing({ kind: "creator-publishing-list", worldId });
    return off;
  }, [worldId, enabled, connection, scope]);
  const send = (command: Parameters<typeof creatorPublishing>[0]) => { const request = creatorPublishing(command); setBusy(!!request); return request; };
  return { reply: reply?.scopeId === scope ? reply : null, busy, send, account, connection };
}

const statusName = (value: string) => ({ "awaiting-upload": "Awaiting upload", "in-review": "In review", "changes-requested": "Changes requested", "held": "Held for checks", "approved": "Approved · awaiting publication", "publishing": "Publication in progress", "published": "Published", "withdrawn": "Withdrawn", "validating": "Verifying package", "rejected": "Rejected" }[value] ?? value.replaceAll("-", " "));

export function CreatorPublishingPanel({ worldId, productionId, exportId }: { worldId: string; productionId: string; exportId: string }) {
  const [open, setOpen] = useState(false); const { reply, busy, send, account, connection } = useCreatorPublishing(worldId, open);
  const [preview, setPreview] = useState<CreatorPackagePreview | null>(null); const [error, setError] = useState<string | null>(null);
  const [replace, setReplace] = useState("");
  const [form, setForm] = useState<Omit<CreatorPublishingForm, "distributionPermissionGranted"> & { distributionPermissionGranted: boolean }>({ title: "", creatorDisplayName: "", summary: "", language: "en", audience: "general", ageRating: "", attribution: "", rightsBasis: "", evidenceReference: "", distributionPermissionGranted: false });
  const scope = account?.kind === "signed-in" ? account.creatorScope : undefined;
  const saved = !!preview && !!reply?.publications.some(p => p.id === preview.candidateId);
  useEffect(() => { setPreview(null); setError(null); setReplace(""); setForm(f => ({ ...f, rightsBasis: "", evidenceReference: "", attribution: "", distributionPermissionGranted: false })); }, [exportId, scope]);
  useEffect(() => { if (reply?.preview?.exportId === exportId) { const p = reply.preview; setPreview(p); setForm(f => ({ ...f, title: p.title, creatorDisplayName: p.creatorDisplayName, summary: p.summary, distributionPermissionGranted: false })); } }, [reply?.preview, exportId]);
  const field = (name: keyof typeof form, label: string, maxLength: number, multiline = false) => <label className={multiline ? "fy-creator-field fy-creator-wide" : "fy-creator-field"}><span>{label}</span>{multiline ? <Textarea aria-label={label} value={String(form[name])} maxLength={maxLength} onChange={e => setForm(f => ({ ...f, [name]: e.target.value }))} /> : <Input aria-label={label} value={String(form[name])} maxLength={maxLength} onChange={e => setForm(f => ({ ...f, [name]: e.target.value }))} />}</label>;
  return <details className="fy-creator-publishing" open={open} onToggle={e => setOpen(e.currentTarget.open)}><summary>Submit to Arke Player</summary>
    {isRemoteSession() ? <OnYourPC>submit a Player edition</OnYourPC> : <>
      <p>Submit this frozen edition for independent editorial review. Your source world stays on this device.</p>
      {reply?.refusal && <p role="alert">{reply.refusal}</p>}
      {account?.kind === "signed-out" && account.refusal && <p role="alert">{account.refusal}</p>}
      {account?.kind === "signing-in" ? <p>Waiting for sign-in in your browser. <Button onClick={() => cancelAccountSignIn()}>Cancel sign-in</Button></p> : account?.kind !== "signed-in" ? <Button disabled={reply?.configured === false} onClick={() => signInAccount()}>Sign in to submit</Button> : <>
        {!preview ? <Button disabled={busy || connection !== "open" || reply?.configured === false} onClick={() => { setError(null); send({ kind: "creator-publishing-prepare", worldId, productionId, exportId }); }}>Review frozen edition</Button> : <>
          <div className="fy-creator-identity"><strong>{preview.title}</strong><span>{preview.edition} · {(preview.bytes / 1048576).toFixed(1)} MiB · {preview.assets.length} files</span><code>{preview.sha256}</code></div>
          <p>Public artwork: {preview.assets.find(a => a.id === preview.artworkAssetId)?.path}. Only the files listed below are submitted.</p>
          <details><summary>Files included in this edition</summary><ul>{preview.assets.map(a => <li key={a.id}>{a.path} · {a.mediaType}</li>)}</ul></details>
          <fieldset className="fy-creator-fields" disabled={saved}><legend>Public details and distribution rights</legend>
            {field("title", "Public title", 200)}{field("creatorDisplayName", "Public creator name", 200)}{field("summary", "Public description", 2000, true)}{field("language", "Language", 35)}
            <label className="fy-creator-field"><span>Audience</span><select aria-label="Audience" className="ui-input" value={form.audience} onChange={e => setForm(f => ({ ...f, audience: e.target.value as CreatorPublishingForm["audience"] }))}><option value="general">General</option><option value="children">Children</option><option value="adults">Adults</option></select></label>
            {field("ageRating", "Age suitability", 120)}{field("attribution", "Artwork, writing and voice attribution", 2000, true)}{field("rightsBasis", "Distribution rights for every included file", 1000, true)}{field("evidenceReference", "Rights evidence reference", 512)}
            <label className="fy-creator-field"><span>Submission</span><select aria-label="Submission" className="ui-input" value={replace} onChange={e => setReplace(e.target.value)}><option value="">New submission</option>{reply?.publications.filter(p => p.productionId === productionId && p.receiptId && p.transfer !== "superseded" && !["publishing", "published", "withdrawn", "validating"].includes(p.status)).filter((p, i, rows) => rows.findIndex(row => row.receiptId === p.receiptId) === i).map(p => <option key={p.id} value={p.id}>Revise {p.title} · revision {p.revisionNumber}</option>)}</select></label>
          </fieldset>
          <p>{preview.permissionText}</p><small>Permission statement: {preview.rightsDeclarationVersion}</small>
          <label className="fy-creator-permission"><input type="checkbox" disabled={saved} checked={form.distributionPermissionGranted} onChange={e => setForm(f => ({ ...f, distributionPermissionGranted: e.target.checked }))} /><span>I confirm the distribution permission and the rights, attribution and audience information for these exact files.</span></label>
          {replace && <p>Replacing a revision removes its previous approval and requires fresh verification and review.</p>}
          {error && <p role="alert">{error}</p>}
          <div className="fy-creator-actions"><Button variant="primary" disabled={saved || busy || connection !== "open" || !form.distributionPermissionGranted} onClick={() => { const parsed = CreatorPublishingFormSchema.safeParse(form); if (!parsed.success) { setError("Complete the public details, rights, attribution and age suitability before submitting."); return; } setError(null); send({ kind: "creator-publishing-submit", worldId, candidateId: preview.candidateId, form: parsed.data, ...(replace ? { replace } : {}) }); }}>{busy ? "Saving request…" : "Submit for review"}</Button><Button disabled={busy} onClick={() => { setPreview(null); setForm(f => ({ ...f, distributionPermissionGranted: false })); }}>Review another confirmation</Button></div>
          {!!reply?.publications.some(p => p.id === preview.candidateId) && <p role="status">Submission saved. Follow its upload and editorial status in <Link to="/publications">Publications</Link>.</p>}
        </>}
      </>}
    </>}
  </details>;
}

export function CreatorPublicationHistory({ worldId }: { worldId: string }) {
  const { reply, busy, send, connection } = useCreatorPublishing(worldId);
  if (isRemoteSession()) return <OnYourPC>manage Player submissions</OnYourPC>;
  if (!reply || !reply.publications.length) return null;
  return <section className="fy-creator-publishing" aria-label="Player submission receipts"><h2>Player submissions</h2><p>Saved receipts for your creator account. Approval and public delivery are separate steps.</p>{reply.refusal && <p role="alert">{reply.refusal}</p>}
    {reply.publications.map(p => <article className="fy-creator-receipt" key={p.id}><div><strong>{p.title}</strong><span>{p.edition} · {statusName(p.status)} · {p.transfer}</span></div><code>{p.packageSha256}</code><small>{p.receiptId ? `Receipt ${p.receiptId} · revision ${p.revisionNumber}` : "Request saved locally; waiting for a service receipt"}</small>
      <small><time dateTime={p.updatedAt}>Updated {new Date(p.updatedAt).toLocaleString()}</time></small>
      {p.transfer !== "complete" && <progress value={p.receivedBytes} max={p.packageBytes} aria-label={p.title + " upload"} />}
      {p.message && <p role="status">{p.message}</p>}
      {p.decisions.filter(d => d.revisionId === p.revisionId).map((d, i) => <p key={i}><strong>{statusName(d.decision)}</strong> · {d.message || "No additional creator message"}</p>)}
      <div className="fy-creator-actions">{p.transfer === "uploading" ? <><Button disabled={busy || connection !== "open"} onClick={() => send({ kind: "creator-publishing-control", worldId, id: p.id, action: "pause" })}>Pause upload</Button><Button disabled={busy || connection !== "open"} onClick={() => send({ kind: "creator-publishing-control", worldId, id: p.id, action: "cancel" })}>Cancel upload</Button></> : ["paused", "pending", "cancelled"].includes(p.transfer) ? <Button disabled={busy || connection !== "open"} onClick={() => send({ kind: "creator-publishing-control", worldId, id: p.id, action: "resume" })}>Resume upload</Button> : null}<Button disabled={busy || connection !== "open"} onClick={() => send({ kind: "creator-publishing-control", worldId, id: p.id, action: "refresh" })}>Refresh receipt</Button></div>
    </article>)}
  </section>;
}
