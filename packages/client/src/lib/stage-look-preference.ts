import { STAGE_LOOKS, type StageLook } from "@arke-studio/contracts";

/**
 * The Stage's look on this device (issue 1825): Greybox, Lit or Plate is how a person likes to see
 * the Stage, a habit of the person at this machine and never a fact about the world, so it lives
 * in the browser's own storage and travels nowhere. The playblast records the look it was exported
 * in. Storage can be absent or refuse (a private window, blocked site data); every read and write
 * is guarded, and Lit is the look without it.
 */
const KEY = "arke.stage.look";

export function readStageLook(): StageLook {
  try {
    const saved = globalThis.localStorage?.getItem(KEY) ?? "";
    return (STAGE_LOOKS as readonly string[]).includes(saved) ? saved as StageLook : "lit";
  } catch {
    return "lit";
  }
}

export function rememberStageLook(look: StageLook): void {
  try {
    globalThis.localStorage?.setItem(KEY, look);
  } catch {
    // The choice still holds for this visit.
  }
}
