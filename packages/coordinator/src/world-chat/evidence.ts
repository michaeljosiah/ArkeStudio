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
  | { kind: "message-not-the-users"; messageId: string }
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
  /**
   * The passages of each attachment that may be quoted, keyed by attachment id.
   *
   * Ranges rather than one string, because a document is not read whole: the model is shown its
   * opening inline and may page into the rest through `get_attachment_text`, from any offset.
   * Holding them separately keeps two things true that a concatenation would lose — a quotation
   * is checked against text the model actually read, and it cannot be assembled across a seam
   * between passages that were never adjacent.
   */
  attachmentText: ReadonlyMap<string, readonly string[]>;
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
      /**
       * Only the user's own words are evidence.
       *
       * Every purpose a message citation can carry — intent, settledness, correction — is a
       * statement about what the *person* wanted, decided or changed. The Studio's replies are
       * this app's own prose, and a proposition evidenced by one is circular: an inference the
       * model made two turns ago would come back as a fact, verified, indistinguishable in the
       * panel from something the user actually said. The quote would match, which is exactly
       * what makes it worth refusing here rather than trusting the prompt not to offer it.
       */
      if (message.role !== "user") {
        return [{ kind: "message-not-the-users", messageId: evidence.messageId }];
      }
      if (message.text.slice(evidence.start, evidence.end) === evidence.quote) return [];

      /**
       * Offsets that miss are forgiven when the quotation itself is real; a quotation that is
       * not in the message never is.
       *
       * `slice` counts UTF-16 code units, so one emoji earlier in the sentence puts a
       * code-point count out by one and every subsequent offset with it. That is a counting
       * convention, not a false citation — the words really were said — and failing the whole
       * turn over it costs the user their answer twice, since the corrective retry has no more
       * chance of guessing the convention than the first attempt did. The claim this evidence
       * makes is "they said this", and `includes` is exactly that claim. `normaliseEvidence`
       * puts the offsets right before the candidate is stored, so the record stays exact.
       */
      if (locateQuote(message.text, evidence.quote) !== null) return [];

      if (evidence.end > message.text.length || evidence.start > evidence.end) {
        return [{ kind: "message-span-out-of-range", messageId: evidence.messageId }];
      }
      return [
        {
          kind: "message-span-mismatch",
          messageId: evidence.messageId,
          expected: evidence.quote,
          found: message.text.slice(evidence.start, evidence.end),
        },
      ];
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
      } else if (evidence.ref.kind === "sheet") {
        const sheetId = evidence.ref.sheetId;
        entity = sources.bundle.sheets.find((s) => s.id === sheetId);
        if (!entity) return [{ kind: "world-entity-missing", ref: label }];
        current = sheetObservation(entity);
      } else {
        // A production record has no observed version or content hash to compare a citation
        // against, so a citation naming one cannot be checked — which is a missing entity as far
        // as this check is concerned, and is said rather than crashed on.
        return [{ kind: "world-entity-missing", ref: label }];
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
        if (locateQuote(haystack, evidence.quote) === null) {
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
      const passages = sources.attachmentText.get(evidence.attachmentId);
      if (passages === undefined || !passages.some((text) => locateQuote(text, evidence.quote) !== null)) {
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

/**
 * Where a quotation sits in a text, forgiving how the text happens to be laid out (§5.8).
 *
 * The claim a quotation makes is "these words, in this order, are in this entity" — not "these
 * bytes". Canon bodies are markdown wrapped at about ninety-five columns, so a sentence quoted
 * across a wrap arrives with a space where the file has a newline and a byte-exact `includes`
 * can never match it. Found by driving on 2026-08-21: two well-grounded season answers were
 * refused in a row, and the harder a model tried to quote real canon the more certainly it
 * failed.
 *
 * So the comparison folds the things that are about rendering rather than content: runs of
 * whitespace become one space, and the typographic variants of quotes and dashes become their
 * plain forms. Nothing else is forgiven — every word must still be present, in order, which is
 * the whole of what the citation asserts. The returned span is in the ORIGINAL text, so a
 * verified quotation still stores offsets that point at the real words.
 */
export function locateQuote(haystack: string, quote: string): { start: number; end: number } | null {
  const fold = (ch: string): string => {
    if (/\s/.test(ch)) return " ";
    if (ch === "\u2018" || ch === "\u2019") return "'";
    if (ch === "\u201C" || ch === "\u201D") return '"';
    if (ch === "\u2013" || ch === "\u2014" || ch === "\u2212") return "-";
    if (ch === "\u00A0") return " ";
    return ch;
  };
  // A projection of the text with runs of whitespace collapsed, and an index back to the
  // original for every character kept — so a match found here can be reported as a real span.
  const project = (text: string): { flat: string; at: number[] } => {
    let flat = "";
    const at: number[] = [];
    let lastWasSpace = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = fold(text[i]!);
      if (ch === " ") {
        if (lastWasSpace || flat === "") continue;
        lastWasSpace = true;
      } else lastWasSpace = false;
      flat += ch;
      at.push(i);
    }
    return { flat, at };
  };
  const hay = project(haystack);
  const needle = project(quote).flat.trim();
  if (needle === "") return null;
  const found = hay.flat.indexOf(needle);
  if (found === -1) return null;
  const start = hay.at[found]!;
  const lastKept = hay.at[found + needle.length - 1]!;
  return { start, end: lastKept + 1 };
}

export function verifyAllEvidence(
  evidence: readonly CandidateEvidence[],
  sources: EvidenceSources,
): EvidenceProblem[] {
  return evidence.flatMap((e) => verifyEvidence(e, sources));
}

/**
 * Put verified offsets where the quotation actually is, before it is stored (§5.8).
 *
 * Verification forgives a miscounted offset when the quoted words are really in the message;
 * this is the other half of that bargain. Storing the offsets as sent would leave a candidate
 * whose evidence points at the wrong span — checkable today only because `includes` happens to
 * be forgiving, and quietly wrong to anyone who later reads the record as exact. Anything that
 * does not resolve is left untouched: it did not verify, so the turn is not being stored.
 */
export function normaliseEvidence(
  evidence: readonly CandidateEvidence[],
  messages: readonly WorldChatMessage[],
): CandidateEvidence[] {
  return evidence.map((e) => {
    if (e.kind !== "message") return e;
    const message = messages.find((m) => m.id === e.messageId);
    if (!message || message.text.slice(e.start, e.end) === e.quote) return e;
    const span = locateQuote(message.text, e.quote);
    return span === null ? e : { ...e, start: span.start, end: span.end };
  });
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
    case "message-not-the-users":
      return "Evidence cites one of your own replies. Only the user's messages are evidence — cite the id shown beside their words.";
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
