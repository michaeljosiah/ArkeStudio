import type {
  CandidateEvidence,
  CanonEntry,
  Sheet,
  WorldBundle,
  WorldChatAttachment,
  WorldChatMessage,
} from "@arke-studio/contracts";
import { canonObservation, quotableText, sheetObservation } from "./observations.js";

/**
 * Checking that a proposition's reasons are real (#70 §5.8).
 *
 * Every quotation is verified against the thing it claims to come from before the turn is
 * accepted. This is the mechanism behind the panel being trustworthy at a glance: a proposition
 * says "because you said her aunt", and that span really is in that message, at those offsets.
 *
 * The failure mode this exists to prevent is not malice, it is fluency. A model asked to justify
 * a proposition will produce a plausible quotation whether or not one exists, and a plausible
 * quotation is indistinguishable from a real one to a reader who is not going to go and check.
 * So the app checks, every time, and a turn whose evidence does not verify does not land at all.
 */

export type EvidenceProblem =
  | { kind: "message-missing"; messageId: string }
  | { kind: "message-span-mismatch"; messageId: string; expected: string; found: string }
  | { kind: "message-span-out-of-range"; messageId: string }
  | { kind: "world-entity-missing"; ref: string }
  | { kind: "world-version-moved"; ref: string; observed: number; current: number }
  | { kind: "world-content-changed"; ref: string }
  | { kind: "world-quote-not-found"; ref: string; quote: string }
  | { kind: "attachment-missing"; attachmentId: string }
  | { kind: "attachment-content-changed"; attachmentId: string }
  | { kind: "attachment-quote-not-found"; attachmentId: string; quote: string };

export interface EvidenceSources {
  messages: readonly WorldChatMessage[];
  bundle: WorldBundle;
  attachments: readonly WorldChatAttachment[];
  /** Text of any attachment that may be quoted, keyed by attachment id. */
  attachmentText: ReadonlyMap<string, string>;
}

function refLabel(evidence: Extract<CandidateEvidence, { kind: "world" }>): string {
  const ref = evidence.ref;
  if (ref.kind === "canon") return ref.entryId;
  if (ref.kind === "sheet") return ref.sheetId;
  return "world";
}

/**
 * Verify one piece of evidence, returning every problem it has.
 *
 * Returns problems rather than throwing so a caller can report all of them at once. A corrective
 * retry that names one error at a time would burn the single retry on the first of three.
 */
export function verifyEvidence(evidence: CandidateEvidence, sources: EvidenceSources): EvidenceProblem[] {
  switch (evidence.kind) {
    case "message": {
      const message = sources.messages.find((m) => m.id === evidence.messageId);
      if (!message) return [{ kind: "message-missing", messageId: evidence.messageId }];
      if (evidence.end > message.text.length || evidence.start > evidence.end) {
        return [{ kind: "message-span-out-of-range", messageId: evidence.messageId }];
      }
      const found = message.text.slice(evidence.start, evidence.end);
      if (found !== evidence.quote) {
        return [
          {
            kind: "message-span-mismatch",
            messageId: evidence.messageId,
            expected: evidence.quote,
            found,
          },
        ];
      }
      return [];
    }

    case "world": {
      const label = refLabel(evidence);
      if (evidence.ref.kind === "world") {
        // The world as a whole has no quotable text; a citation of it is a category error.
        return [{ kind: "world-entity-missing", ref: "world" }];
      }

      let entity: CanonEntry | Sheet | undefined;
      let current: { observedVersion: number; contentHash: string };
      if (evidence.ref.kind === "canon") {
        const entryId = evidence.ref.entryId;
        entity = sources.bundle.canon.find((c) => c.id === entryId);
        if (!entity) return [{ kind: "world-entity-missing", ref: label }];
        current = canonObservation(entity, sources.bundle.meta.canonRevision);
      } else {
        const sheetId = evidence.ref.sheetId;
        entity = sources.bundle.sheets.find((s) => s.id === sheetId);
        if (!entity) return [{ kind: "world-entity-missing", ref: label }];
        current = sheetObservation(entity);
      }

      const problems: EvidenceProblem[] = [];
      if (current.observedVersion !== evidence.observedVersion) {
        problems.push({
          kind: "world-version-moved",
          ref: label,
          observed: evidence.observedVersion,
          current: current.observedVersion,
        });
      }
      if (current.contentHash !== evidence.contentHash) {
        problems.push({ kind: "world-content-changed", ref: label });
      }
      // Only worth checking the quote when the content still matches; otherwise the useful
      // report is "this moved", not a second complaint that follows from the first.
      if (problems.length === 0) {
        const haystack = quotableText(entity, evidence.field);
        if (!haystack.includes(evidence.quote)) {
          problems.push({ kind: "world-quote-not-found", ref: label, quote: evidence.quote });
        }
      }
      return problems;
    }

    case "attachment": {
      const attachment = sources.attachments.find((a) => a.id === evidence.attachmentId);
      if (!attachment) return [{ kind: "attachment-missing", attachmentId: evidence.attachmentId }];
      if (attachment.contentHash !== evidence.contentHash) {
        return [{ kind: "attachment-content-changed", attachmentId: evidence.attachmentId }];
      }
      const text = sources.attachmentText.get(evidence.attachmentId);
      if (text === undefined || !text.includes(evidence.quote)) {
        return [
          {
            kind: "attachment-quote-not-found",
            attachmentId: evidence.attachmentId,
            quote: evidence.quote,
          },
        ];
      }
      return [];
    }
  }
}

export function verifyAllEvidence(
  evidence: readonly CandidateEvidence[],
  sources: EvidenceSources,
): EvidenceProblem[] {
  return evidence.flatMap((e) => verifyEvidence(e, sources));
}

/**
 * What a validation failure may say back to the model (§8.4).
 *
 * Deliberately terse and structural. The corrective turn names what was wrong with the shape of
 * the answer, never world content the model has not already been given — a "correction" that
 * quoted the entry it should have cited would be handing over world text through the error path.
 */
export function safeEvidenceMessage(problem: EvidenceProblem): string {
  switch (problem.kind) {
    case "message-missing":
      return "Evidence cites a message that is not in this conversation.";
    case "message-span-mismatch":
      return "A quoted span does not match the text at those offsets in the message.";
    case "message-span-out-of-range":
      return "A quoted span lies outside the message it cites.";
    case "world-entity-missing":
      return "Evidence cites something that is not in this world.";
    case "world-version-moved":
      return "Evidence cites a version that is no longer current; read it again.";
    case "world-content-changed":
      return "Evidence cites content that has changed since it was read; read it again.";
    case "world-quote-not-found":
      return "A quotation was not found in the entity it cites.";
    case "attachment-missing":
      return "Evidence cites an attachment that is not linked to this conversation.";
    case "attachment-content-changed":
      return "Evidence cites an attachment whose contents have changed.";
    case "attachment-quote-not-found":
      return "A quotation was not found in the attachment it cites.";
  }
}
