import { Laptop } from "./icons.js";
/** The gateway enforces this boundary; this is the readable state beside it (turn 175). */
export function OnYourPC({ children }: { children: React.ReactNode }) {
  return <div className="fy-on-pc"><Laptop size={18} /><span><strong>On your PC</strong><small>{children}</small></span></div>;
}
