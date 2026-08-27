/**
 * The §2.9 screen inventory. Every id here renders exactly one <Screen data-screen={id}>,
 * and the navigation test walks every samplePath asserting it mounts (SPEC-001 R-7).
 * Sample params come from the fixture world.
 */

export const FIXTURE_WORLD_ID = "01J8F3K2QW9VZX4N7M0RTYB6HC";

const W = `/w/${FIXTURE_WORLD_ID}`;
const P = `${W}/p/saltlight`;

export interface ScreenEntry {
  id: string;
  samplePath: string;
}

export const SCREENS: ScreenEntry[] = [
  // Shell
  { id: "launch", samplePath: "/" },
  { id: "startup", samplePath: "/starting" },
  { id: "first-run", samplePath: "/first-run" },
  { id: "world-picker", samplePath: "/worlds" },
  { id: "new-world", samplePath: "/worlds/new" },
  { id: "building", samplePath: `/building/${FIXTURE_WORLD_ID}` },
  { id: "settings-providers", samplePath: "/settings/providers" },
  { id: "settings-notifications", samplePath: "/settings/notifications" },
  { id: "settings-appearance", samplePath: "/settings/appearance" },
  { id: "settings-local-ai", samplePath: "/settings/local-ai" },
  { id: "settings-engines", samplePath: "/settings/engines" },
  { id: "settings-downloads", samplePath: "/settings/downloads" },
  { id: "settings-harness", samplePath: "/settings/harness" },
  { id: "settings-cloud-ai", samplePath: "/settings/cloud-ai" },
  { id: "settings-sample-world", samplePath: "/settings/sample-world" },
  { id: "settings-about", samplePath: "/settings/about" },
  { id: "activity", samplePath: "/activity" },

  // World
  { id: "world-overview", samplePath: W },
  { id: "proposals", samplePath: `${W}/proposals` },
  { id: "world-art-direction", samplePath: `${W}/art-direction` },
  { id: "art-direction-proposal", samplePath: `${W}/art-direction/propose` },
  { id: "bible", samplePath: `${W}/bible` },
  { id: "cast", samplePath: `${W}/cast` },
  { id: "character-detail", samplePath: `${W}/cast/maren-kest` },
  { id: "character-edit", samplePath: `${W}/cast/maren-kest/edit` },
  { id: "reference-kit", samplePath: `${W}/cast/maren-kest/kit` },
  { id: "character-looks", samplePath: `${W}/cast/maren-kest/looks` },
  { id: "replace-main-photo", samplePath: `${W}/cast/maren-kest/main-photo` },
  { id: "model-sheet-generate", samplePath: `${W}/cast/maren-kest/model-sheet` },
  { id: "voice-picker", samplePath: `${W}/cast/maren-kest/voice` },
  { id: "new-character", samplePath: `${W}/cast/new` },
  { id: "locations", samplePath: `${W}/locations` },
  { id: "location-detail", samplePath: `${W}/locations/the-vigil` },
  { id: "location-reference", samplePath: `${W}/locations/the-vigil/reference` },
  { id: "new-location", samplePath: `${W}/locations/new` },
  { id: "factions", samplePath: `${W}/factions` },
  { id: "canon", samplePath: `${W}/canon` },
  { id: "canon-entry", samplePath: `${W}/canon/CANON-002` },
  { id: "canon-thread", samplePath: `${W}/canon/CANON-044/thread` },
  { id: "new-canon", samplePath: `${W}/canon/new` },
  { id: "world-chat", samplePath: `${W}/chat` },
  { id: "world-chat-conversation", samplePath: `${W}/chat/cv_01J8F3K2QW9VZX4N7M0RTYB6HC` },
  { id: "artifacts", samplePath: `${W}/artifacts` },
  { id: "productions", samplePath: `${W}/productions` },
  { id: "new-production", samplePath: `${W}/productions/new` },

  // Production
  { id: "production-dashboard", samplePath: P },
  { id: "production-cast", samplePath: `${P}/cast` },
  // Talking and looking are two screens (turn 88): the thread, then what it settled.
  { id: "production-chat", samplePath: `${P}/story` },
  { id: "story-overview", samplePath: `${P}/overview` },
  // Arcs, themes, setups and payoffs — off the season and under one rail item (turn 99).
  { id: "story-structure", samplePath: `${P}/story-structure` },
  { id: "chapter-tree", samplePath: `${P}/story/chapters` },
  { id: "scenes", samplePath: `${P}/scenes` },
  { id: "scene-detail", samplePath: `${P}/scenes/sc_04` },
  { id: "shot-sheet", samplePath: `${P}/scenes/sc_04/shots/sh_12` },
  { id: "new-scene", samplePath: `${P}/scenes/new` },
  { id: "generate-workspace", samplePath: `${P}/generate` },
  { id: "dispatch-dialog", samplePath: `${P}/generate/dispatch` },
  { id: "voice-line-dialog", samplePath: `${P}/generate/voice-line` },
  { id: "cut", samplePath: `${P}/cut` },
  { id: "audio", samplePath: `${P}/audio` },
  { id: "exports", samplePath: `${P}/exports` },
  { id: "stills-contact-sheet", samplePath: `${P}/generate?view=stills` },
];
