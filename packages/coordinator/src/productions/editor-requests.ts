import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EDITOR_REQUEST_BOUNDS,
  EditorRequestFileSchema,
  editorRequestStaleness,
  previewEditorRequest,
  seedSpinePictureTimeline,
  seedStoryPictureTimeline,
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
import { applyTimelineCommand, TimelineCommandRefused } from "./timeline.js";
import type { WorldStore } from "../world/store.js";
import type { CommitFileInput } from "../world/commit.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";

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

const requestsPath = (productionId: string): string => `productions/${productionId}/editor-requests.json`;

const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

async function readRequests(store: WorldStore, productionId: string): Promise<{ raw: string | null; file: EditorRequestFile }> {
  let raw: string | null;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, fromPortable(requestsPath(productionId)))), "utf8");
  } catch (error) {
    if (!missing(error)) throw error;
    raw = null;
  }
  if (raw === null) return { raw, file: { schemaVersion: 1, requests: [] } };
  try {
    return { raw, file: EditorRequestFileSchema.parse(JSON.parse(raw)) };
  } catch (error) {
    throw new EditorRequestRefused(`editor-requests.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const serialise = (file: EditorRequestFile): string => `${JSON.stringify(file, null, 2)}\n`;

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

function fileFor(path: string, raw: string | null, content: string): CommitFileInput {
  return { path, action: raw === null ? "create" : "replace", content, baseHash: raw === null ? null : sha256(raw) };
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
  return { timeline: seedStoryPictureTimeline(production), baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production) };
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
  },
): Promise<EditorRequest[]> {
  const productionId = productionOfContext(input.entryContext);
  if (productionId === null) throw new EditorRequestRefused("editor requests need a production, episode or scene thread");
  if (input.requests.length === 0) return [];
  return store.gateOp(async () => {
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
    if (!production) throw new EditorRequestRefused(`production ${productionId} is not in this world`);
    const base = requestBase(store, production);
    const sourceLength = sourceLengthFramesFor(production, store.getBundle().artifacts);
    const { raw, file } = await readRequests(store, productionId);
    const staged: EditorRequest[] = [];
    const added: EditorRequest[] = [];
    for (const request of input.requests) {
      const preview = previewEditorRequest(base.timeline, request.commands, { sourceLength });
      if (!preview.ok) throw new EditorRequestRefused(`"${request.summary.slice(0, 80)}" cannot apply: ${preview.reason}`);
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
    if (added.length === 0) return staged;
    const next: EditorRequestFile = {
      schemaVersion: 1,
      requests: retainEditorRequests([...file.requests, ...added]),
    };
    await store.commitUnserialised({
      kind: "editor-request",
      source: "stage",
      files: [fileFor(requestsPath(productionId), raw, serialise(next))],
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
      files: [fileFor(requestsPath(productionId), raw, serialise({ ...file, requests: file.requests.map((candidate) => (candidate.id === requestId ? updated : candidate)) }))],
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
  if (stale !== null) {
    await writeStatus(store, productionId, requestId, (current) => ({ ...current, status: "stale", decidedAt: now, reason: stale }));
    throw new EditorRequestRefused(`the request is stale: ${stale}; ask Arke for a new one against the current timeline`);
  }

  const resultRevision = (production.timeline?.status === "ready" ? production.timeline.timeline.revision : 0) + 1;
  const accepted: EditorRequest = { ...request, status: "accepted", decidedAt: now, resultRevision };
  const attach = fileFor(
    requestsPath(productionId),
    raw,
    serialise({ ...file, requests: file.requests.map((candidate) => (candidate.id === requestId ? accepted : candidate)) }),
  );
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
      await writeStatus(store, productionId, requestId, (current) => ({ ...current, status: "stale", decidedAt: now, reason: error.reason.slice(0, 300) }));
      throw new EditorRequestRefused(`the request is stale: ${error.reason}; ask Arke for a new one against the current timeline`);
    }
    throw error;
  }
  return accepted;
}
