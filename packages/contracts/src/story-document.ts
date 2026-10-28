import type { PlayerBeat } from "./beats.js";
import type { Routing } from "./routing.js";
import type { StoryPredicate } from "./story-state-schema.js";
import { storyEnding, storyIdentity, storyPredicate, storyReplay, storyVisibleBeats, validateStoryProgram, type StoryProgram, type StoryState } from "./story-state.js";
import {
  STORY_FORMAT,
  STORY_VERSION,
  storyDocumentProgram,
  storyDocumentRefusal,
  storyItemShot,
  storySceneItems,
  type StoryDocument,
  type StoryDocumentBeat,
  type StoryDocumentClip,
  type StoryKind,
  type StoryShape,
} from "./world-package.js";

/**
 * An interactive story compiled for Arke Player (SPEC-058 R-80, R-81; SPEC-063 R-27): the routing a
 * production owns, resolved once, at export, to the clips or beats and lines a listener is given, so
 * the Player never needs the world's script and the fingerprint covers what is actually seen.
 *
 * Nothing here evaluates a story of its own. The route walk folds choices with SPEC-063's
 * `storyReplay`, opens choices with its `storyPredicate`, projects a scene with its
 * `storyVisibleBeats` and resolves an ending with its `storyEnding` (R-23 forbids a second
 * evaluator); `arke_world`'s Dart port is held to the walk's output by the shared route fixtures.
 */

/**
 * One footage window, as `exportInteractive` resolves a scene: `playbackWindow` gives seconds of
 * the covering pass, so `from` and `to` are those times ×1000, rounded. A window with no `to` (the
 * cut leaves its end open) and a whole pass that the scene plays with no window at all both run to
 * the end of the file, so the caller measures it: a document's window always has its end.
 */
export interface StoryCompileClip {
  /** The package asset id of the clip's MP4. */
  asset: string;
  from: number;
  to: number;
  /**
   * The shot the window plays, in shot order, as the export's windows are. A Show when on a shot
   * (SPEC-063 R-7) can only leave out a clip that names it; a whole pass, naming none, cannot.
   */
  shotId?: string;
}

/**
 * One beat, as `exportBeats` has it from `playerBeats(scene, { story: true, … })`, with its resolvers
 * returning package asset ids rather than package paths: `picture` and `audio` (its voice) are asset
 * ids, `text` its line, `speaker` the name its tab shows. `tall` is the asset id of the picture made
 * Tall, where the moment has one.
 */
export type StoryCompileBeat = Pick<PlayerBeat, "shotId" | "pictureShotId" | "blockId" | "picture" | "text" | "speaker" | "audio"> & { tall?: string };

/** A scene the export resolved: a movie's scene has clips, a novel's beats. */
export interface StoryCompileScene {
  title: string;
  clips?: readonly StoryCompileClip[];
  beats?: readonly StoryCompileBeat[];
}

/**
 * What Export → Arke Player (R-89, slice 15) hands the compiler: the routing as stored, stateful
 * (schemaVersion 2) or legacy, which compiles with no facts; the production's kind and aspect; and
 * the scenes it resolved, by id. Scenes no route can reach are not asked for and, given, are left out.
 */
export interface StoryCompileInput {
  routing: Pick<Routing, "start" | "facts" | "choices" | "presentation" | "endings">;
  kind: StoryKind;
  shape: StoryShape;
  scenes: Readonly<Record<string, StoryCompileScene>>;
}

/** What stops a compile, by scene where it is one, so the Export sheet can offer `Go to` (R-89). */
export interface StoryCompileProblem {
  detail: string;
  sceneId?: string;
}

export type StoryCompiled = { ok: true; document: StoryDocument } | { ok: false; problems: StoryCompileProblem[] };

/** The document's fingerprint (SPEC-063 R-14): the canonical SHA-256 of all it holds but itself. */
export function storyFingerprint(document: Omit<StoryDocument, "fingerprint"> & { fingerprint?: string }): string {
  const { fingerprint: _fingerprint, ...content } = document;
  return storyIdentity(content);
}

/**
 * Compiles a production's routing and its resolved scenes to an `arke-story` document (R-80).
 *
 * The scenes are those a route can reach, whatever their conditions, in the order the routing
 * reaches them: a choice never open in any state still names its scene, and may still be shown
 * closed with its reason. Fact labels, groups, exclusions and the routing's revision are the
 * author's and are left out (SPEC-063 R-27). A Show when becomes a presentation row on each item it
 * guards; a beat's shot and block conditions both hold for it to play, as `storyVisibleBeats` reads
 * them. What a document cannot say is a problem rather than a guess (SPEC-063 R-9): a line shown
 * only sometimes in footage that cannot leave it out, a shot no clip names, and a beat that keeps
 * the picture of a shot shown only in some states, which the web player would show with no picture.
 */
export function compileStoryDocument(input: StoryCompileInput): StoryCompiled {
  const { routing, kind } = input;
  try {
    validateStoryProgram(routing);
  } catch (error) {
    return { ok: false, problems: [{ detail: error instanceof Error ? error.message : String(error) }] };
  }
  const problems: StoryCompileProblem[] = [];
  const order = [routing.start];
  const reached = new Set(order);
  for (let at = 0; at < order.length; at++) {
    for (const choice of routing.choices) {
      if (choice.from === order[at] && !reached.has(choice.to)) {
        reached.add(choice.to);
        order.push(choice.to);
      }
    }
  }

  const scenes: StoryDocument["scenes"] = [];
  const presentation: StoryDocument["presentation"] = [];
  for (const sceneId of order) {
    const source = input.scenes[sceneId];
    if (source === undefined) {
      problems.push({ sceneId, detail: `${sceneId} has nothing to play` });
      continue;
    }
    const rules = routing.presentation?.find((entry) => entry.sceneId === sceneId);
    const shotWhen = (shotId: string | undefined) => (shotId === undefined ? undefined : rules?.shots.find((rule) => rule.shotId === shotId)?.when);
    const blockWhen = (blockId: string | undefined) => (blockId === undefined ? undefined : rules?.blocks.find((rule) => rule.blockId === blockId)?.when);
    const guard = (index: number, when: StoryPredicate | undefined) => {
      if (when !== undefined) presentation.push({ scene: sceneId, index, when });
    };
    const title = source.title;
    if (kind === "movie") {
      const clips = source.clips ?? [];
      if (clips.length === 0 || source.beats !== undefined) {
        problems.push({ sceneId, detail: `${title} has no clip to play` });
        continue;
      }
      // A clip's sound and picture are one: it cannot drop a line, or a shot it does not stand for.
      if ((rules?.blocks.length ?? 0) > 0) problems.push({ sceneId, detail: `${title} shows a line only in some states, and its clips cannot leave it out` });
      const named = new Set(clips.map((clip) => clip.shotId));
      for (const rule of rules?.shots ?? []) if (!named.has(rule.shotId)) problems.push({ sceneId, detail: `${title} shows ${rule.shotId} only in some states, and no clip of it stands for that shot alone` });
      clips.forEach((clip, index) => {
        if (!Number.isInteger(clip.from) || !Number.isInteger(clip.to) || clip.from < 0 || clip.to <= clip.from) problems.push({ sceneId, detail: `${title}, clip ${index + 1} has no window to play` });
        guard(index, shotWhen(clip.shotId));
      });
      scenes.push({ id: sceneId, title, clips: clips.map(({ asset, from, to }): StoryDocumentClip => ({ asset, from, to })) });
      continue;
    }
    const beats = source.beats ?? [];
    if (beats.length === 0 || source.clips !== undefined) {
      problems.push({ sceneId, detail: `${title} has no beats to read` });
      continue;
    }
    beats.forEach((beat, index) => {
      if (beat.picture === undefined) problems.push({ sceneId, detail: `${title}, beat ${index + 1} needs a picture` });
      if (beat.pictureShotId !== undefined && beat.pictureShotId !== beat.shotId && shotWhen(beat.pictureShotId) !== undefined) {
        problems.push({ sceneId, detail: `${title}, beat ${index + 1} keeps the picture of a shot shown only in some states — give it a picture of its own` });
      }
      const shot = shotWhen(beat.shotId);
      const line = blockWhen(beat.blockId);
      guard(index, shot !== undefined && line !== undefined ? { op: "all", args: [shot, line] } : (shot ?? line));
    });
    scenes.push({
      id: sceneId,
      title,
      beats: beats.map((beat): StoryDocumentBeat => ({
        picture: beat.picture ?? "",
        ...(beat.tall === undefined ? {} : { tall: beat.tall }),
        ...(beat.speaker === undefined ? {} : { speaker: beat.speaker }),
        ...(beat.text === undefined || beat.text === "" ? {} : { line: beat.text }),
        ...(beat.audio === undefined ? {} : { voice: beat.audio }),
      })),
    });
  }
  if (problems.length > 0) return { ok: false, problems };

  const content: Omit<StoryDocument, "fingerprint"> = {
    format: STORY_FORMAT,
    version: STORY_VERSION,
    kind,
    shape: input.shape,
    start: routing.start,
    facts: (routing.facts ?? []).map((fact) => (fact.type === "boolean" ? { id: fact.id, type: fact.type, default: fact.default } : { id: fact.id, type: fact.type, values: [...fact.values], default: fact.default })),
    scenes,
    presentation,
    choices: routing.choices
      .filter((choice) => reached.has(choice.from))
      .map((choice) => ({
        id: choice.id,
        from: choice.from,
        to: choice.to,
        label: choice.label,
        ...(choice.when === undefined ? {} : { when: choice.when }),
        effects: (choice.effects ?? []).map((effect) => ({ fact: effect.fact, value: effect.value })),
        ...(choice.unavailable === undefined ? {} : { unavailable: { ...(choice.unavailable.label === undefined ? {} : { label: choice.unavailable.label }), reason: choice.unavailable.reason } }),
      })),
    endings: routing.endings
      .filter((ending) => reached.has(ending.sceneId))
      .map((ending) => ({
        scene: ending.sceneId,
        title: ending.title,
        ...(ending.variants === undefined
          ? {}
          : { variants: ending.variants.map((variant) => ("fallback" in variant ? { id: variant.id, title: variant.title, text: variant.text, fallback: true as const } : { id: variant.id, title: variant.title, text: variant.text, when: variant.when })) }),
      })),
  };
  // Keys in the order R-80 writes them, so the file reads as the spec's example does.
  const { format, version, shape, start, facts, choices, endings } = content;
  const document: StoryDocument = { format, version, kind, shape, start, fingerprint: storyFingerprint(content), facts, scenes, presentation, choices, endings };
  // The compiler's output is read back by the reader's own shape, so nothing it writes is refused
  // later by a Player: a label past its bound, an ending that offers a choice.
  const refusal = storyDocumentRefusal(document);
  return refusal === null ? { ok: true, document } : { ok: false, problems: [{ detail: `the story would not be read: ${refusal}` }] };
}

/** A choice shown closed (R-85): its own label, or the one the author wrote for it closed, and the reason. */
export interface StoryClosedChoice {
  id: string;
  label: string;
  reason: string;
}

/** Where a route stands on arriving at a scene: SPEC-058 R-81's step. */
export interface StoryRouteStep {
  scene: string;
  /** Every declared fact, in declaration order, with its value. */
  facts: StoryState;
  /** The choices open here, in authored order. */
  open: string[];
  /** The choices closed here that carry a reason, in authored order; a closed choice without one is hidden. */
  closed: StoryClosedChoice[];
  /** The scene's clips or beats that play in this state, by index, ascending. */
  play: number[];
}

/** The ending a route reaches: its variant, or the ending itself when it has none (variant and text null). */
export interface StoryRouteEnding {
  scene: string;
  variant: string | null;
  title: string;
  text: string | null;
}

export interface StoryRoute {
  choices: string[];
  /** `choices.length + 1` steps: the start, then the scene each choice enters. */
  steps: StoryRouteStep[];
  /** Null only when the walk stopped this route at its bound. */
  ending: StoryRouteEnding | null;
}

export interface StoryRoutes {
  /** True when every route ended; false when one was stopped at the bound. */
  complete: boolean;
  /** The bound that stopped the walk, or null when nothing did. */
  bound: { choices: number; routes: number } | null;
  routes: StoryRoute[];
}

/** The step a route of choice ids arrives at: SPEC-063 R-6's replay, then what that scene offers and plays. */
export function storyStepAt(document: StoryDocument, choices: readonly string[], program: StoryProgram = storyDocumentProgram(document)): StoryRouteStep {
  const point = storyReplay(program, choices);
  const scene = document.scenes.find((candidate) => candidate.id === point.sceneId)!;
  const leaving = document.choices.filter((choice) => choice.from === point.sceneId);
  // Each item stands as its own shot (storyDocumentProgram), so the rules' projection keeps exactly
  // the items whose rows hold, in scene order.
  const items = storySceneItems(scene).map((_, index) => ({ index, shotId: storyItemShot(index), pictureShotId: storyItemShot(index) }));
  return {
    scene: point.sceneId,
    facts: Object.fromEntries(document.facts.map((fact) => [fact.id, point.state[fact.id]!])),
    open: leaving.filter((choice) => storyPredicate(choice.when, point.state)).map((choice) => choice.id),
    closed: leaving.flatMap((choice) => (choice.unavailable !== undefined && !storyPredicate(choice.when, point.state) ? [{ id: choice.id, label: choice.unavailable.label ?? choice.label, reason: choice.unavailable.reason }] : [])),
    play: storyVisibleBeats(program, point.sceneId, items, point.state).map((item) => item.index),
  };
}

/**
 * Every complete route through a document, depth first in authored order (R-81, R-89's read-back):
 * each with its step at every scene and the ending it reaches. A loop is legitimate (SPEC-063 R-6),
 * so the walk is bounded: a route that reaches `choices` choices without ending is kept, unended, and
 * the walk stops collecting at `routes` routes; either makes it incomplete. A state with no open
 * choice that is not an ending, or an ending no variant resolves, throws, as the rules do.
 */
export function storyRoutes(document: StoryDocument, limits: { choices?: number; routes?: number } = {}): StoryRoutes {
  const program = storyDocumentProgram(document);
  const maxChoices = limits.choices ?? 2048;
  const maxRoutes = limits.routes ?? 100_000;
  const endings = new Set(document.endings.map((ending) => ending.scene));
  const routes: StoryRoute[] = [];
  let complete = true;
  const walk = (choices: string[], before: StoryRouteStep[]) => {
    if (routes.length >= maxRoutes) {
      complete = false;
      return;
    }
    const step = storyStepAt(document, choices, program);
    const steps = [...before, step];
    if (endings.has(step.scene)) {
      const point = storyReplay(program, choices);
      const resolved = storyEnding(program, point.sceneId, point.state)! as { id?: string; title: string; text?: string };
      routes.push({ choices, steps, ending: { scene: step.scene, variant: resolved.id ?? null, title: resolved.title, text: resolved.text ?? null } });
      return;
    }
    if (step.open.length === 0) throw new Error(`Route ${choices.join(" → ") || "start"} stops at ${step.scene}, which is no ending and offers no choice`);
    if (choices.length >= maxChoices) {
      complete = false;
      routes.push({ choices, steps, ending: null });
      return;
    }
    for (const id of step.open) walk([...choices, id], steps);
  };
  walk([], []);
  return { complete, bound: complete ? null : { choices: maxChoices, routes: maxRoutes }, routes };
}
