import type { ProductionBundle } from "./client-state.js";
import type { Sheet } from "./world.js";

/**
 * The season intelligence (Scope §04; SPEC-023 R-16, issue #397): eight named findings, each
 * carrying the episode, scene, or entity it is about and the evidence it stands on. Derived at
 * read, never stored — stored intelligence goes stale silently — and there is deliberately no
 * aggregate score anywhere: a number would hide exactly the sentence a creator needs.
 */

export type SeasonFindingKind =
  | "repeated-hook"
  | "repetitive-cliffhanger"
  | "absent-character"
  | "unresolved-promise"
  | "stalled-arc"
  | "continuity-contradiction"
  | "new-entity-budget"
  | "cost-pattern";

export interface SeasonFinding {
  kind: SeasonFindingKind;
  /** What it is about: an episode id, a scene id, a sheet slug, or an arc id. */
  about: string;
  /** The finding as a sentence a creator can act on. */
  message: string;
  /** What it stands on — the ids or values that make it true. */
  evidence: string[];
}

/** How many first-appearance entities in one episode read as a budget concern (Scope §04). */
const NEW_ENTITY_BUDGET = 3;

const normalise = (text: string): string => text.trim().toLowerCase();

/** Every `@slug` mention in a shot description — the same tokens prompt assembly resolves. */
function mentionsOf(text: string): string[] {
  return [...text.matchAll(/@([a-z0-9]+(?:-[a-z0-9]+)*)/g)].map((m) => m[1]!);
}

export function seasonFindings(production: ProductionBundle, sheets: readonly Sheet[] = []): SeasonFinding[] {
  const findings: SeasonFinding[] = [];
  const episodes = production.episodes;
  if (episodes.length === 0) return findings;
  const scenesById = new Map(production.scenes.map((s) => [s.id, s]));

  // --- membership integrity (SPEC-023 R-12): the continuity findings the schema promises ----
  const owners = new Map<string, string[]>();
  for (const episode of episodes) {
    for (const sceneId of episode.scenes) {
      owners.set(sceneId, [...(owners.get(sceneId) ?? []), episode.id]);
      if (!scenesById.has(sceneId)) {
        findings.push({
          kind: "continuity-contradiction",
          about: episode.id,
          message: `${episode.title} lists ${sceneId}, which is not a scene in this production.`,
          evidence: [sceneId],
        });
      }
    }
    for (const link of [episode.linked?.closesInto, episode.linked?.opensFrom]) {
      if (link !== undefined && !episodes.some((e) => e.id === link)) {
        findings.push({
          kind: "continuity-contradiction",
          about: episode.id,
          message: `${episode.title} links to ${link}, which is not an episode in this production.`,
          evidence: [link],
        });
      }
    }
  }
  for (const [sceneId, episodeIds] of owners) {
    if (episodeIds.length > 1) {
      findings.push({
        kind: "continuity-contradiction",
        about: sceneId,
        message: `${sceneId} belongs to ${episodeIds.length} episodes; a scene belongs to exactly one.`,
        evidence: episodeIds,
      });
    }
  }
  for (const scene of production.scenes) {
    if (!owners.has(scene.id)) {
      findings.push({
        kind: "continuity-contradiction",
        about: scene.id,
        message: `"${scene.title}" (${scene.id}) belongs to no episode.`,
        evidence: [scene.id],
      });
    }
  }

  // --- hooks and cliffhangers -----------------------------------------------------------------
  const byOpens = new Map<string, string[]>();
  const byCloses = new Map<string, string[]>();
  for (const episode of episodes) {
    const opens = episode.promise?.opens;
    const closes = episode.promise?.closes;
    if (opens) byOpens.set(normalise(opens), [...(byOpens.get(normalise(opens)) ?? []), episode.id]);
    if (closes) byCloses.set(normalise(closes), [...(byCloses.get(normalise(closes)) ?? []), episode.id]);
  }
  for (const [, ids] of byOpens) {
    if (ids.length > 1) {
      findings.push({
        kind: "repeated-hook",
        about: ids[0]!,
        message: `${ids.length} episodes open on the same hook (${ids.join(", ")}).`,
        evidence: ids,
      });
    }
  }
  for (const [, ids] of byCloses) {
    if (ids.length > 1) {
      findings.push({
        kind: "repetitive-cliffhanger",
        about: ids[0]!,
        message: `${ids.length} episodes close on the same cliffhanger (${ids.join(", ")}).`,
        evidence: ids,
      });
    }
  }

  // --- promises -------------------------------------------------------------------------------
  for (const episode of episodes) {
    const promise = episode.promise;
    if (promise?.opens && !promise.closes) {
      findings.push({
        kind: "unresolved-promise",
        about: episode.id,
        message: `${episode.title} opens on "${promise.opens.slice(0, 80)}" and never says how it closes.`,
        evidence: [episode.id],
      });
    }
  }

  // --- arcs -----------------------------------------------------------------------------------
  for (const arc of production.season?.arcs ?? []) {
    if (arc.setup !== undefined && arc.payoff === undefined) {
      findings.push({
        kind: "stalled-arc",
        about: arc.id,
        message: `The arc "${arc.title}" sets up${arc.turn !== undefined ? " and turns" : ""} but never pays off.`,
        evidence: [arc.setup, ...(arc.turn !== undefined ? [arc.turn] : [])],
      });
    }
  }

  // --- cast presence ---------------------------------------------------------------------------
  const mentioned = new Set<string>();
  for (const scene of production.scenes) {
    for (const shot of scene.shots) for (const slug of mentionsOf(shot.description)) mentioned.add(slug);
  }
  for (const sheet of sheets) {
    if (sheet.type !== "character" || sheet.retired === true) continue;
    if (sheet.billing !== "lead") continue;
    if (!mentioned.has(sheet.id)) {
      findings.push({
        kind: "absent-character",
        about: sheet.id,
        message: `${sheet.name} is billed as a lead and appears in no episode's shots.`,
        evidence: [sheet.id],
      });
    }
  }

  // --- new entities per episode ----------------------------------------------------------------
  const seen = new Set<string>();
  for (const episode of episodes) {
    const introduced = new Set<string>();
    for (const sceneId of episode.scenes) {
      const scene = scenesById.get(sceneId);
      if (!scene) continue;
      for (const shot of scene.shots) {
        for (const slug of mentionsOf(shot.description)) {
          if (!seen.has(slug)) introduced.add(slug);
        }
      }
    }
    if (introduced.size > NEW_ENTITY_BUDGET) {
      findings.push({
        kind: "new-entity-budget",
        about: episode.id,
        message: `${episode.title} introduces ${introduced.size} new entities; more than ${NEW_ENTITY_BUDGET} in one episode strains a short format.`,
        evidence: [...introduced],
      });
    }
    for (const slug of introduced) seen.add(slug);
  }

  // --- cost pattern -----------------------------------------------------------------------------
  const defaults = production.season?.defaults;
  if (defaults?.episodeSecondsMin !== undefined || defaults?.episodeSecondsMax !== undefined) {
    for (const episode of episodes) {
      const seconds = episode.scenes.reduce((sum, sceneId) => {
        const scene = scenesById.get(sceneId);
        return sum + (scene?.shots.reduce((s, shot) => s + (shot.durationSec ?? 0), 0) ?? 0);
      }, 0);
      if (seconds === 0) continue; // nothing planned yet is not a cost finding
      const min = defaults.episodeSecondsMin;
      const max = defaults.episodeSecondsMax;
      if ((min !== undefined && seconds < min) || (max !== undefined && seconds > max)) {
        findings.push({
          kind: "cost-pattern",
          about: episode.id,
          message: `${episode.title} plans ${Math.round(seconds)}s against the season's ${min ?? "…"}–${max ?? "…"}s envelope.`,
          evidence: [`${Math.round(seconds)}s`],
        });
      }
    }
  }

  return findings;
}
