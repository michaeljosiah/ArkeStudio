import type { PromptReview } from "@arke-studio/contracts";
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
