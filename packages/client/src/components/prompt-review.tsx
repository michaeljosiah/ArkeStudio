import type { PromptReview } from "@arke-studio/contracts";
import { reviewPrompt, promptCapabilityWarnings, productionShape, type PromptCapabilityModel } from "@arke-studio/contracts";
import { useEffect, useState } from "react";
import { useStore } from "../lib/store.js";
import { useResolvedModel, resolveModel, productionModel } from "./dispatch-bar.js";

export function ResolvedPromptCapabilityNotices({text, capability, modelId}: {text: string; capability: "image" | "video"; modelId?: string}) {
  const { state } = useStore();
  const { model } = useResolvedModel(state, capability, modelId);
  return <PromptCapabilityNotices text={text} model={model} />;
}

export function PromptCapabilityNotices({text, model}: {text: string; model: PromptCapabilityModel | null | undefined}) {
  return <>{model && promptCapabilityWarnings(text, model).map(warning => <p role="status" key={warning}>{warning}</p>)}</>;
}

export function ShotPromptProposalDiff({ before, after, targetPath }: { before: string | null; after: string | null; targetPath: string }) {
  const { state } = useStore();
  // A proposal can be reviewed outside its production route. Its target names the owner.
  const productionId = /^productions\/([^/]+)\/scenes\//.exec(targetPath)?.[1];
  const production = state?.world?.productions.find(p => p.meta.id === productionId);
  const capability = production && productionShape(production.meta).dispatchCapability === "image" ? "image" : "video";
  const model = productionId ? resolveModel(state, capability, undefined, productionModel(state, productionId, capability)).model : null;
  const [result, setResult] = useState<{ before: string; after: string; model: PromptCapabilityModel | null; review: PromptReview } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true; setResult(null); setError("");
    if (before && after) void reviewPrompt(before, after, [], "shot-prompt", model ?? undefined).then(review => {
      if (current) setResult({ before, after, model, review });
    }).catch(() => { if (current) setError("Prompt diff unavailable. Review the complete before and after text."); });
    return () => { current = false; };
  }, [before, after, model]);
  if (result?.before === before && result.after === after && result.model === model) return <PromptReviewDetails review={result.review} />;
  return <><PromptCapabilityNotices text={after ?? ""} model={model} />
    {!before || !after ? <p>No pair of filed overrides to compare. Review the complete new or removed text above.</p> :
      <p role="status">{error || "Calculating exact prompt changes…"}</p>}
  </>;
}
export function PromptReviewDetails({ review, showMetrics=true }: {review:PromptReview;showMetrics?:boolean}) {
  const [open,setOpen]=useState(false),[limit,setLimit]=useState(30);
  const additions=review.hunks.filter(h=>h.op==="add");
  const unverified=additions.filter(h=>h.support==="unverified");
  const ordered=[...unverified,...review.hunks.filter(h=>!unverified.some(u=>u===h))];
  const removed=review.hunks.filter(h=>h.op==="delete").length;
  return <div className="fy-prompt-review" aria-label="Creative prompt diff" style={{overflowWrap:"anywhere"}}>
    {review.capabilityWarnings?.map(warning => <p role="status" key={warning}>{warning}</p>)}
    {showMetrics&&<p>{review.candidate.characters} Unicode characters · {review.candidate.utf8Bytes} UTF-8 bytes. Change: {review.characterDelta>=0?"+":""}{review.characterDelta} characters.</p>}
    {review.hunks.length===0?<p>No textual changes.</p>:<>
      <p>Changed passages: {additions.length} added; {removed} removed.{unverified.length>0&&<> {unverified.length} {unverified.length===1?"addition is":"additions are"} <abbr tabIndex={0} title="Unverified means the application found no exact quotation in the supplied sources. It does not mean false.">unverified</abbr>.</>}</p>
      <details onToggle={event=>setOpen(event.currentTarget.open)}>
        <summary>Review changes</summary>
        {open&&<div className="fy-prompt-review__hunks">
          {ordered.slice(0,limit).map((h,i)=><div key={i}>
            {h.op==="delete"?<p>Removed passage: <del>{h.text}</del></p>:<>
              <p>Added passage: <ins>{h.text}</ins> · {h.support==="unverified"?<abbr tabIndex={0} title="No exact quotation found in the supplied sources. This does not mean false.">unverified</abbr>:"exact-source"}</p>
              {h.sources.length>0&&<details><summary>{h.sources.length} exact sources</summary>
                {h.sources.map((source,j)=><p key={j}>Exact source: {source.ref} · “{source.quote}”</p>)}
              </details>}
              {h.warnings.map(w=><p key={w}>{w}</p>)}
            </>}
          </div>)}
          {ordered.length>limit&&<button type="button" onClick={()=>setLimit(limit+30)}>Show more changes ({ordered.length-limit} remaining)</button>}
        </div>}
      </details>
    </>}
  </div>;
}
