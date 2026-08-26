import { Route, Routes, useLocation, useNavigate } from "react-router";
import { useEffect, useRef } from "react";
import {
  ActivityScreen,
  FirstRunScreen,
  StartupScreen,
  NewWorldScreen,
  SettingsAboutScreen,
  SettingsAppearanceScreen,
  SettingsLayout,
  SettingsHarnessScreen,
  SettingsLocalRuntimeScreen,
  SettingsNotificationsScreen,
  SettingsProvidersScreen,
  SettingsSampleWorldScreen,
  SettingsWhoDoesWhatScreen,
  ShellChrome,
  WorldPickerScreen,
} from "./screens/shell.js";
import { BuildingScreen } from "./screens/building.js";
import { LaunchScreen } from "./screens/launch.js";
import { ArtDirectionProposalScreen, ArtDirectionScreen } from "./screens/art-direction.js";
import { BenchScreen } from "./screens/bench.js";
import { BibleScreen } from "./screens/bible.js";
import { ProposalsScreen } from "./screens/proposals.js";
import { WorldChatScreen } from "./screens/world-chat.js";
import {
  CharacterLooksScreen,
  CharacterReferenceScreen,
  GenerateCharacterSheetScreen,
  ReplaceMainPhotoScreen,
} from "./screens/character-reference.js";
import { LocationReferenceScreen } from "./screens/location-reference.js";
import {
  ArtifactsScreen,
  CanonEntryScreen,
  CanonScreen,
  CanonThreadScreen,
  CastScreen,
  CharacterDetailScreen,
  CharacterEditScreen,
  FactionsScreen,
  LocationDetailScreen,
  LocationsScreen,
  NewCanonScreen,
  NewCharacterScreen,
  NewLocationScreen,
  NewProductionScreen,
  ProductionsScreen,
  VoicePickerScreen,
  WorldLayout,
  WorldOverviewScreen,
} from "./screens/world.js";
import { EpisodeChatScreen, EpisodeDetailScreen } from "./screens/development.js";
import {
  AudioScreen,
  ChapterTreeScreen,
  CutScreen,
  DispatchDialogScreen,
  ExportsScreen,
  GenerateScreen,
  NewSceneScreen,
  ProductionCastScreen,
  ProductionHomeScreen,
  ProductionLayout,
  SceneChatScreen,
  SceneDetailScreen,
  ScenesScreen,
  ProductionChatScreen,
  StoryScreen,
  VoiceLineDialogScreen,
} from "./screens/production.js";
import { ShotSheetScreen } from "./screens/storyboard.js";
import { StoryStructureScreen } from "./screens/development.js";
import { BranchMapScreen } from "./screens/branch-map.js";
import { Navigate } from "react-router";
import { QueueToaster } from "./components/queue-toaster.js";
import { PlayerDock } from "./components/player.js";
import { useThemePreference } from "./lib/theme.js";
import { dismissPlayback } from "./lib/audio.js";
import { useUpdateStatus } from "./lib/store.js";

export function UpdateTransition() {
  const update = useUpdateStatus();
  if (update?.status !== "shutting-down" && update?.status !== "installing") return null;
  return (
    <div className="fy-update-transition" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <div className="fy-update-transition__panel">
        <div className="fy-update-transition__pulse" aria-hidden="true" />
        <h1 id="update-title">Finishing local work...</h1>
        <p>Arke Studio will install the update and {update.flow === "restart" ? "reopen" : "remain closed"}.</p>
      </div>
    </div>
  );
}

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  useThemePreference();
  useEffect(() => window.arke?.onActivateActivity?.(() => navigate("/activity")), [navigate]);
  // The dock survives navigation (design 25c). It clears on an explicit dismiss or on leaving
  // this world for another — a clip from the world you just closed has nothing to say here.
  const openWorld = /^\/w\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
  const lastWorld = useRef<string | null>(null);
  useEffect(() => {
    if (openWorld === null) return;
    if (lastWorld.current !== null && lastWorld.current !== openWorld) dismissPlayback();
    lastWorld.current = openWorld;
  }, [openWorld]);
  return (
    <>
      {/* The window has no native title bar to grab, so the top 44px is the app's own chrome
          on every screen — not only the ones that happen to draw a titlebar. Invisible, takes
          no clicks, contributes nothing but geometry. */}
      <div className="fy-dragstrip" aria-hidden="true" />
      <QueueToaster />
      <PlayerDock />
      <UpdateTransition />
      <Routes>
        <Route path="/" element={<LaunchScreen />} />
        <Route path="/starting" element={<StartupScreen />} />
        {/* The founding build's watch surface (SPEC-031 §1.8): full-bleed, no world chrome —
            the run needs its world open, and this screen is what keeps it that way. */}
        <Route path="/building/:worldId" element={<BuildingScreen />} />

        <Route element={<ShellChrome />}>
          <Route path="/first-run" element={<FirstRunScreen />} />
          <Route path="/worlds" element={<WorldPickerScreen />} />
          <Route path="/worlds/new" element={<NewWorldScreen />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="providers" replace />} />
            <Route path="providers" element={<SettingsProvidersScreen />} />
            <Route path="appearance" element={<SettingsAppearanceScreen />} />
            <Route path="notifications" element={<SettingsNotificationsScreen />} />
            <Route path="local-runtime" element={<SettingsLocalRuntimeScreen />} />
            <Route path="harness" element={<SettingsHarnessScreen />} />
            {/* Settings › Agents folded into Who does what (design 54b); the old address keeps working. */}
            <Route path="agents" element={<Navigate to="/settings/who-does-what" replace />} />
            <Route path="who-does-what" element={<SettingsWhoDoesWhatScreen />} />
            <Route path="sample-world" element={<SettingsSampleWorldScreen />} />
            <Route path="about" element={<SettingsAboutScreen />} />
          </Route>
          <Route path="/activity" element={<ActivityScreen />} />
        </Route>

        <Route path="/w/:worldId" element={<WorldLayout />}>
          <Route index element={<WorldOverviewScreen />} />
          <Route path="art-direction" element={<ArtDirectionScreen />} />
          <Route path="art-direction/propose" element={<ArtDirectionProposalScreen />} />
          <Route path="bible" element={<BibleScreen />} />
          <Route path="cast" element={<CastScreen />} />
          <Route path="cast/new" element={<NewCharacterScreen />} />
          <Route path="cast/:sheetId" element={<CharacterDetailScreen />} />
          <Route path="cast/:sheetId/edit" element={<CharacterEditScreen />} />
          <Route path="cast/:sheetId/kit" element={<CharacterReferenceScreen />} />
          <Route path="cast/:sheetId/looks" element={<CharacterLooksScreen />} />
          <Route path="cast/:sheetId/main-photo" element={<ReplaceMainPhotoScreen />} />
          <Route path="cast/:sheetId/model-sheet" element={<GenerateCharacterSheetScreen />} />
          <Route path="cast/:sheetId/voice" element={<VoicePickerScreen />} />
          <Route path="proposals" element={<ProposalsScreen />} />
          <Route path="locations" element={<LocationsScreen />} />
          <Route path="locations/new" element={<NewLocationScreen />} />
          <Route path="locations/:sheetId" element={<LocationDetailScreen />} />
          <Route path="locations/:sheetId/reference" element={<LocationReferenceScreen />} />
          <Route path="factions" element={<FactionsScreen />} />
          <Route path="factions/:sheetId" element={<LocationDetailScreen />} />
          <Route path="canon" element={<CanonScreen />} />
          <Route path="canon/new" element={<NewCanonScreen />} />
          <Route path="canon/:entryId" element={<CanonEntryScreen />} />
          <Route path="canon/:entryId/thread" element={<CanonThreadScreen />} />
          <Route path="chat" element={<WorldChatScreen />} />
          <Route path="chat/:conversationId" element={<WorldChatScreen />} />
          <Route path="artifacts" element={<ArtifactsScreen />} />
          <Route path="artifacts/bench" element={<BenchScreen />} />
          <Route path="artifacts/bench/:sessionId" element={<BenchScreen />} />
          <Route path="productions" element={<ProductionsScreen />} />
          <Route path="productions/new" element={<NewProductionScreen />} />
        </Route>

        <Route path="/w/:worldId/p/:prodId" element={<ProductionLayout />}>
          <Route index element={<ProductionHomeScreen />} />
          <Route path="cast" element={<ProductionCastScreen />} />
          {/* Talking and looking are two screens (turn 88): `story` is the conversation that sets
              the foundations up, and the details it produced are read next door — `season` for an
              episodic production, `overview` for one without a season. */}
          <Route path="story" element={<ProductionChatScreen />} />
          <Route path="season" element={<StoryScreen />} />
          <Route path="overview" element={<StoryScreen />} />
          {/* The same pair one level down (turn 91): the episode's chat lives under `story`
              beside the production's own, and the page it lands on sits at production level. */}
          <Route path="story/episodes/:episodeId" element={<EpisodeChatScreen />} />
          <Route path="episodes/:episodeId" element={<EpisodeDetailScreen />} />
          {/* And once more for a scene (turn 94), the level the writing happens at. */}
          <Route path="story/scenes/:sceneId" element={<SceneChatScreen />} />
          <Route path="story/chapters" element={<ChapterTreeScreen />} />
          {/* Arcs, themes, setups and payoffs — off the season, under one rail item
              (turn 99): a season is its episodes. */}
          <Route path="story-structure" element={<StoryStructureScreen />} />
          <Route path="scenes" element={<ScenesScreen />} />
          <Route path="scenes/new" element={<NewSceneScreen />} />
          <Route path="scenes/:sceneId" element={<SceneDetailScreen />} />
          {/* The full shot behind the card (turn 97, 14d). */}
          <Route path="scenes/:sceneId/shots/:shotId" element={<ShotSheetScreen />} />
          {/* Interactive video's structural authority (epic 401) — linear seasons never route here. */}
          <Route path="branch-map" element={<BranchMapScreen />} />
          <Route path="generate" element={<GenerateScreen />} />
          <Route path="generate/dispatch" element={<DispatchDialogScreen />} />
          <Route path="generate/voice-line" element={<VoiceLineDialogScreen />} />
          <Route path="cut" element={<CutScreen />} />
          <Route path="audio" element={<AudioScreen />} />
          <Route path="exports" element={<ExportsScreen />} />
          {/* Stills is a lens on Generate now (design 55a); the old address keeps working. */}
          <Route path="stills" element={<Navigate to="../generate?view=stills" replace />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
