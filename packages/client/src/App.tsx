import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useEffect, useRef } from "react";
import { SettingsDownloadsScreen } from "./screens/settings-downloads.js";
import { SettingsDiagnosticsScreen } from "./screens/settings-diagnostics.js";
import { SettingsModelsScreen } from "./screens/settings-models.js";
import { SettingsProvidersScreen } from "./screens/settings-providers.js";
import {
  ActivityScreen,
  FirstRunScreen,
  StartupScreen,
  NewWorldScreen,
  SettingsAboutScreen,
  SettingsAppearanceScreen,
  SettingsLayout,
  SettingsHarnessScreen,
  SettingsNotificationsScreen,
  SettingsSampleWorldScreen,
  SettingsSignInScreen,
  SettingsGeneralScreen,
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
import { PropDetailScreen, PropsScreen } from "./screens/props.js";
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
  ChapterTreeScreen,
  CutScreen,
  GenerateScreen,
  ProductionCastScreen,
  ProductionHomeScreen,
  ProductionLayout,
  SceneDetailScreen,
  ScenesScreen,
  ProductionChatScreen,
  StoryScreen,
  VoiceLineDialogScreen,
} from "./screens/production.js";
import { ChapterScreen } from "./screens/chapter-workspace.js";
import { ShotSheetScreen } from "./screens/storyboard.js";
import { StoryStructureScreen } from "./screens/development.js";
import { BranchMapScreen } from "./screens/branch-map.js";
import { QueueToaster } from "./components/queue-toaster.js";
import { ImageContextMenu } from "./components/image-context-menu.js";
import { PlayerDock } from "./components/player.js";
import { useThemePreference } from "./lib/theme.js";
import { dismissPlayback } from "./lib/audio.js";
import { replyToPermission, usePermissions, useUpdateStatus } from "./lib/store.js";
import { Button, Callout } from "./components/ui.js";

export function PermissionBackstops() {
  const permissions = Object.entries(usePermissions());
  if (permissions.length === 0) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: "fixed",
        top: "var(--space-4)",
        right: "var(--space-4)",
        zIndex: 80,
        maxWidth: 520,
        maxHeight: "calc(100vh - var(--space-8))",
        overflowY: "auto",
      }}
    >
      {permissions.map(([id, permission]) => (
        <Callout key={id} tone="warning" title="The drafting agent is asking permission">
          {permission.description}. This is the backstop, not the gate. Nothing lands in a world without your accept.
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <Button variant="primary" onClick={() => replyToPermission(id, "once")}>Allow once</Button>
            {permission.rememberable ? (
              <Button onClick={() => replyToPermission(id, "always")}>Always allow</Button>
            ) : null}
            <Button variant="ghost" onClick={() => replyToPermission(id, "reject")}>Reject</Button>
          </div>
        </Callout>
      ))}
    </div>
  );
}

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

export function retiredDispatchPath(sceneId: string | null): string {
  return sceneId === null ? "../generate" : `../scenes/${encodeURIComponent(sceneId)}`;
}

function RetiredDispatchRoute() {
  const [searchParams] = useSearchParams();
  return <Navigate to={retiredDispatchPath(searchParams.get("scene"))} replace />;
}

export function retiredSceneChatPath(worldId: string, productionId: string, sceneId: string, shotId: string | null = null): string {
  return `/w/${encodeURIComponent(worldId)}/p/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}${
    shotId === null ? "" : `?shot=${encodeURIComponent(shotId)}`
  }`;
}

function RetiredSceneChatRoute() {
  const { worldId, prodId, sceneId } = useParams();
  const [searchParams] = useSearchParams();
  if (worldId === undefined || prodId === undefined || sceneId === undefined) return <Navigate to="../scenes" replace />;
  return <Navigate to={retiredSceneChatPath(worldId, prodId, sceneId, searchParams.get("shot"))} replace />;
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
      {/* Right-click any picture, anywhere, and copy it. One listener rather than a control on
          each of the twenty-odd frames that draw one. */}
      <ImageContextMenu />
      <PermissionBackstops />
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
            {/* Every model, cloud and local, under the kind it makes (SPEC-042 R-1). Providers
                keeps the credential; this is where the switch is. */}
            <Route path="models" element={<SettingsModelsScreen />} />
            <Route path="sign-in" element={<SettingsSignInScreen />} />
            <Route path="appearance" element={<SettingsAppearanceScreen />} />
            <Route path="notifications" element={<SettingsNotificationsScreen />} />
            <Route path="downloads" element={<SettingsDownloadsScreen />} />
            {/* Local runtime became two screens, and then those two became one pane of Providers
                (SPEC-034 R-5). Every address on the way answers, so a link, a bookmark or a
                remedy written against any of them lands where its content went. */}
            <Route path="local-runtime" element={<Navigate to="/settings/providers" replace />} />
            <Route path="local-ai" element={<Navigate to="/settings/providers" replace />} />
            <Route path="engines" element={<Navigate to="/settings/providers" replace />} />
            <Route path="harness" element={<SettingsHarnessScreen />} />
            {/* Settings › Agents folded into Who does what (design 54b); the old address keeps working. */}
            <Route path="general" element={<SettingsGeneralScreen />} />
            {/* Cloud AI became General when a default stopped having to be a cloud model
                (SPEC-034 R-14). The old address answers. */}
            <Route path="cloud-ai" element={<Navigate to="/settings/general" replace />} />
            {/* Two addresses that no longer name a screen, and they do not land in the same
                place: `agents` named the per-agent overrides, and those are on Harness now, so
                sending it to Cloud AI would land it on the one screen defined by not having
                them. Each goes where its content went. */}
            <Route path="agents" element={<Navigate to="/settings/harness" replace />} />
            <Route path="who-does-what" element={<Navigate to="/settings/general" replace />} />
            <Route path="sample-world" element={<SettingsSampleWorldScreen />} />
            <Route path="diagnostics" element={<SettingsDiagnosticsScreen />} />
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
          <Route path="props" element={<PropsScreen />} />
          <Route path="props/:propId" element={<PropDetailScreen />} />
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
          {/* Scene Chat moved into the scene workspace; old bookmarks retain their subject. */}
          <Route path="story/scenes/:sceneId" element={<RetiredSceneChatRoute />} />
          <Route path="story/chapters" element={<ChapterTreeScreen />} />
          {/* The chapter, opened (turn 126): the scene workspace's sibling, under Chapters. */}
          <Route path="story/chapters/:chapterId" element={<ChapterScreen />} />
          {/* Arcs, themes, setups and payoffs — off the season, under one rail item
              (turn 99): a season is its episodes. */}
          <Route path="story-structure" element={<StoryStructureScreen />} />
          <Route path="scenes" element={<ScenesScreen />} />
          {/* The brief form retired (SPEC-036 R-37): `New scene` makes the scene and opens it, and
              a bookmark to the form lands on the list rather than on a route that writes on load. */}
          <Route path="scenes/new" element={<Navigate to="../scenes" replace />} />
          <Route path="scenes/:sceneId" element={<SceneDetailScreen />} />
          {/* The full shot behind the card (turn 97, 14d). */}
          <Route path="scenes/:sceneId/shots/:shotId" element={<ShotSheetScreen />} />
          {/* Interactive video's structural authority (epic 401) — linear seasons never route here. */}
          <Route path="branch-map" element={<BranchMapScreen />} />
          <Route path="generate" element={<GenerateScreen />} />
          <Route path="generate/dispatch" element={<RetiredDispatchRoute />} />
          <Route path="generate/voice-line" element={<VoiceLineDialogScreen />} />
          <Route path="cut" element={<CutScreen />} />
          {/* The editor owns sound and delivery now (SPEC-039 R-1, T-5): the old addresses land in it. */}
          <Route path="audio" element={<Navigate to="../cut?library=audio" replace />} />
          <Route path="exports" element={<Navigate to="../cut?export=1" replace />} />
          {/* Stills is a lens on Generate now (design 55a); the old address keeps working. */}
          <Route path="stills" element={<Navigate to="../generate?view=stills" replace />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
