import type { WorldChatNotCarried } from "@arke-studio/contracts";

/**
 * Why a proposition did not become a proposal, in the user's own terms (R-13, R-27d).
 *
 * The approvals screen shows this beside the proposals that did land, so it reads as an
 * explanation rather than an error. "Five of nine points became proposals" invites exactly one
 * question, and the four have to be answerable — a count alone leaves somebody wondering what
 * they lost.
 *
 * The wording matters most for `tentative`, which is the commonest and the one that sounds like a
 * bug if it is put badly. "You said maybe, so it cannot become a fact" is a description of the
 * design; "not settled" is a description of a field.
 */
export function explainNotCarried(reason: WorldChatNotCarried["reason"]): string {
  switch (reason) {
    case "tentative":
      return "You said maybe, so it cannot become a fact — it is still in the conversation";
    case "undecided":
      return "It is not clear yet what kind of change this is";
    case "target-missing":
      return "What it would have changed is no longer in the world";
    case "invalid":
      return "There was not enough behind it to write it down";
  }
}
