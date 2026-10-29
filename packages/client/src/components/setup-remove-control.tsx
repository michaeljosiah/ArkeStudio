import { useId, useRef, useState } from "react";
import { storageByteLabel, type SetupComponent } from "@arke-studio/contracts";
import { setupRemove } from "../lib/store.js";
import { EditorDialog } from "./editor-dialog.js";
import { Button } from "./ui.js";

/** One review shared by Models and Downloads; the host still owns every removal fence. */
export function SetupRemoveControl({ component, label = "Remove", remove = setupRemove }: {
  component: SetupComponent; label?: string; remove?: (id: string) => void;
}) {
  const heading = useId(), submitted = useRef(false);
  const [review, setReview] = useState<string | null>(null);
  const identity = JSON.stringify([component.id, component.installLocation, component.state,
    component.sizeMb, component.installedMb, component.leftovers]);
  const current = review === identity;
  const size = component.sizeMb * 1024 ** 2;
  return <>
    <button type="button" className="fy-set__link" onClick={() => { submitted.current = false; setReview(identity); }}>{label}</button>
    <EditorDialog open={review !== null} title={`Remove ${component.displayName}?`} labelledBy={heading} onClose={() => setReview(null)}>
      <div className="fy-exsheet">
        <p>Estimated size: {storageByteLabel(size)}. Shared files or files still in use may reduce the space recovered.</p>
        <p>You will need to download it again to use it. Your worlds, artwork and recordings are kept.</p>
        {!current && <p>Installation details changed. Cancel and review the current item again.</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={() => setReview(null)}>Cancel</Button>
          <Button variant="primary" disabled={!current} onClick={() => {
            if (!current || submitted.current) return;
            submitted.current = true; setReview(null); remove(component.id);
          }}>Remove</Button>
        </div>
      </div>
    </EditorDialog>
  </>;
}
