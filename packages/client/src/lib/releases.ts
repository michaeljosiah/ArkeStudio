import { RELEASE_CARDS } from "./release-cards.js";
import { orderReleases, parseReleaseCard, type ReleaseCard } from "./release-notes.js";

/**
 * The release cards the build carries (SPEC-016 R-19): the newest eight, chosen and bundled by
 * the release-cards Vite plugin, never fetched. Under node's test runner the generated module is
 * its checked-in stub — no cards — and a test injects its own.
 */
let injected: ReleaseCard[] | null = null;
let gathered: ReleaseCard[] | null = null;

export function bundledReleases(): ReleaseCard[] {
  if (injected) return injected;
  if (gathered === null) {
    gathered = orderReleases(
      RELEASE_CARDS.map((card) => parseReleaseCard(card.tag, card.notes, () => card.picture)).filter(
        (card): card is ReleaseCard => card !== null,
      ),
    );
  }
  return gathered;
}

export function __setReleasesForTest(cards: ReleaseCard[] | null): void {
  injected = cards ? orderReleases(cards) : null;
}
