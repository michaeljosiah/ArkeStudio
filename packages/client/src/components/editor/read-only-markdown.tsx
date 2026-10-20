import { useMemo } from "react";
import { describeRichModeRefusal } from "./rich-mode.js";
import { markdownHTML } from "./round-trip.js";

/** A reading view uses the existing parser without mounting an editing session for each section. */
export function ReadOnlyMarkdown({ value, ariaLabel }: { value: string; ariaLabel: string }) {
  const html = useMemo(() => {
    let rendered: string | null = null;
    const refusal = describeRichModeRefusal(value, text => (rendered = markdownHTML(text)));
    return refusal ? null : rendered;
  }, [value]);
  return <div className="fy-rme fy-rme--read">
    {/* Only schema-generated HTML enters this sink; unsupported content falls back to escaped text. */}
    {html === null
      ? <div className="fy-rme__doc" role="document" aria-label={ariaLabel} style={{ whiteSpace: "pre-wrap" }}>{value}</div>
      : <div className="fy-rme__doc" role="document" aria-label={ariaLabel} dangerouslySetInnerHTML={{ __html: html }} />}
  </div>;
}
