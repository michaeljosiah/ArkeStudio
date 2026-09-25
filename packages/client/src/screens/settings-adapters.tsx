import { useState } from "react";
import { Link } from "react-router";
import { adapterCommand, useStore } from "../lib/store.js";
import { Button } from "../components/ui.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { RuntimeHead, RuntimeSection } from "./settings-parts.js";

export function SettingsAdaptersScreen() {
  const { state, connection } = useStore();
  const library = state?.app.adapters;
  const [acknowledging, setAcknowledging] = useState(false);
  const [checks, setChecks] = useState([false, false, false]);
  const [selected, setSelected] = useState<string[]>([]);
  const close = () => { setAcknowledging(false); setChecks([false, false, false]); };
  const enabled = library?.adultContent.enabled === true;
  const connected = connection === "open" && !!library;
  const rows = library?.entries ?? [];
  const installable = rows.filter(row => selected.includes(row.release.id) && !row.reason && !row.installed);
  const bytes = installable.reduce((sum, row) => sum + row.release.source.bytes, 0);
  return <section data-screen="settings-adapters" className="fy-adapters">
    <RuntimeHead title="Content & safety" caps="On this device" tone={enabled ? "ok" : "idle"} state={enabled ? "Enabled" : "Off"} />
    <RuntimeSection label="Adult content" />
    <p>Choose whether adult adapters are available in your studio. Enabling access does not download files or start generation.</p>
    <Button disabled={!connected} onClick={() => enabled ? adapterCommand({ action: "disable-content" }) : setAcknowledging(true)}>
      {enabled ? "Turn off adult content" : "Enable adult content…"}
    </Button>
    {!library && <p>The adapter library is unavailable in this host.</p>}
    {library?.error && <p role="alert">{library.error}</p>}
    {!enabled && <p>Adult adapters and their previews are hidden. Your files and accepted work are kept.</p>}
    {enabled && <>
      <RuntimeSection label="Local H3 adapters" />
      <p>Install an adapter here, then select it in Generate for a verified or owner-approved recipe pairing.</p>
      <p><Link to="/settings/downloads">Download progress and disk usage</Link></p>
      <Button disabled={!connected || !library?.scannerAvailable} onClick={() => adapterCommand({ action: "scan" })}>Run compliance assessment</Button>
      <Button disabled={!connected} onClick={() => adapterCommand({ action: "refresh" })}>Refresh status</Button>
      {!library?.scannerAvailable && <p>No compliance agent is connected. Assessments remain pending.</p>}
      <Button disabled={!connected || !installable.length} onClick={() => adapterCommand({ action: "install", releaseIds: installable.map(row => row.release.id) })}>
        Install selected · {Math.ceil(bytes / 1_000_000).toLocaleString()} MB
      </Button>
      {rows.map(row => <article key={row.release.id} className="fy-fact">
        <label><input type="checkbox" checked={selected.includes(row.release.id)} disabled={!!row.reason || row.installed}
          onChange={event => setSelected(current => event.target.checked ? [...current, row.release.id] : current.filter(id => id !== row.release.id))} /> {row.release.displayName}</label>
        <p>{row.release.publisher} · {Math.ceil(row.release.source.bytes / 1_000_000).toLocaleString()} MB · {row.installed ? "On disk" : "Not installed"}</p>
        <p>{row.reason ?? "Compliance approved"}</p>
        <details><summary>Compatibility and source</summary>
          {row.release.compatibility.map(pair => <p key={pair.recipeId}>{pair.recipeId}: {pair.reason}</p>)}
          <p>Source revision: <code>{row.release.source.revision}</code></p>
          <p>SHA-256: <code style={{ overflowWrap: "anywhere" }}>{row.release.source.sha256}</code></p>
          <p>License source: <a href={row.release.license.url} target="_blank" rel="noreferrer">{row.release.license.name}</a></p>
        </details>
        <Button disabled={!connected || !!row.reason || row.installed} onClick={() => adapterCommand({ action: "install", releaseIds: [row.release.id] })}>Install</Button>
        <Button disabled={!connected || row.removed} onClick={() => adapterCommand({ action: "disable", releaseId: row.release.id })}>Disable</Button>
        {row.reason && <Button disabled={!connected} onClick={() => adapterCommand({ action: "restore", releaseId: row.release.id })}>Request fresh review</Button>}
        <Button disabled={!connected || row.removed} onClick={() => adapterCommand({ action: "remove", releaseId: row.release.id, deleteOwnedFile: false })}>Remove from catalogue</Button>
        {row.owned && row.installed && <Button disabled={!connected} onClick={() => adapterCommand({ action: "remove", releaseId: row.release.id, deleteOwnedFile: true })}>Remove downloaded file</Button>}
      </article>)}
    </>}
    <EditorDialog open={acknowledging} onClose={close} labelledBy="adult-content-title" width="32rem">
      <h2 id="adult-content-title">Enable adult content?</h2>
      <p>This makes eligible adult image and video tools available on this device.</p>
      {["I am 18 or older and meet the adult-age requirement where I live.", "I choose to access adult images and videos, including nudity and sexually explicit content.", "I have the necessary rights and consent for the material I use."].map((label, index) =>
        <p key={label}><label><input type="checkbox" checked={checks[index]} onChange={event => setChecks(current => current.map((value, i) => i === index ? event.target.checked : value))} /> {label}</label></p>)}
      <Button onClick={close}>Keep off</Button>
      <Button disabled={!connected || !checks.every(Boolean)} onClick={() => { adapterCommand({ action: "enable", acknowledgement: { adultAge: true, explicitChoice: true, rightsAndConsent: true } }); close(); }}>Enable adult content</Button>
    </EditorDialog>
  </section>;
}
