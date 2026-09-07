import type { PromptReview } from "@arke-studio/contracts";
import { reviewPrompt } from "@arke-studio/contracts";
import { useEffect, useState } from "react";

export function ShotPromptProposalDiff({ before, after }: { before: string | null; after: string | null }) {
  const [result, setResult] = useState<{ before: string; after: string; review: PromptReview } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true; setResult(null); setError("");
    if (before && after) void reviewPrompt(before, after, [], "shot-prompt").then(review => {
      if (current) setResult({ before, after, review });
    }).catch(() => { if (current) setError("Prompt diff unavailable. Review the complete before and after text."); });
    return () => { current = false; };
  }, [before, after]);
  if (!before || !after) return <p>No pair of filed overrides to compare. Review the complete new or removed text above.</p>;
  if (error) return <p role="status">{error}</p>;
  return result?.before === before && result.after === after ? <PromptReviewDetails review={result.review} /> : <p role="status">Calculating exact prompt changes…</p>;
}
export function PromptReviewDetails({ review, showMetrics=true }: {review:PromptReview;showMetrics?:boolean}) {
  const [open,setOpen]=useState(false),[limit,setLimit]=useState(30);
  const additions=review.hunks.filter(h=>h.op==="add");
  const unverified=additions.filter(h=>h.support==="unverified"&&/[\p{L}\p{N}]/u.test(h.text));
  const ordered=[...unverified,...review.hunks.filter(h=>!unverified.some(u=>u===h))];
  const added=additions.reduce((sum,h)=>sum+Array.from(h.text).length,0);
  const removed=review.hunks.filter(h=>h.op==="delete").reduce((sum,h)=>sum+Array.from(h.text).length,0);
  return <div className="fy-prompt-review" aria-label="Creative prompt diff" style={{overflowWrap:"anywhere"}}>
    {showMetrics&&<p>{review.candidate.characters} Unicode characters · {review.candidate.utf8Bytes} UTF-8 bytes. Change: {review.characterDelta>=0?"+":""}{review.characterDelta} characters.</p>}
    {review.hunks.length===0?<p>No textual changes.</p>:<>
      <p>Added {added} characters; removed {removed}.{unverified.length>0&&<> {unverified.length} {unverified.length===1?"addition is":"additions are"} <abbr tabIndex={0} title="Unverified means the application found no exact quotation in the supplied sources. It does not mean false.">unverified</abbr>.</>}</p>
      <details onToggle={event=>setOpen(event.currentTarget.open)}>
        <summary>Review changes</summary>
        {open&&<div className="fy-prompt-review__hunks">
          {ordered.slice(0,limit).map((h,i)=><div key={i}>
            {h.op==="delete"?<p>Removed: <del>{h.text}</del></p>:<>
              <p>Added: <ins>{h.text}</ins> · {h.support==="unverified"?<abbr tabIndex={0} title="No exact quotation found in the supplied sources. This does not mean false.">unverified</abbr>:"exact-source"}</p>
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
