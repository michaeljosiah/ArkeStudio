import { useState, type ReactNode } from "react";
import { Pin, Sparkle } from "./icons.js";
import { ResponsiveSheet } from "./responsive-sheet.js";
import { useMediaQuery } from "../lib/media-query.js";

/** The season and map keep one conversation mounted while its column becomes a drawer. */
export function ArkeEdge({ children, title = "Arke" }: { title?: string; children: (putAway: () => void) => ReactNode }) {
  const compact = useMediaQuery("(max-width: 1099px)");
  const phone = useMediaQuery("(max-width: 599px)");
  const [docked, setDocked] = useState(true), [open, setOpen] = useState(false);
  const inline = !compact && docked;
  return <>
    {!inline && <button type="button" className={phone ? "fy-season-arke" : "fy-sw__rail fy-season-arke-rail"}
      aria-label="Open Arke" aria-haspopup={compact ? "dialog" : undefined} onClick={() => compact ? setOpen(true) : setDocked(true)}>
      {phone ? <Sparkle size={16} /> : <span className="fy-sw__rail-dot" aria-hidden />}
      <span className="fy-sw__rail-label">{phone ? "Arke" : "Ask Arke"}</span><span className="fy-sw__rail-pin"><Pin size={13} /></span>
    </button>}
    <ResponsiveSheet sheet={!inline} open={compact && open} title={title} className="fy-season-arke-sheet" onClose={() => setOpen(false)}>
      {children(() => compact ? setOpen(false) : setDocked(false))}
    </ResponsiveSheet>
  </>;
}
