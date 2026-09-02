import type { ProductionBundle, WorldBundle, WorldChatContext } from "@arke-studio/contracts";
import {
  orderedShots,
  orderedTrackClips,
  productionAspect,
  productionShape,
  seedEmptyPictureTimeline,
  TURN_RESULT_BOUNDS,
  type ProductionTimeline,
  type TimelineClip,
} from "@arke-studio/contracts";
import { MAX_PROPOSALS } from "./wrapup.js";

/**
 * Episodes per run.
 *
 * Not the operation cap minus a token reserve — that number got shaved twice and was still wrong,
 * because the cap counts everything a production turn is allowed to do at once: the episodes, the
 * overview, the season direction, and any world fact that surfaced while writing them. Eight
 * leaves four, which is enough for all of those together, and the turn is told the real cap as
 * well so it can reason rather than count on this number being generous.
 */
const EPISODE_RUN = 8;

/**
 * What the conversation was opened about, in a sentence the model can use (#70 phase 6).
 *
 * A conversation started from a refusal already has its question; one started from a sheet
 * already has its subject. Handing that over is the whole point of the entry points — otherwise
 * somebody describes what they were looking at, having just been looking at it.
 *
 * Only names and ids cross: the model reads the entity itself through its tools, at the version
 * that is current when it asks, rather than from a snapshot pasted into a prompt that may already
 * be out of date.
 */
export function describeEntryContext(context: WorldChatContext, bundle: WorldBundle): string {
  switch (context.kind) {
    case "world":
      return "";
    case "canon-question": {
      const considered = context.candidateEntryIds.filter((id) => bundle.canon.some((c) => c.id === id));
      const closest =
        considered.length > 0
          ? ` The closest entries the search found were ${considered.join(", ")}, and none of them answered it.`
          : " Nothing in canon came close to it.";
      return `This conversation was opened from a question canon could not answer: "${context.question}".${closest}`;
    }
    case "canon-entry": {
      const entry = bundle.canon.find((c) => c.id === context.entryId);
      const named = entry ? `${context.entryId} — "${entry.title}"` : context.entryId;
      return `This conversation was opened from the canon entry ${named}. Read it before proposing a change to it.`;
    }
    case "sheet": {
      const sheet = bundle.sheets.find((s) => s.id === context.sheetId);
      const named = sheet ? `${sheet.name} (${context.sheetKind}, ${context.sheetId})` : context.sheetId;
      return `This conversation was opened from the ${context.sheetKind} sheet for ${named}. Read it before proposing a change to it.`;
    }
    case "attachment":
      return "This conversation was opened from a document that was handed over. Read it before drawing anything from it.";
    case "production": {
      const production = bundle.productions.find((p) => p.meta.id === context.productionId);
      const named = production ? `"${production.meta.title}" (${context.productionId})` : context.productionId;
      // The narration is orientation; the record is the read. `get_production` serves the whole
      // thing — story, season direction, episodes, scenes — since round 3 (2026-08-22) found a
      // thread deciding against a season it could not see.
      const lines = [
        `This is the Production Chat thread for the production ${named}. It shapes the overview, the season, and the episodes; world facts that surface here cross over as their own proposals, never inside a production edit. Read the full records with get_production(${context.productionId}) before deciding against them.`,
      ];
      const shape = describeShape(production, true);
      if (shape) lines.push(shape);
      if (production?.story) {
        lines.push(
          `The overview is v${production.story.version}${production.story.logline ? ` — logline: "${clip(production.story.logline)}"` : ""}${production.story.spine ? `; spine: "${clip(production.story.spine)}"` : ""}.`,
        );
      } else lines.push("There is no overview yet.");
      if (production?.season) {
        lines.push(
          `The season is v${production.season.version}${production.season.question ? ` — question: "${clip(production.season.question)}"` : ""}${production.season.ending ? `; ending: "${clip(production.season.ending)}"` : ""}.`,
        );
      }
      if (production && production.episodes.length > 0) {
        lines.push(
          `Episodes, in order: ${production.episodes
            .slice(0, 20)
            .map((e) => `${e.id} "${e.title}" (${e.scenes.length} scene${e.scenes.length === 1 ? "" : "s"})`)
            .join("; ")}.`,
        );
      }
      const timeline = describeTimeline(production);
      if (timeline) lines.push(timeline);
      return lines.join(" ");
    }
    case "episode": {
      const production = bundle.productions.find((p) => p.meta.id === context.productionId);
      const episode = production?.episodes.find((e) => e.id === context.episodeId);
      const named = episode ? `"${episode.title}" (${context.episodeId})` : context.episodeId;
      const lines = [
        `This is the episode thread for ${named} in the production ${context.productionId}. An episode is its promise and its scenes in order; a script belongs to a scene and to nothing above it. Read the season and the sibling episodes with get_production(${context.productionId}) before deciding against them; an episode's scenes list may only name scenes that already exist.`,
      ];
      const shape = describeShape(production);
      if (shape) lines.push(shape);
      if (episode) {
        const promise = episode.promise;
        if (promise && (promise.opens || promise.turn || promise.closes)) {
          lines.push(
            `Its promise: ${[
              promise.opens ? `opens — "${clip(promise.opens)}"` : null,
              promise.turn ? `turn — "${clip(promise.turn)}"` : null,
              promise.closes ? `closes — "${clip(promise.closes)}"` : null,
            ]
              .filter(Boolean)
              .join("; ")}.`,
          );
        }
        lines.push(
          episode.scenes.length > 0 ? `Its scenes, in order: ${episode.scenes.join(", ")}.` : "It has no scenes yet.",
        );
      }
      const timeline = describeTimeline(production);
      if (timeline) lines.push(timeline);
      return lines.join(" ");
    }
    case "scene": {
      const production = bundle.productions.find((p) => p.meta.id === context.productionId);
      const scene = production?.scenes.find((s) => s.id === context.sceneId);
      const named = scene ? `"${scene.title}" (${context.sceneId})` : context.sceneId;
      const lines = [
        `This is the scene thread for ${named} in the production ${context.productionId}. Its script is ordered blocks that shots cite; propose the whole block list as it should read, keeping an existing block's id when only its text changes. Read the season and the episode this scene serves with get_production(${context.productionId}) before deciding against them.`,
      ];
      if (scene?.script && scene.script.blocks.length > 0) {
        lines.push(
          `The current blocks: ${scene.script.blocks
            .slice(0, 40)
            .map((b) => `${b.id} [${b.kind}${b.speaker ? ` ${b.speaker}` : ""}] "${clip(b.text)}"`)
            .join("; ")}.`,
        );
      } else if (scene) lines.push("It has no script yet.");
      /*
       * The shots themselves, always. Found by asking: a person in this thread asked what happens
       * in the scene shot by shot, and the studio could only say how many there were — it knew the
       * title, the production and the count, and correctly refused to invent the rest. A scene
       * whose shots are invisible to its own thread cannot be talked about, which is what the
       * thread is for.
       */
      const shape = describeShape(production);
      if (shape) lines.push(shape);
      if (scene) {
        const shots = orderedShots(scene);
        lines.push(
          shots.length > 0
            ? `Its shots, in order: ${shots
                .slice(0, 30)
                .map(
                  (sh) =>
                    `${sh.id} #${sh.number} "${sh.title}"${
                      sh.durationSec !== undefined ? ` (${sh.durationSec}s)` : ""
                    } — "${clip(sh.description)}"`,
                )
                .join("; ")}${shots.length > 30 ? "; …" : ""}.`
            : "It has no shots yet.",
        );
        if (scene.inherits) {
          const { location, timeOfDay, tone } = scene.inherits;
          const parts = [location ? `location ${location}` : null, timeOfDay, tone].filter(Boolean);
          if (parts.length > 0) lines.push(`Every shot inherits: ${parts.join(", ")}.`);
        }
        /*
         * And that they can be changed here. The shots were narrated into this thread before the
         * thread could propose one, so a conversation could describe exactly what a shot should
         * become and then hand the person back to the storyboard to type it in — the one place
         * the workspace stopped being the conversation.
         */
        lines.push(
          "A shot itself can be settled here: propose development.shot naming the shot to amend, or leaving the shot out to add one at the end. Carry only the fields that change. A shot's id and its number are not yours to set, and reordering is the storyboard's drag, not a proposition.",
        );
      }
      const timeline = describeTimeline(production);
      if (timeline) lines.push(timeline);
      return lines.join(" ");
    }
  }
}

function clipLabel(clip: TimelineClip): string {
  const source = clip.source;
  return source.kind === "shot" ? source.shotId : source.kind === "take" ? source.takeId : `"${source.label}"`;
}

/**
 * The timeline as the model may address it (SPEC-039 R-27, issue 684): every clip id, track and
 * frame it could name in an editor request, and the requests already waiting so it does not
 * stage them twice. A story production with no saved record is described from the first
 * assembly its first command would materialise; the song clock is not, because opening it on
 * the timeline is the person's own choice.
 */
function describeTimeline(production: ProductionBundle | undefined): string | null {
  if (!production) return null;
  const state = production.timeline;
  if (state?.status === "invalid") return "The timeline record is invalid, so no editor request can be made until it is repaired.";
  let base: ProductionTimeline;
  let revision: number | null;
  if (state?.status === "ready") {
    base = state.timeline;
    revision = base.revision;
  } else if (production.spine !== null) {
    return "This production is cut to a song and has not been opened on the timeline yet; an editor request needs the person to press Open on the timeline first.";
  } else {
    try {
      base = seedEmptyPictureTimeline(production);
    } catch {
      return null;
    }
    revision = null;
  }
  const tracks = [...base.tracks]
    .sort((a, b) => a.order - b.order)
    .slice(0, 12)
    .map((track) => {
      const clips = orderedTrackClips(track);
      const items = clips
        .slice(0, 40)
        .map((clip) => `${clip.id} ${clipLabel(clip)} ${clip.startFrame}–${clip.startFrame + clip.durationFrames}f`)
        .join(", ");
      return `${track.id} (${track.kind}${track.muted ? ", muted" : ""}): ${items || "empty"}${clips.length > 40 ? ", …" : ""}`;
    });
  const pending = production.editorRequests.filter((request) => request.status === "pending");
  const waiting =
    pending.length > 0
      ? ` Requests already waiting for their decision: ${pending
          .slice(0, 6)
          .map((request) => `${request.id} "${request.summary.slice(0, 80)}"`)
          .join("; ")}.`
      : "";
  return `The production timeline ${
    revision === null
      ? "has not been saved yet; a first request materialises the story order below"
      : `is revision ${revision}`
  }, ${base.frameRate} fps, frames counted from zero. Tracks — ${tracks.join("; ")}. An editor request names these clip ids exactly; the person accepts or rejects it on its card.${waiting}`;
}

/**
 * What kind of thing is being made, and what that kind asks of an episode (design turn 99).
 *
 * Found by asking (2026-08-21): a season thread proposed seven excellent episodes that read like
 * short-film beats, because nothing had told it they were forty-five-second vertical ones. The
 * kind and its numbers were on disk from the moment the production was created — episode count,
 * the length range, the hook window, the frame — and none of it reached the turn. A profile that
 * only the screens can see is not a profile.
 *
 * The numbers are stated, never the craft: how to use three seconds is the model's job, but it
 * cannot do that job without being told there are three.
 */
function describeShape(production: ProductionBundle | undefined, writesTheSeason = false): string | null {
  if (!production) return null;
  const shape = productionShape(production.meta);
  const bits: string[] = [];
  const defaults = production.season?.defaults;
  if (shape.isEpisodic) {
    const count = defaults?.episodeCount;
    bits.push(
      `This is a ${shape.kindLabel.toLowerCase()}: a season of ${count !== undefined ? count : "several"} episodes, each one a complete piece that also carries the next.`,
    );
    /*
     * A season longer than one turn can carry, said before it is attempted (2026-08-23).
     *
     * The door promises up to a hundred episodes now, and a turn stages at most
     * `TURN_RESULT_BOUNDS.candidateOperations` operations. A model that reads "eighty episodes" and
     * writes eighty has the whole turn refused for breaking the bound — after doing all the work,
     * which is the failure this file's numbers exist to prevent one level up. Naming the run size
     * turns that into a plan: write a run, say where it stopped, and come back.
     *
     * The run is smaller than the cap because the cap counts everything, not only episodes: a turn
     * that writes a full run and also settles the overview or the season direction would otherwise
     * be one operation over and rejected for doing exactly what it was asked to do.
     *
     * Only the thread that writes the season hears it. `describeShape` also brief the episode and
     * scene threads, and telling a scene thread to write ten episodes is an invitation to propose
     * work nobody asked for while somebody is looking at one scene.
     */
    /*
     * Only while there are episodes left to write. Gated on what remains rather than on what was
     * promised, or a finished sixty-episode season would go on asking for more of them every turn
     * — including in a conversation that opened to change one line of the overview.
     */
    /*
     * Written, not merely existing. The season board creates a tile per promised episode and
     * counts it unwritten until it has a promise ([development.tsx]); counting the tiles instead
     * would read a board of sixty blanks as a finished season and stop asking for the episodes
     * nobody has written yet. Same predicate as the board, so the two agree about what is done.
     */
    const written = (production.episodes ?? []).filter((e) => e.promise?.opens || e.promise?.closes).length;
    const remaining = count === undefined ? 0 : count - written;
    if (writesTheSeason && remaining > EPISODE_RUN) {
      /*
       * A limit, not an instruction to go and write them. Phrased as an imperative it arrived on
       * every turn of an unfinished season — including one opened to change a line of the
       * overview — and told the model to write eight episodes nobody had asked for.
       */
      bits.push(
        `${written} of ${count} episodes are written. When you write more, a run is at most ${EPISODE_RUN} of them and never all ${remaining} at once: say which episodes the run covers and where the next one picks up.`,
      );
      /*
       * The half that makes the loop terminate. A run that is settled and left on the rail is
       * still on the rail next turn, and a wrap-up refuses more than MAX_PROPOSALS at once — so an
       * author following the runs advice for six turns on a sixty-episode season reaches Wrap up
       * and is refused, with every episode unwritten. Wrapping each run is what turns several
       * turns into several seasons' worth of work landing.
       */
      bits.push(
        `One turn records at most ${TURN_RESULT_BOUNDS.candidateOperations} changes of any kind, episodes and everything else together, so a run leaves room for the overview, the season direction, or a world fact that surfaced while writing it. Wrap up each run before starting the next: a single wrap-up carries at most ${MAX_PROPOSALS} changes, and runs left unwritten on the rail accumulate until it refuses them all.`,
      );
    }
    if (defaults?.episodeSecondsMin !== undefined && defaults.episodeSecondsMax !== undefined) {
      bits.push(
        `An episode runs ${defaults.episodeSecondsMin}–${defaults.episodeSecondsMax} seconds — a handful of shots, one turn, one thing left hanging. Anything that needs a second act does not fit.`,
      );
    }
    if (defaults?.hookWindowSec !== undefined) {
      bits.push(
        `The first ${defaults.hookWindowSec} seconds are the hook: whatever makes somebody stay has to be inside them, not built toward.`,
      );
    }
  } else {
    bits.push(`This is a ${shape.displayLabel.toLowerCase()} — one continuous piece, not episodes.`);
  }
  /*
   * Only a picture has a frame (review 2026-08-22): `productionAspect` defaults to 16:9 when
   * unset, and narrating that default to a Story thread told the model prose "delivers in
   * 16:9" — a fabricated fact it would then honour.
   */
  if (shape.medium === "video") {
    const aspect = productionAspect(production.meta);
    bits.push(
      `It delivers in ${aspect}${aspect === "9:16" ? ", so blocking is vertical: one subject, close, and the frame cannot hold a wide two-shot" : ""}.`,
    );
  }
  return bits.join(" ");
}

/** Bounded quotation: enough to recognise the text, never the whole document. */
function clip(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 197)}…`;
}
