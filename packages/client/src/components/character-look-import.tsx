import { useEffect, useRef, useState } from "react";
import { ulid } from "@arke-studio/contracts";
import { readBrowserMedia } from "../lib/browser-media-import.js";
import { send, subscribeCharacterLookImport, useStore } from "../lib/store.js";
import { PageSheet } from "./page-sheet.js";
import { Button, Input, Select } from "./ui.js";

export function CharacterLookImport({ worldId, sheetId, characterName, onClose, onImported }: {
  worldId: string; sheetId: string; characterName: string; onClose: () => void; onImported: (takeId: string) => void;
}) {
  const { state, connection } = useStore();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"costume" | "pose-expression" | "condition-age">("costume");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<string | null>(null);
  const current = useRef(false);
  current.current = connection === "open" && state?.world?.meta.worldId === worldId;
  useEffect(() => () => { current.current = false; request.current = null; }, []);
  useEffect(() => subscribeCharacterLookImport(result => {
    if (result.requestId !== request.current || result.worldId !== worldId || result.sheetId !== sheetId) return;
    request.current = null; setBusy(false);
    if (result.status === "landed" && result.takeId) onImported(result.takeId);
    else setError(result.reason ?? "The look could not be imported.");
  }), [worldId, sheetId, onImported]);
  useEffect(() => {
    if (connection !== "open" && request.current) {
      request.current = null; setBusy(false);
      setError("Connection interrupted. Check Recent looks before importing again.");
    }
  }, [connection]);
  const submit = async () => {
    if (!file || !name.trim() || request.current || !current.current) return;
    const requestId = ulid(); request.current = requestId; setBusy(true); setError("");
    try {
      const files = await readBrowserMedia([file], () => current.current && request.current === requestId);
      if (!send({ kind: "import-character-look", worldId, sheetId, requestId, name: name.trim(), lookKind: kind, files }))
        throw new Error("Connect to Arke before importing this look.");
    } catch (err) {
      if (request.current === requestId) {
        request.current = null; setBusy(false); setError(err instanceof Error ? err.message : "The image could not be read.");
      }
    }
  };
  return <PageSheet open title="Import a look" subtitle={characterName} onClose={onClose}
    footer={<><Button onClick={onClose}>{busy ? "Close" : "Cancel"}</Button><Button variant="primary" disabled={!file || !name.trim() || busy || !current.current} onClick={() => { void submit(); }}>{busy ? "Importing…" : "Add for review"}</Button></>}>
    <div className="fy-look-import">
      <p>Choose a finished image. Review its identity in More looks before accepting it.</p>
      <label>Image<Input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => {
        const chosen = event.currentTarget.files?.[0] ?? null; setFile(chosen);
        if (chosen && !name.trim()) setName(chosen.name.replace(/\.[^.]*$/, "").replace(/[-_]+/g, " ").slice(0, 60));
      }} /></label>
      <label>Name<Input value={name} maxLength={60} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label>Type<Select label="Look type" value={kind} disabled={busy} onChange={event => setKind(event.target.value as typeof kind)}>
        <option value="costume">Costume</option><option value="pose-expression">Pose / expression</option><option value="condition-age">Condition / age</option>
      </Select></label>
      {error && <p role="alert">{error}</p>}
    </div>
  </PageSheet>;
}
