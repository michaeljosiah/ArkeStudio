import { useMemo } from "react";
import { externalWebUrl } from "@arke-studio/contracts";
import { describeRichModeRefusal } from "./rich-mode.js";
import { markdownHTML } from "./round-trip.js";

/** A reading view uses the existing parser without mounting an editing session for each section. */
export function ReadOnlyMarkdown({ value, ariaLabel }: { value: string; ariaLabel: string }) {
  const html = useMemo(() => {
    // A reading view never rewrites link definitions, so the authoring-only refusal does not apply.
    const refusal = describeRichModeRefusal(value, () => "");
    if (refusal && refusal.reason !== "reference-links") return null;
    const rendered = markdownHTML(value);
    if (rendered === null) return null;
    const view = document.createElement("div");
    view.innerHTML = rendered;
    for (const link of view.querySelectorAll("a[href]")) {
      const href = externalWebUrl(link.getAttribute("href")!);
      if (href) link.setAttribute("href", href);
      else { link.removeAttribute("href"); link.removeAttribute("target"); }
    }
    for (const input of view.querySelectorAll("input")) input.disabled = true;
    return view.innerHTML;
  }, [value]);
  return <div className="fy-rme fy-rme--read">
    {/* Only schema-generated HTML enters this sink; unsupported content falls back to escaped text. */}
    {html === null
      ? <div className="fy-rme__doc" role="document" aria-label={ariaLabel} style={{ whiteSpace: "pre-wrap" }}>{value}</div>
      : <div className="fy-rme__doc" role="document" aria-label={ariaLabel} dangerouslySetInnerHTML={{ __html: html }} />}
  </div>;
}
