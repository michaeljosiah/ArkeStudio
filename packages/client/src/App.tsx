import { Route, Routes, useLocation, useNavigate } from "react-router";
import { useEffect } from "react";
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
import { useThemePreference } from "./lib/theme.js";
import { stopAudio } from "./lib/audio.js";

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  useThemePreference();
  useEffect(() => window.arke?.onActivateActivity?.(() => navigate("/activity")), [navigate]);
  useEffect(() => stopAudio, [location.pathname]);
  return (
    <>
      {/* The window has no native title bar to grab, so the top 44px is the app's own chrome
          on every screen — not only the ones that happen to draw a titlebar. Invisible, takes
          no clicks, contributes nothing but geometry. */}
      <div className="fy-dragstrip" aria-hidden="true" />
      <QueueToaster />
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
          <Route path="locations" element={<LocationsScreen />} />
          <Route path="locations/new" element={<NewLocationScreen />} />
          <Route path="locations/:sheetId" element={<LocationDetailScreen />} />
          <Route path="factions" element={<FactionsScreen />} />
          <Route path="factions/:sheetId" element={<LocationDetailScreen />} />
          <Route path="canon" element={<CanonScreen />} />
          <Route path="canon/new" element={<NewCanonScreen />} />
          <Route path="canon/:entryId" element={<CanonEntryScreen />} />
          <Route path="canon/:entryId/thread" element={<CanonThreadScreen />} />
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
