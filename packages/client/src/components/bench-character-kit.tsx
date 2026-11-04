import { useEffect, useRef, useState } from "react";
import type { BenchTake } from "@arke-studio/contracts";
import { sendBenchUseReference, subscribeBenchReferenceUsed, useStore } from "../lib/store.js";
import { EditorDialog } from "./editor-dialog.js";
import { Button, Select } from "./ui.js";

export function BenchCharacterKit({ worldId, sessionId, take }: { worldId: string; sessionId: string; take: BenchTake }) {
  const store = useStore();
  const characters = store.state?.world?.sheets.filter(sheet => sheet.type === "character" && !sheet.retired && !sheet.neverDepicted) ?? [];
  const [open, setOpen] = useState(false);
  const [sheetId, setSheetId] = useState("");
  const [image, setImage] = useState<"main-photo" | "character-sheet">("main-photo");
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const character = characters.find(sheet => sheet.id === sheetId);
  useEffect(() => subscribeBenchReferenceUsed(answer => {
    if (answer.worldId !== worldId || answer.sessionId !== sessionId || answer.takeId !== take.id || answer.requestId !== request.current) return;
    request.current = null;
    setPending(false);
    setNote(answer.accepted ? "Image added to the character kit." : answer.reason ?? "The image could not be used.");
    if (answer.accepted) setOpen(false);
  }), [worldId, sessionId, take.id]);
  useEffect(() => {
    if (store.connection === "open" || request.current === null) return;
    request.current = null;
    setPending(false);
    setNote("Connection lost. Check the character kit before trying again.");
  }, [store.connection]);
  return <>
    <Button variant="outline" data-testid="bench-use-reference" disabled={store.connection !== "open" || characters.length === 0} onClick={() => { setNote(null); setOpen(true); }}>Use in character kit…</Button>
    {!open && note && <span role="status">{note}</span>}
    <EditorDialog open={open} title="Use in character kit" subtitle={`Bench · Take ${take.n}`} onClose={() => { if (!pending) setOpen(false); }}>
      <div style={{ display: "grid", gap: 16, padding: 20 }}>
        <label style={{ display: "grid", gap: 6 }}>Character<Select label="Character" value={sheetId} disabled={pending} onChange={event => setSheetId(event.target.value)}><option value="">Choose a character</option>{characters.map(sheet => <option key={sheet.id} value={sheet.id}>{sheet.name}</option>)}</Select></label>
        <label style={{ display: "grid", gap: 6 }}>Use as<Select label="Use as" value={image} disabled={pending} onChange={event => setImage(event.target.value as typeof image)}><option value="main-photo">Main photo</option><option value="character-sheet">Character sheet</option></Select></label>
        <p>{character ? `The image becomes the selected ${image === "main-photo" ? "main photo" : "character sheet"} for ${character.name}.` : "Choose the character whose kit will use this image."} Existing images stay in the kit’s history.</p>
        <p>No new image is generated.</p>
        {note && <p role="alert">{note}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" data-testid="bench-use-reference-confirm" disabled={pending || !character || store.connection !== "open"} onClick={() => {
            const id = sendBenchUseReference(worldId, sessionId, take.id, sheetId, image);
            if (id === null) { setNote("Not connected. Try again."); return; }
            request.current = id; setPending(true); setNote(null);
          }}>{pending ? "Using image…" : "Use image"}</Button>
        </div>
      </div>
    </EditorDialog>
  </>;
}
