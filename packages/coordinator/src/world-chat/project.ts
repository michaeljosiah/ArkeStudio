import type {
  WorldChangeCandidate,
  WorldChatCheckReceipt,
  WorldChatLoaded,
  WorldChatPoint,
  WorldChatWorkspace,
} from "@arke-studio/contracts";

/**
 * The conversation as a screen needs it (#70 §10.3).
 *
 * A deliberate narrowing. The stored candidate carries revisions, structural keys, evidence
 * spans, check receipts and classifications — everything the coordinator needs to decide what may
 * become a proposal. None of it belongs on the screen, and sending it would invite the panel to
 * start making those decisions itself. What the panel needs is a sentence and the thing it is
 * about.
 *
 * Only `live` propositions cross this line (§6.1). Withdrawn and superseded ones are history:
 * they stay in the log and are available in a collapsed view, but the panel is what the studio
 * currently understands, and a retracted idea is not that.
 */

/** How a subject is described in the panel: "sheet · v4", "new rule", "canon · CANON-018". */
function subjectKindOf(candidate: WorldChangeCandidate, sheetVersion?: (slug: string) => number | null): string {
  const subject = candidate.subject;
  if (subject.kind === "new") {
    switch (candidate.classification) {
      case "canon.create":
        return "new rule";
      case "canon.thread":
        return "open thread";
      case "sheet.create":
        return "new sheet";
      default:
        return "new";
    }
  }
  if (subject.kind === "canon") return `canon · ${subject.entryId}`;
  if (subject.kind === "sheet") {
    const version = sheetVersion?.(subject.sheetId) ?? null;
    return version === null ? "sheet" : `sheet · v${version}`;
  }
  return "world";
}

function subjectLabelOf(candidate: WorldChangeCandidate, sheetName?: (slug: string) => string | null): string {
  const subject = candidate.subject;
  if (subject.kind === "new") return subject.label;
  if (subject.kind === "canon") return subject.entryId;
  if (subject.kind === "sheet") return sheetName?.(subject.sheetId) ?? subject.sheetId;
  return "This world";
}

/**
 * Whether a proposition would actually carry at wrap-up (§6.2).
 *
 * The panel does not show this per point — there are no controls on a point — but the wrap-up
 * caption has to say how many of the points become proposals, and saying "nine" when three would
 * carry would be a promise the next screen breaks.
 */
function wouldCarry(candidate: WorldChangeCandidate): boolean {
  if (candidate.classification === "undecided") return false;
  if (candidate.classification === "media.image-opportunity") return false;
  if (candidate.classification === "canon.thread") return candidate.settledness === "unresolved";
  return candidate.settledness === "settled";
}

export interface ProjectOptions {
  sheetName?: (slug: string) => string | null;
  sheetVersion?: (slug: string) => number | null;
}

export function projectPoints(
  candidates: readonly WorldChangeCandidate[],
  options: ProjectOptions = {},
): WorldChatPoint[] {
  return candidates
    .filter((c) => c.status === "live")
    .map((candidate) => ({
      id: candidate.id,
      kind: candidate.classification === "canon.thread" || candidate.classification === "undecided"
        ? ("question" as const)
        : ("point" as const),
      subject: subjectLabelOf(candidate, options.sheetName).slice(0, 160),
      subjectKind: subjectKindOf(candidate, options.sheetVersion).slice(0, 80),
      text: candidate.title.slice(0, 400),
      settled: wouldCarry(candidate),
    }));
}

/**
 * Receipts, worded for a person (§9.3).
 *
 * `querySummary` is already safe product text rather than raw tool JSON, so this only decides how
 * to say what happened. A search that could not run says so: "could not search canon" and "found
 * nothing in canon" mean opposite things to somebody deciding whether an idea is new, and the
 * line under a reply is exactly where that distinction is read.
 */
export function wordReceipt(receipt: WorldChatCheckReceipt): string {
  const what = receipt.querySummary ? ` ${receipt.querySummary}` : "";
  switch (receipt.status) {
    case "unavailable":
      return receipt.tool === "search-canon" || receipt.tool === "search-sheets"
        ? "could not search — the index is unavailable"
        : "could not read — unavailable";
    case "failed":
      return "a check did not complete";
    case "empty":
      if (receipt.tool === "search-canon") return `searched ${receipt.searchedCount ?? 0} canon entries, nothing close`;
      if (receipt.tool === "search-sheets") return `searched ${receipt.searchedCount ?? 0} sheets, nothing close`;
      return `no${what}`;
    default:
      break;
  }
  switch (receipt.tool) {
    case "search-canon":
      return `searched ${receipt.searchedCount ?? 0} canon entries`;
    case "search-sheets":
      return `searched ${receipt.searchedCount ?? 0} sheets`;
    case "get-entry":
    case "get-sheet": {
      const one = receipt.consulted[0];
      if (!one) return `read${what}`;
      return `read${what} v${one.observedVersion}`;
    }
    case "related":
      return `checked what references${what}`;
    case "get-attachment-text":
      return `read${what}`;
    default:
      return `checked${what}`;
  }
}

export function projectWorkspace(
  loaded: WorldChatLoaded,
  receiptsByMessage: ReadonlyMap<string, readonly WorldChatCheckReceipt[]>,
  options: ProjectOptions = {},
): WorldChatWorkspace {
  return {
    conversationId: loaded.id,
    status: loaded.status,
    messages: loaded.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      receipts: (receiptsByMessage.get(m.id) ?? []).map(wordReceipt),
      createdAt: m.createdAt,
    })),
    hasMore: loaded.hasMore,
    points: projectPoints(loaded.candidates, options),
    runStatus: loaded.activeRun?.status ?? null,
    // Any required observation that could not be made makes the panel say so rather than let a
    // proposition read as checked (§9.4).
    retrievalUnavailable: loaded.candidates.some((c) => c.checks.state === "unavailable"),
  };
}
