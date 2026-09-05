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
export function PromptReviewDetails({ review }: {review:PromptReview}) {
  return <div aria-label="Creative prompt diff" style={{overflowWrap:"anywhere"}}>
    <p>{review.candidate.characters} Unicode characters · {review.candidate.utf8Bytes} UTF-8 bytes. Change: {review.characterDelta>=0?"+":""}{review.characterDelta} characters.</p>
    <p>Unverified means the application found no exact quotation in the supplied sources. It does not mean false.</p>
    {review.hunks.length===0?<p>No textual changes.</p>:review.hunks.map((h,i)=><div key={i} style={{marginBlock:8}}>
      {h.op==="delete"?<p>Removed: <del>{h.text}</del></p>:<><p>Added: <ins>{h.text}</ins> · {h.support}</p>
      {h.sources.map((source,j)=><p key={j}>Exact source: {source.ref} · “{source.quote}”</p>)}
      {h.warnings.map(w=><p key={w}>{w}</p>)}</>}
    </div>)}
  </div>;
}
