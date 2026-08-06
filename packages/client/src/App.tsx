import { Route, Routes, useLocation, useNavigate } from "react-router";
import { useEffect, useRef } from "react";
import {
  ActivityScreen,
  FirstRunScreen,
  LaunchScreen,
  NewWorldScreen,
  SettingsAboutScreen,
  SettingsAppearanceScreen,
  SettingsLayout,
  SettingsLocalRuntimeScreen,
  SettingsNotificationsScreen,
  SettingsProvidersScreen,
  SettingsWhoDoesWhatScreen,
  ShellChrome,
  WorldPickerScreen,
} from "./screens/shell.js";
import { SettingsAgentsScreen } from "./screens/agents.js";
import { ArtDirectionProposalScreen, ArtDirectionScreen } from "./screens/art-direction.js";
import { ProposalsScreen } from "./screens/proposals.js";
import { WorldChatConversationScreen, WorldChatScreen } from "./screens/world-chat.js";
import {
  CharacterLooksScreen,
  CharacterReferenceScreen,
  GenerateCharacterSheetScreen,
  ReplaceMainPhotoScreen,
} from "./screens/character-reference.js";
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
import {
  AudioScreen,
  ChapterTreeScreen,
  CutScreen,
  DispatchDialogScreen,
  ExportsScreen,
  GenerateScreen,
  NewSceneScreen,
  ProductionDashboardScreen,
  ProductionLayout,
  SceneDetailScreen,
  ScenesScreen,
  StillsScreen,
  StoryScreen,
  VoiceLineDialogScreen,
} from "./screens/production.js";
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
            <Route path="agents" element={<SettingsAgentsScreen />} />
            <Route path="who-does-what" element={<SettingsWhoDoesWhatScreen />} />
            <Route path="about" element={<SettingsAboutScreen />} />
          </Route>
          <Route path="/activity" element={<ActivityScreen />} />
        </Route>

        <Route path="/w/:worldId" element={<WorldLayout />}>
          <Route index element={<WorldOverviewScreen />} />
          <Route path="art-direction" element={<ArtDirectionScreen />} />
          <Route path="art-direction/propose" element={<ArtDirectionProposalScreen />} />
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
          <Route path="factions" element={<FactionsScreen />} />
          <Route path="factions/:sheetId" element={<LocationDetailScreen />} />
          <Route path="canon" element={<CanonScreen />} />
          <Route path="canon/new" element={<NewCanonScreen />} />
          <Route path="canon/:entryId" element={<CanonEntryScreen />} />
          <Route path="canon/:entryId/thread" element={<CanonThreadScreen />} />
          <Route path="chat" element={<WorldChatScreen />} />
          <Route path="chat/:conversationId" element={<WorldChatConversationScreen />} />
          <Route path="artifacts" element={<ArtifactsScreen />} />
          <Route path="productions" element={<ProductionsScreen />} />
          <Route path="productions/new" element={<NewProductionScreen />} />
        </Route>

        <Route path="/w/:worldId/p/:prodId" element={<ProductionLayout />}>
          <Route index element={<ProductionDashboardScreen />} />
          <Route path="story" element={<StoryScreen />} />
          <Route path="story/chapters" element={<ChapterTreeScreen />} />
          <Route path="scenes" element={<ScenesScreen />} />
          <Route path="scenes/new" element={<NewSceneScreen />} />
          <Route path="scenes/:sceneId" element={<SceneDetailScreen />} />
          <Route path="generate" element={<GenerateScreen />} />
          <Route path="generate/dispatch" element={<DispatchDialogScreen />} />
          <Route path="generate/voice-line" element={<VoiceLineDialogScreen />} />
          <Route path="cut" element={<CutScreen />} />
          <Route path="audio" element={<AudioScreen />} />
          <Route path="exports" element={<ExportsScreen />} />
          <Route path="stills" element={<StillsScreen />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
