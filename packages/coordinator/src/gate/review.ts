import { SceneRecordSchema, orderedShots } from "@arke-studio/contracts";
import {
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
  CanonEntrySchema,
  ChapterFrontmatterSchema,
  EpisodeSchema,
  RoutingSchema,
  SeasonSchema,
  SeriesSchema,
  SheetSchema,
  StoryOverviewSchema,
  type Proposal,
} from "@arke-studio/contracts";
import { MarkdownFile } from "../world/text-files.js";

/**
 * What a proposal would actually change, field by field (#70 §11.5).
 *
 * Derived from the captured base and the proposed file, never from what anything said it was
 * changing. That is the whole point: a summary is a claim, and the reason to compute this is so
 * the screen shows what will happen rather than what somebody meant to happen. If the two ever
 * disagree, the files win, because the files are what the accept gate writes.
 *
 * A proposal that lists three targets and a one-line summary tells a reviewer almost nothing. A
 * reviewer needs the sentence that is there now beside the sentence that would replace it, which
 * is what design turn 41b shows and what this produces.
 */

export interface ReviewField {
  field: string;
  before: string | null;
  proposed: string | null;
}

export interface ReviewTarget {
  path: string;
  /** How the reviewer knows what they are looking at: "Maren Kest", "CANON-018". */
  label: string;
  /** "character sheet · v4", "canon entry", "new rule". */
  kind: string;
  action: "create" | "amend";
  fields: ReviewField[];
}

export interface ReviewProjection {
  targets: ReviewTarget[];
}

/** Parse a sheet or canon file into comparable fields, or null when it is neither. */
function fieldsOf(path: string, content: string): { label: string; kind: string; fields: Map<string, string> } | null {
  /*
   * The world look is JSON, and the only proposal target that is not Markdown.
   *
   * Everything below parses frontmatter and would return nothing for it, which the panel renders
   * as an empty review — the summary and the ripples, and not one word of the look being adopted.
   * That is the one thing a reviewer has to read: it can run to four thousand characters and it
   * is what every image is generated from.
   */
  if (path === ART_DIRECTION_PATH) {
    try {
      const record = ArtDirectionRecordSchema.parse(JSON.parse(content));
      const fields = new Map<string, string>([["Look", record.description]]);
      // Named even though it is rarely set: a look that quietly loses its master image would
      // otherwise change every generation with nothing on screen to show for it.
      if (record.masterLook) fields.set("Master look", record.masterLook);
      if ("keyArtIntent" in record) {
        fields.set("Key art intent", record.keyArtIntent ? JSON.stringify(record.keyArtIntent) : "None");
      }
      policyFields(fields, record);
      return { label: `World look v${record.version}`, kind: "art direction", fields };
    } catch {
      return null;
    }
  }

  /*
   * The structured overview is JSON too (issue #385): without this branch a reviewer would be
   * asked to accept a story overview shown as a bare path — not one field of the thing that
   * steers drafting. Every schema field is projected; a malformed file returns null and the
   * accept gate refuses it separately.
   */
  if (/^productions\/[a-z0-9-]+\/scenes\/[^/]+\.json$/.test(path)) {
    try {
      const scene = SceneRecordSchema.parse(JSON.parse(content));
      const fields = new Map<string, string>([["Scene JSON", JSON.stringify(scene, null, 2)]]);
      for (const shot of orderedShots(scene)) {
        if (shot.visualFacts) fields.set(`Shot ${shot.id} · Authored visual facts`, JSON.stringify(shot.visualFacts, null, 2));
        if (shot.promptOverride !== undefined) fields.set(`Shot ${shot.id} · Prompt override`, shot.promptOverride);
      }
      return { label: scene.title, kind: `scene · v${scene.version}`, fields };
    } catch { return null; }
  }
  const storyMatch = /^productions\/[a-z0-9-]+\/story\.json$/.exec(path);
  if (storyMatch) {
    try {
      const overview = StoryOverviewSchema.parse(JSON.parse(content));
      const fields = new Map<string, string>();
      if (overview.logline !== undefined) fields.set("Logline", overview.logline);
      if (overview.spine !== undefined) fields.set("Spine", overview.spine);
      for (const [i, act] of (overview.acts ?? []).entries()) {
        fields.set(`Act ${i + 1} · ${act.title}`, act.summary ?? "—");
      }
      if (overview.targetLength !== undefined) fields.set("Target length", overview.targetLength);
      return { label: `Story overview v${overview.version}`, kind: "story overview", fields };
    } catch {
      return null;
    }
  }

  // The remaining narrative-domain JSON tracks (SPEC-023 R-18, issue #400): every field a
  // reviewer would otherwise accept unseen.
  if (/^productions\/[a-z0-9-]+\/season\.json$/.test(path)) {
    try {
      const season = SeasonSchema.parse(JSON.parse(content));
      const fields = new Map<string, string>();
      if (season.question !== undefined) fields.set("Question", season.question);
      if (season.ending !== undefined) fields.set("Ending", season.ending);
      if (season.direction !== undefined) fields.set("Direction", season.direction);
      // Lanes included: an arc's setup/turn/payoff placements are exactly what a bad merge
      // loses, and a review that omits them cannot show the loss it exists to catch.
      for (const arc of season.arcs ?? []) {
        const lanes = [
          arc.setup !== undefined ? `setup ${arc.setup}` : null,
          arc.turn !== undefined ? `turn ${arc.turn}` : null,
          arc.payoff !== undefined ? `payoff ${arc.payoff}` : null,
        ].filter((lane): lane is string => lane !== null);
        fields.set(`Arc · ${arc.title}`, [arc.note, ...lanes].filter(Boolean).join(" · ") || "—");
      }
      if (season.defaults !== undefined) fields.set("Defaults", JSON.stringify(season.defaults));
      return { label: `Season v${season.version}`, kind: "season", fields };
    } catch {
      return null;
    }
  }
  if (/^productions\/[a-z0-9-]+\/episodes\/[^/]+\.json$/.test(path)) {
    try {
      const episode = EpisodeSchema.parse(JSON.parse(content));
      const fields = new Map<string, string>();
      fields.set("Title", episode.title);
      fields.set("Order", String(episode.order));
      if (episode.promise?.opens !== undefined) fields.set("Opens", episode.promise.opens);
      if (episode.promise?.turn !== undefined) fields.set("Turn", episode.promise.turn);
      if (episode.promise?.closes !== undefined) fields.set("Closes", episode.promise.closes);
      fields.set("Scenes", episode.scenes.length > 0 ? episode.scenes.join(", ") : "none yet");
      if (episode.release !== undefined) fields.set("Release", JSON.stringify(episode.release));
      return { label: `${episode.title} (${episode.id})`, kind: `episode · v${episode.version}`, fields };
    } catch {
      return null;
    }
  }
  if (/^productions\/[a-z0-9-]+\/routing\.json$/.test(path)) {
    try {
      const routing = RoutingSchema.parse(JSON.parse(content));
      const fields = new Map<string, string>();
      fields.set("Start", routing.start);
      for (const choice of routing.choices) fields.set(`Choice · ${choice.id}`, `${choice.from} → "${choice.label}" → ${choice.to}`);
      for (const ending of routing.endings) fields.set(`Ending · ${ending.sceneId}`, ending.title);
      for (const entry of routing.excluded) fields.set(`Excluded · ${entry.sceneId}`, entry.reason);
      return { label: `Routing v${routing.version}`, kind: "routing", fields };
    } catch {
      return null;
    }
  }
  if (/^series\/[a-z0-9-]+\.json$/.test(path)) {
    try {
      const series = SeriesSchema.parse(JSON.parse(content));
      const fields = new Map<string, string>();
      fields.set("Title", series.title);
      if (series.engine !== undefined) fields.set("Engine", series.engine);
      if (series.continuity !== undefined) fields.set("Continuity", series.continuity);
      fields.set("Seasons", series.seasons.join(", ") || "none yet");
      return { label: `${series.title} (series)`, kind: `series · v${series.version}`, fields };
    } catch {
      return null;
    }
  }

  let doc;
  try {
    doc = MarkdownFile.parse(content);
  } catch {
    return null;
  }

  if (/^productions\/[a-z0-9-]+\/chapters\/[^/]+\.md$/.test(path)) {
    const parsed = ChapterFrontmatterSchema.safeParse(doc.data);
    if (!parsed.success) return null;
    const chapter = parsed.data;
    const fields = new Map<string, string>();
    fields.set("Chapter ID", chapter.id);
    fields.set("Title", chapter.title);
    if (chapter.status !== undefined) fields.set("Status", chapter.status);
    const order = chapter.order ?? chapter.number;
    if (order !== undefined) fields.set("Order", String(order));
    if (chapter.draws?.sheets.length) fields.set("Draws from sheets", chapter.draws.sheets.join(", "));
    if (chapter.draws?.canon.length) fields.set("Draws from canon", chapter.draws.canon.join(", "));
    fields.set("Prose", doc.body.trim());
    return { label: chapter.title, kind: `chapter · v${chapter.version}`, fields };
  }

  if (path.startsWith("canon/")) {
    const parsed = CanonEntrySchema.safeParse({ ...doc.data, body: doc.body.trim() });
    if (!parsed.success) return null;
    const entry = parsed.data;
    return {
      label: entry.title,
      kind: entry.status === "open" ? "open thread" : `canon · ${entry.type}`,
      fields: new Map([
        ["Type", entry.type],
        ["Title", entry.title],
        ["Status", entry.status],
        ["Links", entry.links.join(", ") || "None"],
        ["Retired", entry.retired ? "Yes" : "No"],
        ["Statement", entry.body],
      ]),
    };
  }

  const type = path.startsWith("characters/")
    ? "character"
    : path.startsWith("locations/")
      ? "location"
      : path.startsWith("factions/")
        ? "faction"
        : null;
  if (!type) return null;

  const parsed = SheetSchema.safeParse({ ...doc.data, type, sections: doc.sections() });
  if (!parsed.success) return null;
  const sheet = parsed.data;
  const fields = new Map<string, string>([
    ["Name", sheet.name],
    ["Status", sheet.status],
    ["Role", sheet.role ?? "None"],
    ["Billing", sheet.billing ?? "None"],
    ["Region", sheet.region ?? "None"],
    ["Canon rules", sheet.canonRules.join(", ") || "None"],
    ["Links", sheet.links.join(", ") || "None"],
    ["Owner", sheet.production ?? "World"],
    ["Origin", sheet.origin ? `${sheet.origin.sheet} v${sheet.origin.version}` : "None"],
    ["Voice", sheet.voice ? JSON.stringify(sheet.voice) : "None"],
    ["Retired", sheet.retired ? "Yes" : "No"],
  ]);
  for (const section of sheet.sections) fields.set(section.heading, section.body);
  return { label: sheet.name, kind: `${type} sheet · v${sheet.version}`, fields };
}

export interface ReviewInput {
  proposal: Proposal;
  /** The proposed file for a path, as staged. */
  proposed: (path: string) => string | null;
  /** The base captured with the proposal, or null for a create. */
  base: (path: string) => string | null;
}

/**
 * Compare base with proposed and keep only what differs.
 *
 * Unchanged fields are dropped deliberately. A review that lists every field of a sheet buries
 * the one line that changed among fifteen that did not, and the reviewer's job is to judge the
 * change, not to find it.
 */
/**
 * The look a staged change supersedes, taken from the change's own history.
 *
 * Only for the case where nothing is on disk to compare against: the record being staged always
 * pushes the look it replaces onto `history`, so the newest entry there is what the world was
 * resolving to. Null when the staged record is the world's very first look and supersedes
 * nothing — then "create" is the honest word.
 */
/**
 * The standing constraints as review fields (#244, round 3).
 *
 * A policy-only change moves neither the description nor the master look, so the review had no
 * changed fields at all — a reviewer could accept a change binding every future generation while
 * the screen showed them nothing. Rendered as prose because that is what the panel diffs; the
 * failure modes are numbered so a reordering reads as the change it is.
 */
function policyFields(
  fields: Map<string, string>,
  record: { audio: { music: string }; failureModes: readonly string[] },
): void {
  fields.set(
    "Music",
    record.audio.music === "environmental-only"
      ? "Environmental and action sound only"
      : "Allow model-generated score",
  );
  fields.set(
    "Failure modes",
    record.failureModes.length === 0
      ? "None"
      : record.failureModes.map((mode, i) => `${i + 1}. ${mode}`).join("\n"),
  );
}

function inheritedLookBase(proposedRaw: string): { label: string; kind: string; fields: Map<string, string> } | null {
  try {
    const record = ArtDirectionRecordSchema.parse(JSON.parse(proposedRaw));
    const previous = record.history.at(-1);
    if (!previous) return null;
    const fields = new Map<string, string>([["Look", previous.description]]);
    if (previous.masterLook) fields.set("Master look", previous.masterLook);
    if ("keyArtIntent" in previous) {
      fields.set("Key art intent", previous.keyArtIntent ? JSON.stringify(previous.keyArtIntent) : "None");
    }
    policyFields(fields, previous);
    return { label: `World look v${previous.version}`, kind: "art direction", fields };
  } catch {
    return null;
  }
}

export function projectReview(input: ReviewInput): ReviewProjection {
  const targets: ReviewTarget[] = [];

  for (const target of input.proposal.targets) {
    const proposedRaw = input.proposed(target.path);
    if (proposedRaw === null) continue;
    const proposed = fieldsOf(target.path, proposedRaw);
    if (!proposed) continue;

    const baseRaw = input.base(target.path);
    /*
     * A world always has a look, even before it has a file for one.
     *
     * Until somebody changes it, the look is derived from the world's tone and genre and lives
     * nowhere on disk — so the first change to it stages as a create with no base, and the review
     * showed a new art direction with no `was` at all. What it was replacing, and what the person
     * was about to lose, went unmentioned. The staged record carries the look it supersedes in
     * its own history, which is the same words the world was resolving to.
     */
    const base =
      baseRaw === null
        ? target.path === ART_DIRECTION_PATH
          ? inheritedLookBase(proposedRaw)
          : null
        : fieldsOf(target.path, baseRaw);
    const action: ReviewTarget["action"] = base === null ? "create" : "amend";

    const fields: ReviewField[] = [];
    for (const [field, value] of proposed.fields) {
      const before = base?.fields.get(field) ?? null;
      if (before === value) continue;
      fields.push({ field, before, proposed: value });
    }
    // A field the proposal removes is a change too, and one a reviewer would want to see.
    if (base) {
      for (const [field, value] of base.fields) {
        if (!proposed.fields.has(field)) fields.push({ field, before: value, proposed: null });
      }
    }

    targets.push({
      path: target.path,
      label: proposed.label,
      kind: action === "create" ? newKindOf(proposed.kind) : proposed.kind,
      action,
      fields,
    });
  }

  return { targets };
}

/** A create has no version to show, and "new" is the thing the reviewer needs to notice. */
function newKindOf(kind: string): string {
  if (kind.startsWith("canon · ")) return `new ${kind.slice("canon · ".length)}`;
  if (kind === "open thread") return "new open thread";
  const sheet = /^(\w+) sheet/.exec(kind);
  return sheet ? `new ${sheet[1]} sheet` : `new ${kind}`;
}
