import type {
  WorldChangeCandidate,
  WorldChatCheckReceipt,
  WorldChatLoaded,
  WorldChatPoint,
  WorldChatWorkspace,
} from "@arke-studio/contracts";
import { type CurrentLook, lookHasMoved } from "./look.js";

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
  // The world look is not one of the world's entities, so no subject ref describes it: whatever
  // the model names, "This world · world" is true and says nothing about what is changing.
  if (candidate.classification === "art-direction.change") return "world look";
  // Production records name themselves (SPEC-023 R-20): the target says exactly which file the
  // proposition would rewrite, and the panel should say the same.
  if (candidate.classification === "development.overview") return "story overview";
  if (candidate.classification === "development.season") return "season";
  if (candidate.classification === "development.episode") {
    return candidate.target.episodeId === undefined ? "new episode" : `episode · ${candidate.target.episodeId}`;
  }
  if (candidate.classification === "development.scene-script") return `scene script · ${candidate.target.sceneId}`;
  if (candidate.classification === "development.shot") {
    return candidate.target.shotId === undefined ? "new shot" : `shot · ${candidate.target.shotId}`;
  }
  if (candidate.classification === "development.series") return `series · ${candidate.target.seriesId}`;
  if (candidate.classification === "media.image-opportunity") {
    const target = candidate.draft.target;
    if (target.kind === "production") return "production";
    if (target.kind === "episode") return target.episodeId ? `episode · ${target.episodeId}` : "episode";
    if (target.kind === "scene") return `scene · ${target.sceneId}`;
    if (target.kind === "shot") return target.shotId ? `shot · ${target.shotId}` : "shot";
    if (target.kind === "series") return `series · ${target.seriesId}`;
  }
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
  if (candidate.classification === "art-direction.change") return "Art direction";
  if (
    candidate.classification === "development.overview" ||
    candidate.classification === "development.season" ||
    candidate.classification === "development.episode"
  ) {
    return candidate.target.productionId;
  }
  if (candidate.classification === "development.scene-script") return candidate.target.sceneId;
  // A shot is named by the scene it lives in — "sh_12" alone says nothing about where it is.
  if (candidate.classification === "development.shot") return candidate.target.sceneId;
  if (candidate.classification === "development.series") return candidate.target.seriesId;
  if (candidate.classification === "media.image-opportunity") {
    const target = candidate.draft.target;
    if (target.kind === "production" || target.kind === "episode") return target.productionId;
    if (target.kind === "scene" || target.kind === "shot") return target.sceneId;
    if (target.kind === "series") return target.seriesId;
  }
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
function wouldCarry(candidate: WorldChangeCandidate, options: ProjectOptions = {}): boolean {
  if (candidate.classification === "undecided") return false;
  if (candidate.classification === "media.image-opportunity") return false;
  if (candidate.classification === "canon.thread") return candidate.settledness === "unresolved";
  if (candidate.classification === "art-direction.change") {
    // Every blocker readiness applies to a look, applied here too. One of the two was, and the
    // other was not, so a point readiness would refuse as moved still counted towards "1 of 1
    // points become proposals" — the caption promising exactly what the button then refused.
    if (options.lookAlreadyProposed === true) return false;
    if (lookHasMoved(candidate.checks, options.look)) return false;
  }
  return candidate.settledness === "settled";
}

/**
 * What the studio is doing, in the house register (§15.3, R-18).
 *
 * Mapped here rather than on the screen because R-18 is explicit that a rendered `tool.activity`
 * string is not a thing the UI may show: those summaries name entities — "checked canon:
 * CANON-002, CANON-007" — and a progress line is not a receipt. The receipts are their own
 * surface, computed by the coordinator and shown when the turn lands. This is only ever the verb.
 *
 * Borrowed in shape from opencode's `computeStatusFromPart`, which maps the last streamed part to
 * a short present-tense phrase. The vocabulary is this product's, because the tools are.
 */
const WORKING_LABELS: Record<string, string> = {
  // The world-query tools, which arrive namespaced — see workingLabel.
  search_canon: "Searching canon",
  search_sheets: "Searching the cast",
  get_entry: "Reading canon",
  get_sheet: "Reading a sheet",
  list_entities: "Looking over the world",
  related: "Checking what references it",
  get_attachment_text: "Reading what you attached",
  fetch_url: "Reading a page online",
  get_production: "Reading the production",
  /*
   * Going online, which is the one thing here a person opted into and the one thing the screen
   * has to be honest about (2026-08-23).
   *
   * Driven against a real turn: it searched four pages and the spinner said "Checking the world"
   * for the whole of it. Someone who has just turned on a switch saying the studio may go online
   * is then told it is reading their own world instead — not a missing label, the wrong claim,
   * at the only moment the distinction matters.
   */
  websearch: "Searching online",
  webfetch: "Reading a page online",
  /*
   * The harness's own read-only tools. The world-builder agent is allowed read, glob, grep, list
   * and the todo pair (adapter-opencode/config.ts READ_ONLY_PERMISSION), and it does reach for
   * them — a turn that only ever showed the world-query verbs would fall back to the generic
   * label for a good part of its life.
   */
  read: "Reading a file",
  glob: "Looking through files",
  grep: "Searching the files",
  list: "Looking through files",
  todowrite: "Planning what to check",
  todoread: "Planning what to check",
  /*
   * Delegation, which in practice is most of what a turn reports.
   *
   * Observed against a real turn: the world-builder agent calls `task`, and every world-query
   * call then happens inside the *child* session — which the runner filters out, because it
   * matches events on its own session id. So the vocabulary above is mostly unreachable today
   * and this is the label a turn actually shows.
   *
   * Worded without naming delegation. That a model spawned a helper is an implementation detail
   * of the harness, and saying "delegating" invites "to whom?" — a question this product has no
   * surface to answer and no reason to raise.
   */
  task: "Working through it",
};

/** The resting label, before any tool has run. Never blank: a spinner with no words is a shrug. */
export const THINKING_LABEL = "Thinking";

/** The label for a turn that has started writing its reply. */
export const WRITING_LABEL = "Writing";

/**
 * The verb for one tool call.
 *
 * MCP tools do not arrive under the names they were registered with. opencode keys every one as
 * `${server}_${tool}` (its `mcp/index.ts`), so `search_canon` — served by the `arke-world` MCP —
 * reaches us as `arke-world_search_canon`. The first version of this looked up the bare name,
 * missed on every world-query call, and fell back to "Checking the world" for the whole turn.
 * The words were all correct and none of them were ever shown.
 *
 * Matched by suffix rather than by stripping a hard-coded `arke-world_`, so renaming the MCP
 * server cannot silently take the vocabulary out again — which is precisely how this went
 * unnoticed: a fallback that reads plausibly hides its own failure.
 *
 * Case-folded for the same reason, found the same way (2026-08-23). The harness names above are
 * OpenCode's, which are lowercase; Claude Code calls the same tools `Read`, `Glob`, `Grep` and
 * `WebSearch`. With Claude as the engine EVERY harness tool missed and the turn showed the
 * fallback throughout — the words were all correct and none of them were ever shown, which is
 * the second time that sentence has been true of this function. Keys here stay lowercase and the
 * incoming name is folded to meet them.
 */
export function workingLabel(tool: string): string {
  const key = tool.toLowerCase();
  const direct = WORKING_LABELS[key];
  if (direct !== undefined) return direct;
  for (const [name, label] of Object.entries(WORKING_LABELS)) {
    if (key.endsWith(`_${name}`)) return label;
  }
  return "Checking the world";
}

export interface ProjectOptions {
  sheetName?: (slug: string) => string | null;
  sheetVersion?: (slug: string) => number | null;
  /**
   * A turn is in flight for this conversation right now (§15.3).
   *
   * Supplied by the caller because the fold cannot know it: on disk a live run and one abandoned
   * by a crash are the same record — a start with no terminal event — so the fold calls both
   * interrupted. Without this the screen never says the studio is thinking, never disables Send
   * and never offers Stop, which is indistinguishable from having sent nothing at all.
   */
  liveRun?: boolean;
  /**
   * A change to the world look is already waiting to be decided.
   *
   * Supplied for the same reason as `liveRun`: the fold cannot see the world's staged proposals,
   * and readiness will refuse a second look on those grounds at wrap-up. Without it the rail
   * counts such a point as one that carries, the caption promises "1 of 1 points become
   * proposals", and pressing the button returns nothing-to-carry — the screen having promised
   * something the coordinator was always going to refuse.
   */
  lookAlreadyProposed?: boolean;
  /**
   * The world look as it stands, for the same reason again.
   *
   * A whole-description draft written against a look that has since moved is held back at
   * wrap-up, and the fold cannot see the world to know it. Absent, a point is counted as
   * carrying — which was the second half of the same broken promise, and the half that survives
   * even when nothing is waiting on the approvals screen.
   */
  look?: CurrentLook;
  /** Why a media brief cannot be prepared yet, keyed by its durable candidate id. */
  mediaBlockedReason?: (candidate: WorldChangeCandidate) => string | null;
  /** Existing Bench handoffs, supplied by projectWorkspace from the fold. */
  mediaHandoffs?: WorldChatLoaded["mediaHandoffs"];
}

export function projectPoints(
  candidates: readonly WorldChangeCandidate[],
  options: ProjectOptions = {},
): WorldChatPoint[] {
  return candidates
    .filter((c) => c.status === "live")
    .map((candidate) => {
      const media = candidate.classification === "media.image-opportunity" ? candidate.draft : null;
      const handoff = options.mediaHandoffs?.[candidate.id];
      const blockedReason = media ? options.mediaBlockedReason?.(candidate) ?? null : null;
      return {
        id: candidate.id,
        kind: candidate.classification === "canon.thread" || candidate.classification === "undecided"
          ? ("question" as const)
          : ("point" as const),
        subject: subjectLabelOf(candidate, options.sheetName).slice(0, 160),
        subjectKind: subjectKindOf(candidate, options.sheetVersion).slice(0, 80),
        text: candidate.title.slice(0, 400),
        settled: wouldCarry(candidate, options),
        revision: candidate.revision,
        ...(candidate.groupId ? { groupId: candidate.groupId } : {}),
        ...(media
          ? {
              media: {
                medium: media.medium,
                purpose: media.purpose,
                brief: media.brief,
                reason: media.reason,
                ...(handoff?.candidateRevision === candidate.revision ? { sessionId: handoff.sessionId } : {}),
                ...(blockedReason ? { blockedReason } : {}),
              },
            }
          : {}),
      };
    });
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

/** The vocabulary {@link refusalLabel} draws on, in this product's words rather than a harness's. */
const REFUSAL_LABELS: Record<string, string> = {
  // The one this exists for. Neither harness grants a shell to any agent, so every one of these
  // is a turn that believed otherwise.
  bash: "run a command on your computer",
  bashoutput: "run a command on your computer",
  killshell: "run a command on your computer",
  powershell: "run a command on your computer",
  shell: "run a command on your computer",
  // Reading and writing are refused on WHERE, not on what: both roles permit the intent, so what
  // was wrong was the place — outside the working directory, or an argument naming a place the
  // gate could not check. Said as place, because that is the part worth telling somebody.
  read: "read a file outside this conversation",
  write: "write a file outside this conversation",
  edit: "change a file outside this conversation",
  glob: "look through files outside this conversation",
  grep: "search files outside this conversation",
  list: "look through files outside this conversation",
  websearch: "search online",
  webfetch: "read a page online",
  task: "hand the work to another agent",
};

/** The resting phrase: something was refused, and naming it would name a tool. */
const REFUSAL_FALLBACK = "use a tool it does not have";

/**
 * What a refused tool was reaching for, in the product's words (SPEC-005 R-10b, R-16).
 *
 * Keyed on the tool rather than on the adapter's summary because a person may not be shown a
 * harness tool name — "refused Bash" is R-16's exact prohibition — and because the summary is
 * operator text. The phrase names the CAPABILITY, which is what the reply may be claiming to have
 * used: someone reading "I ran it, exit 0" needs "Refused: run a command on your computer" under
 * it, not a tool name they have no way to interpret.
 *
 * Suffix-matched and case-folded for the reasons {@link workingLabel} gives at length: MCP tools
 * arrive namespaced, and the same tool is `read` in OpenCode and `Read` in Claude Code.
 */
export function refusalLabel(tool: string): string {
  const key = tool.toLowerCase();
  const direct = REFUSAL_LABELS[key];
  if (direct !== undefined) return direct;
  for (const [name, label] of Object.entries(REFUSAL_LABELS)) {
    if (key.endsWith(`_${name}`)) return label;
  }
  return REFUSAL_FALLBACK;
}

/**
 * The refusals of one turn, worded and deduplicated (#506).
 *
 * Deduplicated on the PHRASE, not the tool: a turn that tried `Bash` five times and `PowerShell`
 * twice was doing one thing, and seven lines saying so would read as seven separate events.
 */
export function wordRefusals(tools: readonly string[]): string[] {
  return [...new Set(tools.map(refusalLabel))];
}

export function projectWorkspace(
  loaded: WorldChatLoaded,
  receiptsByMessage: ReadonlyMap<string, readonly WorldChatCheckReceipt[]>,
  options: ProjectOptions = {},
): WorldChatWorkspace {
  return {
    conversationId: loaded.id,
    status: loaded.status,
    // The mode changes initiative, never acceptance authority (SPEC-023 R-21).
    initiative: loaded.initiative ?? "collaborate",
    messages: loaded.messages.map((m) => ({
      id: m.id,
      turnId: m.turnId,
      role: m.role,
      text: m.text,
      receipts: (receiptsByMessage.get(m.id) ?? []).map(wordReceipt),
      refusals: wordRefusals(loaded.refusals[m.id] ?? []),
      ...(loaded.bibleEdits[m.id] ? { bibleEdit: loaded.bibleEdits[m.id]! } : {}),
      ...(loaded.benchOutcomes[m.id] ? { benchOutcome: loaded.benchOutcomes[m.id]! } : {}),
      ...(loaded.frameRunOutcomes[m.id] ? { frameRunOutcome: loaded.frameRunOutcomes[m.id]! } : {}),
      createdAt: m.createdAt,
    })),
    hasMore: loaded.hasMore,
    seq: loaded.seq,
    points: projectPoints(loaded.candidates, { ...options, mediaHandoffs: loaded.mediaHandoffs }),
    actions: loaded.actions,
    attachments: loaded.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      kind: a.kind,
      readability: a.readability,
      promoted: a.promotedArtifactId !== undefined,
    })),
    // The live signal wins over the fold's reading of the log — see ProjectOptions.liveRun.
    runStatus: options.liveRun === true ? "running" : (loaded.activeRun?.status ?? null),
    runStartedAt: options.liveRun === true ? (loaded.activeRun?.startedAt ?? null) : null,
    // A turn that failed says so, and says it in the words a person can act on. Without this the
    // screen is identical whether the studio answered, failed, or was never asked.
    ...(loaded.lastFailedRun
      ? {
          lastFailure: {
            turnId: loaded.lastFailedRun.turnId,
            status: loaded.lastFailedRun.status,
            ...(loaded.lastFailedRun.safeDetail ? { detail: loaded.lastFailedRun.safeDetail } : {}),
          },
        }
      : {}),
    // Any required observation that could not be made makes the panel say so rather than let a
    // proposition read as checked (§9.4).
    retrievalUnavailable: loaded.candidates.some((c) => c.checks.state === "unavailable"),
  };
}
