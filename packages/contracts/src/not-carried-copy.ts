import type { WorldChatNotCarried } from "./world-chat.js";
import { CHARACTER_ROLE_MAX } from "./world.js";

/**
 * Why a point from a conversation did not become a proposal, in the person's own terms (R-13,
 * R-27d), said once for the approvals screen and the chat's wrap-up alike (issue 2815). The two
 * used to word every reason differently, so a person read two explanations of one thing; the
 * chat's shorter wording is the one kept. It is a clause: the chat sets it after a colon, and the
 * screen as a sentence of its own.
 *
 * The wording matters most for `tentative`, the commonest and the one that sounds like a bug if
 * it is put badly: "still a maybe" describes the design, where "not settled" would describe a
 * field.
 */
export function notCarriedReason(reason: WorldChatNotCarried["reason"]): string {
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
    case "role-too-long":
      return `it gives a role of more than ${CHARACTER_ROLE_MAX} characters, and a role is a label rather than a sentence`;
    case "unknown-section":
      return "it writes under a heading this kind of sheet does not have, so none of it would reach the page";
    case "changes-nothing":
      return "everything in it is already what the world says";
    case "incomplete-read":
      return "the complete current record was not read at the revision this replacement would overwrite";
  }
}
