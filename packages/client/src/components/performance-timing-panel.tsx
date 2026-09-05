import { useEffect, useRef, useState } from "react";
import { calculateDialogueTiming, dialogueSlots, DialogueTimingIntentSchema, ulid, type PerformanceRecord, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { send, subscribePerformanceResults } from "../lib/store.js";
import { Button } from "./ui.js";

export function PerformanceTimingPanel({ world, production, performance }: { world: WorldBundle; production: ProductionBundle; performance: PerformanceRecord }) {
  const [lead,setLead]=useState(0), [sourceIn,setSourceIn]=useState(0), [sourceOut,setSourceOut]=useState(performance.provenance.outputTechnical.durationSec ?? 0);
  const [handle,setHandle]=useState(0), [purpose,setPurpose]=useState<"tail"|"reaction"|"hold">("tail"), [notice,setNotice]=useState("");
  const pending=useRef<string|null>(null);
  useEffect(()=>subscribePerformanceResults(result=>{if(result.requestId===pending.current){pending.current=null;setNotice(result.reason??"Placement updated.");}}),[]);
  const slots=dialogueSlots(production).filter(s=>s.shotId===performance.target.shotId);
  const intent=DialogueTimingIntentSchema.safeParse({sourceRange:{inSec:sourceIn,outSec:sourceOut},postHandle:{kind:purpose,durationSec:handle},overflow:{mode:"forbid"}});
  const timing=slots.length===1 && intent.success ? calculateDialogueTiming(slots[0]!,performance.provenance.outputTechnical.durationSec,lead,intent.data):null;
  const timeline=production.timeline?.status==="ready"?production.timeline:null;
  const placed=timeline?.timeline.tracks.flatMap(t=>t.clips).find(c=>c.source.kind==="performance"&&c.source.shotId===performance.target.shotId)?.source;
  return <fieldset className="grid min-w-0 gap-2 rounded border p-3"><legend>Selected performance timing</legend>
    <p className="break-all text-xs">Selected: {performance.id}. Placed: {placed?.kind==="performance"?placed.performanceId:"none"}.</p>
    <div className="flex flex-wrap gap-2">{([["Source in",sourceIn,setSourceIn],["Source out",sourceOut,setSourceOut],["Lead-in",lead,setLead],["Post-speech handle",handle,setHandle]] as const).map(([label,value,set])=><label className="grid text-xs" key={label}>{label} (seconds)<input className="w-24 rounded border p-1" type="number" min="0" step="0.001" value={value} onChange={e=>set(Number(e.target.value))}/></label>)}
    <label className="grid text-xs">Handle purpose<select value={purpose} onChange={e=>setPurpose(e.target.value as typeof purpose)}><option value="tail">Tail</option><option value="reaction">Reaction</option><option value="hold">Hold</option></select></label></div>
    <p className="text-xs">{timing?.ok?`Slot ${timing.timing.slotDurationSec.toFixed(3)}s · speech ${timing.timing.spokenSec.toFixed(3)}s · required ${timing.timing.requiredMinimumSec.toFixed(3)}s · ${timing.timing.deltaSec<0?"deficit":"spare hold"} ${Math.abs(timing.timing.deltaSec).toFixed(3)}s`:timing?.reason??"Place this shot exactly once on the production timeline. Measured audio is required."}</p>
    {timing?.ok && timing.timing.audioOverflowSec>0 && <p role="status">Speech exceeds picture by {timing.timing.audioOverflowSec.toFixed(3)}s. Extend the picture slot before placing this performance.</p>}
    <Button disabled={!timeline?.hash||!timing?.ok||timing.timing.audioOverflowSec>0||pending.current!==null} onClick={()=>{
      if(!timeline?.hash||!intent.success)return;
      const requestId=ulid();pending.current=requestId;setNotice("Applying reviewed placement…");
      if(!send({kind:"place-selected-performance",requestId,worldId:world.meta.worldId,productionId:production.meta.id,performanceId:performance.id,
        expectedTimelineRevision:timeline.timeline.revision,expectedTimelineHash:timeline.hash,expectedSelectionHash:production.performanceReview.selectionHash,leadInSec:lead,timing:intent.data})) {pending.current=null;setNotice("Reconnect before placing this performance.");}
    }}>{placed?"Update cut to selected performance":"Use selected performance in cut"}</Button>
    <p className="text-xs" role="status">{notice}</p>
  </fieldset>;
}
