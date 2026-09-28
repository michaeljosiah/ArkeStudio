import { useState } from "react";
import { REVIEW_NOTE_MAX, type Take, type WorldBundle } from "@arke-studio/contracts";
import { PageSheet } from "./page-sheet.js";
import { Portrait, characterPortraitPath, locationPortraitPath } from "./portrait.js";
import { Button } from "./ui.js";
import { rejectTake, useStore } from "../lib/store.js";

/** A rejection teaches from an explicit citation, chosen from this take's frozen provenance. */
export function RejectTakeChoice({ world, productionId, take, number, shotId, onClose }: {
  world: WorldBundle; productionId: string; take: Take; number: number; shotId?: string; onClose: () => void;
}) {
  const citations = Object.entries(take.provenance.sheets);
  const { connection } = useStore();
  const [sheet, setSheet] = useState(citations[0]?.[0] ?? "");
  const [note, setNote] = useState("");
  return <PageSheet open onClose={onClose} title={`Reject take ${number}`} className="fy-reject-take" footer={<>
    <Button variant="outline" onClick={onClose}>Cancel</Button>
    <Button variant="primary" disabled={connection !== "open" || !citations.some(([id]) => id === sheet)} onClick={() => {
      rejectTake(world.meta.worldId, productionId, take.id, { sheet, field: "appearance", note }, shotId); onClose();
    }}>Reject take {number}</Button>
  </>}>
    <h3>Drifted from</h3>
    <div className="fy-reject-take__citations" role="group" aria-label="Drifted from">
      {citations.map(([id, version]) => {
        const source = world.sheets.find(candidate => candidate.id === id);
        return <button key={id} type="button" aria-pressed={sheet === id} onClick={() => setSheet(id)}>
          <Portrait worldSlug={world.meta.slug} path={source?.type === "location" ? locationPortraitPath(world, id) : characterPortraitPath(world, id)} label={source?.name ?? id} radius={8} />
          <span><b>{source?.name ?? id}</b><small>appearance · v{version}</small></span><i aria-hidden="true">{sheet === id ? "✓" : ""}</i>
        </button>;
      })}
    </div>
    <label className="fy-reject-take__note">Note<textarea value={note} maxLength={REVIEW_NOTE_MAX} onChange={event => setNote(event.target.value.slice(0, REVIEW_NOTE_MAX))} /></label>
  </PageSheet>;
}
