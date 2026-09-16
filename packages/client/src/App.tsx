import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useEffect, useRef } from "react";
import { isSettingsPath, rememberSettingsReturn, settingsReturnPath } from "./lib/settings-return.js";
import { ProductionSetupScreen } from "./screens/production-setup.js";
import { ProductionNarrativeScreen } from "./screens/production-narrative.js";
import { ProductionArtifactsScreen } from "./screens/production-artifacts.js";
import { SettingsDownloadsScreen } from "./screens/settings-downloads.js";
import { SettingsDiagnosticsScreen } from "./screens/settings-diagnostics.js";
import { SettingsModelsScreen } from "./screens/settings-models.js";
import { SettingsProvidersScreen } from "./screens/settings-providers.js";
import {
  FirstRunScreen,
  StartupScreen,
  SessionRefusal,
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
import { CharacterVoiceScreen } from "./screens/character-voice.js";
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
  WorldLayout,
  WorldOverviewScreen,
} from "./screens/world.js";
import { EpisodeChatScreen, EpisodeDetailScreen } from "./screens/development.js";
import { ChapterTreeScreen, SceneDetailScreen, ScenesScreen, StoryScreen } from "./screens/production-story.js";
import { AudiobookScreen } from "./screens/audiobook.js";
import { CutScreen } from "./screens/cut.js";
import { GenerateScreen } from "./screens/production-generate.js";
import { VoiceLineDialogScreen } from "./screens/production-voice-line.js";
import { ProductionCastScreen } from "./screens/production-cast.js";
import { ProductionHomeScreen } from "./screens/production-dashboard.js";
import { ProductionLayout, ProductionChatScreen } from "./screens/production-shell.js";
import { ChapterScreen } from "./screens/chapter-workspace.js";
import { ShotPage } from "./screens/scene-workspace/shot-page.js";
import { StoryStructureScreen } from "./screens/development.js";
import { BranchMapScreen } from "./screens/branch-map.js";
import { QueueToaster } from "./components/queue-toaster.js";
import { ActivityPanel } from "./components/activity-panel.js";
import { openActivityPanel, openActivityPanelOnArrival } from "./lib/activity-panel.js";
import { ImageContextMenu } from "./components/image-context-menu.js";
import { PlayerDock } from "./components/player.js";
import { useThemePreference } from "./lib/theme.js";
import { dismissPlayback } from "./lib/audio.js";
import { replyToPermission, usePermissions, useUpdateStatus } from "./lib/store.js";
import { Button, Callout } from "./components/ui.js";
import { RouteErrorBoundary } from "./components/route-error-boundary.js";

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

/**
 * `/activity` no longer renders a page (design turn 136, SPEC-014 R-20). Old links, the desktop's
 * notification click of earlier builds and any bookmark still land: on Home, with the panel open
 * on the Inbox. The panel opens once the redirect has landed, so it opens over the screen it will
 * stay on rather than over the redirect it would otherwise close on.
 */
export function ActivityRoute() {
  const navigate = useNavigate();
  useEffect(() => {
    openActivityPanelOnArrival("inbox");
    navigate("/worlds", { replace: true });
  }, [navigate]);
  return null;
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

/**
 * Settings, as a sheet over the screen it was opened from (design turn 150; SPEC-042 R-5 amended).
 *
 * The routes are the page's, unchanged — every link, remedy and bookmark written against
 * `/settings/<tab>` still lands — but they render in their own tree, against the real address,
 * while the screen tree below renders the route the gear remembered (SPEC-042 R-6). That is the
 * one thing the old panel never did: the screen you left stays mounted behind the scrim, and
 * Escape, the scrim and the close put you back on it without a remount.
 */
function SettingsRoutes() {
  return (
    <Routes>
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
      {/* An address under /settings that names no pane — lands on the first pane rather than
          falling out to the launch screen with the sheet open over nothing. */}
      <Route path="/settings/*" element={<Navigate to="/settings/providers" replace />} />
    </Routes>
  );
}

export function App() {
  const location = useLocation();
  useThemePreference();
  // A background notification's click opens the panel over whatever is showing (SPEC-014 R-20).
  useEffect(() => window.arke?.onActivateActivity?.(() => openActivityPanel("inbox")), []);
  // The dock survives navigation (design 25c). It clears on an explicit dismiss or on leaving
  // this world for another — a clip from the world you just closed has nothing to say here.
  const inSettings = isSettingsPath(location.pathname);
  // Every way into Settings — the gear, a remedy's button, a chip that opens the narrator's
  // setting — has the sheet open over the screen the person was on, and returns there: the last
  // address outside Settings is remembered here, on every change of address, rather than by each
  // caller remembering to (SPEC-042 R-6; Codex on PR 1214 found three that did not).
  useEffect(() => {
    if (!inSettings) rememberSettingsReturn(location.pathname + location.search);
  }, [inSettings, location.pathname, location.search]);
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
      <SessionRefusal />
      <QueueToaster />
      <ActivityPanel />
      {/* Right-click any picture, anywhere, and copy it. One listener rather than a control on
          each of the twenty-odd frames that draw one. */}
      <ImageContextMenu />
      <PermissionBackstops />
      <PlayerDock />
      <UpdateTransition />
      {/* While the address is a Settings route, the screen tree renders the route the gear
          remembered — the world picker where nothing was — and the sheet renders over it. Each
          tree fails on its own: a screen that throws is replaced by the failure screen behind
          the sheet, not the sheet with it, so Settings stays reachable from a broken screen. */}
      <RouteErrorBoundary>
      <Routes location={inSettings ? settingsReturnPath() : location}>
        <Route path="/" element={<LaunchScreen />} />
        <Route path="/starting" element={<StartupScreen />} />
        {/* The founding build's watch surface (SPEC-031 §1.8): full-bleed, no world chrome —
            the run needs its world open, and this screen is what keeps it that way. */}
        <Route path="/building/:worldId" element={<BuildingScreen />} />

        <Route element={<ShellChrome />}>
          <Route path="/first-run" element={<FirstRunScreen />} />
          <Route path="/worlds" element={<WorldPickerScreen />} />
          <Route path="/worlds/new" element={<NewWorldScreen />} />
          {/* The page is retired (design turn 136); its route lands on Home with the panel open. */}
          <Route path="/activity" element={<ActivityRoute />} />
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
          <Route path="cast/:sheetId/voice" element={<CharacterVoiceScreen />} />
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
          <Route path="productions/setup/:setupId" element={<ProductionSetupScreen />} />
        </Route>

        <Route path="/w/:worldId/p/:prodId" element={<ProductionLayout />}>
          <Route index element={<ProductionHomeScreen />} />
          <Route path="cast" element={<ProductionCastScreen />} />
          {/* The production's own shelf (design 134, SPEC-020 R-13). The rail row used to address
              the world's `/artifacts`, which is the one surface that excludes what a production
              owns; this is inside the production, so pressing it keeps the rail and the crumb. */}
          <Route path="artifacts" element={<ProductionArtifactsScreen />} />
          {/* Talking and looking are two screens (turn 88): `story` is the conversation that sets
              the foundations up, and the details it produced are read next door — `season` for an
              episodic production, `overview` for one without a season. */}
          <Route path="story" element={<ProductionChatScreen />} />
          <Route path="season" element={<StoryScreen />} />
          <Route path="overview" element={<StoryScreen />} />
          <Route path="narrative" element={<ProductionNarrativeScreen />} />
          {/* The same pair one level down (turn 91): the episode's chat lives under `story`
              beside the production's own, and the page it lands on sits at production level. */}
          <Route path="story/episodes/:episodeId" element={<EpisodeChatScreen />} />
          <Route path="episodes/:episodeId" element={<EpisodeDetailScreen />} />
          {/* Scene Chat moved into the scene workspace; old bookmarks retain their subject. */}
          <Route path="story/scenes/:sceneId" element={<RetiredSceneChatRoute />} />
          <Route path="story/chapters" element={<ChapterTreeScreen />} />
          {/* The chapter, opened (turn 126): the scene workspace's sibling, under Chapters. */}
          <Route path="story/chapters/:chapterId" element={<ChapterScreen />} />
          {/* The audiobook's door (turn 146, SPEC-047 R-29): a row a chapter, its state, one priced batch. */}
          <Route path="story/audiobook" element={<AudiobookScreen />} />
          {/* Arcs, themes, setups and payoffs — off the season, under one rail item
              (turn 99): a season is its episodes. */}
          <Route path="story-structure" element={<StoryStructureScreen />} />
          <Route path="scenes" element={<ScenesScreen />} />
          {/* The brief form retired (SPEC-036 R-37): `New scene` makes the scene and opens it, and
              a bookmark to the form lands on the list rather than on a route that writes on load. */}
          <Route path="scenes/new" element={<Navigate to="../scenes" replace />} />
          <Route path="scenes/:sceneId" element={<SceneDetailScreen />} />
          {/* The shot as a page (turn 145): the route 97's Advanced sheet used, now the shot's home. */}
          <Route path="scenes/:sceneId/shots/:shotId" element={<ShotPage />} />
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
      </RouteErrorBoundary>
      {inSettings && (
        <RouteErrorBoundary>
          <SettingsRoutes />
        </RouteErrorBoundary>
      )}
    </>
  );
}
