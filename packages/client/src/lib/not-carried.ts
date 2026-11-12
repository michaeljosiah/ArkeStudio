import { notCarriedReason, type WorldChatNotCarried } from "@arke-studio/contracts";

/**
 * Why a proposition did not become a proposal, as a sentence for the approvals screen (R-13,
 * R-27d). The approvals screen shows this beside the proposals that did land, so it reads as an
 * explanation rather than an error: "Five of nine points became proposals" invites exactly one
 * question, and the four have to be answerable. The words are contracts' `notCarriedReason`,
 * the same the chat's wrap-up says (issue 2815).
 */
export function explainNotCarried(reason: WorldChatNotCarried["reason"]): string {
  const clause = notCarriedReason(reason);
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}
