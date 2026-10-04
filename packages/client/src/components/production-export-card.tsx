import { useState } from "react";
import { ConversationExportStateSchema, type ConversationActionCard, type ProductionCardPreview } from "@arke-studio/contracts";
import { cancelExport, useExports, useStore } from "../lib/store.js";
import { mediaUrl } from "../lib/media.js";
import { clock } from "./player.js";
import { Button } from "./ui.js";

type ExportContext = Pick<ConversationActionCard, "worldId" | "productionId" | "authority" | "exportState">;

function useCardExport(action: ExportContext) {
  const record = useExports()[action.authority.id];
  const candidate = record?.worldId === action.worldId && record.productionId === action.productionId ? record : action.exportState;
  const parsed = ConversationExportStateSchema.safeParse(candidate ? { status: candidate.status, percent: candidate.percent, output: candidate.output } : null);
  return parsed.success ? parsed.data : null;
}
export function ProductionExportCard({ preview, action }: { preview: Extract<ProductionCardPreview, { kind: "export" }>; action: ExportContext }) {
  const record = useCardExport(action);
  return <div className="fy-production-preview" aria-label="Export preview"><dl>{[
    ["Preset", preview.preset.replaceAll("-", " ")], ["Duration", preview.durationSec === null ? "Unavailable" : clock(preview.durationSec)],
    ["Picture", `${preview.dimensions} · ${preview.frameRate} fps`], ["Subtitles", preview.subtitles], ["Scope", preview.scope],
  ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {record && <div role="status"><p>{record.status === "running" ? `Rendering · ${Math.round(record.percent)}%` : record.status}</p>
      {record.status === "running" && <><progress value={record.percent} max={100} /><Button variant="ghost" onClick={() => cancelExport(action.worldId, action.authority.id)}>Cancel export</Button></>}
    </div>}
  </div>;
}
export function ProductionExportReceipt({ action }: { action: ConversationActionCard }) {
  const world = useStore().state?.world;
  const record = useCardExport(action);
  const [result, setResult] = useState("");
  if (world?.meta.worldId !== action.worldId || record?.status !== "done" || !record.output) return null;
  const output = record.output;
  return <div className="fy-generation-card" aria-label="Completed export">
    <video className="fy-actioncard__media" controls preload="metadata" src={mediaUrl(world.meta.slug, output)} />
    {typeof window !== "undefined" && window.arke?.revealMedia ? <Button variant="ghost" onClick={() => {
      void window.arke!.revealMedia!(world.meta.slug, output).then(answer => setResult(answer.ok ? "" : answer.reason));
    }}>Open</Button> : <a href={mediaUrl(world.meta.slug, output)} target="_blank" rel="noreferrer">Open</a>}
    <span role="status">{result}</span>
  </div>;
}
