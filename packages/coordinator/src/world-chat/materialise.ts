import {
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
  CanonIdSchema,
  CanonEntrySchema,
  editShot,
  EpisodeSchema,
  GraphSceneSchema,
  insertShot,
  isGraphScene,
  migrateLegacyScene,
  nextShotIdIn,
  SeasonSchema,
  SeriesSchema,
  SheetSchema,
  StoryOverviewSchema,
  orderedShots,
  type GraphScene,
  type SceneRecord,
  type Sheet,
  type Shot,
  type WorldBundle,
  type WorldChangeCandidate,
  WorldChangeCandidateSchema,
  type WorldChatLinkRef,
} from "@arke-studio/contracts";
import { ZodError } from "zod";
import { entryContent } from "../canon/authoring.js";
import { buildSheetContent, editSheetContent } from "../sheets/authoring.js";
import { slugify, uniqueSlug } from "../world/slug.js";
import { MarkdownFile } from "../world/text-files.js";

/**
 * Turning a proposition into the files a proposal is made of (#70 §11.2).
 *
 * The coordinator writes every one of them. The model never serialises anything authoritative,
 * and this is where that promise is kept: it proposed a title and a statement, and the frontmatter,
 * the id, the version, the section order and the file's shape are all decided here.
 *
 * Everything is parsed through its own domain schema before a single file is written. A malformed
 * candidate has to fail wrap-up without leaving a proposal directory behind, because a directory
 * that exists but cannot be accepted is worse than no directory: it sits on the approvals screen
 * asking for a decision nobody can make.
 */

export class MaterialiseError extends Error {
  constructor(
    readonly candidateId: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "MaterialiseError";
  }
}

export interface Identities {
  /** Canon ids reserved for this wrap-up, in the order its creates were planned. */
  canonIds: string[];
  /** Slugs chosen for new sheets, keyed by the candidate that creates them. */
  slugBy: Map<string, string>;
  /**
   * Canon ids chosen for new entries, keyed by the candidate that creates them.
   *
   * The same shape as `slugBy`, and for the same reason. These used to be handed out positionally
   * as materialise walked the set, which meant nothing could name an entry before it was reached —
   * so a sheet asking to be governed by a rule written in the same breath had no id to point at.
   * Planned together, the graph between propositions can be resolved before any file exists.
   */
  canonIdBy: Map<string, string>;
}

export interface MaterialisedTarget {
  path: string;
  content: string;
}

export interface Materialised {
  candidate: WorldChangeCandidate;
  targets: MaterialisedTarget[];
  /** Which fields this proposition actually changes, for the origin record. */
  fields: string[];
  reservedCanonIds: string[];
}

export interface ChoiceMaterialised extends Materialised {
  action: "create" | "amend";
}

/** Rebuild a questioned Canon create as the create or canonical amendment the person selected. */
export function materialiseDuplicateChoice(
  candidate: WorldChangeCandidate,
  optionId: string,
  reservedCanonId: string,
  bundle: WorldBundle,
  at: string,
): ChoiceMaterialised {
  if (candidate.classification !== "canon.create") {
    throw new MaterialiseError(candidate.id, "this question no longer belongs to a new Canon rule");
  }
  if (optionId === "create") {
    const id = CanonIdSchema.parse(reservedCanonId);
    const built = materialiseCandidate(
      candidate,
      { canonIds: [id], slugBy: new Map(), canonIdBy: new Map([[candidate.id, id]]) },
      bundle,
      at,
    );
    return { ...built, action: "create" };
  }

  const match = /^amend:(CANON-[0-9]+)$/.exec(optionId);
  if (!match) throw new MaterialiseError(candidate.id, "that answer cannot be turned into a Canon change");
  const entryId = CanonIdSchema.parse(match[1]);
  if (!candidate.checks.likelyDuplicates.some((ref) => ref.kind === "canon" && ref.entryId === entryId)) {
    throw new MaterialiseError(candidate.id, `${entryId} was not one of this question's Canon matches`);
  }
  const amendment = WorldChangeCandidateSchema.parse({
    ...candidate,
    classification: "canon.amend",
    target: { kind: "canon", entryId },
  });
  return { ...materialiseCandidate(amendment, { canonIds: [], slugBy: new Map(), canonIdBy: new Map() }, bundle, at), action: "amend" };
}

/**
 * Choose the identities a wrap-up needs, all at once (§11.3 step 3).
 *
 * Together rather than one at a time because two new entities in the same wrap-up may refer to
 * each other: the graph can only be resolved once every name in it exists.
 */
export function planIdentities(
  carried: readonly WorldChangeCandidate[],
  reservedCanonIds: readonly string[],
  bundle: WorldBundle,
): Identities {
  const canonIds = [...reservedCanonIds];
  const slugBy = new Map<string, string>();
  const canonIdBy = new Map<string, string>();
  const taken = bundle.sheets.map((s) => s.id);

  for (const candidate of carried) {
    if (candidate.classification !== "sheet.create") continue;
    const draft = candidate.draft as { type: Sheet["type"]; name: string };
    // Uniqueness is checked against slugs chosen earlier in this same wrap-up as well as those
    // on disk: two new characters with similar names must not collide on one file.
    const slug = uniqueSlug(draft.name, draft.type, [...taken, ...slugBy.values()]);
    slugBy.set(candidate.id, slug);
    taken.push(slug);
  }
  /*
   * Reserved ids handed to the entries that will carry them, in the order `canonIdsNeeded` counted.
   *
   * The two must walk the same set the same way or an entry is written under an id nothing
   * reserved — so both filter on exactly this pair of classifications, and this is the only place
   * the order is decided.
   */
  let next = 0;
  for (const candidate of carried) {
    if (candidate.classification !== "canon.create" && candidate.classification !== "canon.thread") continue;
    const id = canonIds[next++];
    if (id) canonIdBy.set(candidate.id, id);
  }
  return { canonIds, slugBy, canonIdBy };
}

/** How many Canon ids this wrap-up must reserve before it can write anything. */
export function canonIdsNeeded(carried: readonly WorldChangeCandidate[]): number {
  return carried.filter(
    (c) => c.classification === "canon.create" || c.classification === "canon.thread",
  ).length;
}

function requireEntry(bundle: WorldBundle, entryId: string, candidateId: string) {
  const entry = bundle.canon.find((c) => c.id === entryId);
  if (!entry) throw new MaterialiseError(candidateId, `canon entry ${entryId} is not in this world`);
  return entry;
}

function requireSheet(bundle: WorldBundle, sheetId: string, candidateId: string): Sheet {
  const sheet = bundle.sheets.find((s) => s.id === sheetId);
  if (!sheet) throw new MaterialiseError(candidateId, `sheet ${sheetId} is not in this world`);
  return sheet;
}

/** World Chat writes only graph scenes, migrating a legacy record at the read boundary. */
function graphSceneAtBoundary(record: SceneRecord): GraphScene {
  return isGraphScene(record) ? record : migrateLegacyScene(record);
}

/** Parse what was built through the schema the world reads it with, before it is written. */
function validateCanon(candidateId: string, content: string, id: string): void {
  try {
    const doc = MarkdownFile.parse(content);
    CanonEntrySchema.parse({ ...doc.data, body: doc.body.trim() });
  } catch (err) {
    throw new MaterialiseError(candidateId, `${id} would not read back: ${detailOf(err)}`);
  }
}

function detailOf(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
      .join("; ")
      .slice(0, 300);
  }
  return err instanceof Error ? err.message.slice(0, 300) : "unreadable";
}

/**
 * The references a draft asks for, as the two frontmatter fields a sheet has to hold them (§2.3.2).
 *
 * These used to be dropped: every sheet a conversation wrote came out with `canonRules: []` and
 * `links: []`, so "he is bound by the maintenance-hand rule" was heard, answered, and then not
 * written down anywhere. Resolved here instead, against the world and against the propositions
 * this same wrap-up is about to create.
 *
 * A reference that resolves to nothing throws rather than being quietly left out, following the
 * two `require*` calls above it: a sheet naming a rule that does not exist is a broken edge in the
 * citation graph, and writing one is worse than saying the sentence could not be written.
 */
function resolveReferences(
  candidate: WorldChangeCandidate,
  draft: Record<string, unknown>,
  identities: Identities,
  bundle: WorldBundle,
  /** The sheet being written, so it cannot end up linking to itself. */
  selfId: string | undefined,
): { canonRules: string[]; links: string[] } {
  const canonRules = new Set<string>();
  const links = new Set<string>();

  for (const id of (draft["canonRules"] as string[] | undefined) ?? []) {
    requireEntry(bundle, id, candidate.id);
    canonRules.add(id);
  }

  for (const ref of (draft["links"] as WorldChatLinkRef[] | undefined) ?? []) {
    if (ref.kind === "canon") {
      /*
       * A sheet has exactly one field for canon and this is it.
       *
       * `links` holds sheet slugs alone, so a canon reference arriving as a link has nowhere else
       * to go — and the link union admits one, so it is a shape the model is invited to produce.
       * Folded rather than dropped, and deduplicated against `canonRules` by the set.
       */
      requireEntry(bundle, ref.entryId, candidate.id);
      canonRules.add(ref.entryId);
      continue;
    }
    if (ref.kind === "sheet") {
      requireSheet(bundle, ref.sheetId, candidate.id);
      links.add(ref.sheetId);
      continue;
    }
    /*
     * Another proposition in this same wrap-up.
     *
     * Its slug — or its canon id — was chosen before any file was written, which is exactly what
     * planning identities together is for: two new entities may refer to each other, and the graph
     * can only be resolved once every name in it exists.
     */
    const slug = identities.slugBy.get(ref.ref.candidateId);
    if (slug) {
      links.add(slug);
      continue;
    }
    const canonId = identities.canonIdBy.get(ref.ref.candidateId);
    if (canonId) {
      canonRules.add(canonId);
      continue;
    }
    throw new MaterialiseError(
      candidate.id,
      "it refers to something that is not being created alongside it",
    );
  }

  links.delete(selfId ?? "");
  return { canonRules: [...canonRules], links: [...links] };
}

/**
 * What a Development amendment would make of the record it names (SPEC-023 R-20).
 *
 * The merge, in one place, because two places is how it goes wrong. Readiness has to know whether
 * an amendment would change anything — a draft restating what the record already says is a
 * proposition that reports success and writes nothing — and the only honest way to answer that is
 * to perform the same merge the file is built from. Written out a second time it would drift, and
 * the first casualty would be the arcs rule below: a readiness check that merged arcs wholesale
 * would call a real change empty and hold back work somebody asked for.
 *
 * `live` is the record as the world has it and `next` is that record with the draft merged onto
 * it — the two values a caller compares, and the one a file is written from. Null means there is
 * nothing to amend: a creation (a new episode, a new shot), or a target this world does not hold,
 * both of which the caller already handles.
 */
export function developmentAmendment(
  candidate: WorldChangeCandidate,
  bundle: WorldBundle,
): { live: Record<string, unknown>; next: Record<string, unknown> } | null {
  if (!candidate.classification.startsWith("development.")) return null;
  const target = (candidate as unknown as { target: Record<string, unknown> }).target;
  const draft = candidate.draft as Record<string, unknown>;
  const production = bundle.productions.find((p) => p.meta.id === target["productionId"]);

  switch (candidate.classification) {
    case "development.overview": {
      if (!production) return null;
      // A production with no story.json still has a record to merge onto: version 1, empty. Every
      // field the draft carries is then new, which is exactly right — writing it is a change.
      const live = (production.story ?? { version: 1 }) as Record<string, unknown>;
      return { live, next: { ...live, ...draft } };
    }
    case "development.season": {
      if (!production) return null;
      const live = (production.season ?? { version: 1 }) as Record<string, unknown>;
      // Arcs merge by id, not wholesale (issue #397 round 2): a conversational draft restating an
      // arc's note must not silently delete the setup/turn/payoff placements the board authored —
      // a lane the draft does not mention is a lane it did not change.
      const liveArcs = (live["arcs"] as Array<{ id: string }> | undefined) ?? [];
      const draftArcs = draft["arcs"] as Array<{ id: string }> | undefined;
      const mergedArcs = draftArcs?.map((arc) => ({ ...liveArcs.find((e) => e.id === arc.id), ...arc }));
      return {
        live,
        next: { ...live, ...draft, ...(mergedArcs !== undefined ? { arcs: mergedArcs } : {}) },
      };
    }
    case "development.episode": {
      const episodeId = target["episodeId"];
      if (!production || episodeId === undefined) return null; // absent episodeId creates
      const live = production.episodes.find((e) => e.id === episodeId) as Record<string, unknown> | undefined;
      return live ? { live, next: { ...live, ...draft } } : null;
    }
    case "development.scene-script": {
      const record = production?.scenes.find((scene) => scene.id === target["sceneId"]);
      if (!record) return null;
      const scene = graphSceneAtBoundary(record) as unknown as Record<string, unknown>;
      return { live: scene, next: { ...scene, script: { blocks: draft["blocks"] } } };
    }
    case "development.shot": {
      // A shot has no file of its own, so the record being amended is the whole scene with one
      // shot changed inside it — and an amendment is a patch: every field the draft omits is left
      // exactly as the shot has it, including the ones a conversation may not touch at all.
      const record = production?.scenes.find((scene) => scene.id === target["sceneId"]);
      const shotId = target["shotId"];
      if (!record || typeof shotId !== "string") return null; // absent shotId adds a shot
      if (!orderedShots(record).some((shot) => shot.id === shotId)) return null;
      return {
        live: graphSceneAtBoundary(record) as unknown as Record<string, unknown>,
        next: editShot(record, { shotId, change: candidate.draft }) as unknown as Record<string, unknown>,
      };
    }
    case "development.series": {
      const live = bundle.series.find((s) => s.id === target["seriesId"]) as Record<string, unknown> | undefined;
      return live ? { live, next: { ...live, ...draft } } : null;
    }
    default:
      return null;
  }
}

/**
 * The same merge, where the caller has already proved the target is there.
 *
 * Every use inside `materialiseCandidate` sits behind its own lookup and its own worded refusal —
 * "episode X is not in Y", "shot X is not in scene Y" — which say far more than a null would. This
 * turns the shared merge back into a value for those paths without weakening any of them.
 */
function requireAmendment(
  candidate: WorldChangeCandidate,
  bundle: WorldBundle,
): { live: Record<string, unknown>; next: Record<string, unknown> } {
  const amendment = developmentAmendment(candidate, bundle);
  if (!amendment) throw new MaterialiseError(candidate.id, `${candidate.classification} has nothing to amend`);
  return amendment;
}

export function materialiseCandidate(
  candidate: WorldChangeCandidate,
  identities: Identities,
  bundle: WorldBundle,
  /** The whole instant, not the day: the world-look record stamps a full timestamp. */
  at: string,
  /**
   * Identities already claimed by SIBLING candidates in this same wrap-up (issue #400 round 2):
   * the scanned bundle cannot see them, so two new episodes in one batch would otherwise take
   * one stem and one order between them.
   */
  claimed?: {
    episodeIds: Set<string>;
    episodeStems: Set<string>;
    episodeOrders: Set<number>;
    /** New shot ids, so two shots added to one scene in one wrap-up do not share an id. */
    shotIds: Set<string>;
  },
): Materialised {
  /** The id planned for this entry, so nothing depends on the order materialise is walked in. */
  const nextCanonId = (): string => {
    const id = identities.canonIdBy.get(candidate.id);
    if (!id) throw new MaterialiseError(candidate.id, "no canon id was reserved for this entry");
    return id;
  };
  const draft = candidate.draft as Record<string, unknown>;
  const date = at.slice(0, 10);

  switch (candidate.classification) {
    case "canon.create": {
      const id = nextCanonId();
      const content = entryContent({
        id,
        type: String(draft["type"]),
        title: String(draft["title"]),
        status: "settled",
        statement: String(draft["statement"]),
      });
      validateCanon(candidate.id, content, id);
      return {
        candidate,
        targets: [{ path: `canon/${id}.md`, content }],
        fields: ["title", "statement"],
        reservedCanonIds: [id],
      };
    }

    case "canon.thread": {
      const id = nextCanonId();
      // A thread asserts nothing, so it is created open rather than settled: retrieving one would
      // answer a question with the same question.
      const content = entryContent({
        id,
        type: "thread",
        title: String(draft["title"]),
        status: "open",
        statement: String(draft["question"]),
      });
      validateCanon(candidate.id, content, id);
      return {
        candidate,
        targets: [{ path: `canon/${id}.md`, content }],
        fields: ["question"],
        reservedCanonIds: [id],
      };
    }

    case "canon.amend": {
      const target = (candidate as unknown as { target: { entryId: string } }).target;
      const entry = requireEntry(bundle, target.entryId, candidate.id);
      const content = entryContent({
        id: entry.id,
        type: String(draft["type"] ?? entry.type),
        title: String(draft["title"] ?? entry.title),
        // Only a thread stays open; anything else an amendment produces asserts something, so it
        // is settled. A `proposed` entry being amended becomes the settled form of itself rather
        // than carrying a status the entry writer has no way to express.
        status: entry.status === "open" ? "open" : "settled",
        statement: String(draft["statement"] ?? entry.body),
      });
      validateCanon(candidate.id, content, entry.id);
      return {
        candidate,
        targets: [{ path: `canon/${entry.id}.md`, content }],
        fields: Object.keys(draft),
        reservedCanonIds: [],
      };
    }

    case "sheet.create": {
      const slug = identities.slugBy.get(candidate.id);
      if (!slug) throw new MaterialiseError(candidate.id, "no slug was planned for this new sheet");
      const sections: Record<string, string> = {};
      for (const section of (draft["sections"] as Array<{ heading: string; body: string }>) ?? []) {
        sections[section.heading] = section.body;
      }
      const refs = resolveReferences(candidate, draft, identities, bundle, slug);
      const content = buildSheetContent({
        id: slug,
        type: draft["type"] as Sheet["type"],
        name: String(draft["name"]),
        // New entities arrive as sketches, never locked: what a conversation produced is an
        // invitation to work on it, not a finished thing.
        status: "sketch",
        sections,
        date,
        canonRules: refs.canonRules,
        links: refs.links,
        ...(draft["role"] !== undefined ? { extra: { role: draft["role"] } } : {}),
      });
      assertSheetParses(candidate.id, content, draft["type"] as Sheet["type"]);
      return {
        candidate,
        targets: [{ path: `${folderFor(draft["type"] as Sheet["type"])}/${slug}.md`, content }],
        fields: ["name", ...Object.keys(sections)],
        reservedCanonIds: [],
      };
    }

    case "sheet.edit": {
      const target = (candidate as unknown as { target: { sheetId: string; sheetKind: Sheet["type"] } }).target;
      const sheet = requireSheet(bundle, target.sheetId, candidate.id);
      const sections: Record<string, string> = {};
      for (const section of sheet.sections) sections[section.heading] = section.body;
      for (const section of (draft["sections"] as Array<{ heading: string; body: string }>) ?? []) {
        sections[section.heading] = section.body;
      }
      /*
       * An edit changes what it names and carries everything else (SPEC-007 §2.3.2).
       *
       * `canonRules` and `links` are carried rather than taken from the draft: a draft's links are
       * refs, including refs to entities this same wrap-up is still planning slugs for, and
       * resolving those is a piece of work this does not do yet. Carrying them is the honest half
       * — the sheet keeps the references it had, and a conversation simply cannot change them.
       */
      const names = draft["canonRules"] !== undefined || draft["links"] !== undefined;
      const refs = names ? resolveReferences(candidate, draft, identities, bundle, sheet.id) : null;
      const content = editSheetContent({
        sheet,
        ...(refs ? { canonRules: refs.canonRules, links: refs.links } : {}),
        ...(draft["name"] !== undefined ? { name: String(draft["name"]) } : {}),
        sections,
        ...(draft["role"] !== undefined ? { role: draft["role"] as string | null } : {}),
        ...(draft["billing"] !== undefined ? { billing: draft["billing"] as string | null } : {}),
        ...(draft["region"] !== undefined ? { region: draft["region"] as string | null } : {}),
        date,
      });
      assertSheetParses(candidate.id, content, sheet.type);
      return {
        candidate,
        targets: [{ path: `${folderFor(sheet.type)}/${sheet.id}.md`, content }],
        fields: Object.keys(draft),
        reservedCanonIds: [],
      };
    }

    case "relationship.change": {
      // The minimum necessary target: a one-sided link changes one sheet, and changing both
      // would put an edit in front of somebody for a file they did not agree to touch.
      const edits = (draft["proseEdits"] as Array<{ sheet: { sheetId?: string }; sectionHeading: string; body: string }>) ?? [];
      const targets: MaterialisedTarget[] = [];
      const fields: string[] = [];
      for (const edit of edits) {
        const sheetId = edit.sheet.sheetId;
        if (!sheetId) continue;
        const sheet = requireSheet(bundle, sheetId, candidate.id);
        const sections: Record<string, string> = {};
        for (const section of sheet.sections) sections[section.heading] = section.body;
        sections[edit.sectionHeading] = edit.body;
        // One section changes; the rest of the sheet is not this proposition's business.
        const content = editSheetContent({ sheet, sections, date });
        assertSheetParses(candidate.id, content, sheet.type);
        targets.push({ path: `${folderFor(sheet.type)}/${sheet.id}.md`, content });
        fields.push(edit.sectionHeading);
      }
      if (targets.length === 0) {
        throw new MaterialiseError(candidate.id, "this relationship change would edit no file");
      }
      return { candidate, targets, fields, reservedCanonIds: [] };
    }

    case "art-direction.change": {
      /*
       * The next world look, written whole.
       *
       * The same record `stageArtDirectionChange` builds from the form, because there is only one
       * world look and two ways of writing it would drift. The previous version is pushed onto
       * history rather than discarded — accepted takes stay pinned to the look they were made
       * under, and the history is how they still resolve.
       *
       * `masterLook` is dropped rather than carried: it is an image of the look being replaced,
       * and holding it against a new description would misdescribe every generation that read it.
       */
      const current = bundle.artDirection;
      const record = ArtDirectionRecordSchema.parse({
        version: current.version + 1,
        description: String(draft["description"]).trim(),
        acceptedAt: at,
        // The fourth place that rebuilds this record (#244), and the one talking about the look
        // in a chat rather than on a form. A conversation that never mentioned music must not
        // decide anything about it: the standing constraints are carried unchanged, and the
        // outgoing ones go to history with the version they belonged to.
        audio: current.audio,
        failureModes: [...current.failureModes],
        history: [
          ...current.history,
          {
            version: current.version,
            description: current.description,
            ...(current.masterLook ? { masterLook: current.masterLook } : {}),
            acceptedAt: current.acceptedAt ?? bundle.meta.created,
            audio: current.audio,
            failureModes: [...current.failureModes],
          },
        ],
      });
      return {
        candidate,
        targets: [{ path: ART_DIRECTION_PATH, content: `${JSON.stringify(record, null, 2)}\n` }],
        fields: ["description"],
        reservedCanonIds: [],
      };
    }

    /*
     * The Development classifications (SPEC-023 R-20, issue #400): each writes its whole JSON
     * record — the draft merged onto what is live — validated against the domain schema before
     * any proposal directory exists, exactly like a malformed sheet. The JSON gate lane owns
     * rebase and conflicts from here.
     */
    case "development.overview": {
      const production = bundle.productions.find((p) => p.meta.id === candidate.target.productionId);
      if (!production) throw new MaterialiseError(candidate.id, `production ${candidate.target.productionId} is not in this world`);
      const content = jsonContent(candidate.id, StoryOverviewSchema, requireAmendment(candidate, bundle).next);
      return {
        candidate,
        targets: [{ path: `productions/${production.meta.id}/story.json`, content }],
        fields: Object.keys(candidate.draft),
        reservedCanonIds: [],
      };
    }

    case "development.season": {
      const production = bundle.productions.find((p) => p.meta.id === candidate.target.productionId);
      if (!production) throw new MaterialiseError(candidate.id, `production ${candidate.target.productionId} is not in this world`);
      const content = jsonContent(candidate.id, SeasonSchema, requireAmendment(candidate, bundle).next);
      return {
        candidate,
        targets: [{ path: `productions/${production.meta.id}/season.json`, content }],
        fields: Object.keys(candidate.draft),
        reservedCanonIds: [],
      };
    }

    case "development.episode": {
      const production = bundle.productions.find((p) => p.meta.id === candidate.target.productionId);
      if (!production) throw new MaterialiseError(candidate.id, `production ${candidate.target.productionId} is not in this world`);
      /*
       * An episode lists scenes that exist (round 3, 2026-08-22). A wrap-up decided "this
       * episode has two scenes" and wrote their guessed ids straight into the membership list —
       * ids nothing had created and nothing ever would, since scene records are made from the
       * episode page, not named into being. The membership is the single order authority
       * (SPEC-023 R-12), so a dangling id there is a scene the board promises and cannot open.
       */
      const draftScenes = candidate.draft.scenes;
      if (draftScenes !== undefined) {
        const missing = draftScenes.filter(
          (id) => !production.scenes.some((s) => s.id === id) && production.sceneFiles[id] === undefined,
        );
        if (missing.length > 0) {
          throw new MaterialiseError(
            candidate.id,
            `the scenes list names ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in ${candidate.target.productionId} — an episode may only list scenes that already exist; leave the list alone and the scenes are made from the episode page`,
          );
        }
      }
      const episodeId = candidate.target.episodeId;
      if (episodeId !== undefined) {
        const live = production.episodes.find((e) => e.id === episodeId);
        const stem = production.episodeFiles[episodeId];
        if (!live || stem === undefined) {
          throw new MaterialiseError(candidate.id, `episode ${episodeId} is not in ${production.meta.id}`);
        }
        const content = jsonContent(candidate.id, EpisodeSchema, requireAmendment(candidate, bundle).next);
        return {
          candidate,
          targets: [{ path: `productions/${production.meta.id}/episodes/${stem}.json`, content }],
          fields: Object.keys(candidate.draft),
          reservedCanonIds: [],
        };
      }
      // Creation: identity is stable at birth — id and stem from the title's slug, deduplicated,
      // never from position (SPEC-023 R-12; the chapters-and-scenes lesson applied from day one).
      const title = candidate.draft.title;
      if (title === undefined) throw new MaterialiseError(candidate.id, "a new episode needs a title");
      const slug = slugify(title).slice(0, 60) || "episode";
      const takenIds = new Set([...production.episodes.map((e) => e.id), ...(claimed?.episodeIds ?? [])]);
      const takenStems = new Set([...Object.values(production.episodeFiles), ...(claimed?.episodeStems ?? [])]);
      let id = `ep_${slug}`;
      let stem = slug;
      for (let n = 2; takenIds.has(id) || takenStems.has(stem); n++) {
        id = `ep_${slug}-${n}`;
        stem = `${slug}-${n}`;
      }
      const takenOrders = new Set([...production.episodes.map((e) => e.order), ...(claimed?.episodeOrders ?? [])]);
      let order = candidate.draft.order ?? production.episodes.length + 1;
      while (candidate.draft.order === undefined && takenOrders.has(order)) order += 1;
      claimed?.episodeIds.add(id);
      claimed?.episodeStems.add(stem);
      claimed?.episodeOrders.add(order);
      const content = jsonContent(candidate.id, EpisodeSchema, {
        id,
        version: 1,
        order,
        title,
        ...(candidate.draft.promise !== undefined ? { promise: candidate.draft.promise } : {}),
        scenes: candidate.draft.scenes ?? [],
      });
      return {
        candidate,
        targets: [{ path: `productions/${production.meta.id}/episodes/${stem}.json`, content }],
        fields: Object.keys(candidate.draft),
        reservedCanonIds: [],
      };
    }

    case "development.scene-script": {
      const production = bundle.productions.find((p) => p.meta.id === candidate.target.productionId);
      if (!production) throw new MaterialiseError(candidate.id, `production ${candidate.target.productionId} is not in this world`);
      const scene = production.scenes.find((s) => s.id === candidate.target.sceneId);
      const stem = production.sceneFiles[candidate.target.sceneId];
      if (!scene || stem === undefined) {
        throw new MaterialiseError(candidate.id, `scene ${candidate.target.sceneId} is not in ${production.meta.id}`);
      }
      const content = jsonContent(candidate.id, GraphSceneSchema, requireAmendment(candidate, bundle).next);
      return {
        candidate,
        targets: [{ path: `productions/${production.meta.id}/scenes/${stem}.json`, content }],
        fields: ["script"],
        reservedCanonIds: [],
      };
    }

    case "development.shot": {
      /*
       * A shot proposal is a scene edit, because a shot has no file of its own — which is also
       * why it can never be materialised from the draft alone: the whole scene has to come back
       * out with one shot changed inside it.
       *
       * An amendment is a patch, not a rewrite. The draft carries only what the conversation
       * settled, and every field it omits is left exactly as the shot has it — including the
       * ones a conversation may not touch at all (id, number, covers, promptOverride). Writing
       * the draft over the shot wholesale would silently clear a hand-tuned prompt because
       * nobody mentioned it.
       */
      const production = bundle.productions.find((p) => p.meta.id === candidate.target.productionId);
      if (!production) throw new MaterialiseError(candidate.id, `production ${candidate.target.productionId} is not in this world`);
      const record = production.scenes.find((s) => s.id === candidate.target.sceneId);
      const stem = production.sceneFiles[candidate.target.sceneId];
      if (!record || stem === undefined) {
        throw new MaterialiseError(candidate.id, `scene ${candidate.target.sceneId} is not in ${production.meta.id}`);
      }
      const existingShots = orderedShots(record);
      const draft = candidate.draft;
      const shotId = candidate.target.shotId;
      let next: GraphScene;
      if (shotId !== undefined) {
        const live = existingShots.find((shot) => shot.id === shotId);
        if (!live) {
          throw new MaterialiseError(
            candidate.id,
            `shot ${shotId} is not in ${candidate.target.sceneId} — name a shot the scene has, or leave shotId out to add one`,
          );
        }
        // Through the shared merge, so the patch semantics above are stated exactly once: what
        // readiness compares against is what this writes.
        next = requireAmendment(candidate, bundle).next as unknown as GraphScene;
      } else {
        // A new shot needs enough to be one. The storyboard already has a button for a blank.
        if (draft.title === undefined || draft.description === undefined) {
          throw new MaterialiseError(
            candidate.id,
            "a new shot needs both a title and a description — amend an existing shot to change one field",
          );
        }
        /*
         * Identity is minted here, never by the model: the id clears every shot in the whole
         * production because takes and selections key by bare shot id. The semantic operation
         * owns the insertion anchor and display numbers, as it does for the storyboard command.
         */
        const claimedIds = claimed?.shotIds ?? new Set<string>();
        const id = nextShotIdIn([
          ...production.scenes.flatMap((scene) => orderedShots(scene).map((shot) => shot.id)),
          ...claimedIds,
        ]);
        claimedIds.add(id);
        const last = existingShots[existingShots.length - 1];
        next = insertShot(record, {
          shot: { ...draft, id, title: draft.title, description: draft.description } as Omit<Shot, "number">,
          at: last === undefined ? { atStart: true } : { after: last.id },
        });
      }
      const content = jsonContent(candidate.id, GraphSceneSchema, next);
      return {
        candidate,
        targets: [{ path: `productions/${production.meta.id}/scenes/${stem}.json`, content }],
        fields: shotId === undefined ? ["flow"] : Object.keys(draft),
        reservedCanonIds: [],
      };
    }

    case "development.series": {
      const live = bundle.series.find((s) => s.id === candidate.target.seriesId);
      if (!live) {
        // A Series is created with its first season, never from a conversation (SPEC-023 R-9).
        throw new MaterialiseError(candidate.id, `series ${candidate.target.seriesId} is not in this world`);
      }
      const content = jsonContent(candidate.id, SeriesSchema, requireAmendment(candidate, bundle).next);
      return {
        candidate,
        targets: [{ path: `series/${live.id}.json`, content }],
        fields: Object.keys(candidate.draft),
        reservedCanonIds: [],
      };
    }

    default:
      // Media opportunities and undecided propositions never reach here — readiness holds them
      // back — and a new classification arriving without a case is a mistake worth failing on.
      throw new MaterialiseError(candidate.id, `${candidate.classification} cannot become a proposal`);
  }
}

/** A whole JSON record, schema-validated before any proposal directory exists. */
function jsonContent(candidateId: string, schema: { parse: (v: unknown) => unknown }, value: unknown): string {
  try {
    return `${JSON.stringify(schema.parse(value), null, 2)}\n`;
  } catch (err) {
    throw new MaterialiseError(candidateId, err instanceof Error ? err.message.slice(0, 300) : "does not satisfy its schema");
  }
}

function folderFor(kind: Sheet["type"]): string {
  return kind === "character" ? "characters" : kind === "location" ? "locations" : "factions";
}

/**
 * Prove the built sheet is one the world can read back.
 *
 * Building content and never parsing it is how a proposal comes to hold a file the scanner will
 * silently drop — the entity would simply be missing after accept, with nothing to point at.
 */
function assertSheetParses(candidateId: string, content: string, type: Sheet["type"]): void {
  try {
    const doc = MarkdownFile.parse(content);
    SheetSchema.parse({ ...doc.data, type, sections: doc.sections() });
  } catch (err) {
    throw new MaterialiseError(candidateId, `the built sheet would not read back: ${detailOf(err)}`);
  }
}
