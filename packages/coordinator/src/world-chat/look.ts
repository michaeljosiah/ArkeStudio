import type { CandidateChecks } from "@arke-studio/contracts";
import { sha256 } from "../world/text-files.js";

/**
 * Which look a draft was written against, and whether it is still the look the world has (§6.2).
 *
 * Asked in three places — the rail's count, readiness at wrap-up, and once more after staging has
 * captured a base — and they have to agree. Two of them spelled the rule out separately and the
 * third did not ask at all, which is how the panel came to promise a proposal that wrap-up was
 * always going to refuse.
 */

/** The world look as it stands: the number a person is shown, and the words it stands for. */
export interface CurrentLook {
  version: number;
  description: string;
}

/** What a draft records about the look it replaced, if it recorded anything. */
type LookProvenance = Pick<CandidateChecks, "basedOnArtDirectionVersion" | "basedOnArtDirectionLook">;

/**
 * The identity of a look's content, so a draft can be bound to the words and not just the number.
 *
 * A version alone does not identify a look. A world with no art-direction file still has one,
 * derived from its name, tone, genre and logline — and that derivation is always v1. Edit the
 * world's tone and the description every image is generated from changes while the number stays
 * exactly where it was, so a whole-description draft written before the edit still matched, and
 * overwrote it.
 */
export function lookContentHash(description: string): string {
  return sha256(description);
}

export function lookIdentityOf(look: CurrentLook): {
  basedOnArtDirectionVersion: number;
  basedOnArtDirectionLook: string;
} {
  return {
    basedOnArtDirectionVersion: look.version,
    basedOnArtDirectionLook: lookContentHash(look.description),
  };
}

/**
 * Whether the look a draft was shown has since moved.
 *
 * Both halves are compared and either is enough. The version catches a look that was accepted and
 * then reverted word for word — decided twice, and the second decision is not this draft's to
 * undo. The content catches a derived look rewritten underneath a number that never moves.
 *
 * A draft with neither recorded has not moved: nothing was pinned, so there is nothing to be
 * stale against. That is the case for every `art-direction.change` drafted before the pin existed,
 * and refusing them all on a missing field would be a refusal about our own history rather than
 * about the world.
 */
export function lookHasMoved(checks: LookProvenance, current: CurrentLook | undefined): boolean {
  if (current === undefined) return false;
  if (checks.basedOnArtDirectionVersion !== undefined && checks.basedOnArtDirectionVersion !== current.version) {
    return true;
  }
  return (
    checks.basedOnArtDirectionLook !== undefined &&
    checks.basedOnArtDirectionLook !== lookContentHash(current.description)
  );
}
