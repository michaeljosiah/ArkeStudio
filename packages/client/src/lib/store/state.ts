import type {
  PromptReview, PromptSourceSnapshot, WorldOpenPhase, AskCandidate, AskResult, ModelChoices,
  ChangeRecord, ClientState, DomainEvent, ProviderCallRecord, RankedVoice, RippleItem,
  ReconcileAction,
} from "@arke-studio/contracts";
import type { FrameRunStartResultEvent } from "./events.js";
import type { SheetRefsState } from "./canon.js";
import type { ReadingVoice, StagedClip } from "./voice.js";
import type { ExportState } from "./takes.js";
import type { ImportReportState } from "./manuscript.js";

/** A conversation nobody has said anything in yet. */
export const discardedGenesis = new Set<string>();

export function emptyGenesis(): StoreState["genesis"][string] {
  return {
    turns: [],
    blueprint: null,
    status: null,
    working: null,
    runStartedAt: null,
    attachments: [],
    refusals: [],
  };
}

/**
 * The client store: one external store holding connection status and the coordinator's
 * ClientState. Frames are schema-validated at the boundary; events fold with the same rules
 * as the coordinator's read model. View state (tabs, panels) stays in components.
 */

export type ConnectionStatus = "connecting" | "open" | "closed" | "auth-refused";

/** The last blocked-accept notice per proposal (SPEC-004): why it did not land, and what to offer. */
export interface GateNotice {
  reason:
    | "stale"
    | "needs-reconfirm"
    | "no-op"
    | "pending-review"
    | "unresolved-conflicts"
    | "open-choices"
    | "target-retired"
    | "invalid"
    /** #70 SS11.4.1: an in-place edit whose outcome is unknown, so accepting is not offered. */
    | "draft-unresolved"
    /** Issue 239: a turn is writing into the proposal, so it is not settled enough to act on. */
    | "drafting"
    /** PR 1232: the draft moved on since the press; the newer one is to be read, not rebased. */
    | "draft-changed";
  detail?: string;
  authoritativeSignature?: string;
  /** The request refused, when it carried one: only a screen's own answers it (PR 1232). */
  requestId?: string;
}

/** Live authoring activity per proposal (SPEC-005 R-13, R-15). */
export interface AuthoringActivity {
  status: "running" | "completed" | "cancelled" | "timeout" | "budget-exceeded" | "failed";
  detail?: string;
  lines: string[];
}

/** A harness backstop prompt awaiting the user (SPEC-005 R-16). */
export interface PendingPermission {
  description: string;
  actionClass: string;
  rememberable: boolean;
}

export interface CanonSearchState {
  searched: number;
  floorCleared: boolean;
  candidates: AskCandidate[];
}

export interface CanonRefsState {
  citedBy: {
    sheets: Array<{ id: string; atVersion: number | null }>;
    entries: string[];
    productions: string[];
  };
  /**
   * The entry's own change lines, oldest first (issue 289). Read per entity by the coordinator
   * rather than filtered out of `world.changes`, which is a tail of the whole log and so goes
   * empty for an entry the moment a bulk write fills the window.
   */
  history: ChangeRecord[];
  /** Whether older records exist beyond the ones held here, so the panel can say so. */
  historyTruncated: boolean;
  /** The canon revision this answer describes — how a late one is told from a current one. */
  canonRevision: number;
  ripples: Array<{ kind: string; summary: string; targets: string[] }>;
}

export type NarratorQuote =
  | { state: "working" }
  | { state: "refused"; refused: string }
  | { state: "done"; stale: number; held: number; directed: number; estimatedMicroUsd: number; kept: number };

/** What `Direct this chapter` would read, or how many speaker notes were drafted (design turn 184, SPEC-047 R-51, R-54), by request id. */
export type AudiobookAsk =
  | { state: "working" }
  | { state: "reads"; reads: import("@arke-studio/contracts").DirectionReads }
  | { state: "drafted"; drafted: number }
  | { state: "refused"; refused: string }
  /** A picture suggested for a block (design turn 191a, R-99): the prompt, who is in it and the price — nothing made. */
  | { state: "suggested"; suggestion: import("@arke-studio/contracts").PictureSuggestion }
  /** A suggested picture on its block (R-99), or held with the reason it was not made. */
  | { state: "made"; sessionId?: string }
  | { state: "failed"; reason: string; sessionId?: string }
  /** Which chapters (by number) of the book chose each kit look (design turn 193, R-114). */
  | { state: "looks"; usage: Record<string, number[]>; coverage?: import("@arke-studio/contracts").ChapterReferenceCoverage[] }
  /** Update prompt answered (design turn 193d, R-146): the prompt with the changed people's clothing words rewritten. */
  | { state: "prompt"; prompt: string };

/**
 * `Illustrate this chapter` (design turn 191b, 191d, SPEC-047 R-101, R-102), keyed like a run: the proposal the
 * window holds until it is accepted or discarded, the rows the author skipped or sent without a missing
 * reference, and — once accepted — where the pictures stand as they are made, one at a time.
 */
export interface IllustrationRun {
  state: "reading" | "proposed" | "making" | "done" | "failed" | "unavailable" | "stopped";
  proposal?: import("@arke-studio/contracts").IllustrationProposal;
  refreshing?: boolean;
  /** Rows the author took out, and held rows they said to make without a reference. */
  skipped: string[];
  without: string[];
  /** While it is made, where it stands; once it has ended, how it ended (what was held, and why). */
  progress?: import("@arke-studio/contracts").IllustrationProgress;
  reason?: string;
}

export type HeardLine = { state: "working" } | { state: "done"; file: string } | { state: "priced"; token: string; estimatedMicroUsd: number; parts: number } | { state: "refused"; refused: string };

/** A script out, or returned files matched and checked, for a recorded speaker (design turn 155d, SPEC-047 R-39). */
export interface SpeakerLinesState {
  kind: "script" | "files" | "summary";
  state: "working" | "done" | "keeping" | "refused";
  output?: string;
  lines?: number;
  chapters?: number;
  recorded?: number;
  awaiting?: number;
  notCast?: number;
  rows?: Extract<import("@arke-studio/contracts").DomainEvent, { type: "audiobook.lines-staged" }>["rows"];
  kept?: number;
  refused?: string;
}

/** A recording on its way to being a block's take (design turn 155c): what the checks said, and where it stands. */
export interface StagedTake {
  worldId: string;
  productionId: string;
  block: string;
  state: "choosing" | "staged" | "keeping" | "refused";
  file?: string;
  /** What the checks said, as the dialog shows them (SPEC-047 R-35). */
  checks?: {
    durationSec: number | null;
    sampleRateHz: number | null;
    channels: number | null;
    rmsDbfs: number | null;
    samplePeakDbfs: number | null;
    noiseFloor: string;
    words: "match" | "differ" | "unchecked";
    differences: number;
  };
  refused?: string;
}

/** Which part of a world's open is under way, with how many files it has read (issue 1844). */
export interface WorldOpenProgress {
  worldId: string;
  phase: WorldOpenPhase;
  done?: number;
  total?: number;
}

export interface StoreState {
  connection: ConnectionStatus;
  state: ClientState | null;
  gateNotices: Record<string, GateNotice>;
  authoring: Record<string, AuthoringActivity>;
  /** Conversation over a proposal (SPEC-005): user instructions and gate replies, in order. */
  transcripts: Record<string, Array<{ role: "user" | "gate"; text: string; at: string }>>;
  /** Local-runtime setup progress — the whole picture, newest wins. */
  setupStatus: import("@arke-studio/contracts").SetupStatus | null;
  /**
   * The derived findings snapshot (SPEC-032 R-33): pushed when it changes, replayed on connect
   * beside held permissions. Held outside ClientState because it is a projection OF that state,
   * not a part of it — folding it in would make the read model carry its own derivative.
   */
  diagnostics: import("@arke-studio/contracts").DiagnosticsSnapshot | null;
  recoveryCommandResults: Record<string, import("@arke-studio/contracts").RecoveryCommandResult>;
  recoveryActionResults: Record<string, import("@arke-studio/contracts").RecoveryActionResult>;
  recoveryHistoryPages: Record<string, import("@arke-studio/contracts").RecoveryHistoryPage>;
  /** Build reviews by conversation and request, so a late response cannot erase a newer answer. */
  buildPlans: Record<
    string,
    Record<string, { requestId: string; plan: import("@arke-studio/contracts").BuildReview | null; reason?: string }>
  >;
  /** What key art would carry and drop, per world — the dialog's honest opening (SPEC-010 R-15). */
  keyArtPlans: Record<
    string,
    {
      requestId: string;
      prompt: string;
      promptReviewId?:string; modelId?:string; fixedConstraints?:string; candidate?:string; review?:PromptReview; reason?:string; sources?:PromptSourceSnapshot[];
      carried: Array<{ name: string; role: string }>;
      dropped: Array<{ name: string; reason: string }>;
    }
  >;
  /** Genesis conversations: sandboxed world-shaping before any world exists. */
  genesis: Record<
    string,
    {
      turns: Array<{ id?: string; role: "user" | "gate"; text: string; at: string }>;
      conversationId?: string;
      revision?: number;
      worldId?: string;
      review?: import("@arke-studio/contracts").GenesisContentReview;
      reviewRequestId?: string;
      images?: import("@arke-studio/contracts").GenesisImages;
      voices?: import("@arke-studio/contracts").GenesisVoices;
      readiness?: import("@arke-studio/contracts").GenesisReadiness;
      readinessPending?: boolean;
      imports?: import("@arke-studio/contracts").GenesisImports;
      imageError?: string;
      importError?: string;
      reviewPending?: boolean;
      chatPending?: boolean;
      chatSubmission?: { requestId: string; text: string };
      rejectedChat?: string;
      chatError?: string;
      writingModel?: string;
      reviewError?: string;
      readinessError?: string;
      voiceError?: string;
      decisionPending?: "image" | "voice" | "import";
      founding?: boolean;
      frozenModels?: ModelChoices;
      frozenGenerateImages?: boolean;
      formHandoff?: "pending" | "completed";
      /** The plan so far, folded from the sandbox directory (SPEC-031 R-2). */
      blueprint: import("@arke-studio/contracts").GenesisBlueprint | null;
      status: "running" | "completed" | "cancelled" | "timeout" | "budget-exceeded" | "failed" | null;
      detail?: string;
      /** The turn in flight, one verb at a time — cleared when the turn settles. */
      working: string | null;
      /** When the running turn began, for the working line's elapsed clock. */
      runStartedAt: string | null;
      /** Waiting in the sandbox: filed into the world the moment it exists. */
      attachments: Array<{ name: string; kind: import("@arke-studio/contracts").ArtifactKind }>;
      /** What would not go in, and why — said on a chip rather than swallowed. */
      refusals: Array<{ name: string; reason: string }>;
    }
  >;
  /**
   * Reading a document for facts, keyed by artifact. What the offer under the composer shows —
   * and the reason it can say "nothing in it" rather than going quiet and looking broken.
   */
  reading: Record<
    string,
    {
      file: string;
      state: "reading" | "found" | "nothing" | "no-text" | "stopped" | "unavailable" | "failed";
      found: number;
      dropped: number;
      reason?: string;
    }
  >;
  /**
   * Deriving continuity for a chapter (turn 129), keyed by `worldId/productionId/chapterId` —
   * the world too, because two worlds can share a production and a chapter slug and a record
   * finished in one must never be shown in the other (codex on PR 907). What the panel shows
   * while one runs and how it ended; the record a run finished with rides here as well.
   */
  deriving: Record<
    string,
    {
      state: "deriving" | "derived" | "stopped" | "unavailable" | "failed";
      placed: number;
      dropped: number;
      omitted: number;
      cut: number;
      /** The record a derivation finished with, so the open panel has the lines without a second read. */
      record?: import("@arke-studio/contracts").ChapterContinuity;
      reason?: string;
    }
  >;
  /**
   * Casting a chapter's lines (turn 130), keyed by `worldId/productionId/chapterId` as deriving
   * is: what the Voices panel shows while one runs and how it ended, with the record a run
   * finished with.
   */
  /**
   * A manuscript read for import (turn 131), by request: what the file holds before anything
   * is written, then what the import made of it. The import sheet reads this.
   */
  manuscripts: Record<
    string,
    {
      state: "reading" | "read" | "refused" | "importing" | "imported" | "failed" | "cancelled";
      fileName?: string;
      words?: number;
      chapters?: Array<{ title: string; words: number }>;
      headingLevel?: string;
      leftOut?: number;
      levels?: Array<{ level: "title" | "subtitle" | "heading1" | "heading2" | "document"; label: string; count: number; chosen: boolean }>;
      notes?: number;
      links?: number;
      after?: number;
      created?: number;
      reason?: string;
    }
  >;
  casting: Record<
    string,
    {
      state: "casting" | "cast" | "stopped" | "unavailable" | "failed";
      lines: number;
      dropped: number;
      omitted: number;
      record?: import("@arke-studio/contracts").ChapterVoices;
      reason?: string;
      /** A pin refused (SPEC-012 R-62), in its one clause; cleared by the next record. */
      pinRefused?: string;
    }
  >;
  /**
   * A chapter being read into kept takes (turn 146, SPEC-047), keyed by
   * `worldId/productionId/chapterId`: the run's progress while it goes, its price while that
   * is on the table, and how it ended. The record itself lands on the chapter's open result and
   * on the finished event; this is only what the Audiobook view says about the run.
   */
  audiobook: Record<
    string,
    {
      state: "reading" | "priced" | "read" | "stopped" | "unavailable" | "failed" | "refused";
      requestId?: string;
      toMake: number;
      blocks: number;
      made: number;
      flagged: number;
      /** The last block that landed or was flagged, and why, for the foot. */
      last?: { block: string; outcome: "made" | "adopted" | "flagged"; reason?: string };
      price?: { previews?: Extract<DomainEvent, { type: "audiobook.priced" }>["previews"]; characters: number; estimatedMicroUsd: number; confirmationToken: string; voices: { label: string; provider: string; characters: number; estimatedMicroUsd: number }[]; notices: string[]; freePlan?: import("@arke-studio/contracts").FreePlanShort; requests?: number; perParagraph?: number; groupingUnavailable?: true; toCast?: number };
      /** A grouped run (design turn 185b): its requests, each grouped request's blocks, and the one being read. */
      requests?: number;
      groups?: string[][];
      request?: number;
      requestKeys?: string[];
      record?: import("@arke-studio/contracts").ChapterAudiobook;
      reason?: string;
    }
  >;
  /**
   * `Direct this chapter` (turn 146, SPEC-047 R-10), keyed like a run: the card the window
   * holds until it is accepted whole or discarded, then the acceptance's word. The record a
   * write outside a run answers with — a block's direction set, a card accepted — lands here
   * too, so the workspace takes the newest record whoever wrote it.
   */
  illustration: Record<string, IllustrationRun>;
  direction: Record<
    string,
    {
      state: "directing" | "directed" | "accepting" | "accepted" | "stopped" | "unavailable" | "failed";
      /** The acceptance's own name while it is on its way, so only its answer moves the card. */
      requestId?: string;
      directed: number;
      dropped: number;
      summary?: string;
      proposed?: Record<string, import("@arke-studio/contracts").AudiobookDirectionInput>;
      hash?: string;
      chapterVersion?: number;
      /** What the proposal carries besides its directions (design turn 184): the lines it casts, the notes it drafted. */
      cast?: { lines: number; speakers: number };
      /** The cast the proposal was directed against, while it is held (codex on PR 1479). */
      castRecord?: import("@arke-studio/contracts").ChapterVoices;
      /** Of the blocks addressed, those moved off the ordinary reading — kept past acceptance for the tally. */
      moved?: number;
      /** The card's own name, echoed on acceptance (codex on PR 1476). */
      proposalId?: string;
      speakerNotes?: Record<string, string>;
      reason?: string;
    }
  >;
  audiobookRecords: Record<string, { record?: import("@arke-studio/contracts").ChapterAudiobook; refused?: string; seq: number; requestId?: string }>;
  /**
   * Group by beats (design turn 201), by `world/production/chapter`: grouping while the director
   * reads, then what came of it — the blocks before and after, or why nothing was grouped.
   */
  beats: Record<string, { state: "grouping" | "grouped" | "refused" | "failed" | "unavailable"; reason?: string; before?: number; after?: number }>;
  /**
   * Recordings on their way to being a block's take (design turn 155c), by the window's request
   * id: the host's picker open, the checks back, the keep on its way, or refused in one clause.
   */
  stagedTakes: Record<string, StagedTake>;
  /** A recorded speaker's script out and files back (turn 155d), by the window's request id. */
  speakerLines: Record<string, SpeakerLinesState>;
  /** What a narrator switch would do (design turn 155h, SPEC-047 R-46), by the dialog's request id. */
  narratorQuotes: Record<string, NarratorQuote>;
  /** A line heard as it would be read (R-45, R-46), by request id: waiting, the file to play, or why not. */
  heardLines: Record<string, HeardLine>;
  /** What the director would read and speaker notes drafted (design turn 184), by request id. */
  audiobookAsks: Record<string, AudiobookAsk>;
  /**
   * The door (turn 146, SPEC-047 R-29), by production: what every chapter stands at, who
   * reads, and the price of a press, as the coordinator last answered; and `Read the book`,
   * the chapter's run over the whole book, keyed by production like the chapters' by chapter.
   */
  audiobookDoor: Record<string, { door: import("@arke-studio/contracts").AudiobookDoor | null; requestId: string; refused?: string }>;
  /** The audiobook's credits (design turn 252), by production, as the coordinator last answered. */
  audiobookCredits: Record<string, { credits: import("@arke-studio/contracts").AudiobookCreditsView | null; refused?: string }>;
  audiobookBook: Record<
    string,
    {
      state: "reading" | "priced" | "read" | "stopped" | "unavailable" | "failed";
      requestId?: string;
      chapters: number;
      blocks: number;
      done: number;
      chaptersRead: number;
      chaptersRefused: number;
      made: number;
      flagged: number;
      price?: Extract<import("@arke-studio/contracts").DomainEvent, { type: "audiobook.book-priced" }>;
      reason?: string;
    }
  >;
  /** Directions re-checked against changed readers (R-13): how many controls went, said once on the door. */
  audiobookNotes: Record<string, { dropped: number; held: number; chapters: number; seq: number }>;
  /** The last word on archiving a world — said once, then dismissed. */
  archiveNote: { worldId: string; text: string; refused: boolean } | null;
  permissions: Record<string, PendingPermission>;
  askResults: Record<string, AskResult>;
  canonSearches: Record<string, CanonSearchState>;
  canonRefs: Record<string, CanonRefsState>;
  sheetRefs: Record<string, SheetRefsState>;
  /** The last start-up reconciliation report (SPEC-009 R-18) — transient, newest wins. */
  reconcileReport: ReconcileAction[] | null;
  /** SPEC-011: ranked voice candidates per sheet, with the honest overlap framing. */
  voiceCandidates: Record<string, VoiceCandidatesState>;
  /** Every voice the world can read with (design 70) — unranked, and not per sheet. */
  voiceCatalogue: ReadingVoice[] | null;
  /**
   * The last catalogue answered, kept through a re-ask: `voiceCatalogue` goes null while one is
   * asked for, and a reader of availability alone — the Audiobook door's stamp — would read
   * every refresh as a change and ask its question again.
   */
  voiceCatalogueHeld: ReadingVoice[] | null;
  voiceCatalogueErrors: string[];
  cataloguePreview: Extract<DomainEvent, { type: "voice.catalogue-preview" }> | null;
  /** SPEC-011: audition results keyed provider/model/voiceId — cached files replay free. */
  voicePreviews: Record<string, { file: string | null; error: string | null }>;
  voiceAudio: Record<string, Extract<DomainEvent, { type: "voice.audio" }>>;
  /** The pieces of a long read, in order, per request — see the voice.audio branch below. */
  voiceParts: Record<string, string[]>;
  /** SPEC-011: dictation results by requestId — inserted as editable text, never submitted. */
  dictation: Record<string, { text: string | null; error: string | null }>;
  /**
   * SPEC-022 T-10: clips staged for a clone, by requestId. A name and a length, never a path —
   * the coordinator holds where it went, and hands back only what 74c draws.
   */
  voiceClips: Record<string, StagedClip>;
  /** SPEC-022 T-10: the outcome of the last clone — the voice it made, or why it made none. */
  voiceCloned: { voiceId: string | null; label: string | null; reason: string | null } | null;
  /**
   * Files World Chat would not take, by conversation (#70 §13.2).
   *
   * Kept here rather than in the workspace because nothing was written: a refused file has no
   * durable home, so if this does not hold it the reason is lost the moment it arrives.
   */
  worldChatRefusals: Record<string, Array<{ name: string; reason: string }>>;
  /**
   * A wrap-up that was refused, by conversation (#70 §11.3).
   *
   * Here for the same reason as a refused file: a refused wrap-up writes nothing, so the workspace
   * that arrives afterwards is identical to the one before and cannot carry the reason. One at a
   * time, not a list — the next attempt replaces it, and there is only ever one button to answer.
   *
   * It carries the id of the attempt it answers. The reason is worth showing whoever is looking,
   * but only the window that made that attempt may act on it: these events reach every client,
   * and a second window's refusal must not end the first window's wait.
   */
  worldChatWrapUpRefusals: Record<string, { requestId: string; detail: string }>;
  /** Last no-preview accept consequence per conversation; transient and dismissible. */
  worldChatRipples: Record<string, { requestId: string; items: RippleItem[] }>;
  /**
   * What the studio is doing right now, by conversation (#70 §15.3).
   *
   * Transient: it is cleared when the turn ends, and nothing is lost if it never arrives — the
   * spinner falls back to its resting word. Kept out of the workspace because the workspace is a
   * projection of the durable log, and this is deliberately not durable.
   */
  worldChatProgress: Record<string, { label: string; at: string }>;
  /**
   * How far the world being opened has got (issue 1844).
   *
   * Transient like the progress above: the open's own `world.opened` or `world.open-failed` ends
   * it, as does a snapshot that carries the world, and a loader with nothing here says the plain
   * "opening the world" it always did.
   */
  worldOpenProgress: WorldOpenProgress | null;
  voiceSidecar: { state: "not-started" | "downloading" | "unavailable" | "ready"; detail: string } | null;
  voiceRuntimeTest: {
    requestId: string;
    status: "testing" | "ready" | "failed";
    detail: string;
    audioBase64: string | null;
  } | null;
  /** Last main-photo accept result by sheet; null status means the command is in flight. */
  mainPhotoAcceptance: Record<
    string,
    { status: "accepted" | "failed" | null; reason?: string; candidateRetained: boolean }
  >;
  /** Last hand-carried character sheet result by sheet; null status means the picker is open. */
  characterSheetAcceptance: Record<string, { status: "accepted" | "failed" | null; reason?: string }>;
  /**
   * Last hand-carried location view result by sheet; null status means the picker is open (issue 243).
   * "landed" and not "accepted": the upload leaves an unreviewed candidate, and naming it is a
   * separate press.
   */
  locationViewUpload: Record<string, { status: "landed" | "failed" | null; reason?: string }>;
  /** SPEC-013: export lifecycle by exportId. */
  exportsState: Record<string, ExportState>;
  /** SPEC-015: the last import report and filing notices — transient. */
  importReport: ImportReportState | null;
  /* `production` is the scope the refused filing was attempted at, so a surface can tell its
     own refusals from another's: `null` is the world, absent is a filing that stated no opinion. */
  artifactNotices: Array<{ sourcePath: string; outcome: string; reason: string; sizeBytes: number | null; production?: string | null }>;
  /** Filed by attaching to a chat, newest last — what the composer shows as chips. */
  attached: Array<{
    worldId: string;
    artifactId: string;
    file: string;
    kind: import("@arke-studio/contracts").ArtifactKind;
  }>;
  /** SPEC-016: first-run environment verification and diagnostics. */
  envCheck: {
    pathBudgetOk: boolean;
    pathBudgetDetail: string | null;
    diskFreeMb: number | null;
    nativeIndexOk: boolean;
    nativeIndexDetail: string | null;
  } | null;
  diagnosticsBundle: string | null;
  providerCallsByJob: Record<string, ProviderCallRecord[]>;
  /** Ephemeral frame-run quotes by request id; option cleanup removes stale authorization. */
  frameRunQuotes: Record<string, import("@arke-studio/contracts").FrameRunQuote>;
  /** Correlated frame-run authorization outcomes; retained only while their dialog listens. */
  frameRunStartResults: Record<string, FrameRunStartResultEvent>;
  /** Bumped on snapshots so open quote dialogs abandon pre-refresh authorization. */
  frameRunRequestEpoch: number;
  /**
   * Snapshots that answered a hello: each is a connection made again, and anything this window
   * was waiting to hear over the one before may have been lost with it. A screen records the
   * count when it starts waiting, and a larger one means the answer will not come.
   */
  rejoins: number;
  /**
   * A line just sent into a conversation the screen has not yet seen become a turn, by
   * conversation (codex on PR 1232). Kept here rather than by whichever dock sent it, so a dock
   * put away and brought back in the gap still holds: a line said into it would be refused by the
   * runner as already working. Ended by the coordinator's answer for that request — refused, or
   * taken and then shown running or moved on. A rejoin may have lost that answer, and its
   * snapshot can be taken while the line is still being admitted (codex on PR 1232), so the
   * rejoin does not end it: the coordinator is asked where the line stands, and answers.
   */
  worldChatHolds: Record<string, WorldChatHold>;
}

export type WorldChatHold = {
  requestId: string;
  worldId: string;
  seq: number | null;
  rejoins: number;
  takenAt?: number | null;
  /** Asked where it stands after a rejoin. */
  asked?: boolean;
};

export interface VoiceCandidatesState {
  extracted: string[];
  ranked: RankedVoice[];
  previewLine: { text: string; source: "own-line" | "drafted" | "stock" };
  cloudPreviewMicroUsd: number | null;
  previewMicroUsdByVoice: Record<string, number>;
  previewQuoteByVoice?: Record<string, string>;
  /** What a first read through a reader adds, by target key (SPEC-046 R-14): said on the row before the preview. */
  notices: Record<string, string>;
}
