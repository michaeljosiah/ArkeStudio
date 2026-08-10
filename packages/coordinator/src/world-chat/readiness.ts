import type { WorldBundle, WorldChangeCandidate } from "@arke-studio/contracts";

/**
 * What a proposition may become, decided once (#70 §6.2).
 *
 * Readiness is not a state the user maintains. An earlier draft made it one — each proposition
 * carried a status somebody had to move it out of — and that turned a conversation into twelve
 * small approvals held while the ideas were still moving. It is evaluated here instead, at
 * wrap-up, for every live proposition at once.
 *
 * Nothing is silently dropped. A proposition that cannot carry is named on the approvals screen
 * with the reason, because "five of nine points became proposals" invites exactly one question,
 * and the four have to be answerable.
 */

export type NotCarriedReason =
  | "tentative"
  | "undecided"
  | "target-missing"
  | "invalid"
  | "look-moved"
  | "look-already-proposed";

export interface NotCarried {
  candidateId: string;
  /** The proposition in its own words, so the screen names it rather than counting it (R-27d). */
  summary: string;
  reason: NotCarriedReason;
}

export interface Readiness {
  carried: WorldChangeCandidate[];
  /** Media ideas are retained against their target; they are never proposals (R-37a). */
  mediaIdeas: WorldChangeCandidate[];
  notCarried: NotCarried[];
}

/**
 * Settledness by classification (§6.2).
 *
 * A settled fact must say it is settled and an open question must say it is not. The model may
 * suggest either; this decides. That split is the whole reason the coordinator owns readiness —
 * a model that could mark its own output settled would be deciding what enters the world.
 */
function settlednessHolds(candidate: WorldChangeCandidate): boolean {
  if (candidate.classification === "canon.thread") return candidate.settledness === "unresolved";
  return candidate.settledness === "settled";
}

function targetExists(candidate: WorldChangeCandidate, bundle: WorldBundle): boolean {
  const target = (candidate as unknown as Record<string, unknown>)["target"] as
    | { kind: "canon"; entryId: string }
    | { kind: "sheet"; sheetId: string }
    | undefined;
  if (!target) return true;

  if (target.kind === "canon") {
    const entry = bundle.canon.find((c) => c.id === target.entryId);
    // A retired entry resolves for old citations but must not be amended into the present.
    return entry !== undefined && entry.retired !== true;
  }
  const sheet = bundle.sheets.find((s) => s.id === target.sheetId);
  return sheet !== undefined && sheet.retired !== true;
}

/** Intent has to be verified, not asserted: a proposition with no evidence is a claim about a claim. */
function hasIntentEvidence(candidate: WorldChangeCandidate): boolean {
  return candidate.evidence.some((e) => e.kind === "message" && e.purpose === "intent");
}

/**
 * Whether the checks are good enough to write against.
 *
 * `unavailable` does not block. When the index is down the user is shown the limitation and may
 * still choose to create — refusing outright would make a broken cache into a broken app, and the
 * choice is durable and visible in final review (§9.4).
 */
function checksAllow(candidate: WorldChangeCandidate): boolean {
  return candidate.checks.state !== "partial" || candidate.checks.userOverride !== undefined;
}

export function evaluateReadiness(
  candidates: readonly WorldChangeCandidate[],
  bundle: WorldBundle,
): Readiness {
  const carried: WorldChangeCandidate[] = [];
  const mediaIdeas: WorldChangeCandidate[] = [];
  const notCarried: NotCarried[] = [];

  for (const candidate of candidates) {
    if (candidate.status !== "live") continue;

    if (candidate.classification === "media.image-opportunity") {
      mediaIdeas.push(candidate);
      continue;
    }

    const fail = (reason: NotCarriedReason) =>
      notCarried.push({ candidateId: candidate.id, summary: candidate.title, reason });

    if (candidate.classification === "undecided") {
      fail("undecided");
      continue;
    }
    if (!targetExists(candidate, bundle)) {
      fail("target-missing");
      continue;
    }
    /*
     * A look drafted against a look that has since changed.
     *
     * This classification carries the whole description, so writing it now would replace an edit
     * made in between with words chosen before it existed — and nothing downstream would call
     * that stale, because the proposal is staged against whatever is current at this moment. The
     * proposition is not wrong, only out of date: it stays in the conversation, and saying so is
     * what lets somebody ask for it again against the look that is actually there.
     */
    if (
      candidate.classification === "art-direction.change" &&
      candidate.checks.basedOnArtDirectionVersion !== undefined &&
      candidate.checks.basedOnArtDirectionVersion !== bundle.artDirection.version
    ) {
      fail("look-moved");
      continue;
    }
    /*
     * One look change waiting at a time.
     *
     * There is a single world look, and the screen that reviews a proposed one finds it by kind
     * rather than by id — so a second would be reviewed, accepted or discarded in place of the
     * first, arbitrarily. Held back rather than staged: the conversation keeps the proposition,
     * and it can be asked for again once the one already waiting has been dealt with.
     */
    if (
      candidate.classification === "art-direction.change" &&
      bundle.proposals.some((staged) => staged.proposal.kind === "art-direction")
    ) {
      fail("look-already-proposed");
      continue;
    }
    if (!hasIntentEvidence(candidate) || !checksAllow(candidate)) {
      fail("invalid");
      continue;
    }
    if (!settlednessHolds(candidate)) {
      // The commonest one, and the one worth wording carefully on the screen: "you said maybe,
      // so it cannot become a fact" is the difference between a bug and a design.
      fail("tentative");
      continue;
    }
    carried.push(candidate);
  }

  return { carried, mediaIdeas, notCarried };
}

/**
 * Why a proposition did not carry, in the user's terms.
 *
 * The approvals screen shows this beside the proposals that did land, so it has to read as an
 * explanation rather than an error code.
 */
export function explainNotCarried(reason: NotCarriedReason): string {
  switch (reason) {
    case "tentative":
      return "still a maybe, so it cannot become a fact yet";
    case "look-moved":
      return "the world look changed after this was written, so it would undo that change";
    case "look-already-proposed":
      return "a change to the world look is already waiting to be decided";
    case "undecided":
      return "it is not clear yet what kind of change this is";
    case "target-missing":
      return "what it would change is no longer in the world";
    case "invalid":
      return "there is not enough behind it to write it down";
  }
}
