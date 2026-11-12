import { useMemo } from "react";
import { externalWebUrl } from "@arke-studio/contracts";
import { describeRichModeRefusal } from "./rich-mode.js";
import { markdownHTML, markdownText } from "./round-trip.js";

function canReadMarkdown(value: string): boolean {
  // Reading does not rewrite definitions, so reference links need no authoring refusal.
  const refusal = describeRichModeRefusal(value, () => "");
  return !refusal || refusal.reason === "reference-links";
}

/** Card copy shares the reading view's supported forms and escaped-source fallback. */
export function readOnlyMarkdownText(value: string): string | null {
  return canReadMarkdown(value) ? markdownText(value) : null;
}

/** A reading view uses the existing parser without mounting an editing session for each section. */
export function ReadOnlyMarkdown({ value, ariaLabel }: { value: string; ariaLabel: string }) {
  const html = useMemo(() => {
    if (!canReadMarkdown(value)) return null;
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
