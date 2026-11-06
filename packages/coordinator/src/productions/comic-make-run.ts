/**
 * What an approved Make card does (design turn 270, SPEC-064): the panels not yet made, redraws of what
 * the review faulted, then the words on every page whose panels are all in. The approved price is the
 * limit on everything it spends. It stops at the price, at the redraw limit or on Stop, and leaves every
 * remaining decision to the author: accepting a panel at fault and accepting a page are never its to do.
 */

/** How often one panel may be redrawn: one hand failed every take in the cell trial, so the card's limit is shared. */
export const COMIC_REDRAWS_PER_PANEL = 2;
/** The card's limit: a redraw for about every second panel, and six at most. */
export const comicCardRedraws = (panels: number): number => Math.min(6, Math.ceil(panels / 2));

export interface ComicMakeOps {
  /** The panels of a page with no picture yet. */
  unmade(page: string): string[];
  /** The panels of a page at fault and not accepted. */
  faulted(page: string): string[];
  allAccepted(page: string): boolean;
  /** What drawing these panels would cost now; null when the page refuses them. */
  price(page: string, panels: readonly string[]): number | null;
  /** Everything spent on the card's pages since it began. */
  spent(): number;
  make(page: string, confirmedMicroUsd: number, panel?: string): Promise<void>;
  /** Until every picture just filed has been looked at. */
  reviewed(page: string, signal: AbortSignal): Promise<void>;
  place(page: string, signal: AbortSignal): Promise<void>;
}

export interface ComicMakeInput {
  pages: readonly string[];
  /** One panel again: drawn once, with no redraws and no placing. */
  panel?: string;
  redraws: number;
  ceilingMicroUsd: number;
  signal: AbortSignal;
}

export type ComicMakeStop = "finished" | "stopped" | "limit";

export async function runComicMake(input: ComicMakeInput, ops: ComicMakeOps): Promise<ComicMakeStop> {
  const { signal } = input;
  const left = () => input.ceilingMicroUsd - ops.spent();
  /** Drawn only when the price allows: a refused page is left to the author, a price past the limit ends the run. */
  const draw = async (page: string, panels: readonly string[], panel?: string): Promise<"drawn" | "refused" | "limit"> => {
    const price = ops.price(page, panels);
    if (price === null) return "refused";
    if (price > left()) return "limit";
    await ops.make(page, left(), panel);
    await ops.reviewed(page, signal);
    return "drawn";
  };

  if (input.panel !== undefined) {
    const [page] = input.pages;
    if (page === undefined) return "finished";
    return await draw(page, [input.panel], input.panel) === "limit" ? "limit" : signal.aborted ? "stopped" : "finished";
  }

  let redraws = input.redraws;
  const tries = new Map<string, number>();
  for (const page of input.pages) {
    if (signal.aborted) return "stopped";
    const unmade = ops.unmade(page);
    if (unmade.length > 0 && await draw(page, unmade) === "limit") return "limit";
    for (;;) {
      if (signal.aborted) return "stopped";
      if (redraws <= 0) break;
      const fault = ops.faulted(page).find((panel) => (tries.get(panel) ?? 0) < COMIC_REDRAWS_PER_PANEL);
      if (fault === undefined) break;
      const drawn = await draw(page, [fault], fault);
      if (drawn === "limit") return "limit";
      tries.set(fault, (tries.get(fault) ?? 0) + 1);
      redraws -= 1;
      if (drawn === "refused") continue;
    }
    if (signal.aborted) return "stopped";
    if (ops.allAccepted(page)) await ops.place(page, signal);
  }
  return signal.aborted ? "stopped" : "finished";
}
