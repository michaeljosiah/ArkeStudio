import type { CutTransport } from "./editor-transport.js";

/** Local whole-delivery repetition; Current/Suggested and authored history do not own it. */
export function CutLoopControl({ transport }: { transport: Pick<CutTransport, "loop" | "setLoop" | "canLoop"> }) {
  return <button type="button" className="fy-loop-control fy-tlbtn fy-tlbtn--text fy-tlbtn--toggle" aria-label="Loop whole video"
    title="Repeat the whole video delivery" aria-pressed={transport.loop} disabled={!transport.canLoop}
    onClick={() => transport.setLoop(value => !value)}>Loop</button>;
}
