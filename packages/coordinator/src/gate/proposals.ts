import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
  DEFAULT_AUDIO_POLICY,
  type AudioPolicy,
  type KeyArtIntent,
  CHARACTER_ROLE_MAX,
  ChapterFrontmatterSchema,
  EpisodeSchema,
  isGraphScene,
  newId,
  ProposalSchema,
  RipplePreviewSchema,
  SceneRecordSchema,
  SeasonSchema,
  SeriesSchema,
  validateSceneFlow,
  RoutingSchema,
  StoryOverviewSchema,
  type SceneRecord,
  type Proposal,
  type ProposalDecision,
  type ProposalOrigin,
  type ProposalConflict,
  type ProposalOpenChoice,
  type ProposalSkill,
  type WorldBundle,
  type WorldChatProposalOrigin,
  type RippleItem,
  type RipplePreview,
  orderedShots,
} from "@arke-studio/contracts";
import { ripplesForCanonEntry, ripplesForSheet } from "../index-db/queries.js";
import { atomicWriteFile, renameWithRetry, withTransientRetry } from "../world/atomic.js";
import { appendChanges } from "../world/change-writer.js";
import { changesAnything, classify, type CommitFileInput, type CommitResult } from "../world/commit.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { MarkdownFile, sha256 } from "../world/text-files.js";
import {
  legacySceneCandidateContent,
  parseSceneRecord,
  readSceneRecord,
} from "../productions/scene-record.js";
import {
  WorldStateStaleError,
  type WorldStatePrecondition,
  type WorldStore,
} from "../world/store.js";
import {
  draftStagingPath,
  readDraftOperations,
  removeDraftOperation,
  writeDraftRecord,
  type DraftOperation,
} from "./draft-journal.js";
import { applyFieldEdit, safeFieldEditMessage } from "./field-edit.js";
import { applyJsonResolution, applyResolution, mergeJson, mergeMarkdown } from "./merge.js";
import { projectReview, type ReviewProjection } from "./review.js";

/**
 * The schema each JSON track's whole file must satisfy (SPEC-023 R-17): checked at staging so a
 * malformed record never reaches review, and again at accept so review edits and conflict
 * resolutions cannot smuggle one out. Scenes belong here too: the scanner reads them with this
 * exact schema and silently drops what fails, so a scene this gate would refuse is a scene that
 * stops existing the moment it is accepted — the drafting agent edits its proposal target with
 * raw file tools, and this is the only fence between those edits and the commit. (An earlier
 * note here feared stranding a legacy shape the scanner tolerates; the scanner tolerates
 * nothing this refuses, so there is no such shape.)
 *
 * Scenes are checked against the R-1 union, which is what the scanner now reads (SPEC-029): a
 * target authored in either shape is legible here, and one carrying both structural fields — or
 * neither — is refused by name rather than becoming a scene with two ideas of its own order.
 * What is accepted is a different question from what is written: accept migrates a legacy scene
 * target on its way into the commit, below.
 */
const JSON_TRACK_SCHEMAS: Partial<Record<ReturnType<typeof classify>["track"], { parse: (v: unknown) => unknown }>> = {
  story: StoryOverviewSchema,
  routing: RoutingSchema,
  season: SeasonSchema,
  episode: EpisodeSchema,
  series: SeriesSchema,
  scene: SceneRecordSchema,
};

/**
 * A scene target whose graph is not one path, said in the validator's own words (SPEC-029).
 *
 * Null for anything that is not a graph-backed scene: a legacy target has no flow to be wrong,
 * and the shape check above has already spoken for everything else.
 */
function sceneFlowProblem(path: string, content: string): string | null {
  if (classify(path).track !== "scene") return null;
  const record = parseSceneRecord(content);
  if (!isGraphScene(record)) return null;
  const findings = validateSceneFlow(record.flow);
  return findings.length === 0 ? null : `the scene flow is not one path: ${findings.map((f) => f.message).join(" ")}`;
}

function chapterProblem(path: string, content: string): string | null {
  if (classify(path).track !== "chapter") return null;
  try {
    ChapterFrontmatterSchema.parse(MarkdownFile.parse(content).data);
    return null;
  } catch (err) {
    return `not a chapter: ${err instanceof Error ? err.message.slice(0, 200) : "unreadable"}`;
  }
}

/** The refusal names the record in a person's words, not the commit track's. */
const JSON_TRACK_LABELS: Partial<Record<ReturnType<typeof classify>["track"], string>> = {
  story: "story overview",
  routing: "routing",
  season: "season",
  episode: "episode",
  series: "series record",
  scene: "scene",
};

/**
 * The accept gate (SPEC-004): one path into the world. A proposal is materialised with its
 * bases, edited, previewed with computed ripples, verified under the lock, and accepted as
 * exactly one SPEC-002 commit — or discarded, leaving one log line.
 */

export interface UpdateFieldInput {
  proposalId: string;
  requestId: string;
  path: string;
  field: string;
  value: string;
  expectedDraftRevision: number;
}

export interface MergeSheetFormInput {
  proposalId: string;
  requestId: string;
  path: string;
  sections: Array<{ heading: string; body: string }>;
  /** Characters only: the new role, including an empty string to clear it. */
  role?: string;
  expectedDraftRevision: number;
}

export interface MergeFormInput {
  proposalId: string;
  requestId: string;
  path: string;
  expectedDraftRevision: number;
  edit(content: string): { content: string } | { reason: string };
}

export interface ResolveOpenChoiceInput {
  proposalId: string;
  requestId: string;
  choiceId: string;
  optionId: string;
  expectedDraftRevision: number;
}

export interface ChoiceMaterialisation {
  candidateId: string;
  action: "create" | "amend";
  targets: Array<{ path: string; content: string }>;
  fields: string[];
}

export type ResolveOpenChoiceOutcome =
  | { status: "updated"; proposal: Proposal }
  | { status: "stale"; currentDraftRevision: number }
  | { status: "unknown-choice" }
  | { status: "invalid-option" }
  | { status: "rejected"; message: string }
  | { status: "draft-unresolved"; records: string[] };

export type UpdateFieldOutcome =
  | { status: "updated"; proposal: Proposal }
  /** Somebody else moved it on. Carries what it now is, so the screen can reload rather than guess. */
  | { status: "stale"; currentDraftRevision: number }
  | { status: "unknown-target" }
  | { status: "rejected"; message: string }
  /** An edit whose outcome cannot be determined; nothing may proceed until a person deals with it. */
  | { status: "draft-unresolved"; records: string[] };

export type DraftRecovery = {
  status: "settled" | "blocked";
  unreadable: string[];
  rolledForward: number;
  dropped: number;
};

/** A second world look cannot wait beside the first — see stage(). */
export class LookAlreadyProposedError extends Error {
  constructor(readonly proposalId: string) {
    super(`a change to the world look is already waiting (${proposalId}); decide that one first`);
    this.name = "LookAlreadyProposedError";
  }
}

/**
 * Thrown by the paths that have no outcome type to carry a refusal.
 *
 * Rebase and resolve-conflict both write the proposal's files, so neither may run over an edit
 * whose outcome is unknown; unlike accept, they have nowhere to return that fact politely.
 */
export class DraftUnresolvedError extends Error {
  constructor(
    readonly proposalId: string,
    readonly records: string[],
  ) {
    super(`${proposalId} has an unresolved in-place edit; its journal must be dealt with first`);
    this.name = "DraftUnresolvedError";
  }
}

export type AcceptOutcome =
  | { status: "accepted"; result: CommitResult; ripples: RippleItem[] }
  | { status: "no-op" }
  | { status: "stale"; stalePaths: string[]; detail?: string }
  | { status: "needs-reconfirm"; authoritative: RipplePreview; signature: string }
  | { status: "pending-review" }
  | { status: "unresolved-conflicts"; count: number }
  | { status: "open-choices"; count: number }
  | { status: "target-retired"; paths: string[] }
  /** An in-place edit whose outcome could not be determined; accepting past it is not offered. */
  | { status: "draft-unresolved"; records: string[] }
  | { status: "invalid"; problems: Array<{ path: string; message: string }> };

/**
 * Accept on behalf of a press that has already decided (SPEC-004 R-9, R-10).
 *
 * The ripple reconfirmation exists for the approvals screen: somebody shown "this affects three
 * things" must not have eleven written under them, so a set that has moved since the preview was
 * computed sends the decision back to be looked at again.
 *
 * A conversation shows no such preview. Save and Accept all are one press over points the person
 * has read as sentences, not as ripple counts — so there is nothing for them to re-read, and the
 * refusal is not a question but a dead end: pressing Save again is the only move it leaves, and
 * it works, which is the proof that nothing was being asked.
 *
 * And it moved for a reason worth naming: the proposals in one press are staged together and then
 * accepted one after another, so each accept changes what the next one's ripples look like. Three
 * canon rules about one subject wrote the first and refused the other two, every time — the
 * consequences of the press catching up with the rest of the press.
 *
 * What still refuses is everything that guards the world rather than the reader. The staleness
 * check on each target's recorded base is untouched, so a file edited underneath this press is
 * still refused; so are a retired target, an unresolved conflict, and an over-long role.
 */
export async function acceptDecided(
  gate: ProposalManager,
  proposalId: string,
  precondition?: WorldStatePrecondition,
): Promise<AcceptOutcome> {
  try {
    const first = await gate.accept(proposalId, { precondition });
    if (first.status !== "needs-reconfirm") return first;
    /*
     * Once, and only once.
     *
     * A second refusal is no longer this press's own consequences arriving — something else changed
     * the world between these two calls, and that is exactly the case the reconfirmation is for.
     */
    return await gate.accept(proposalId, { confirmRipples: first.signature, precondition });
  } catch (error) {
    if (error instanceof WorldStateStaleError) {
      return { status: "stale", stalePaths: [], detail: error.detail };
    }
    throw error;
  }
}

/** Apply a person's look fields over an existing proposal without accepting its unread fields. */
export function artDirectionFormContent(
  content: string,
  description: string,
  masterLook: string | null | undefined,
): string {
  const current = ArtDirectionRecordSchema.parse(JSON.parse(content));
  const next = { ...current, description: description.trim() };
  if (masterLook) next.masterLook = masterLook;
  else delete next.masterLook;
  return JSON.stringify(ArtDirectionRecordSchema.parse(next), null, 2) + "\n";
}

/**
 * Did the world end up saying what the proposal said?
 *
 * Two outcomes mean yes, and every caller has to treat them alike. `accepted` wrote it; `no-op`
 * found it already written, which is the same answer to the only question a caller is asking.
 * Reached for by name rather than compared to a string because getting it wrong is silent and
 * expensive: a Save point that read `no-op` as a refusal took the point off the rail, recorded a
 * send-back that never happened, and told the person their change could not be written — over a
 * world that already contained it.
 */
export function landed(outcome: AcceptOutcome): boolean {
  return outcome.status === "accepted" || outcome.status === "no-op";
}

/**
 * Why an accept did not write, said to somebody who pressed a button expecting it to.
 *
 * The statuses are the gate's own vocabulary and no use on their own: `the gate answered "invalid"`
 * tells a person nothing they can act on, least of all that a character's role is a hundred
 * characters over its limit. Every branch that carries detail spends it — `invalid` names the first
 * problem, because it is the one case where the gate knows exactly what is wrong and has already
 * worded it for a person.
 *
 * Each reads as the tail of "this could not be written because …".
 */
export function explainAcceptRefusal(outcome: AcceptOutcome): string {
  switch (outcome.status) {
    case "invalid": {
      const first = outcome.problems[0];
      if (!first) return "one of its fields is outside what may be written";
      const others = outcome.problems.length - 1;
      return `${first.path}: ${first.message}${others > 0 ? `, and ${others} more like it` : ""}`;
    }
    case "stale":
      return outcome.detail ?? `the world moved underneath it — ${outcome.stalePaths.join(", ")} changed while this was being written`;
    case "no-op":
      return "nothing in it differs from what the world already says";
    case "needs-reconfirm":
      return "what it would affect elsewhere changed while it was being written, so it has to be looked at again";
    case "pending-review":
      return "it was rebased onto newer work and has to be read before it can be written";
    case "unresolved-conflicts":
      return `${outcome.count} of its fields conflict with a change made since, and only a person can choose between them`;
    case "open-choices":
      return `${outcome.count} question${outcome.count === 1 ? "" : "s"} must be answered on the approvals screen before this can be written`;
    case "target-retired":
      return `${outcome.paths.join(", ")} has been retired, so it can no longer be changed`;
    case "draft-unresolved":
      return "an edit to it could not be resolved, and writing past that would write something nobody reviewed";
    case "accepted":
      // Unreachable through every caller, and not worth a throw: a wrong word beats a crash on a
      // path that only runs once something has already gone unexpectedly.
      return "it was written after all";
  }
}

export interface StageInput {
  kind: Proposal["kind"];
  summary: string;
  source: string;
  /** Immutable initiating surface. The source remains duplicated for old readers and commits. */
  origin?: Omit<ProposalOrigin, "source">;
  /** Where the still-outstanding human decision is being collected. */
  decision?: ProposalDecision;
  /** World-relative paths to materialise. Created paths carry content and no live base. */
  targets: Array<{ path: string; content?: string }>;
  /**
   * SPEC-020 R-8: the production this draft belongs to, when it stages a guest. Carried on the
   * proposal so the world's surfaces can keep a pending guest off them — the targets hold no
   * content, so nothing downstream could otherwise tell.
   */
  production?: string;
  /** How many canon ids to reserve at creation (R-13). */
  reserveCanonIds?: number;
  /** Ids already reserved by the caller (store.allocateCanonIds) — recorded, not re-allocated. */
  preReservedCanonIds?: string[];
  /** #70: which propositions became this proposal. Explains the draft; never governs accept. */
  worldChatOrigins?: WorldChatProposalOrigin[];
  /** #70: questions blocking this proposal's acceptance and no other (R-34c). */
  openChoices?: ProposalOpenChoice[];
  /** SPEC-019 R-19: the authoring skill this draft was shaped under, when there was one. */
  skill?: ProposalSkill;
}

/**
 * Written inside a proposal the moment its change lands, so the decision survives a
 * directory that cannot be deleted yet (Windows busy handles). Every reader of `.proposals/`
 * honours it: `listOpen` here, and the world scan that feeds the screens.
 */
export const SETTLED_FILE = "settled.json";

const PROPOSALS_DIR = ".proposals";

/** Category:count signature — the definition of a material ripple difference (R-10, D6). */
export function rippleSignature(items: RippleItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + item.targets.length);
  const canonical = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

export class ProposalManager {
  constructor(private readonly store: WorldStore) {}

  private abs(...rel: string[]): string {
    return join(this.store.dir, ...rel.map(fromPortable));
  }

  private proposalDir(id: string): string {
    return this.abs(PROPOSALS_DIR, id);
  }

  private async readLive(path: string): Promise<string | null> {
    try {
      return await readFile(toExtendedLength(this.abs(path)), "utf8");
    } catch {
      return null;
    }
  }

  private async readProposalFile(id: string, path: string): Promise<string | null> {
    try {
      return await readFile(toExtendedLength(join(this.proposalDir(id), fromPortable(path))), "utf8");
    } catch {
      return null;
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Materialise a proposal: copies, bases, `_base/` snapshots, reservation, preview (R-1, R-2). */
  async stage(input: StageInput, precondition?: WorldStatePrecondition): Promise<Proposal> {
    return this.store.gateOp(async () => {
      /*
       * One open look proposal, enforced where it is actually atomic.
       *
       * Readiness checks this too, but from a bundle read before any staging — two conversations
       * wrapping up together both see none and both proceed. Inside the gate operation the check
       * and the write cannot be separated, and this is the only place that is true. It matters
       * because the screen that reviews a proposed look finds it by kind rather than by id, so a
       * second one is reviewed, accepted or discarded in place of the first, arbitrarily.
       */
      if (input.kind === "art-direction") {
        const open = this.store.getBundle().proposals.find((p) => p.proposal.kind === "art-direction");
        if (open) {
          throw new LookAlreadyProposedError(open.proposal.id);
        }
      }
      // Malformed structured JSON is refused before a proposal directory exists (issues #385,
      // #400): nothing should reach review that the scanner would then drop from the bundle.
      for (const target of input.targets) {
        if (target.content === undefined) continue;
        const malformedChapter = chapterProblem(target.path, target.content);
        if (malformedChapter) throw new Error(`${target.path} is ${malformedChapter}`);
        const track = classify(target.path).track;
        const schema = JSON_TRACK_SCHEMAS[track];
        if (!schema) continue;
        try {
          schema.parse(JSON.parse(target.content));
        } catch (err) {
          throw new Error(
            `${target.path} is not a ${JSON_TRACK_LABELS[track] ?? track}: ${err instanceof Error ? err.message.slice(0, 200) : "unreadable"}`,
          );
        }
      }
      const id = newId("pr");
      const at = this.store.now();

      let reservedCanonIds: string[] = input.preReservedCanonIds ?? [];
      if (input.reserveCanonIds && input.reserveCanonIds > 0) {
        reservedCanonIds = [
          ...reservedCanonIds,
          ...(
            await this.store.commitUnserialised({
              kind: "canon-id-allocation",
              source: input.source,
              files: [],
              allocateCanonIds: input.reserveCanonIds,
            })
          ).allocatedCanonIds,
        ];
      }

      const targets: Proposal["targets"] = [];
      for (const target of input.targets) {
        const live = await this.readLive(target.path);
        const baseVersion = live !== null ? readVersion(target.path, live) : null;
        targets.push({
          path: target.path,
          baseVersion,
          baseHash: live !== null ? sha256(live) : null,
        });
        const content = target.content ?? live;
        if (content === null) throw new Error(`${target.path}: no live file and no content supplied`);
        await atomicWriteFile(join(this.proposalDir(id), fromPortable(target.path)), content);
        // The base travels with the proposal — rebase must not depend on .history existing (§2.5).
        if (live !== null) {
          await atomicWriteFile(join(this.proposalDir(id), "_base", fromPortable(target.path)), live);
        }
      }

      const proposal: Proposal = {
        id,
        kind: input.kind,
        summary: input.summary,
        targets,
        baseCanonRevision: this.store.getBundle().meta.canonRevision,
        reservedCanonIds,
        source: input.source,
        origin: {
          source: input.source,
          surface: input.origin?.surface ?? input.source.split(":", 1)[0] ?? "unknown",
          gesture: input.origin?.gesture ?? "stage",
          ...(input.origin?.conversationId !== undefined ? { conversationId: input.origin.conversationId } : {}),
        },
        ...(input.decision !== undefined ? { decision: input.decision } : {}),
        ...(input.production !== undefined ? { production: input.production } : {}),
        created: at,
        draftRevision: 1,
        ...(input.worldChatOrigins ? { worldChatOrigins: input.worldChatOrigins } : {}),
        ...(input.openChoices ? { openChoices: input.openChoices } : {}),
        // Exactly the provenance triple, never the caller's object. The registry's Skill carries
        // its whole guidance body, and TypeScript's structural typing lets it arrive here under
        // the narrow type — spread into the manifest it fails the strict ProposalSkillSchema
        // AFTER the targets are on disk, orphaning an invisible proposal.
        ...(input.skill
          ? { skill: { id: input.skill.id, version: input.skill.version, family: input.skill.family } }
          : {}),
      };
      await this.writeManifest(proposal);
      await this.refreshPreview(proposal);
      return proposal;
    }, precondition);
  }

  /**
   * The form editor's whole flow (SPEC-004 §2.9): stage a sheet edit whose proposed content
   * is the live sheet with its prose sections replaced. Serialisation stays server-side.
   */
  async stageSheetEdit(
    path: string,
    summary: string,
    sections: Array<{ heading: string; body: string }>,
    source: string,
    /** Characters only: the new `role`, or "" to clear it. Undefined leaves it untouched. */
    role?: string,
  ): Promise<Proposal> {
    const live = await this.readLive(path);
    if (live === null) throw new Error(`${path} does not exist`);
    const doc = MarkdownFile.parse(live);
    doc.setBody(sections.map((s) => `## ${s.heading}\n${s.body.trim()}`).join("\n\n"));
    if (role !== undefined) {
      const trimmed = role.trim();
      if (trimmed === "") {
        // Cleared means absent, not empty. An empty frontmatter string reads back as a role of
        // "" — truthy enough to suppress the card's "no role yet" state while showing nothing.
        // setBody above has already marked the doc dirty, so dropping the key is enough.
        const { role: _cleared, ...rest } = doc.data;
        doc.data = rest;
      } else {
        doc.setData({ role: trimmed });
      }
    }
    return this.stage({
      kind: "sheet-edit",
      summary,
      source,
      targets: [{ path, content: doc.serialize() }],
    });
  }

  /**
   * Merge only the fields submitted by a sheet form into the proposal already on that target.
   *
   * Presence dominates acceptance (SPEC-040 R-9a): the proposal may contain unread Studio work,
   * so the form press must not accept the whole file. Applying its dirty fields to the proposal's
   * current bytes keeps that work for the proposal's own decision without treating it as consent.
   */
  async mergeSheetFormEdit(input: MergeSheetFormInput): Promise<UpdateFieldOutcome> {
    const edits = [
      ...input.sections.map((section) => ({ field: section.heading, value: section.body })),
      ...(input.role === undefined ? [] : [{ field: "Role", value: input.role }]),
    ];
    if (edits.length === 0) return { status: "rejected", message: "No changed sheet fields were submitted." };
    return this.mergeFormEdit({
      proposalId: input.proposalId,
      requestId: input.requestId,
      path: input.path,
      expectedDraftRevision: input.expectedDraftRevision,
      edit(content) {
        if (classify(input.path).track !== "sheet") {
          return { reason: "That target is not a sheet." };
        }
        for (const edit of edits) {
          const changed = applyFieldEdit(input.path, content, edit.field, edit.value);
          if (!changed.ok) return { reason: safeFieldEditMessage(changed.problem) };
          content = changed.content;
        }
        return { content };
      },
    });
  }

  /**
   * Merge a form's named fields into the proposal already occupying its target (SPEC-040 R-9a).
   * The caller owns the entity-shaped edit; this owns the revision fence and recoverable journal.
   */
  async mergeFormEdit(input: MergeFormInput): Promise<UpdateFieldOutcome> {
    return this.store.gateOp(async () => {
      const dir = this.proposalDir(input.proposalId);
      const recovery = await this.recoverDrafts(input.proposalId);
      if (recovery.status === "blocked") return { status: "draft-unresolved", records: recovery.unreadable };

      const proposal = await this.readManifest(input.proposalId);
      if (proposal.lastDraftRequestId === input.requestId) return { status: "updated", proposal };
      if (proposal.draftRevision !== input.expectedDraftRevision) {
        return { status: "stale", currentDraftRevision: proposal.draftRevision };
      }
      if (!proposal.targets.some((target) => target.path === input.path)) {
        return { status: "unknown-target" };
      }

      const current = await this.readProposalFile(input.proposalId, input.path);
      if (current === null) return { status: "unknown-target" };
      const edited = input.edit(current);
      if ("reason" in edited) return { status: "rejected", message: edited.reason };

      const nextManifest: Proposal = {
        ...proposal,
        draftRevision: proposal.draftRevision + 1,
        lastDraftRequestId: input.requestId,
      };
      const op: DraftOperation = {
        operationId: newId("dop"),
        requestId: input.requestId,
        proposalId: input.proposalId,
        expectedDraftRevision: input.expectedDraftRevision,
        currentDraftRevision: proposal.draftRevision,
        nextDraftRevision: nextManifest.draftRevision,
        state: "prepared",
        files: [{ path: input.path, content: edited.content }],
        nextManifest: ProposalSchema.parse(nextManifest) as Record<string, unknown>,
        at: this.store.now(),
      };
      await writeDraftRecord(dir, op);
      await atomicWriteFile(draftStagingPath(dir, op.operationId, input.path), edited.content);
      await writeDraftRecord(dir, { ...op, state: "committing" });
      await this.commitDraft(dir, { ...op, state: "committing" });
      return { status: "updated", proposal: nextManifest };
    });
  }

  /** Stage the next world-look version. Acceptance, not this form write, stamps the version. */
  async stageArtDirectionChange(
    description: string,
    masterLook: string | null | undefined,
    /**
     * The standing constraints, when this change is editing them (#244). Absent means unchanged,
     * which has to be carried explicitly: the schema fills its defaults on parse, so a record
     * rebuilt without them would silently return a world set to `allow-model-score` to
     * `environmental-only` — a policy reverted by an unrelated edit to the description, with
     * nothing said and nothing to notice until a clip came back with music under it.
     */
    policy?: { audio?: AudioPolicy; failureModes?: readonly string[]; keyArtIntent?: KeyArtIntent | null },
    options: {
      source?: string;
      precondition?: WorldStatePrecondition;
      origin?: StageInput["origin"];
      decision?: ProposalDecision;
    } = {},
  ): Promise<Proposal> {
    const bundle = this.store.getBundle();
    const current = bundle.artDirection;
    const acceptedAt = current.acceptedAt ?? bundle.meta.created;
    const keyArtIntent = policy && "keyArtIntent" in policy ? policy.keyArtIntent : current.keyArtIntent;
    const proposed = ArtDirectionRecordSchema.parse({
      version: current.version + 1,
      description,
      ...(masterLook ? { masterLook } : {}),
      ...(keyArtIntent !== undefined ? { keyArtIntent } : {}),
      acceptedAt: this.store.now(),
      audio: policy?.audio ?? current.audio,
      failureModes: [...(policy?.failureModes ?? current.failureModes)],
      history: [
        ...current.history,
        {
          version: current.version,
          description: current.description,
          ...(current.masterLook ? { masterLook: current.masterLook } : {}),
          ...(current.keyArtIntent !== undefined ? { keyArtIntent: current.keyArtIntent } : {}),
          acceptedAt,
          // The outgoing policy, kept with the version it belonged to. Reading history to explain
          // an old take is the whole reason these fields are on history at all.
          audio: current.audio,
          failureModes: [...current.failureModes],
        },
      ],
    });
    return this.stage(
      {
        kind: "art-direction",
        summary: `Change world look to v${current.version + 1}`,
        source: options.source ?? "form",
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.decision ? { decision: options.decision } : {}),
        targets: [
          {
            path: ART_DIRECTION_PATH,
            content: `${JSON.stringify(proposed, null, 2)}\n`,
          },
        ],
      },
      options.precondition,
    );
  }

  /** Editor write (chat or form — one proposal, R-14). Refreshes the advisory preview. */
  async updateFile(proposalId: string, path: string, content: string): Promise<void> {
    await this.store.gateOp(async () => {
      const proposal = await this.readManifest(proposalId);
      if (!proposal.targets.some((t) => t.path === path)) {
        throw new Error(`${path} is not a target of ${proposalId}`);
      }
      await atomicWriteFile(join(this.proposalDir(proposalId), fromPortable(path)), content);
      await this.refreshPreview(proposal);
    });
  }

  /**
   * Change one reviewed field in place, through the recoverable draft journal (§11.4.1).
   *
   * The revision check is the point. Two windows on one proposal, or a person editing while a
   * send-back lands, must not silently combine into a third version neither of them read: the
   * losing edit is refused and told what the current revision is, so the screen can reload and
   * show what it now actually says.
   */
  async updateField(input: UpdateFieldInput): Promise<UpdateFieldOutcome> {
    return this.store.gateOp(async () => {
      const dir = this.proposalDir(input.proposalId);

      // Any earlier operation finishes before this one is judged, so the revision it checks
      // against is the settled one rather than a value mid-flight.
      const recovery = await this.recoverDrafts(input.proposalId);
      if (recovery.status === "blocked") return { status: "draft-unresolved", records: recovery.unreadable };

      const proposal = await this.readManifest(input.proposalId);

      // A retry of an edit that already landed is that edit, not a second one.
      if (proposal.lastDraftRequestId === input.requestId) return { status: "updated", proposal };

      if (proposal.draftRevision !== input.expectedDraftRevision) {
        return { status: "stale", currentDraftRevision: proposal.draftRevision };
      }
      if (!proposal.targets.some((t) => t.path === input.path)) {
        return { status: "unknown-target" };
      }

      const current = await this.readProposalFile(input.proposalId, input.path);
      if (current === null) return { status: "unknown-target" };

      const edited = applyFieldEdit(input.path, current, input.field, input.value);
      if (!edited.ok) return { status: "rejected", message: safeFieldEditMessage(edited.problem) };

      // An edit never adds a target or a base: the set of targets was fixed at wrap-up, so the
      // next manifest differs from the current one by its revision alone.
      const nextManifest: Proposal = {
        ...proposal,
        draftRevision: proposal.draftRevision + 1,
        lastDraftRequestId: input.requestId,
      };

      const op: DraftOperation = {
        operationId: newId("dop"),
        requestId: input.requestId,
        proposalId: input.proposalId,
        expectedDraftRevision: input.expectedDraftRevision,
        currentDraftRevision: proposal.draftRevision,
        nextDraftRevision: nextManifest.draftRevision,
        state: "prepared",
        files: [{ path: input.path, content: edited.content }],
        nextManifest: ProposalSchema.parse(nextManifest) as Record<string, unknown>,
        at: this.store.now(),
      };

      // 1. the prepared record, before anything authoritative moves.
      await writeDraftRecord(dir, op);
      // 2. every next file, beside the journal rather than over the target.
      for (const file of op.files) {
        await atomicWriteFile(draftStagingPath(dir, op.operationId, file.path), file.content);
      }
      // 3. past here the targets may move, so recovery may only go forward.
      await writeDraftRecord(dir, { ...op, state: "committing" });
      // 4-7.
      await this.commitDraft(dir, { ...op, state: "committing" });
      return { status: "updated", proposal: nextManifest };
    });
  }

  /** Answer one proposal-local question and replace that candidate's targets as one journalled edit. */
  async resolveOpenChoice(
    input: ResolveOpenChoiceInput,
    materialise: (proposal: Proposal, bundle: WorldBundle, at: string) => ChoiceMaterialisation,
  ): Promise<ResolveOpenChoiceOutcome> {
    return this.store.gateOp(async () => {
      const recovery = await this.recoverDrafts(input.proposalId);
      if (recovery.status === "blocked") return { status: "draft-unresolved", records: recovery.unreadable };

      const proposal = await this.readManifest(input.proposalId);
      if (proposal.lastDraftRequestId === input.requestId) return { status: "updated", proposal };
      if (proposal.draftRevision !== input.expectedDraftRevision) {
        return { status: "stale", currentDraftRevision: proposal.draftRevision };
      }

      const choice = (proposal.openChoices ?? []).find((one) => one.choiceId === input.choiceId);
      if (!choice) return { status: "unknown-choice" };
      if (!choice.options.some((option) => option.optionId === input.optionId)) return { status: "invalid-option" };

      const at = this.store.now();
      const replacement = materialise(proposal, this.store.getBundle(), at);
      if (
        choice.kind === "duplicate-or-amend" &&
        replacement.candidateId !== choice.choiceId.slice("duplicate-or-amend:".length)
      ) {
        return { status: "rejected", message: "the answer no longer matches the point that asked the question" };
      }
      const origin = (proposal.worldChatOrigins ?? []).find((one) => one.candidateId === replacement.candidateId);
      if (!origin) return { status: "rejected", message: "the point behind this question is no longer attached to the proposal" };
      if (replacement.targets.length === 0) return { status: "rejected", message: "the answer produced no change to review" };

      const replacedPaths = new Set(origin.targetPaths);
      const untouched = proposal.targets.filter((target) => !replacedPaths.has(target.path));
      const occupied = new Set(untouched.map((target) => target.path));
      const nextTargets: Proposal["targets"] = [];
      const files: DraftOperation["files"] = [];
      for (const target of replacement.targets) {
        if (occupied.has(target.path) || nextTargets.some((one) => one.path === target.path)) {
          return { status: "rejected", message: `${target.path} is already changed elsewhere in this proposal` };
        }
        const live = await this.readLive(target.path);
        if (replacement.action === "create" && live !== null) {
          return { status: "rejected", message: `${target.path} now exists, so this can no longer be created safely` };
        }
        if (replacement.action === "amend" && live === null) {
          return { status: "rejected", message: `${target.path} no longer exists, so it cannot be amended` };
        }
        nextTargets.push({
          path: target.path,
          baseVersion: live === null ? null : readVersion(target.path, live),
          baseHash: live === null ? null : sha256(live),
        });
        files.push({ path: target.path, content: target.content });
        if (live !== null) files.push({ path: `_base/${target.path}`, content: live });
      }

      const origins = (proposal.worldChatOrigins ?? []).map((one) =>
        one.candidateId === replacement.candidateId
          ? { ...one, targetPaths: replacement.targets.map((target) => target.path), fields: replacement.fields }
          : one,
      );
      const nextManifest: Proposal = {
        ...proposal,
        targets: [...untouched, ...nextTargets],
        baseCanonRevision: this.store.getBundle().meta.canonRevision,
        draftRevision: proposal.draftRevision + 1,
        lastDraftRequestId: input.requestId,
        worldChatOrigins: origins,
        openChoices: (proposal.openChoices ?? []).filter((one) => one.choiceId !== input.choiceId),
      };
      const op: DraftOperation = {
        operationId: newId("dop"),
        requestId: input.requestId,
        proposalId: input.proposalId,
        expectedDraftRevision: input.expectedDraftRevision,
        currentDraftRevision: proposal.draftRevision,
        nextDraftRevision: nextManifest.draftRevision,
        state: "prepared",
        files,
        nextManifest: ProposalSchema.parse(nextManifest) as Record<string, unknown>,
        at,
      };
      const dir = this.proposalDir(input.proposalId);
      await writeDraftRecord(dir, op);
      for (const file of op.files) {
        await atomicWriteFile(draftStagingPath(dir, op.operationId, file.path), file.content);
      }
      await writeDraftRecord(dir, { ...op, state: "committing" });
      await this.commitDraft(dir, { ...op, state: "committing" });
      return { status: "updated", proposal: nextManifest };
    });
  }

  /**
   * Steps 4-7, written so that running them twice is the same as running them once.
   *
   * Recovery calls this without knowing how far the original attempt got, so every step either
   * moves the world to the recorded next state or finds it already there.
   */
  private async commitDraft(dir: string, op: DraftOperation): Promise<void> {
    for (const file of op.files) {
      const staged = draftStagingPath(dir, op.operationId, file.path);
      const target = join(dir, fromPortable(file.path));
      // A choice can replace a proposed create with an amendment whose `_base/` tree did not
      // exist when the proposal was staged. Recovery must be able to create it too.
      await mkdir(dirname(target), { recursive: true });
      try {
        // 4. rename, not copy: the target is never briefly half-written.
        await renameWithRetry(staged, target);
      } catch (err) {
        // Already renamed by an earlier attempt. The record's contents are the authority on what
        // the target should say, so a missing staging file is only acceptable when it does.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const landed = await readFile(toExtendedLength(target), "utf8").catch(() => null);
        if (landed !== file.content) throw err;
      }
    }
    // 5. the manifest, carrying the next revision, wholesale.
    const next = ProposalSchema.parse(op.nextManifest);
    await this.writeManifest(next);
    // 6. the preview follows the files it describes.
    await this.refreshPreview(next);
    // 7. nothing is left to roll forward.
    await removeDraftOperation(dir, op);
  }

  /**
   * Roll this proposal's journal to a settled state (§11.4.1).
   *
   * A committing operation goes forward, because its targets may already have moved. A
   * prepared-only one is dropped, because none of them have. A record that will not parse blocks:
   * an operation whose outcome nobody can determine is exactly what must not be accepted past.
   */
  async recoverDrafts(proposalId: string): Promise<DraftRecovery> {
    const dir = this.proposalDir(proposalId);
    const { operations, unreadable } = await readDraftOperations(dir);
    if (unreadable.length > 0) return { status: "blocked", unreadable, rolledForward: 0, dropped: 0 };

    let rolledForward = 0;
    let dropped = 0;
    for (const op of operations) {
      if (op.state === "committing") {
        await this.commitDraft(dir, op);
        rolledForward += 1;
      } else {
        await removeDraftOperation(dir, op);
        dropped += 1;
      }
    }
    return { status: "settled", unreadable: [], rolledForward, dropped };
  }

  /** Discard: the directory goes, reservations stay burned, one log line remains (R-4, D9). */
  async discard(proposalId: string): Promise<void> {
    await this.store.gateOp(async () => {
      const proposal = await this.readManifest(proposalId).catch(() => null);
      await rm(toExtendedLength(this.proposalDir(proposalId)), { recursive: true, force: true });
      await appendChanges(this.abs("changes.jsonl"), [
        {
          ts: this.store.now(),
          entity: `.proposals/${proposalId}`,
          discarded: true,
          ...(proposal ? { reservedCanonIds: proposal.reservedCanonIds } : {}),
          source: proposal?.source ?? "unknown",
        },
      ]);
    });
  }

  // ---- accept --------------------------------------------------------------

  async accept(
    proposalId: string,
    opts: { confirmRipples?: string; precondition?: WorldStatePrecondition } = {},
  ): Promise<AcceptOutcome> {
    return this.store.gateOp(async () => {
      // §11.4.1: recover first, then refuse while anything remains unresolved. Accepting past an
      // edit whose outcome is unknown would write a version of the file that nobody reviewed.
      const recovery = await this.recoverDrafts(proposalId);
      if (recovery.status === "blocked") return { status: "draft-unresolved", records: recovery.unreadable };

      const proposal = await this.readManifest(proposalId);

      const openChoices = proposal.openChoices ?? [];
      if (openChoices.length > 0) return { status: "open-choices", count: openChoices.length };
      if (proposal.pendingReview) return { status: "pending-review" };
      const unresolved = (proposal.conflicts ?? []).filter((c) => c.resolution === undefined);
      if (unresolved.length > 0) return { status: "unresolved-conflicts", count: unresolved.length };

      // Retired targets can only be discarded (§2.11).
      const retired: string[] = [];
      for (const target of proposal.targets) {
        const live = target.baseHash !== null ? await this.readLive(target.path) : "new";
        if (live !== null && live !== "new" && isRetired(target.path, live)) retired.push(target.path);
      }
      if (retired.length > 0) return { status: "target-retired", paths: retired };

      // Staleness first (R-5): compare recorded bases against the live world.
      const stalePaths: string[] = [];
      for (const target of proposal.targets) {
        const live = await this.readLive(target.path);
        const found = live === null ? null : sha256(live);
        if (target.baseHash === null ? live === null : found === target.baseHash) continue;
        /*
         * The world moved — but a proposal's own landing moves it the same way, and this check
         * cannot tell the difference from the base alone (codex, 2026-08-22). A created target
         * records `baseHash: null` and, once accepted, has a live file; an amended one has a live
         * hash that is no longer its pre-commit base. Both read as stale, which is why the eight
         * sheets from a world door whose commits landed but whose directories survived could not
         * be cleared by anything: stale on accept, and the no-op retirement below unreachable.
         *
         * So: only what the target proposes settles it. Identical bytes mean this proposal is
         * what the world already says, and it falls through to be retired. Anything else is a
         * genuine collision and is still refused, with the path named.
         */
        const proposed = await this.readProposalFile(proposalId, target.path);
        if (proposed !== null && live !== null && !changesAnything(target.path, live, proposed)) continue;
        stalePaths.push(target.path);
      }
      if (stalePaths.length > 0) return { status: "stale", stalePaths };

      // Build the plan; a proposal identical to the live world is a no-op, reported (R-3).
      const files: CommitFileInput[] = [];
      // What each target replaces, kept from this pass: the scene migration below needs the
      // graph a target is landing on, and reading the file a second time would let it move.
      const liveByPath = new Map<string, string | null>();
      for (const target of proposal.targets) {
        const proposed = await this.readProposalFile(proposalId, target.path);
        if (proposed === null) throw new Error(`${target.path} missing from proposal ${proposalId}`);
        const live = await this.readLive(target.path);
        liveByPath.set(target.path, live);
        if (live !== null && !changesAnything(target.path, live, proposed)) continue; // unchanged target
        files.push({
          path: target.path,
          action: live === null ? "create" : "replace",
          content: proposed,
          baseHash: target.baseHash,
        });
      }
      if (files.length === 0) {
        // Every target already says what is proposed, so there is no decision left to make —
        // and a card that cannot be accepted, cannot be usefully discarded, and says nothing when
        // pressed is worse than no card. Driven 2026-08-22: eight sheets from a world door whose
        // commits had landed but whose directories survived sat in Needs you permanently, and
        // Accept all did nothing, visibly or in any log.
        //
        // Retiring rather than refusing is safe precisely because nothing would change: the
        // world already says what this proposal says. What is thrown away is the offer, not work.
        /*
         * Written to the world's own log before the directory goes, because the tombstone dies
         * with the directory and recovery reads the log (codex, 2026-08-22). A process that
         * stopped between retiring and the coordinator's `proposal.resolved` would otherwise
         * leave a leftover with no proposal, no account and no journal line — which
         * `recoverWrapUps` reads as an intent that created nothing, and answers by returning the
         * propositions to live. They would then be proposed a second time over a world that
         * already holds them, which is a duplicate entry produced by a cleanup.
         */
        await appendChanges(join(this.store.dir, "changes.jsonl"), [
          {
            ts: this.store.now(),
            entity: "proposal",
            proposalId,
            settled: "already-live",
            source: proposal.source,
          },
        ]).catch(() => {
          /* the retirement still stands; recovery is the only thing that loses its evidence */
        });
        await this.retire(proposalId, null);
        return { status: "no-op" };
      }

      const problems = await this.checkAuthoredBounds(files);
      if (problems.length > 0) return { status: "invalid", problems };

      // Authority: recompute ripples now, under the lock, after verification (R-9).
      const authoritative = this.computeRipples(proposal, files);
      const signature = rippleSignature(authoritative.items);
      const preview = await this.readPreview(proposalId);
      const previewSignature = preview ? rippleSignature(preview.items) : signature;
      if (signature !== previewSignature && opts.confirmRipples !== signature) {
        // Persist the authoritative set so the panel shows what now governs (R-10).
        await this.writePreview(proposal.id, { ...authoritative, governing: true });
        return { status: "needs-reconfirm", authoritative, signature };
      }

      // Any accepted new-model entity crosses the schema boundary (SPEC-023 R-23): a season,
      // episode, series or routing record landing in a version-1 world must fence it, or an
      // older build opens the world and silently drops what was just accepted.
      const crossesBoundary = files.some((file) => {
        const track = classify(file.path).track;
        return track === "season" || track === "episode" || track === "series" || track === "routing" || track === "story";
      });
      /*
       * New draft and World Chat proposals are graph scenes. A persisted proposal can predate
       * that retirement and still carry a legacy `shots[]` scene, so acceptance upgrades that
       * compatibility input immediately before the one commit lands it (SPEC-029 R-11).
       *
       * A graph target is left exactly as it was reviewed. Its node ids, edges and authored
       * groups are the proposal — not decoration on one — and projecting it to
       * `shots[]` in order to rebuild a flow would silently discard every graph edit somebody
       * had just approved. Its topology was validated with the rest of the record above.
       *
       * The world crosses schema 3 inside the commit, from the bytes (see `commit.ts`), so a
       * scene carrying `script` or an explicit `order` is fenced by the newer boundary and the
       * old scene arm of the check above is subsumed.
       *
       * The refusal here is about the file being landed on, not the one proposed: the checks
       * above read the target, and a live scene that cannot be read — unparseable, or a graph
       * that is not one path — is one no write may be built over (R-59). It is read first,
       * before the proposed shape is even looked at, because whether that rule applies is a fact
       * about the thing being written over and never about the shape of the thing replacing it.
       * And it is reported like any other record problem, because a thrown error out of accept
       * is a card that cannot be accepted, cannot be usefully discarded, and says nothing when
       * pressed.
       */
      const refusals: Array<{ path: string; message: string }> = [];
      for (const file of files) {
        if (classify(file.path).track !== "scene" || file.content === undefined) continue;
        try {
          const live = liveByPath.get(file.path) ?? null;
          // The read-only projection also validates that a live graph has one readable path.
          const current = live !== null ? readSceneRecord(live).record : null;
          const proposedScene = parseSceneRecord(file.content);
          if (isGraphScene(proposedScene)) continue;
          file.content = legacySceneCandidateContent(current, proposedScene);
        } catch (err) {
          refusals.push({
            path: file.path,
            message: `the scene on disk cannot be written over: ${err instanceof Error ? err.message.slice(0, 200) : "unreadable"}`,
          });
        }
      }
      if (refusals.length > 0) return { status: "invalid", problems: refusals };
      // Exactly one commit (R-11); versions derive inside the primitive (R-12, D7).
      const result = await this.store.commitUnserialised({
        kind: proposal.kind,
        source: proposal.source,
        proposalId: proposal.id,
        files,
        ...(crossesBoundary ? { raiseSchemaVersion: 2 } : {}),
      });
      await this.retire(proposalId, result.commitId);
      return { status: "accepted", result, ripples: authoritative.items };
    }, opts.precondition);
  }

  /**
   * The proposal is over, whether or not its directory can be deleted right now.
   *
   * Removing it used to be the last line of accept, unguarded — so on Windows, where the
   * drafting agent's own session has the proposal directory as its working directory, the
   * delete failed with a busy handle and threw AFTER the commit had landed. The caller saw a
   * failed accept, the world had the change, and the proposal came back on the approvals screen
   * for good: accepting it again found the file already live and answered "stale" forever.
   * Driven 2026-08-22 on a brand-new world, where all eight sheets settled and all eight stayed.
   *
   * So the commit is the decision, and this is only tidying. A tombstone goes in first — writing
   * a file inside a busy directory is allowed where deleting the directory is not — and it is
   * what `listOpen` reads, so a proposal whose change has landed never appears open again even
   * if its bytes linger until the next sweep.
   */
  /** `commitId` is null when the proposal was retired without one — nothing differed to commit. */
  private async retire(proposalId: string, commitId: string | null): Promise<void> {
    const dir = this.proposalDir(proposalId);
    try {
      await atomicWriteFile(
        join(dir, SETTLED_FILE),
        JSON.stringify({ commitId, at: this.store.now() }, null, 2) + "\n",
      );
    } catch {
      /* if even the tombstone cannot be written, the sweep below is the only cleanup */
    }
    await withTransientRetry(() => rm(toExtendedLength(dir), { recursive: true, force: true })).catch(() => {
      /* a busy handle clears when the session does; the tombstone already hides it */
    });
  }

  /** Bytes left behind by a retired proposal, cleared whenever the gate next lists. */
  private async sweepSettled(id: string): Promise<void> {
    await rm(toExtendedLength(this.proposalDir(id)), { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Bounds the gate enforces on authored content (SPEC-007 R-18).
   *
   * The form editor caps `role` as you type and the staging frame refuses an over-long one, but
   * a drafting agent reaches neither: it writes files straight into the proposal directory with
   * its own tools. Without a check here the cap would constrain only the human, which is the
   * worst of both — so the gate is where the rule is actually made true. The agent preamble
   * states the same bound so this refusal is a backstop, not the normal path.
   *
   * Only a role this proposal *changes* is judged. A world may already hold a longer one — the
   * read schema is deliberately permissive — and refusing to accept an unrelated edit to that
   * sheet would strand it, uneditable, on a rule that postdates it.
   */
  private async checkAuthoredBounds(
    files: CommitFileInput[],
  ): Promise<Array<{ path: string; message: string }>> {
    const problems: Array<{ path: string; message: string }> = [];
    for (const file of files) {
      // A delete carries no content and cannot introduce a role.
      const jsonSchema = file.content !== undefined ? JSON_TRACK_SCHEMAS[classify(file.path).track] : undefined;
      if (file.content !== undefined && jsonSchema) {
        // Structured JSON is refused before acceptance when it is malformed or out of scope
        // (issues #385, #400): a reviewer cannot be handed JSON the scanner would then drop.
        try {
          jsonSchema.parse(JSON.parse(file.content));
        } catch (err) {
          problems.push({
            path: file.path,
            message: `not a ${JSON_TRACK_LABELS[classify(file.path).track] ?? "valid record"}: ${err instanceof Error ? err.message.slice(0, 200) : "unreadable"}`,
          });
          continue;
        }
        // A graph target's topology, refused here for the same reason its shape is (SPEC-029
        // R-58..R-61): a scene whose flow is not one path is one no consumer may order, so it
        // must not reach the commit that would make it the world's.
        const malformed = sceneFlowProblem(file.path, file.content);
        if (malformed) {
          problems.push({ path: file.path, message: malformed });
          continue;
        }
        const collision = this.collidingShotIds(file.path, file.content);
        if (collision) problems.push({ path: file.path, message: collision });
        continue;
      }
      if (file.content !== undefined) {
        const malformedChapter = chapterProblem(file.path, file.content);
        if (malformedChapter) {
          problems.push({ path: file.path, message: malformedChapter });
          continue;
        }
      }
      if (!file.path.startsWith("characters/") || file.content === undefined) continue;
      const role = roleOf(file.content);
      if (role === null || role.length <= CHARACTER_ROLE_MAX) continue;
      const live = await this.readLive(file.path);
      if (live !== null && roleOf(live) === role) continue; // carried through untouched
      problems.push({
        path: file.path,
        message: `role is ${role.length} characters; the limit is ${CHARACTER_ROLE_MAX}`,
      });
    }
    return problems;
  }

  /**
   * A scene whose shot ids are already another scene's, said in words the agent can act on.
   *
   * Takes, selections and the Generate workspace all key by bare shot id with no scene, so an id
   * reused across two scenes makes one scene's takes render on the other's card and one accept
   * mark both. The storyboard's own Add shot mints against the whole production for exactly this
   * reason; a drafting agent numbers from one per scene and cannot see the others, so the gate
   * is where it is caught — and being a record problem, the still-open session is asked to fix
   * it before anybody presses Accept (round 3, 2026-08-22, driven: "Generate frame" on one
   * scene's shot 1 opened another scene's shot 1).
   */
  private collidingShotIds(path: string, content: string): string | null {
    const match = /^productions\/([^/]+)\/scenes\/([^/]+)\.json$/.exec(path);
    if (!match) return null;
    const [, productionId, stem] = match;
    // Through the union's projection (SPEC-029): a target may be authored in either shape, and
    // an id collision is about the shots the scene holds, not about which field holds them.
    let scene: SceneRecord;
    try {
      scene = parseSceneRecord(content);
    } catch {
      return null; // the schema check above already said so
    }
    const mine = orderedShots(scene).map((shot) => String(shot.id)).filter((id) => id !== "undefined");
    if (mine.length === 0) return null;
    const production = this.store.getBundle().productions.find((p) => p.meta.id === productionId);
    if (!production) return null;
    /*
     * Only ids this edit INTRODUCES (driven 2026-08-22, and this check's own doing).
     *
     * Two scenes drafted before the mint was production-wide really do share sh_1 and sh_2 on
     * disk. Judging the whole shot list made every gated edit to either scene refuse for a
     * collision it did not cause and could not fix — the scene became permanently unwritable
     * through the gate, and the storyboard was the only way to touch it. A pre-existing overlap
     * is a fact about the world; what this check exists to stop is a new one being added.
     */
    const priorScene = production.scenes.find(
      (s) => s.id === scene.id || production.sceneFiles[s.id] === stem,
    );
    const already = new Set((priorScene === undefined ? [] : orderedShots(priorScene)).map((shot) => shot.id));
    const taken = new Map<string, string>();
    for (const other of production.scenes) {
      // The scene this file IS, matched by stem as well as id: a redraft of the same file keeps
      // its own ids, and calling that a collision would make every second draft unacceptable.
      if (other.id === scene.id || production.sceneFiles[other.id] === stem) continue;
      for (const shot of orderedShots(other)) taken.set(shot.id, other.title || other.id);
    }
    const clashes = mine.filter((id) => taken.has(id) && !already.has(id));
    if (clashes.length === 0) return null;
    const next = [...taken.keys()]
      .map((id) => Number(id.replace(/^sh_0*/, "")))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), 0) + 1;
    return `shot ${clashes.length === 1 ? "id" : "ids"} ${clashes.join(", ")} already belong to "${taken.get(clashes[0]!)}" in this production — every shot id must be unique across the whole production, because takes and selections key by shot id alone. Renumber this scene's shots from sh_${next} upward, keeping each shot's own \`number\` as it is.`;
  }

  /**
   * What accept would refuse about this proposal's own files, asked without accepting.
   *
   * The drafting agent writes its target with raw file tools, so the first thing that reads what
   * it wrote used to be the accept the person pressed. This lets the still-open session be told
   * instead — in the gate's own words, from the gate's own schemas, so what the agent is asked to
   * repair is exactly what would otherwise be refused. An empty array means accept would not
   * refuse on these grounds; it promises nothing about staleness or ripples, which are about the
   * world moving rather than about what was written.
   */
  async recordProblems(proposalId: string): Promise<Array<{ path: string; message: string }>> {
    const proposal = await this.readManifest(proposalId);
    const files: CommitFileInput[] = [];
    for (const target of proposal.targets) {
      const content = await this.readProposalFile(proposalId, target.path);
      // A target that cannot be read is accept's problem to name, not this one's: it refuses by
      // a different route, and reporting it here as a record problem would ask the agent to
      // repair a file it may never have been asked to write.
      if (content === null) continue;
      files.push({ path: target.path, action: "replace", content, baseHash: target.baseHash });
    }
    return this.checkAuthoredBounds(files);
  }

  // ---- rebase --------------------------------------------------------------

  /** Field-level three-way rebase (R-6, R-7): new bases, merged files, recomputed preview. */
  async rebase(proposalId: string): Promise<{ conflicts: ProposalConflict[] }> {
    return this.store.gateOp(async () => {
      // §11.4.1: a rebase merges against the proposal's files, so an edit half-applied to them
      // would be merged into the world's history as though it had been reviewed.
      const recovery = await this.recoverDrafts(proposalId);
      if (recovery.status === "blocked") throw new DraftUnresolvedError(proposalId, recovery.unreadable);

      const proposal = await this.readManifest(proposalId);
      const conflicts: ProposalConflict[] = [];
      const targets: Proposal["targets"] = [];

      for (const target of proposal.targets) {
        const live = await this.readLive(target.path);
        const mine = await this.readProposalFile(proposalId, target.path);
        if (mine === null) throw new Error(`${target.path} missing from proposal`);
        const base = await this.readProposalFile(proposalId, `_base/${target.path}`);

        if (live === null) {
          /*
           * A deleted look file does not mean the world has no look.
           *
           * Delete it and the world falls back to the one derived from its tone and genre, so the
           * generic create branch would leave this proposal restating a version that is no longer
           * anywhere — reviewed against the deleted file and accepted against the derived one,
           * which are two different looks. Restating against what the world actually resolves to
           * keeps the thing reviewed and the thing written the same thing.
           */
          if (target.path === ART_DIRECTION_PATH) {
            const resolvedNow = `${JSON.stringify(currentLookRecord(this.store.getBundle().artDirection), null, 2)}
`;
            const restated = restateArtDirection(mine, resolvedNow, base, this.store.now());
            if (restated === null) {
              /*
               * The staged document will not parse, and falling through would keep it.
               *
               * The create branch below reports no conflict and refreshes nothing, so a rebase
               * that could not restate anything came back clean — and the malformed record sat
               * behind an Accept button that throws in the commit gate, with the conflict
               * controls offering no repair because no conflict was ever raised. Raised against
               * the look the world resolves to, exactly as the branch for a live file does: it
               * blocks the accept, and it gives the panel a side that can be chosen.
               */
              conflicts.push({ path: target.path, field: "Look", base, mine, theirs: resolvedNow });
              targets.push({ path: target.path, baseVersion: null, baseHash: null });
              continue;
            }
            await atomicWriteFile(join(this.proposalDir(proposalId), fromPortable(target.path)), restated);
            await atomicWriteFile(
              join(this.proposalDir(proposalId), "_base", fromPortable(target.path)),
              resolvedNow,
            );
            targets.push({ path: target.path, baseVersion: null, baseHash: null });
            continue;
          }
          // The live file vanished (retired files stay; this is create-vs-nothing): keep mine.
          targets.push({ path: target.path, baseVersion: null, baseHash: null });
          continue;
        }
        /*
         * The world look rebases by restatement, not by merging — and before the generic branches,
         * not after them.
         *
         * It is one JSON document rather than prose with a shape, so there are no sections to
         * merge and mergeMarkdown would rewrite it with frontmatter delimiters, leaving a file
         * that no longer parses as a look behind a button that promises recovery. A three-way
         * merge would be the wrong idea even if it worked: a look is one whole description, so
         * rebasing it means stating this look against the version that is current now.
         *
         * The staleness test is the live file rather than `base`, because "staged when the world
         * had no look at all, and one exists now" is exactly the case the create branch below
         * would swallow — it would refresh the hash and leave a record whose version and history
         * were computed against nothing.
         */
        if (target.path === ART_DIRECTION_PATH && sha256(live) !== target.baseHash) {
          const restated = restateArtDirection(mine, live, base, this.store.now());
          if (restated === null) {
            conflicts.push({ path: target.path, field: "Look", base, mine, theirs: live });
            targets.push({ path: target.path, baseVersion: readVersion(target.path, live), baseHash: sha256(live) });
            continue;
          }
          await atomicWriteFile(join(this.proposalDir(proposalId), fromPortable(target.path)), restated);
          await atomicWriteFile(join(this.proposalDir(proposalId), "_base", fromPortable(target.path)), live);
          targets.push({ path: target.path, baseVersion: readVersion(target.path, live), baseHash: sha256(live) });
          continue;
        }

        if (base === null && target.baseHash === null) {
          // This proposal CREATES the file — and someone else created it first. Refreshing the
          // base hash here would let accept overwrite their file wholesale with a draft written
          // against nothing; that is a conflict a person resolves, not bookkeeping.
          conflicts.push({
            path: target.path,
            field: "whole file",
            base: "",
            mine,
            theirs: live,
          });
          targets.push({ path: target.path, baseVersion: readVersion(target.path, live), baseHash: sha256(live) });
          continue;
        }
        if (base === null || sha256(live) === target.baseHash) {
          // Not stale (or the base snapshot is missing, which only the create case above can
          // make meaningful): rebase just refreshes the base record.
          targets.push({
            path: target.path,
            baseVersion: readVersion(target.path, live),
            baseHash: sha256(live),
          });
          continue;
        }

        // JSON tracks merge in the JSON lane (SPEC-023 R-18): mergeMarkdown would re-serialise
        // them with frontmatter fences, leaving files that no longer parse.
        const track = classify(target.path).track;
        const jsonTrack =
          track === "scene" ||
          track === "story" ||
          track === "routing" ||
          track === "season" ||
          track === "episode" ||
          track === "series";
        const merge = jsonTrack
          ? mergeJson(target.path, base, mine, live)
          : mergeMarkdown(target.path, base, mine, live);
        conflicts.push(...merge.conflicts);
        await atomicWriteFile(join(this.proposalDir(proposalId), fromPortable(target.path)), merge.merged);
        await atomicWriteFile(join(this.proposalDir(proposalId), "_base", fromPortable(target.path)), live);
        targets.push({
          path: target.path,
          baseVersion: readVersion(target.path, live),
          baseHash: sha256(live),
        });
      }

      const updated: Proposal = {
        ...proposal,
        targets,
        baseCanonRevision: this.store.getBundle().meta.canonRevision,
        rebasedAt: this.store.now(),
        pendingReview: true, // must be seen before accept (R-7)
        ...(conflicts.length > 0 ? { conflicts } : { conflicts: [] }),
      };
      await this.writeManifest(updated);
      await this.refreshPreview(updated);
      return { conflicts };
    });
  }

  /** A human chose a side for one conflicted field (R-6, D4). */
  async resolveConflict(proposalId: string, path: string, field: string, choice: "mine" | "theirs"): Promise<void> {
    await this.store.gateOp(async () => {
      // §11.4.1: resolving writes the proposal file, so it must not run over an edit in flight.
      const recovery = await this.recoverDrafts(proposalId);
      if (recovery.status === "blocked") throw new DraftUnresolvedError(proposalId, recovery.unreadable);

      const proposal = await this.readManifest(proposalId);
      const conflict = (proposal.conflicts ?? []).find((c) => c.path === path && c.field === field);
      if (!conflict) throw new Error(`no conflict on ${path}#${field}`);
      const current = await this.readProposalFile(proposalId, path);
      if (current === null) throw new Error(`${path} missing from proposal`);
      /*
       * Choosing a side of a world-look conflict takes that whole document.
       *
       * The conflict only exists because one of the two would not parse, and its "field" is the
       * entire record rather than a section. applyResolution writes Markdown — it would wrap the
       * chosen JSON in frontmatter and produce something no longer readable as a look, which is
       * the failure the conflict was raised to prevent.
       */
      if (path === ART_DIRECTION_PATH) {
        /*
         * Neither side is choosable while the live look is unreadable.
         *
         * The commit gate parses the live record before writing the next version, so it would
         * throw whichever side was picked — and the screen would have said the conflict was
         * resolved. A control that reports success and cannot succeed is worse than no control:
         * the file has to be repaired first, and saying so is the only honest answer here.
         *
         * A file that is simply not there is a different thing and not a fault: the world still
         * has a look, derived from its tone and genre, and the commit gate derives the same one
         * rather than parsing anything. Refusing that case would strand the conflict this rebase
         * now raises when a deleted look meets a malformed proposal — telling somebody to repair
         * a file that does not exist.
         */
        const live = await this.readLive(path);
        if (live !== null && !parsesAsLook(live)) {
          throw new Error(
            `${path} cannot be read as a world look, so neither side can be accepted; repair the file first`,
          );
        }
      }
      let resolved: string;
      if (path === ART_DIRECTION_PATH) {
        // The side being written has to be a look as well. Guarding only the live document left
        // "mine" free to write the malformed staged one, which the commit gate then throws on —
        // after this had reported the conflict resolved.
        const chosen = (choice === "mine" ? conflict.mine : conflict.theirs) ?? current;
        if (!parsesAsLook(chosen)) {
          throw new Error(
            `the ${choice} side of ${path} cannot be read as a world look, so it cannot be accepted`,
          );
        }
        resolved = chosen;
      } else if (conflict.field === "whole file") {
        // The create-vs-create conflict is all-or-nothing: mine keeps the staged draft, theirs
        // takes the live file wholesale. Feeding it to the field appliers nested one document
        // inside the other under a literal "whole file" key.
        resolved = choice === "mine" ? current : (conflict.theirs ?? current);
      } else {
        const track = classify(path).track;
        resolved =
          track === "scene" ||
          track === "story" ||
          track === "routing" ||
          track === "season" ||
          track === "episode" ||
          track === "series"
            ? applyJsonResolution(current, conflict, choice)
            : applyResolution(path, current, conflict, choice);
      }
      await atomicWriteFile(join(this.proposalDir(proposalId), fromPortable(path)), resolved);
      const conflicts = (proposal.conflicts ?? []).map((c) =>
        c.path === path && c.field === field ? { ...c, resolution: choice } : c,
      );
      await this.writeManifest({ ...proposal, conflicts });
    });
  }

  /** The user has seen the merged result; the proposal becomes acceptable again (R-7). */
  async markSeen(proposalId: string): Promise<void> {
    await this.store.gateOp(async () => {
      const proposal = await this.readManifest(proposalId);
      await this.writeManifest({ ...proposal, pendingReview: false });
    });
  }

  // ---- ripples -------------------------------------------------------------

  private computeRipples(proposal: Proposal, files?: CommitFileInput[]): RipplePreview {
    const items: RippleItem[] = [];
    const index = this.store.getIndex();
    const bundle = this.store.getBundle();
    if (proposal.kind === "art-direction") {
      const reach = bundle.artDirection.reach;
      const pinnedByThisChange = reach.earlierAcceptedTakes + (reach.acceptedTakesAtCurrentVersion ?? 0);
      items.push(
        {
          kind: "visual-assets-keep-look",
          summary: `${reach.visualAssets} visual assets stay as they are; new work sees the next look`,
          targets: Array.from({ length: reach.visualAssets }, (_, index) => `visual-asset-${index + 1}`),
        },
        {
          kind: "reference-kits-see-new-look",
          summary: `${reach.referenceKits} reference kits see a newer world look`,
          targets: bundle.referenceKits.filter((kit) => !kit.styleOverride?.trim()).map((kit) => kit.sheetId),
        },
        {
          kind: "productions-inherit-look",
          summary: `${reach.productions} productions inherit the next look on dispatch`,
          targets: bundle.productions
            .filter((production) => !production.meta.styleOverride?.trim())
            .map((production) => production.meta.id),
        },
        {
          kind: "takes-pinned-to-old-version",
          /*
           * Everything already behind, plus everything made under the look this replaces.
           *
           * Counting only what was already old described the consequence of the *previous*
           * change: the takes made since — often all of them, and the ones the person is
           * actually thinking of — became pinned the moment this landed and were not in the
           * number they were shown before accepting.
           */
          summary: `${pinnedByThisChange} accepted takes remain pinned to their original look`,
          targets: Array.from({ length: pinnedByThisChange }, (_, index) => `accepted-take-${index + 1}`),
        },
      );
      if (bundle.artDirection.overrides.length > 0) {
        items.push({
          kind: "overrides-keep-own-look",
          summary: `${bundle.artDirection.overrides.length} overrides keep their own look`,
          targets: bundle.artDirection.overrides.map((override) => override.id),
        });
      }
      return { computedAt: this.store.now(), governing: false, items };
    }
    if (index) {
      for (const target of proposal.targets) {
        const kind = classify(target.path);
        if (kind.track === "sheet") {
          const sheet = bundle.sheets.find((s) => s.id === kind.id);
          const newVersion = (sheet?.version ?? target.baseVersion ?? 0) + 1;
          items.push(
            ...ripplesForSheet(index.db, {
              sheetId: kind.id,
              sheetName: sheet?.name ?? kind.id,
              newVersion,
            }),
          );
        } else if (kind.track === "canon") {
          const proposedRaw = files?.find((f) => f.path === target.path)?.content;
          const parsed = proposedRaw ? tryParseCanon(proposedRaw) : null;
          const entry = bundle.canon.find((c) => c.id === kind.id);
          items.push(
            ...ripplesForCanonEntry(index.db, {
              entryId: kind.id,
              title: parsed?.title ?? entry?.title ?? kind.id,
              statement: parsed?.body ?? entry?.body ?? "",
            }),
          );
        }
      }
    }
    return { computedAt: this.store.now(), governing: false, items };
  }

  /** Re-derive the advisory preview from the proposal files as they now stand (SPEC-005). */
  async refreshPreviewFor(proposalId: string): Promise<void> {
    await this.store.gateOp(async () => {
      const proposal = await this.readManifest(proposalId);
      await this.refreshPreview(proposal);
    });
  }

  private async refreshPreview(proposal: Proposal): Promise<void> {
    const files: CommitFileInput[] = [];
    for (const target of proposal.targets) {
      const content = await this.readProposalFile(proposal.id, target.path);
      if (content !== null) {
        files.push({ path: target.path, action: "replace", content, baseHash: target.baseHash });
      }
    }
    await this.writePreview(proposal.id, this.computeRipples(proposal, files));
  }

  // ---- manifest and preview io --------------------------------------------

  private async writeManifest(proposal: Proposal): Promise<void> {
    await mkdir(toExtendedLength(this.proposalDir(proposal.id)), { recursive: true });
    await atomicWriteFile(
      join(this.proposalDir(proposal.id), "proposal.json"),
      JSON.stringify(ProposalSchema.parse(proposal), null, 2) + "\n",
    );
  }

  async readManifest(proposalId: string): Promise<Proposal> {
    const raw = await readFile(toExtendedLength(join(this.proposalDir(proposalId), "proposal.json")), "utf8");
    return ProposalSchema.parse(JSON.parse(raw));
  }

  /** The authority-owned preview used by conversation cards; no staged payload crosses with it. */
  async project(proposalId: string): Promise<{ proposal: Proposal; review: ReviewProjection; ripple: RipplePreview | null }> {
    const proposal = await this.readManifest(proposalId);
    const proposed = new Map<string, string | null>();
    const base = new Map<string, string | null>();
    for (const target of proposal.targets) {
      proposed.set(target.path, await this.readProposalFile(proposalId, target.path));
      base.set(target.path, await this.readProposalFile(proposalId, `_base/${target.path}`));
    }
    return {
      proposal,
      review: projectReview({
        proposal,
        proposed: (path) => proposed.get(path) ?? null,
        base: (path) => base.get(path) ?? null,
      }),
      ripple: await this.readPreview(proposalId),
    };
  }

  /** Read-only preflight. `accept` repeats these fences under the gate immediately before write. */
  async validatePending(proposalId: string, expectedDraftRevision: number): Promise<{ ok: true } | { ok: false; stale: boolean; detail: string }> {
    const proposal = await this.readManifest(proposalId);
    if (proposal.draftRevision !== expectedDraftRevision) {
      return { ok: false, stale: true, detail: "The proposal changed after this card was prepared." };
    }
    if ((proposal.openChoices ?? []).length > 0) {
      return { ok: false, stale: false, detail: "This proposal still has an open choice." };
    }
    if (proposal.pendingReview) {
      return { ok: false, stale: false, detail: "This proposal must be reviewed again after its rebase." };
    }
    if ((proposal.conflicts ?? []).some((conflict) => conflict.resolution === undefined)) {
      return { ok: false, stale: false, detail: "This proposal still has an unresolved conflict." };
    }
    for (const target of proposal.targets) {
      const live = await this.readLive(target.path);
      if (live !== null && isRetired(target.path, live)) {
        return { ok: false, stale: true, detail: "A target of this proposal has been retired." };
      }
      const found = live === null ? null : sha256(live);
      if (target.baseHash === null ? live === null : found === target.baseHash) continue;
      const proposed = await this.readProposalFile(proposalId, target.path);
      if (proposed !== null && live !== null && !changesAnything(target.path, live, proposed)) continue;
      return { ok: false, stale: true, detail: "The world changed after this proposal was prepared." };
    }
    return { ok: true };
  }

  private async writePreview(proposalId: string, preview: RipplePreview): Promise<void> {
    await atomicWriteFile(
      join(this.proposalDir(proposalId), "ripple.json"),
      JSON.stringify(RipplePreviewSchema.parse(preview), null, 2) + "\n",
    );
  }

  private async readPreview(proposalId: string): Promise<RipplePreview | null> {
    try {
      const raw = await readFile(toExtendedLength(join(this.proposalDir(proposalId), "ripple.json")), "utf8");
      return RipplePreviewSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** Restart recovery (§2.11): validate manifests; report proposals whose target retired. */
  /**
   * Whether one proposal is still staged, or a throw when that cannot be read.
   *
   * `listOpen` is the wrong instrument for this question: it swallows a failure to read
   * `.proposals` and returns an empty list, so "nothing is there" and "I could not look" arrive
   * as the same answer. That is fine for painting a screen and wrong for a caller deciding
   * whether a proposal it failed to discard is still standing — the filesystem trouble that made
   * the discard fail is exactly what would make the listing fail too, and it would report the
   * proposal gone at the moment it certainly is not.
   */
  async isStaged(proposalId: string): Promise<boolean> {
    try {
      await stat(toExtendedLength(this.proposalDir(proposalId)));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async listOpen(): Promise<Proposal[]> {
    const out: Proposal[] = [];
    let entries: string[] = [];
    try {
      entries = await readdir(toExtendedLength(this.abs(PROPOSALS_DIR)));
    } catch {
      return out;
    }
    for (const id of entries) {
      // A proposal whose change has landed is over, whatever is still on disk: its directory
      // may have survived a busy handle, and listing it again would offer a decision that was
      // already made — and answer "stale" to anyone who took it.
      if (await this.isSettled(id)) {
        void this.sweepSettled(id);
        continue;
      }
      try {
        out.push(await this.readManifest(id));
      } catch {
        /* unreadable manifest → not listed; discard-only via UI */
      }
    }
    return out;
  }

  private async isSettled(id: string): Promise<boolean> {
    try {
      await stat(toExtendedLength(join(this.proposalDir(id), SETTLED_FILE)));
      return true;
    } catch {
      return false;
    }
  }
}

function readVersion(path: string, raw: string): number | null {
  const kind = classify(path);
  try {
    if (kind.track === "sheet" || kind.track === "chapter") {
      return ((MarkdownFile.parse(raw).data["version"] as number | undefined) ?? 1);
    }
    if (kind.track === "canon") {
      const data = MarkdownFile.parse(raw).data;
      return Math.max(
        (data["introducedAt"] as number | undefined) ?? 0,
        (data["settledAt"] as number | undefined) ?? 0,
        (data["amendedAt"] as number | undefined) ?? 0,
      );
    }
    if (
      kind.track === "scene" ||
      kind.track === "story" ||
      kind.track === "routing" ||
      kind.track === "season" ||
      kind.track === "episode" ||
      kind.track === "series"
    ) {
      return ((JSON.parse(raw) as { version?: number }).version ?? 1);
    }
    if (kind.track === "art-direction") return ArtDirectionRecordSchema.parse(JSON.parse(raw)).version;
  } catch {
    return null;
  }
  return null;
}

/** A sheet's `role` frontmatter, or null when absent or the file will not parse. */
function roleOf(raw: string): string | null {
  try {
    const role = MarkdownFile.parse(raw).data["role"];
    return typeof role === "string" ? role.trim() : null;
  } catch {
    return null;
  }
}

function isRetired(path: string, raw: string): boolean {
  const kind = classify(path);
  if (kind.track !== "sheet" && kind.track !== "canon") return false;
  try {
    return MarkdownFile.parse(raw).data["retired"] === true;
  } catch {
    return false;
  }
}

/** Whether a file on disk can still be read as a world look. */
function parsesAsLook(raw: string): boolean {
  try {
    ArtDirectionRecordSchema.parse(JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
}

/**
 * The world's resolved look as a record, for the case where no file holds it.
 *
 * A world without an explicit art-direction file still has a look, derived from its tone and
 * genre. `ResolvedArtDirection` carries everything the record needs plus reach and overrides,
 * which are computed rather than stored — so this is the narrowing, not a new fact.
 */
function currentLookRecord(resolved: {
  version: number;
  description: string;
  masterLook?: string;
  keyArtIntent?: KeyArtIntent | null;
  acceptedAt?: string;
  audio: AudioPolicy;
  failureModes: readonly string[];
  history: ReadonlyArray<{ version: number; description: string; masterLook?: string; keyArtIntent?: KeyArtIntent | null; acceptedAt: string; audio: AudioPolicy; failureModes: readonly string[] }>;
}): unknown {
  return {
    version: resolved.version,
    description: resolved.description,
    ...(resolved.masterLook ? { masterLook: resolved.masterLook } : {}),
    ...(resolved.keyArtIntent !== undefined ? { keyArtIntent: resolved.keyArtIntent } : {}),
    acceptedAt: resolved.acceptedAt ?? new Date(0).toISOString(),
    audio: resolved.audio,
    failureModes: resolved.failureModes,
    history: resolved.history,
  };
}

/**
 * The proposed look, stated against the version that is current now.
 *
 * Keeps what the proposal is actually for — its description and master look — and takes
 * everything positional from the live record: the version it now follows, and a history with the
 * live version appended, so accepted takes still resolve against the look they were made under.
 *
 * Null when either side will not parse. That is a real conflict rather than something to paper
 * over: writing a guess here would put an unreadable look behind an Accept button.
 */
function restateArtDirection(mine: string, live: string, base: string | null, now: string): string | null {
  try {
    const proposed = ArtDirectionRecordSchema.parse(JSON.parse(mine));
    const current = ArtDirectionRecordSchema.parse(JSON.parse(live));
    /*
     * Did this proposal actually edit the policy, or only inherit it? (#244, Codex round 2.)
     *
     * Staging copies the then-current policy into the staged record, so by the time a rebase
     * reads `mine` the difference between "changed it" and "carried it" has been serialized
     * away. Taking `mine`'s policy unconditionally meant a description-only proposal, rebased
     * over someone else's policy change, wrote the stale inherited values back — a concurrent
     * edit erased by a proposal that never touched the field. The staged base snapshot still
     * knows what the proposal saw, so intent is recovered by comparison: differs from base
     * means edited, equals base means inherited, and inherited fields take the live values.
     * A proposal staged as a create has no base; there the comparison is against the defaults
     * staging would have copied.
     */
    const saw = base !== null ? ArtDirectionRecordSchema.parse(JSON.parse(base)) : null;
    const sawAudio = saw?.audio ?? DEFAULT_AUDIO_POLICY;
    const sawModes = saw?.failureModes ?? [];
    const sawKeyArt = saw?.keyArtIntent;
    const editedAudio = JSON.stringify(proposed.audio) !== JSON.stringify(sawAudio);
    const editedModes = JSON.stringify(proposed.failureModes) !== JSON.stringify(sawModes);
    const editedKeyArt = JSON.stringify(proposed.keyArtIntent) !== JSON.stringify(sawKeyArt);
    const rebased = ArtDirectionRecordSchema.parse({
      version: current.version + 1,
      description: proposed.description,
      ...(proposed.masterLook ? { masterLook: proposed.masterLook } : {}),
      ...((editedKeyArt ? proposed.keyArtIntent : current.keyArtIntent) !== undefined
        ? { keyArtIntent: editedKeyArt ? proposed.keyArtIntent : current.keyArtIntent }
        : {}),
      acceptedAt: now,
      audio: editedAudio ? proposed.audio : current.audio,
      failureModes: editedModes ? proposed.failureModes : current.failureModes,
      history: [
        ...current.history,
        {
          version: current.version,
          description: current.description,
          ...(current.masterLook ? { masterLook: current.masterLook } : {}),
          ...(current.keyArtIntent !== undefined ? { keyArtIntent: current.keyArtIntent } : {}),
          acceptedAt: current.acceptedAt,
          audio: current.audio,
          failureModes: current.failureModes,
        },
      ],
    });
    return `${JSON.stringify(rebased, null, 2)}\n`;
  } catch {
    return null;
  }
}

function tryParseCanon(raw: string): { title: string; body: string } | null {
  try {
    const doc = MarkdownFile.parse(raw);
    return { title: String(doc.data["title"] ?? ""), body: doc.body };
  } catch {
    return null;
  }
}
