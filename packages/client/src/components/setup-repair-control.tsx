import { useId, useRef, useState } from "react";
import { storageByteLabel, type SetupComponent } from "@arke-studio/contracts";
import { setupRepair } from "../lib/store.js";
import { EditorDialog } from "./editor-dialog.js";
import { Button } from "./ui.js";

export function SetupRepairControl({ component, repair = setupRepair }: {
  component: SetupComponent; repair?: (id: string, revision: string) => void;
}) {
  const heading = useId(), sent = useRef(false);
  const [review, setReview] = useState<SetupComponent["repairReview"] | null>(null);
  const current = review && review.revision === component.repairReview?.revision;
  return <>
    <button type="button" className="fy-set__link" disabled={!component.repairReview}
      onClick={() => { sent.current = false; setReview(component.repairReview ?? null); }}>Repair</button>
    <EditorDialog open={review !== null} title={`Repair ${component.displayName}?`} labelledBy={heading} onClose={() => setReview(null)}>
      <div className="fy-exsheet">
        <p>Replace this component’s files and download them again. Estimated download: {storageByteLabel(review?.downloadBytes ?? null)}. Additional disk space: {storageByteLabel(review?.peakBytes ?? null)}, plus the normal reserve.</p>
        <p>Current work must finish first. This model will be unavailable until its download and verification finish. Your worlds, artwork and recordings are kept.</p>
        <p>You can cancel the download in Downloads. File replacement cannot be undone.</p>
        {!current && <p>Installation details changed. Cancel and review Repair again.</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={() => setReview(null)}>Cancel</Button>
          <Button variant="primary" disabled={!current} onClick={() => {
            if (!current || !review || sent.current) return;
            sent.current = true; setReview(null); repair(component.id, review.revision);
          }}>Repair and download</Button>
        </div>
      </div>
    </EditorDialog>
  </>;
}
