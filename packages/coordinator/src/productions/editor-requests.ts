import {
  EDITOR_REQUEST_BOUNDS,
  editorRequestStaleness,
  previewEditorRequest,
  seedSpinePictureTimeline,
  seedFirstPictureTimeline,
  sourceLengthFramesFor,
  spineTimelineFingerprint,
  storyTimelineFingerprint,
  ulid,
  type EditorRequest,
  type EditorRequestFile,
  type ModelEditorRequest,
  type ProductionBundle,
  type ProductionTimeline,
  type WorldChatContext,
} from "@arke-studio/contracts";
import { applyTimelineCommand, refuseUnrenderablePlacements, TimelineCommandRefused } from "./timeline.js";
import { applyTakeAcceptance } from "../takes/review.js";
import type { WorldStore } from "../world/store.js";
import { EditorRequestFileInvalid, readRequestFile, requestFileInput } from "./editor-request-file.js";

/**
 * Arke's editor requests on disk (SPEC-039 §1.7, §2.2; issue 684).
 *
 * The coordinator owns both ends of the boundary. Staging validates the model's commands against
 * the base they name before a record exists, so a request that could never land is refused back
 * to the model as a corrective problem rather than shown to a person. Deciding is the only path
 * that moves a record's status: Accept lands every command through the same write as a person's
 * own batch, in the same commit as the status change, and Reject touches nothing but the record.
 */

export class EditorRequestRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "EditorRequestRefused";
  }
}

async function readRequests(store: WorldStore, productionId: string): Promise<{ raw: string | null; file: EditorRequestFile }> {
  try {
    return await readRequestFile(store, productionId);
  } catch (error) {
    if (error instanceof EditorRequestFileInvalid) throw new EditorRequestRefused(error.reason);
    throw error;
  }
}

/**
 * The file keeps a bounded audit, but a pending request is not audit — it is waiting for a
 * decision, and dropping it off the front would take that decision away (round five). The oldest
 * decided records go first; when every record is still pending, staging refuses instead.
 */
export function retainEditorRequests(requests: readonly EditorRequest[]): EditorRequest[] {
  const kept = [...requests];
  while (kept.length > EDITOR_REQUEST_BOUNDS.kept) {
    const index = kept.findIndex((request) => request.status !== "pending");
    if (index === -1) {
      throw new EditorRequestRefused(`${kept.length - 1} requests are waiting for a decision; accept or reject some before asking for more`);
    }
    kept.splice(index, 1);
  }
  return kept;
}

/** The production a thread is about (R-26), or null for a thread that is not about one. */
export function productionOfContext(context: WorldChatContext | undefined): string | null {
  if (context === undefined) return null;
  return context.kind === "production" || context.kind === "episode" || context.kind === "scene" ? context.productionId : null;
}

/** The fingerprint a first assembly is fenced by right now, or null when none can be derived. */
export function currentSourceFingerprint(store: WorldStore, production: ProductionBundle): string | null {
  const spine = production.spine;
  if (spine === null) return storyTimelineFingerprint(production);
  const measured = store.getBundle().artifacts.find((artifact) => artifact.id === spine.trackArtifactId)?.mediaInfo?.durationSec ?? null;
  return measured === null ? null : spineTimelineFingerprint(production, spine, measured);
}

/**
 * The base a request is prepared against: the saved record, or the first assembly the first
 * command would materialise (SPEC-037 R-13). The song clock has no derivable first assembly
 * for a request — it is opened by the person's own choice — so an unopened spine refuses.
 */
function requestBase(
  store: WorldStore,
  production: ProductionBundle,
): { timeline: ProductionTimeline; baseRevision: number | null; sourceFingerprint: string } {
  const state = production.timeline;
  if (state?.status === "invalid") throw new EditorRequestRefused("the timeline is invalid and cannot take a request");
  if (state?.status === "ready") {
    const fingerprint = currentSourceFingerprint(store, production) ?? storyTimelineFingerprint(production);
    return { timeline: state.timeline, baseRevision: state.timeline.revision, sourceFingerprint: fingerprint };
  }
  const spine = production.spine;
  if (spine !== null) {
    const measured = store.getBundle().artifacts.find((artifact) => artifact.id === spine.trackArtifactId)?.mediaInfo?.durationSec ?? null;
    if (measured === null) throw new EditorRequestRefused("this production is cut to a song; open it on the timeline before requesting edits");
    return {
      timeline: seedSpinePictureTimeline(production, spine, measured),
      baseRevision: null,
      sourceFingerprint: spineTimelineFingerprint(production, spine, measured),
    };
  }
  return { timeline: seedFirstPictureTimeline(production), baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production) };
}

/**
 * Stage this turn's requests as pending records (R-27..R-29), or throw with the reason.
 *
 * Every command is applied to the base in memory first; one that cannot apply refuses the whole
 * turn, which is the corrective problem the model answers. Server-side, and only for the
 * production the thread is about: a request for any other production is refused however the
 * model came by its id.
 */
export async function stageEditorRequests(
  store: WorldStore,
  input: {
    conversationId: EditorRequest["conversationId"];
    entryContext: WorldChatContext | undefined;
    requests: readonly ModelEditorRequest[];
    now: string;
    /** Validate every request against the base and write nothing (round eight). */
    dryRun?: boolean;
  },
): Promise<EditorRequest[]> {
  const productionId = productionOfContext(input.entryContext);
  if (productionId === null) throw new EditorRequestRefused("editor requests need a production, episode or scene thread");
  if (input.requests.length === 0) return [];
  return store.gateOp(async () => {
    const dryRun = input.dryRun === true;
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
    if (!production) throw new EditorRequestRefused(`production ${productionId} is not in this world`);
    const base = requestBase(store, production);
    const artifacts = store.getBundle().artifacts;
    const { raw, file } = await readRequests(store, productionId);
    const staged: EditorRequest[] = [];
    const added: EditorRequest[] = [];
    for (const request of input.requests) {
      const cannot = (reason: string): never => {
        throw new EditorRequestRefused(`"${request.summary.slice(0, 80)}" cannot apply: ${reason}`);
      };
      // A take switch is not a clip command; the preview counts it. It is run through the same
      // acceptance rules Accept will apply, so a switch to a take that does not exist or does
      // not cover the shot is refused now rather than staged as a card that can never land —
      // and the takes it lands are the ones the trims below are judged against (round seven).
      let selections = production.selections;
      for (const command of request.commands) {
        if (command.kind !== "switch-take") continue;
        try {
          selections = applyTakeAcceptance(production, artifacts, selections, {
            takeId: command.takeId,
            shotId: command.shotId,
            by: "user",
            at: input.now,
          }).selections;
        } catch (error) {
          cannot(error instanceof Error ? error.message : String(error));
        }
      }
      const bounded: ProductionBundle = { ...production, selections };
      try {
        refuseUnrenderablePlacements(request.commands, base.timeline, bounded, artifacts);
      } catch (error) {
        cannot(error instanceof TimelineCommandRefused ? error.reason : error instanceof Error ? error.message : String(error));
      }
      const preview = previewEditorRequest(base.timeline, request.commands, { sourceLength: sourceLengthFramesFor(bounded, artifacts) });
      if (!preview.ok) cannot(preview.reason);
      /*
       * The same request twice is one record. A turn's corrective retry runs this again with
       * whatever the model repeats, and a model that ignores "do not repeat a pending request"
       * would otherwise stack identical cards; the person decides each request once.
       */
      const same = [...file.requests, ...added].find(
        (candidate) =>
          candidate.status === "pending" &&
          candidate.conversationId === input.conversationId &&
          candidate.summary === request.summary &&
          JSON.stringify(candidate.commands) === JSON.stringify(request.commands),
      );
      if (same !== undefined) {
        staged.push(same);
        continue;
      }
      const record: EditorRequest = {
        id: `req_${ulid()}`,
        productionId,
        conversationId: input.conversationId,
        baseRevision: base.baseRevision,
        sourceFingerprint: base.sourceFingerprint,
        commands: [...request.commands],
        summary: request.summary,
        createdAt: input.now,
        status: "pending",
      };
      staged.push(record);
      added.push(record);
    }
    if (added.length === 0 || dryRun) return dryRun ? [] : staged;
    const next: EditorRequestFile = {
      schemaVersion: 1,
      requests: retainEditorRequests([...file.requests, ...added]),
    };
    await store.commitUnserialised({
      kind: "editor-request",
      source: "stage",
      files: [requestFileInput(productionId, raw, next)],
    });
    return staged;
  });
}

async function writeStatus(
  store: WorldStore,
  productionId: string,
  requestId: string,
  change: (request: EditorRequest) => EditorRequest,
): Promise<EditorRequest> {
  return store.gateOp(async () => {
    const { raw, file } = await readRequests(store, productionId);
    const current = file.requests.find((candidate) => candidate.id === requestId);
    if (current === undefined) throw new EditorRequestRefused(`request ${requestId} is not on this production`);
    const updated = change(current);
    await store.commitUnserialised({
      kind: "editor-request",
      source: updated.status,
      files: [requestFileInput(productionId, raw, { ...file, requests: file.requests.map((candidate) => (candidate.id === requestId ? updated : candidate)) })],
    });
    return updated;
  });
}

/**
 * Accept or reject one request (R-29..R-32).
 *
 * Reject marks the record and nothing else. Accept lands the commands through the ordinary
 * timeline write — one revision, one Undo entry carrying the request id — with the status change
 * in the same commit, so a crash cannot leave an accepted record over an unchanged timeline or
 * the reverse. A base that moved refuses as stale and marks the record so; nothing is rebased.
 */
export async function decideEditorRequest(
  store: WorldStore,
  input: { productionId: string; requestId: string; decision: "accept" | "reject"; now: string },
): Promise<EditorRequest> {
  const { productionId, requestId, now } = input;
  if (input.decision === "reject") {
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
    if (!production) throw new EditorRequestRefused(`production ${productionId} is not in this world`);
    return writeStatus(store, productionId, requestId, (request) => {
      if (request.status !== "pending") throw new EditorRequestRefused(`request ${requestId} is already ${request.status}`);
      // A request the base has moved under is dismissed as stale, not rejected: the audit says
      // what happened to it, and the person's Reject is how a card nobody can accept goes (R-32).
      const stale = editorRequestStaleness(request, production.timeline, currentSourceFingerprint(store, production));
      return stale === null ? { ...request, status: "rejected", decidedAt: now } : { ...request, status: "stale", decidedAt: now, reason: stale };
    });
  }

  const { raw, file } = await readRequests(store, productionId);
  const request = file.requests.find((candidate) => candidate.id === requestId);
  if (request === undefined) throw new EditorRequestRefused(`request ${requestId} is not on this production`);
  if (request.status !== "pending") throw new EditorRequestRefused(`request ${requestId} is already ${request.status}`);
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
  if (!production) throw new EditorRequestRefused(`production ${productionId} is not in this world`);

  const stale = editorRequestStaleness(request, production.timeline, currentSourceFingerprint(store, production));
  // Two Accepts can race past the status check above; the second must not mark the first's
  // landed request stale. The mark is written under the gate and only onto a record that is
  // still pending (round nine).
  const markStale = (reason: string) =>
    writeStatus(store, productionId, requestId, (current) => {
      if (current.status !== "pending") throw new EditorRequestRefused(`request ${requestId} is already ${current.status}`);
      return { ...current, status: "stale", decidedAt: now, reason: reason.slice(0, 300) };
    });
  if (stale !== null) {
    await markStale(stale);
    throw new EditorRequestRefused(`the request is stale: ${stale}; ask Arke for a new one against the current timeline`);
  }

  const resultRevision = (production.timeline?.status === "ready" ? production.timeline.timeline.revision : 0) + 1;
  const accepted: EditorRequest = { ...request, status: "accepted", decidedAt: now, resultRevision };
  const attach = requestFileInput(productionId, raw, {
    ...file,
    requests: file.requests.map((candidate) => (candidate.id === requestId ? accepted : candidate)),
  });
  try {
    await applyTimelineCommand(store, productionId, {
      kind: "commands",
      commands: request.commands,
      baseRevision: request.baseRevision,
      sourceFingerprint: request.sourceFingerprint,
      label: request.summary.slice(0, 160),
      requestId: request.id,
      attach: [attach],
    });
  } catch (error) {
    if (error instanceof TimelineCommandRefused && /moved from revision|changed while/.test(error.reason)) {
      await markStale(error.reason);
      throw new EditorRequestRefused(`the request is stale: ${error.reason}; ask Arke for a new one against the current timeline`);
    }
    throw error;
  }
  return accepted;
}
