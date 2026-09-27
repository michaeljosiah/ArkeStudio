import { ClientStateSchema } from "@arke-studio/contracts";
import { FIXTURE_STATE } from "./fixture-state.js";

/** Shared DOM/browser fixture; the responsive screens use the ordinary store and commands. */
export function productionsLayoutFixture() {
  const state = structuredClone(FIXTURE_STATE);
  const world = state.world!;
  const film = world.productions[0]!;
  film.meta.aspect = "16:9";
  film.meta.models = { video: "seedance-2.0" };
  film.takes.push(...film.takes.map((take, i) => ({ ...structuredClone(take), id: `tk_01J8F0000000000000000000C${i + 2}`, completedAt: "2026-07-30T15:00:00Z" })));
  const story = structuredClone(film);
  story.meta = { ...story.meta, id: "ledger", format: "story", medium: "story", title: "The Ledger of Nights", logline: "Four watches, two hundred years apart, written in the same hand." };
  story.scenes = []; story.sceneFiles = {}; story.takes = []; story.selections = {};
  story.story = { version: 3, targetLength: "24 chapters" };
  story.chapters = Array.from({ length: 24 }, (_, i) => ({ id: `chapter-${i + 1}`, file: `chapter-${i + 1}`, order: i + 1, title: `Watch ${i + 1}`, status: "planned" as const, version: 1, words: i < 4 ? 2000 : 0 }));
  world.productions = [story, film];
  return ClientStateSchema.parse(state);
}

export function episodicLayoutFixture() {
  const state = productionsLayoutFixture();
  const film = state.world!.productions[1]!;
  film.meta.medium = "video";
  film.meta.kind = "microdrama";
  film.season = { version: 1, question: "Who is ringing the drowned bell?", ending: "The watch answers.", defaults: { episodeSecondsMin: 45, episodeSecondsMax: 75 } };
  film.episodes = Array.from({ length: 4 }, (_, i) => ({ id: `ep_watch-${i + 1}`, order: i + 1, version: 1, title: `The watch ${i + 1}`, scenes: i === 0 ? film.scenes.map(scene => scene.id) : [] }));
  film.episodeFiles = Object.fromEntries(film.episodes.map(episode => [episode.id, episode.id]));
  return ClientStateSchema.parse(state);
}
