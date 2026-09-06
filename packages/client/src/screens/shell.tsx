import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate, useSearchParams } from "react-router";
import { Badge, Button, Callout, Input, Textarea, cx } from "../components/ui.js";
import { VoicePickerDialog } from "../components/voice-picker.js";
import { SetupTransferControl } from "../components/setup-transfer-control.js";
import { EmptyState } from "../components/layout.js";
import { renderInlineMarkdown } from "../components/inline-markdown.js";
import { JobRow } from "../domain/domain.js";
import { Archive, ChevronDown, ChevronRight, Plus, Sparkle } from "../components/icons.js";
import { AgentsPanel } from "./agents.js";
import {
  CAPABILITY_LABEL,
  CAPABILITY_ROWS,
  RuntimeHead,
  RuntimeSection,
  TONE_CLASS,
} from "./settings-parts.js";
// Providers absorbed both surfaces (SPEC-034 R-5), so its pane draws their parts: the engine
// details unabridged, and one engine's models grouped by the provider that owns them.
import { eligibilityInputs, strandReason } from "../components/dispatch-bar.js";
import { AppChrome } from "../components/chrome.js";
import type { StartupState } from "../arke-bridge.js";
import { Working } from "../components/working.js";
import { Portrait } from "../components/portrait.js";
import { Composer } from "../components/composer.js";
import { Loading } from "../components/loading.js";
import { shortDateTime } from "../lib/format.js";
import { setThemePreference, useResolvedTheme, useThemePreference, type ThemePreference } from "../lib/theme.js";
import { genesisMediaUrl } from "../lib/media.js";
import {
  cancelExport as cancelExportMsg,
  cancelJob,
  checkUpdates,
  attachHostFiles,
  attachHostText,
  archiveWorld,
  beginFoundingBuild,
  generateLookPreview,
  planFoundingBuild,
  runBuildItem,
  useBuildPlans,
  setResearchWeb,
  createSheetFromSentence,
  createWorld,
  deleteJob,
  genesisAttachFiles,
  genesisChat,
  genesisDiscard,
  hostCanAttach,
  chooseClaudeExecutable,
  clearClaudeExecutable,
  detectHarnesses,
  downloadUpdate,
  installUpdateAndRestart,
  installUpdateOnClose,
  generateDiagnostics,
  listProviderCalls,
  openDataFolder,
  openThread,
  openWorld,
  resolveHeldJob,
  retryJobFinalization,
  resumeQueue,
  refreshVendorAuth,
  beginVendorSignIn,
  submitVendorSignInCode,
  submitVendorKey,
  cancelVendorSignIn,
  removeVendorConnection,
  listHarnessModels,
  setBackgroundNotifications,
  setRoutingDefault,
  setHarnessEngine,
  setSpendThreshold,
  installSampleWorld,
  useSampleWorld,
  useArchiveNote,
  useDiagnosticsBundle,
  useProviderCalls,
  useEnvCheck,
  useExports as useExportsState,
  useGenesis,
  useSetup,
  useReconcileReport,
  useStore,
  useUpdateStatus,
  useVoiceSidecar as useVoiceSidecarState,
  setNarrator,
  type ReadingVoice,
} from "../lib/store.js";
import { ArtStyleGrid, ArtStyleWords } from "../components/art-style-picker.js";
import { seedFrom } from "../lib/art-styles.js";
import {
  computeNeedsYou,
  computeRunning,
  formatMicroUsd,
  jobActions,
  jobOrigin,
  modelCapabilityCopy,
  PROVIDERS as PROVIDER_TABLE,
  spendSummary,
  type Capability,
  type ComponentHealth,
  type HarnessAvailability,
  type HarnessEngine,
  OPENCODE_AVAILABILITY,
  type LedgerEntry,
  type ManifestModel,
  type ProviderId,
  type ProviderCallRecord,
  type VendorAuthMethod,
  type VendorIntegration,
  type VendorSignIn,
  DEFAULT_NARRATOR,
  blueprintCoverage,
  buildWorkingLine,
  estimateImageMicroUsd,
  legacyVoiceModel,
  modelForCapability,
  supportsVoiceUse,
  ulid,
  ENGINE_LABEL,
  engineOfProvider,
  modelEligible,
} from "@arke-studio/contracts";


export function ShellChrome() {
  // Every shell screen carries its own chrome (prototype 1a/5a/22a/26a) — no shared bar.
  return (
    <div className="scr-frame__content" style={{ height: "100%" }}>
      <Outlet />
    </div>
  );
}

// ---- Launch ----------------------------------------------------------------

/**
 * What setup actually does, in the order it happens. A step is "settled" once its outcome is
 * known — and "not configured" is a settled outcome, not a failure: the app is usable in every
 * one of them (R-6). Progress counts settled steps, so the bar never stalls on an absent
 * optional runtime.
 */
function setupSteps(
  connection: string,
  state: ReturnType<typeof useStore>["state"],
  envChecked: boolean,
): Array<{ label: string; state: string; settled: boolean }> {
  const outcome = (health: ComponentHealth | undefined): { state: string; settled: boolean } => {
    if (!health || health.status === "starting") return { state: "starting…", settled: false };
    if (health.status === "healthy") return { state: "ready", settled: true };
    return { state: health.reason ?? health.status, settled: true };
  };
  return [
    {
      label: "Studio core",
      ...(connection === "open" && state !== null
        ? { state: "ready", settled: true }
        : { state: connection === "closed" ? "retrying…" : "starting…", settled: false }),
    },
    {
      label: "Your data folder",
      ...(envChecked ? { state: "checked", settled: true } : { state: "checking…", settled: false }),
    },
    { label: "Authoring (OpenCode)", ...outcome(state?.app.health.harness) },
    { label: "Local voice (Voxa)", ...outcome(state?.app.health.voice) },
  ];
}

function mb(bytes: number): string {
  const m = bytes / (1024 * 1024);
  return m >= 1024 ? `${(m / 1024).toFixed(1)} GB` : `${Math.round(m)} MB`;
}

/**
 * The setup reel. Kept in public/ rather than imported, so it stays a plain file the bundler
 * copies as-is — and so the route tests, which render every screen through node's loader, do
 * not have to know how to load an mp4. Relative, because the packaged app opens over file://.
 */
const SETUP_REEL = "./setup-reel.mp4";

/** Has this machine asked for less movement? Server-rendered tests have no matchMedia. */
function stillPreferred(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * The one line shown wherever a screen is waiting on a coordinator that is not there.
 *
 * Three screens had reason to say it — the setup reel, the same reel with nothing to download,
 * and the settings pane, whose rows draw `—` from an absent snapshot exactly as they draw `—`
 * from an unconfigured provider (issue 599). Three copies of one sentence drift; one does not.
 * The remedy stays in it because the case that produces this is nearly always a dev browser
 * session, and it self-qualifies for the case that is not.
 */
function WaitingForCoordinator() {
  return (
    <Callout tone="warning" title="Waiting for the coordinator">
      The app keeps retrying on its own. If this is a dev browser session, start it with
      `npm run dev:coordinator`.
    </Callout>
  );
}

export function StartupScreen() {
  const { connection, state } = useStore();
  const navigate = useNavigate();
  const env = useEnvCheck();
  const setup = useSetup();
  const downloading = setup?.running === true;
  const paused = setup?.components.some((component) => component.state === "paused") === true;
  const [startup, setStartup] = useState<StartupState | null>(() =>
    typeof window === "undefined" ? null : window.arke?.startupState?.() ?? null,
  );
  useEffect(() => window.arke?.onStartupState?.(setStartup), []);

  // Setup never walks off on its own — the user continues when they're ready (no worlds →
  // first run; otherwise the picker, R-8).
  const ready = connection === "open" && state !== null;
  // Nothing left to fetch and somewhere to go: the only state where this screen is finished
  // rather than working.
  const settled = ready && !downloading && !paused;
  const steps = setupSteps(connection, state, env !== null);
  const components = setup?.components ?? [];

  // One bar over the whole job. A check counts 1 once settled; a component counts its own
  // fraction of bytes — and counts as done when it is skipped, blocked or failed, because
  // those are settled outcomes too and the bar must not stall on something never coming.
  const parts = steps.length + components.length;
  const doneParts =
    steps.filter((s) => s.settled).length +
    components.reduce(
      (sum, c) =>
        sum +
        (c.state === "downloading" || c.state === "paused" || c.state === "installing"
          ? c.bytesTotal > 0
            ? Math.min(1, c.bytesDone / c.bytesTotal)
            : 0
          : c.state === "queued"
            ? 0
            : 1),
      0,
    );
  const percent = parts === 0 ? 0 : Math.round((doneParts / parts) * 100);

  // What is happening right now, in the product's words — one line, never a list.
  const active =
    components.find((c) => c.state === "downloading" || c.state === "installing") ??
    components.find((c) => c.state === "paused");
  const outstanding = steps.find((s) => !s.settled);
  const activity = active
    ? `${active.state === "installing" ? "installing" : active.state === "paused" ? "paused" : "downloading"} ${active.displayName.toLowerCase()}`
    : outstanding
      ? `checking ${outstanding.label.toLowerCase()}`
      : "everything ready";

  // Bytes and time remaining, only while there is something to measure.
  const totalBytes = components.reduce((sum, c) => sum + c.bytesTotal, 0);
  const doneBytes = components.reduce((sum, c) => sum + (c.state === "queued" ? 0 : c.state === "downloading" || c.state === "paused" || c.state === "installing" ? c.bytesDone : c.bytesTotal), 0);
  const speed = active?.bytesPerSecond ?? null;
  const remaining = speed !== null && speed > 0 ? Math.round((totalBytes - doneBytes) / speed) : null;

  // Setup happens once. Every launch after it detects the runtimes already on this machine,
  // fetches nothing, and waits only for the coordinator to open — a few seconds with no
  // progress worth reporting. A bar creeping under "Setting up your studio" is then a lie
  // about what is happening and about how often it happens, so that panel is kept for the
  // launch that is actually doing the work: something queued, downloading or installing.
  const fetching = components.some(
    (c) => c.state === "queued" || c.state === "downloading" || c.state === "paused" || c.state === "installing",
  );
  const setupRun = downloading || fetching;

  // The snapshot's version once there is a snapshot; the host's before that, so the one line
  // this screen keeps is not an empty "v" for the length of the wait.
  const version =
    state?.app.version ?? (typeof window === "undefined" ? null : window.arke?.appVersion ?? null);
  const enter = () => {
    if (!settled || !state) return;
    // A run cut off by closing the app returns to the building screen, continuing (SPEC-031
    // R-33) — before the library, because the author left mid-build and is coming back to it.
    const midBuild = state.app.builds.find((build) => build.status === "running");
    if (midBuild) {
      navigate(`/building/${midBuild.worldId}`, { replace: true });
      return;
    }
    navigate(state.worlds.length === 0 ? "/first-run" : "/worlds", { replace: true });
  };

  return (
    <div className="fy-app" data-screen="startup">
      {/* The one screen without the two controls: there is no world open to act on yet, and
          nothing has happened here that a control could take you back to. */}
      <AppChrome controls={false} divided={false} />
      <div className="fy-startup">
        <div className="fy-startup__reel">
          {/* The reel plays while the runtimes come down — the wait is the only time this
              screen is ever seen. Muted and silent by design; a setup screen does not get to
              make noise. Someone who has asked for less motion gets the still first frame. */}
          <video
            className="fy-startup__video"
            src={SETUP_REEL}
            autoPlay={!stillPreferred()}
            loop
            muted
            playsInline
            preload="auto"
          />
        </div>
        <div className="fy-startup__panel">
          {startup?.status === "failed" ? (
            <Callout tone="danger" title="The studio could not start">
              <div>{startup.detail}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <Button variant="primary" onClick={() => window.arke?.retryStartup?.()}>Retry</Button>
                <Button variant="secondary" onClick={() => window.arke?.openDataFolder?.()}>Open data folder</Button>
                <Button variant="ghost" onClick={() => window.arke?.quit?.()}>Quit</Button>
              </div>
            </Callout>
          ) : setupRun && !settled ? (
            <>
          <div className="fy-startup__row">
            <span className="fy-startup__title">Setting up your studio.</span>
          </div>
          <div className="fy-startup__row" style={{ marginTop: 10 }}>
            <span className="fy-mono">{activity}</span>
            <span style={{ flex: 1 }} />
            {speed !== null && speed > 0 && <span className="fy-mono">{mb(speed)}/s</span>}
            {active !== undefined && <SetupTransferControl component={active} />}
          </div>
          <div className="fy-setupbar">
            <div className="fy-setupbar__fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="fy-startup__row" style={{ marginTop: 8 }}>
            <span className="fy-mono">{totalBytes > 0 ? `${mb(doneBytes)} of ${mb(totalBytes)}` : ""}</span>
            <span style={{ flex: 1 }} />
            <span className="fy-mono">{remaining !== null ? aboutLeft(remaining) : ""}</span>
          </div>
          {connection === "closed" && startup?.status !== "initializing" && <WaitingForCoordinator />}
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14, justifyContent: "center" }}>
            <span style={{ font: "400 11.5px var(--font-sans)", color: "var(--muted-foreground)" }}>
              One-time setup. After this, Arke runs on your machine. Your worlds never leave it.
            </span>
            <Button
              variant="primary"
              disabled={!ready}
              title={ready ? undefined : "Waiting for the studio to finish setting up"}
              onClick={() => navigate(state!.worlds.length === 0 ? "/first-run" : "/worlds", { replace: true })}
            >
              {ready ? "Continue in the background →" : "Setting up…"}
            </Button>
          </div>
            </>
          ) : (
            /*
              Nothing to fetch: one control and a version number, and the same control the whole
              way through. The title, the step line, the bar and the byte counts all answered
              "what is it doing" — on a launch that only waits for the coordinator, the honest
              answer is "opening", which a button that says so already gives.
            */
            <>
              {connection === "closed" && startup?.status !== "initializing" && <WaitingForCoordinator />}
              <div className="fy-startup__done">
                <Button
                  variant="primary"
                  disabled={!settled}
                  title={settled ? undefined : "Waiting for the studio to open"}
                  onClick={enter}
                >
                  {settled ? "Continue" : "Loading…"}
                </Button>
                <span className="fy-startup__version">{version === null ? "" : `v${version}`}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** "about 3 min left" — rounded, because a precise wrong number is worse than a vague right one. */
function aboutLeft(seconds: number): string {
  if (seconds < 45) return "under a minute left";
  const mins = Math.round(seconds / 60);
  return mins <= 1 ? "about a minute left" : `about ${mins} min left`;
}

// ---- First run -------------------------------------------------------------

export function FirstRunScreen() {
  const navigate = useNavigate();
  const env = useEnvCheck();
  const sample = useSampleWorld();
  return (
    <div className="fy-app" data-screen="first-run">
      <AppChrome divided={false} />
      <div className="fy-content">
        <div className="fy-hero" style={{ paddingTop: 40 }}>
          <div className="fy-hero__eyebrow">Welcome</div>
          <h1 className="fy-hero__title" style={{ fontSize: 56 }}>
            Every world starts as a name.
          </h1>
          <p className="fy-hero__lede" style={{ maxWidth: 460 }}>
            Give yours one. Characters, canon and productions grow from there, and stay consistent
            because they share it. Nothing here requires an account, a key, a download or a network
            to start.
          </p>
        </div>
        {env && (!env.pathBudgetOk || !env.nativeIndexOk) && (
          <div style={{ maxWidth: 560, margin: "18px auto 0", display: "grid", gap: 10 }}>
            {!env.pathBudgetOk && (
              <Callout tone="warning" title="Your data folder sits too deep">
                {env.pathBudgetDetail}
              </Callout>
            )}
            {!env.nativeIndexOk && (
              <Callout tone="warning" title="The search index could not load">
                {env.nativeIndexDetail}
              </Callout>
            )}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", gap: 40, paddingTop: 46 }}>
          <div className="fy-firstrun__flank" style={{ transform: "rotate(-4deg)" }} />
          <div className="fy-fan__drift">
            <div className="fy-createcard" onClick={() => navigate("/worlds/new")}>
              <div className="fy-createcard__ring">
                <Plus size={22} />
              </div>
              <div className="fy-createcard__title">Your first world</div>
              <div className="fy-createcard__sub">
                A name and a sentence are enough. We'll hold everything it becomes.
              </div>
              <div style={{ marginTop: 4 }}>
                <Button variant="primary">Create a world</Button>
              </div>
            </div>
          </div>
          {/* A blank name is a hard place to start from if you have never seen one of these
              finished. The sample world takes the other side of the fan — solid rather than
              dashed, because unlike the card beside it, this one is not an empty slot. */}
          {sample?.available === true ? (
            <div className="fy-fan__drift" style={{ animationDelay: "0.6s" }}>
              <div
                className="fy-createcard fy-createcard--filled"
                onClick={() => {
                  if (sample.installing) return;
                  installSampleWorld();
                }}
              >
                <div className="fy-createcard__ring">
                  <Sparkle size={22} />
                </div>
                <div className="fy-createcard__title">Or start from ours</div>
                <div className="fy-createcard__sub">
                  The Undersong: a cast, its canon, and a production part-way through. Yours to
                  take apart.
                </div>
                <div style={{ marginTop: 4 }}>
                  <Button disabled={sample.installing}>
                    {sample.installing ? "Installing…" : "Install the sample world"}
                  </Button>
                </div>
                {sample.note?.refused === true && (
                  <div className="fy-createcard__sub" style={{ color: "var(--destructive)" }}>
                    {sample.note.text}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="fy-firstrun__flank" style={{ transform: "rotate(4deg)" }} />
          )}
        </div>
        <div style={{ textAlign: "center", paddingTop: 30 }}>
          <span style={{ font: "400 13px var(--font-sans)", color: "var(--muted-foreground)" }}>
            Already have a canon in documents?{" "}
          </span>
          <span
            style={{ font: "500 13px var(--font-sans)", textDecoration: "underline", textUnderlineOffset: 3, cursor: "pointer" }}
            title="Create the world first; then Artifacts → Import folder files everything and offers to lift facts — gated, grounded, optional."
            onClick={() => navigate("/worlds/new")}
          >
            Import a folder
          </span>
          <span style={{ font: "400 13px var(--font-sans)", color: "var(--muted-foreground)" }}>
            . It files into artifacts, ready to link.
          </span>
        </div>
      </div>
    </div>
  );
}

// ---- World picker ----------------------------------------------------------

/** Home (prototype 1a): the greeting, and every world as a held card with its key art. */
export function WorldPickerScreen() {
  const { state } = useStore();
  const navigate = useNavigate();
  const worlds = state?.worlds ?? [];
  const [confirming, setConfirming] = useState<string | null>(null);
  const archiveNote = useArchiveNote();
  const sample = useSampleWorld();
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const lede =
    worlds.length === 0
      ? "Nothing here yet — a first world is a folder and a sentence."
      : worlds.length === 1
        ? "One world, breathing, or start another."
        : `${["", "", "Two", "Three", "Four", "Five"][worlds.length] ?? worlds.length} worlds, all of them breathing, or start another.`;
  const ROT = [-2.5, 1.8, -1.2, 2.4, -2];
  return (
    <div className="fy-app" data-screen="world-picker">
      {/* No back and no context: this is the top, and the wordmark already says where you are. */}
      <AppChrome divided={false} />
      <div className="fy-content">
        <div className="fy-home-hero">
          <div className="fy-hero__eyebrow">{greeting}</div>
          <h1 className="fy-hero__title fy-hero__title--home" style={{ textAlign: "left" }}>
            Pick up where you left off.
          </h1>
          <p className="fy-hero__lede" style={{ margin: "10px 0 0", maxWidth: 540 }}>
            {lede}
          </p>
          {archiveNote && (
            <div className="fy-set__why" style={{ marginTop: 10 }}>
              <span className={cx("fy-set__dot", archiveNote.refused ? "fy-set__dot--warn" : "fy-set__dot--ok")} />
              <span>{archiveNote.text}</span>
            </div>
          )}
        </div>
        {worlds.length === 0 ? (
          <div style={{ padding: "54px 88px" }}>
            <EmptyState
              title="No worlds yet"
              hint={
                sample?.available === true
                  ? "Create one, install ours to pull apart, or drop an existing world folder into your ArkeStudio directory."
                  : "Create one, or drop an existing world folder into your ArkeStudio directory."
              }
              action={
                <span style={{ display: "inline-flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                  <Button onClick={() => navigate("/first-run")}>Start</Button>
                  {sample?.available === true && (
                    <Button
                      variant="ghost"
                      disabled={sample.installing}
                      onClick={() => installSampleWorld()}
                    >
                      {sample.installing ? "Installing…" : "Install the sample world"}
                    </Button>
                  )}
                </span>
              }
            />
          </div>
        ) : (
          <div className="fy-home-cards">
            {worlds.map((w, i) => (
              <div
                key={w.worldId}
                className="fy-fan__drift"
                style={{ animationDuration: `${7 + (i % 3) * 0.7}s`, animationDelay: `${i * 0.6}s` }}
              >
                <div
                  className="fy-worldcard"
                  style={{ transform: `rotate(${ROT[i % ROT.length]}deg)` }}
                  onClick={() => navigate(`/w/${w.worldId}`)}
                >
                  <div className="fy-worldcard__frame">
                    <Portrait worldSlug={w.slug} path={w.keyArt ?? ""} label={`${w.name}: key art`} radius={10} />
                  </div>
                  {/* Archiving is two clicks and no dialog: the second click is the consent,
                      and the words say what actually happens to the folder. */}
                  {confirming === w.worldId ? (
                    <div className="fy-worldcard__confirm" onClick={(e) => e.stopPropagation()}>
                      <span>Move {w.name} to the archive folder? Nothing is deleted.</span>
                      <span className="fy-worldcard__confirmacts">
                        <button
                          type="button"
                          className="fy-set__b fy-set__b--go"
                          onClick={() => {
                            archiveWorld(w.worldId);
                            setConfirming(null);
                          }}
                        >
                          Archive
                        </button>
                        <button type="button" className="fy-set__b" onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="fy-worldcard__archive"
                      aria-label={`Archive ${w.name}`}
                      title="Archive — moves the folder, deletes nothing"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirming(w.worldId);
                      }}
                    >
                      <Archive size={13} />
                    </button>
                  )}
                  <div className="fy-worldcard__name">{w.name}</div>
                  {/* Always rendered: a world with no logline yet keeps the two-line box empty
                      rather than making its card shorter than the ones beside it. */}
                  <div className="fy-worldcard__logline">{w.logline ?? ""}</div>
                  <div className="fy-worldcard__meta">
                    <span
                      className={cx("fy-dot", (w.attention?.unreviewedTakes ?? 0) > 0 ? "fy-dot--warn" : "fy-dot--ok")}
                    />
                    <span className="fy-worldcard__counts">
                      {w.counts.characters} character{w.counts.characters === 1 ? "" : "s"} · {w.counts.productions}{" "}
                      production{w.counts.productions === 1 ? "" : "s"}
                    </span>
                    <span className="mono">{shortDateTime(w.updated)}</span>
                  </div>
                </div>
              </div>
            ))}
            {/* The card is the target, not the control — the same shape the first-run cards
                already use. It was a <button> holding another one, which is invalid HTML: the
                inner control is unreachable in the accessibility tree, and React refuses to
                hydrate it. The whole card still takes a click; what a keyboard and a screen
                reader land on is the one thing here that names what it does. */}
            <div className="fy-newworldcard" onClick={() => navigate("/worlds/new")}>
              <span className="fy-newprodcard__ring" style={{ width: 46, height: 46 }}>
                <Plus size={20} />
              </span>
              <span style={{ font: "600 17px var(--font-sans)" }}>New world</span>
              <span style={{ font: "400 13px/1.5 var(--font-sans)", color: "var(--muted-foreground)", textAlign: "center", maxWidth: 190 }}>
                Name it. We'll hold the rest.
              </span>
              <span style={{ marginTop: 6 }}>
                <Button>Create a world</Button>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- New world -------------------------------------------------------------

const GENESIS_TONES = ["Quiet dread", "Wonder", "Grim", "Playful"] as const;

/** "Name · one line" → the two halves createSheetFromSentence needs; null until both exist. */
function parseSeed(raw: string): { name: string; sentence: string } | null {
  const m = /^(.*?)(?:·|—|-{2}|,)\s*(.+)$/.exec(raw.trim());
  if (!m) return null;
  const name = m[1]!.trim();
  const sentence = m[2]!.trim();
  return name.length > 0 && sentence.length > 0 ? { name, sentence } : null;
}

/**
 * The review before the press (SPEC-031 R-12): what will be created counted by kind, how
 * many generations that is, spend as one figure — and every precondition that failed,
 * stated on the way in rather than discovered at item nine of fifteen (R-11).
 *
 * A card in the founding conversation, not a route of its own (issue 920). The decision was
 * reached in the thread; a second screen for it was a second stop for a yes already given,
 * and the one spend in the whole flow that left the chat every other decision is made in.
 * The press is still one aggregate authorization (R-13) — the same yes, asked where the
 * author is.
 */
function BuildCard({
  plan: entry,
  pressed,
  settling,
  onDismiss,
  onBuild,
}: {
  plan: { requestId: string; plan: import("@arke-studio/contracts").BuildReview | null; reason?: string } | undefined;
  pressed: boolean;
  /** A turn is in flight: the blueprint under the card is moving, so the press waits. */
  settling: boolean;
  onDismiss: () => void;
  onBuild: () => void;
}) {
  const plan = entry?.plan ?? null;
  const counts: Array<[number, string]> = plan
    ? [
        [plan.counts.characters, plan.counts.characters === 1 ? "character" : "characters"],
        [plan.counts.locations, plan.counts.locations === 1 ? "place" : "places"],
        [plan.counts.factions, plan.counts.factions === 1 ? "faction" : "factions"],
        [plan.counts.threads, plan.counts.threads === 1 ? "open thread" : "open threads"],
      ]
    : [];
  const estimate = plan === null ? null : plan.generations === 0 ? "$0.00" : `~${formatMicroUsd(plan.estimateMicroUsd)}`;
  return (
    <article
      className="fy-actioncard"
      data-status={entry !== undefined && plan === null ? "failed" : pressed ? "running" : "pending"}
      aria-label={plan ? `Build ${plan.worldName}` : "The founding build"}
    >
      <div className="fy-actioncard__head">
        <div>
          <div className="fy-actioncard__reason">new world · the build</div>
          <h3>{plan ? `One press makes ${plan.worldName}.` : "The founding build"}</h3>
        </div>
        {estimate !== null && <span className="fy-actioncard__status">{estimate}</span>}
      </div>
      {entry === undefined ? (
        <Loading inline label="sizing the build" />
      ) : plan === null ? (
        <p className="fy-actioncard__notice">{entry.reason ?? "the build could not be sized"}</p>
      ) : (
        <>
          <p className="fy-actioncard__consequence">
            {counts
              .filter(([count]) => count > 0)
              .map(([count, label]) => `${count} ${label}`)
              .join(" · ")}
          </p>
          <div className="fy-mono" style={{ fontSize: 10 }}>
            {plan.generations} GENERATION{plan.generations === 1 ? "" : "S"}
            {plan.imageModel ? ` · ${plan.imageModel.toUpperCase()}` : ""} · THE CAP
          </div>
          <p className="fy-actioncard__notice">Everything lands settled. Nothing waits for a decision.</p>
          {plan.notes.map((note, index) => (
            <p key={index} className="fy-actioncard__notice">
              {note}
            </p>
          ))}
        </>
      )}
      <div className="fy-actioncard__actions">
        {plan !== null && (
          <Button variant="primary" disabled={pressed || settling} onClick={onBuild}>
            {pressed
              ? "Building…"
              : plan.generations === 0
                ? `Build ${plan.worldName}`
                : `Build ${plan.worldName} · ~${formatMicroUsd(plan.estimateMicroUsd)}`}
          </Button>
        )}
        <Button variant="ghost" disabled={pressed} onClick={onDismiss}>
          Not yet
        </Button>
      </div>
      <div className="fy-actioncard__audit">yes once · nothing asks again</div>
    </article>
  );
}

/** World genesis (prototype 12a): the whole window is the surface — form beside the world-so-far rail. */
export function NewWorldScreen() {
  const { state, connection } = useStore();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [logline, setLogline] = useState("");
  const [tone, setTone] = useState("");
  const [genre, setGenre] = useState("");
  const [firstCharacter, setFirstCharacter] = useState("");
  const [firstLocation, setFirstLocation] = useState("");
  const [submittedName, setSubmittedName] = useState<string | null>(null);
  // The look is asked for, never inferred from the logline (design turn 38). It is the last
  // thing before the world exists, because it is the one answer that applies to every image the
  // world will ever make, and asking it while the logline is still being written would be asking
  // about a world nobody has described yet.
  const [step, setStep] = useState<"draft" | "look" | "words">("draft");
  const [presetId, setPresetId] = useState<string | null>(null);
  const [look, setLook] = useState("");
  // The founding build (SPEC-031): a conversation that settled a name is sized into a card in
  // the thread and founded in one press there; a bare form still creates and seeds the old way.
  const [lookForBuild, setLookForBuild] = useState("");
  const [buildPressed, setBuildPressed] = useState(false);
  const [planRequestId, setPlanRequestId] = useState<string | null>(null);
  const [buildRequestId, setBuildRequestId] = useState<string | null>(null);
  const buildRequestRef = useRef<string | null>(null);
  // Where the words came from: the conversation's own proposal, or a preset seed. The look
  // step arrives pre-filled with the agent's words when it proposed some (SPEC-031 R-3) —
  // the preset grid stays one press away as the override, never the only way in.
  const [lookSource, setLookSource] = useState<"conversation" | "preset" | null>(null);
  const conversationLookRef = useRef<string | null>(null);
  const seededRef = useRef(false);
  const [genMode, setGenMode] = useState<"form" | "chat">("form");
  const modeTouchedRef = useRef(false);
  const genesisIdRef = useRef(`gen-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`);
  const genesisId = genesisIdRef.current;
  const [message, setMessage] = useState("");
  const harnessReady = state?.app.health.harness.status === "healthy";
  const g = useGenesis()[genesisId];
  const turns = g?.turns ?? [];
  const chatRunning = g?.status === "running";
  const blueprint = g?.blueprint ?? null;

  // With a healthy harness, talking is the front door (prototype 12a) — unless the author
  // already picked the form themselves.
  useEffect(() => {
    if (harnessReady && !modeTouchedRef.current) setGenMode("chat");
  }, [harnessReady]);

  const charSeed = parseSeed(firstCharacter);
  const locSeed = parseSeed(firstLocation);
  const shownName = name.trim() || blueprint?.name?.trim() || "";
  const shownLogline = logline.trim() || blueprint?.logline?.trim() || "";
  const shownTone = tone.trim() || blueprint?.tone?.trim() || "";
  const shownGenre = genre.trim() || blueprint?.genre?.trim() || "";
  // Never empty: a sentence of "" fails the frame's schema and the character named in
  // conversation would silently not exist in the created world (SPEC-031 R-8).
  const oneLine = (e: { name: string; line?: string; description?: string }) =>
    e.line ?? e.description ?? e.name;
  const hasBrief = (e: { brief?: object }) => e.brief !== undefined && Object.keys(e.brief).length > 0;
  const draftCharacters = (blueprint?.characters ?? []).filter((c) => c.name !== charSeed?.name);
  const draftLocations = (blueprint?.locations ?? []).filter((l) => l.name !== locSeed?.name);
  const railCharacters = [
    ...(charSeed ? [{ ...charSeed, brief: false }] : []),
    ...draftCharacters.map((c) => ({ name: c.name, sentence: oneLine(c), brief: hasBrief(c) })),
  ];
  const railLocations = [
    ...(locSeed ? [{ ...locSeed, brief: false }] : []),
    ...draftLocations.map((l) => ({ name: l.name, sentence: oneLine(l), brief: hasBrief(l) })),
  ];
  const railFactions = (blueprint?.factions ?? []).map((f) => ({ name: f.name, sentence: oneLine(f) }));
  const coverage = blueprint ? blueprintCoverage(blueprint) : null;
  // A conversation that settled a name builds; anything less creates and seeds the old way.
  const buildMode = blueprint?.name !== undefined;
  const buildPlans = useBuildPlans();
  const reviewPlan = planRequestId === null ? undefined : buildPlans[genesisId]?.[planRequestId];
  const buildResponse = buildRequestId === null ? undefined : buildPlans[genesisId]?.[buildRequestId];
  const visibleBuildPlan = buildResponse?.plan === null ? buildResponse : reviewPlan;
  const myBuild = state?.app.builds.find((build) => build.genesisId === genesisId) ?? null;
  // The look preview (SPEC-031 §1.10): conversation-scoped jobs fold like any other, so the
  // rail reads the queue rather than keeping a private channel.
  const previewJob =
    (state?.app.jobs ?? [])
      .filter((job) => job.worldId === genesisId && job.target.kind === "look-preview")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const previewFile = previewJob?.status === "succeeded" ? previewJob.landedFiles?.[0] : undefined;
  const previewStale =
    previewJob !== null &&
    typeof previewJob.params["lookText"] === "string" &&
    previewJob.params["lookText"] !== blueprint?.look;
  const previewRunning =
    previewJob !== null &&
    (previewJob.status === "queued" || previewJob.status === "submitting" || previewJob.status === "running");
  // The estimate is on the control (R-51): a conversation that could spend by talking would
  // be a way to spend somebody's money by talking.
  const previewEstimate = (() => {
    const manifest = state?.app.manifest;
    if (!manifest) return null;
    const routed = modelForCapability(manifest, state?.app.routing.defaults, "image");
    if (!routed || state?.app.models.disabled.includes(routed.id)) return null;
    return estimateImageMicroUsd(routed, { landscape: true });
  })();
  const sendGenesis = () => {
    if (!harnessReady || chatRunning || message.trim().length === 0) return;
    genesisChat(genesisId, message.trim());
    setMessage("");
  };

  // Attachments here have no artifact id — there is no world to hold one yet. The sandbox
  // de-collides the names, so the name is the identity until Begin turns them into artifacts.
  const attachTarget = { kind: "genesis-attach", genesisId } as const;
  const handed = (g?.attachments ?? []).map((a) => ({ id: a.name, file: a.name, kind: a.kind }));

  // The coordinator opens the new world and re-snapshots; when it lands, seed the optional
  // first sheets through the same gate everything else uses, then go there.
  useEffect(() => {
    if (!submittedName || !state?.world || state.world.meta.name !== submittedName) return;
    const worldId = state.world.meta.worldId;
    if (!seededRef.current) {
      seededRef.current = true;
      // Settled, not proposed. Pressing Begin was the yes; being asked again once per
      // character and once per place is a toll on a decision already made, and a sheet is a
      // sketch that changes by typing in it.
      for (const c of railCharacters.slice(0, 4)) createSheetFromSentence(worldId, "character", c.name, c.sentence, true);
      for (const l of railLocations.slice(0, 4)) createSheetFromSentence(worldId, "location", l.name, l.sentence, true);
      for (const f of railFactions.slice(0, 4)) createSheetFromSentence(worldId, "faction", f.name, f.sentence, true);
      for (const t of (blueprint?.threads ?? []).slice(0, 4)) {
        openThread(worldId, t.length > 80 ? `${t.slice(0, 77)}…` : t, t, []);
      }
      genesisDiscard(genesisId);
    }
    navigate(`/w/${worldId}`, { replace: true });
  }, [submittedName, state?.world, navigate, railCharacters, railLocations, railFactions, blueprint, genesisId]);

  // The build begins server-side from one frame (SPEC-031 R-17); the screen's whole job is
  // to follow it to the building screen the moment the coordinator names the world.
  useEffect(() => {
    if (buildPressed && myBuild) navigate(`/building/${myBuild.worldId}`, { replace: true });
  }, [buildPressed, myBuild, navigate]);
  // A begin the coordinator refused answers with a reasoned plan; the press un-arms so the
  // refusal can be read and the author can go back — never a button stuck on "Building…".
  useEffect(() => {
    if (buildPressed && buildResponse?.plan === null) {
      buildRequestRef.current = null;
      setBuildPressed(false);
    }
  }, [buildPressed, buildResponse]);

  // The card is open once a plan has been asked for. It sits in the thread, so the
  // conversation goes on under it.
  const buildCardOpen = planRequestId !== null;
  // A plan is a picture of one blueprint and one preview state, and the card must never state
  // a count or a loss the build is about to contradict: an unsettled preview carries if it
  // lands before the press (SPEC-031 R-54), and a blueprint that moved under the card is
  // exactly what the coordinator would refuse the press for. Either change asks the plan
  // again. A look the conversation proposed follows the conversation; words the author edited
  // or chose from a preset stay theirs.
  const plannedAgainst = useRef<{ blueprint: typeof blueprint; preview: string | null } | null>(null);
  useEffect(() => {
    if (!buildCardOpen || buildPressed) return;
    const preview = previewJob?.status ?? null;
    const last = plannedAgainst.current;
    if (last !== null && last.blueprint === blueprint && last.preview === preview) return;
    let lookText = lookForBuild;
    if (lookSource === "conversation" && look.trim() === conversationLookRef.current) {
      lookText = blueprint?.look?.trim() ?? "";
      conversationLookRef.current = lookText;
      setLook(lookText);
      setLookForBuild(lookText);
    }
    plannedAgainst.current = { blueprint, preview };
    const requestId = ulid();
    setPlanRequestId(requestId);
    // A refusal answered the blueprint that moved; the fresh plan is the review it asked for.
    setBuildRequestId(null);
    planFoundingBuild(genesisId, requestId, lookText);
  }, [buildCardOpen, buildPressed, previewJob?.status, blueprint, lookForBuild, look, lookSource, genesisId]);

  const openBuildCard = (lookText: string) => {
    setLookForBuild(lookText);
    setBuildRequestId(null);
    plannedAgainst.current = { blueprint, preview: previewJob?.status ?? null };
    const requestId = ulid();
    setPlanRequestId(requestId);
    planFoundingBuild(genesisId, requestId, lookText);
    setStep("draft");
  };

  // Back from the look steps, or the card set aside: the conversation is untouched either way.
  const leaveBuild = () => {
    if (buildPressed) return;
    // A proposal copied verbatim is conversation state, not an override. Let the next turn's
    // proposal replace it; words the author edited or chose from a preset remain their choice.
    if (lookSource === "conversation" && look.trim() === conversationLookRef.current) {
      setLook("");
      setLookSource(null);
      conversationLookRef.current = null;
    }
    plannedAgainst.current = null;
    setPlanRequestId(null);
    setBuildRequestId(null);
    setStep("draft");
  };

  const canCreate = connection === "open" && shownName.length > 0 && submittedName === null;
  const entries =
    1 + railCharacters.length + railLocations.length + railFactions.length + (blueprint?.threads.length ?? 0);

  const begin = (artDirection?: string) => {
    setSubmittedName(shownName);
    createWorld({
      name: shownName,
      ...(shownLogline ? { logline: shownLogline } : {}),
      ...(shownTone ? { tone: shownTone.toLowerCase() } : {}),
      ...(shownGenre ? { genre: shownGenre.toLowerCase() } : {}),
      ...(artDirection && artDirection.trim().length > 0 ? { artDirection: artDirection.trim() } : {}),
      // The conversation's own prose, kept as the world's bible. Not shown on this screen and
      // not confirmed separately: pressing Begin is the yes, and the bible is the one file the
      // author can rewrite immediately without asking anyone.
      ...(blueprint?.bible && blueprint.bible.trim().length > 0 ? { bible: blueprint.bible.trim() } : {}),
      // Whatever was handed to the conversation follows it in. Sent always, not only when
      // something is attached: the sandbox is the source of truth for what is waiting, and the
      // screen's idea of it can lag an event behind.
      genesisId,
    });
  };

  if (step !== "draft") {
    return (
      <div className="fy-app" data-screen="new-world-art-direction">
        <AppChrome
          back={{
            label: genMode === "chat" ? "Back to chat" : "Back to form",
            onClick: leaveBuild,
          }}
          context={{ label: "new world · art direction" }}
        />
        <div className="fy-artstep">
          {step === "look" ? (
            <>
              <div className="fy-artstep__head">
                <div>
                  <div className="fy-artstep__steps">
                    <span className="fy-eyebrow-sm">NEW WORLD · STEP 3 OF 3</span>
                    <i />
                    <i />
                    <i />
                  </div>
                  <h1 className="fy-artstep__h1">How should {shownName || "this world"} look?</h1>
                  <p className="fy-artstep__lede">
                    Pick a starting look. Every image this world makes — characters, locations,
                    shots — follows it until you change it. Nothing here is permanent: you can edit
                    the words on the next screen, or set a different look any time from Art
                    direction.
                  </p>
                </div>
                <div className="fy-artstep__aside">
                  <div className="fy-artstep__asidehead">SAME HARBOUR, NINE TREATMENTS</div>
                  <div className="fy-artstep__asidenote">
                    Each preview is one scene rendered each way, so you compare the treatment and
                    not the subject.
                  </div>
                </div>
              </div>
              <ArtStyleGrid
                selectedId={presetId}
                onSelect={(preset) => {
                  setPresetId(preset?.id ?? null);
                  // The preset seeds the words and is then forgotten. Re-picking the same one
                  // rewrites the draft; that is what picking it again means.
                  setLook(seedFrom(preset));
                  setLookSource("preset");
                  setStep("words");
                }}
              />
              <div className="fy-artstep__foot">
                <span className="fy-artstep__note">
                  Nothing is generated yet. The look is recorded with the world and rides along
                  from here.
                </span>
                <span style={{ flex: 1 }} />
                {/* Skippable, but not hidden: a world with no look is a real state, and it is
                    better said out loud than arrived at by closing a screen. */}
                <Button variant="ghost" disabled={!canCreate} onClick={() => (buildMode ? openBuildCard("") : begin())}>
                  Decide later
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="fy-artstep__steps">
                <span className="fy-eyebrow-sm">NEW WORLD · STEP 3 OF 3</span>
                <i />
                <i />
                <i />
              </div>
              <h1 className="fy-artstep__h1">
                {lookSource === "conversation" ? "The conversation proposed this look." : "The preset writes a first draft."}
              </h1>
              <p className="fy-artstep__lede">
                {lookSource === "conversation"
                  ? "Drawn from the tone, genre and story you just settled. These words ride along with every generation — edit them, replace them, or pick a preset instead."
                  : "These are the words that ride along with every generation. Edit them, or replace them entirely. A preset seeds the text; it never locks it."}
              </p>
              <ArtStyleWords
                selectedId={presetId}
                value={look}
                onChange={setLook}
                {...(lookSource === "conversation" ? { provenance: "PROPOSED IN CONVERSATION" } : {})}
              />
              <div className="fy-artstep__reaches">
                <div className="fy-prov__eyebrow">WHAT THIS LOOK REACHES</div>
                <div>The world image · generated later, from the hub</div>
                <div>Every character kit · main photo and sheet</div>
                <div>Every location and every artifact</div>
                <div>Every shot in every production · unless a production overrides</div>
              </div>
              <div className="fy-artstep__foot">
                <Button variant="ghost" onClick={() => setStep("look")}>
                  Back
                </Button>
                <span style={{ flex: 1 }} />
                <span className="fy-artstep__note">
                  recorded as world look v1 · changing it later goes through the accept gate
                </span>
                <Button
                  variant="primary"
                  disabled={!canCreate || look.trim().length === 0}
                  onClick={() => (buildMode ? openBuildCard(look.trim()) : begin(look))}
                >
                  {submittedName ? "Creating…" : "Looks right"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fy-app" data-screen="new-world">
      <AppChrome back={{ label: "Back", to: "/worlds" }} context={{ label: "new world" }} />
      <div className="fy-gate" style={{ flex: 1, minHeight: 0 }}>
        <div className="fy-gate__main">
          <div className="fy-gate__head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-eyebrow-sm">NEW WORLD</div>
              <h1 className="fy-story__h1">
                {genMode === "chat" ? "Start talking. It starts existing." : "Write it down. It starts existing."}
              </h1>
            </div>
            <span className="fy-seg" style={{ marginTop: 4 }}>
              <button
                type="button"
                className={cx("fy-seg__item", genMode === "chat" && "fy-seg__item--active")}
                disabled={!harnessReady}
                style={harnessReady ? undefined : { cursor: "not-allowed", opacity: 0.55 }}
                title={harnessReady ? undefined : "Chat needs OpenCode running — the form drafts the same world"}
                onClick={() => {
                  modeTouchedRef.current = true;
                  setGenMode("chat");
                }}
              >
                Chat
              </button>
              <button
                type="button"
                className={cx("fy-seg__item", genMode === "form" && "fy-seg__item--active")}
                onClick={() => {
                  modeTouchedRef.current = true;
                  setGenMode("form");
                }}
              >
                Form
              </button>
            </span>
          </div>
          <div className="fy-gate__body" style={{ gap: 14 }}>
            {genMode === "chat" ? (
              <>
                {turns.length === 0 && (
                  <div className="fy-bubble--gate">
                    Say what the world is — a place, a wrongness, a person standing in it. The studio shapes it with
                    you and keeps "the world so far" on the right, all proposed, nothing locked.
                    <div className="fy-bubble__note">everything is drafted from this thread · the world is the record, the chat is scaffolding</div>
                  </div>
                )}
                {turns.map((turn, i) => (
                  <div key={i} className={turn.role === "user" ? "fy-bubble--user" : "fy-bubble--gate"} style={{ whiteSpace: "pre-wrap" }}>
                    {/* The author's words are shown exactly as typed; only Arke writes markdown (issue 911). */}
                    {turn.role === "user" ? turn.text : renderInlineMarkdown(turn.text)}
                  </div>
                ))}
                {/* The look, previewable while the conversation is still a conversation (SPEC-031
                    §1.10): the agent proposed the words; the press and the spend are the author's.
                    Asked in the thread, not in the rail beside it — spend is decided where every
                    other decision here is (issue 920). Build mode only: the legacy create path
                    sweeps the sandbox without a carry, and the card must not promise one. */}
                {buildMode && blueprint?.look !== undefined && (
                  <article
                    className="fy-actioncard"
                    data-status={previewFile !== undefined && !previewStale ? "completed" : "pending"}
                    aria-label="The look"
                  >
                    <div className="fy-actioncard__head">
                      <div>
                        <div className="fy-actioncard__reason">proposed in conversation</div>
                        <h3>The look</h3>
                      </div>
                    </div>
                    <p className="fy-actioncard__consequence">{blueprint.look}</p>
                    {previewFile !== undefined && (
                      <>
                        <img
                          className="fy-actioncard__media"
                          src={genesisMediaUrl(genesisId, previewFile)}
                          alt="The look, previewed"
                        />
                        <div className="fy-mono" style={{ fontSize: 9.5 }}>
                          {previewStale
                            ? "the look changed since this was made · it will not carry"
                            : "carries in as the master look at Begin"}
                        </div>
                      </>
                    )}
                    {previewRunning && <Loading inline label="making the look" />}
                    {(previewJob?.status === "failed" ||
                      previewJob?.status === "cancelled" ||
                      previewJob?.status === "needs-reconciliation") && (
                      <div className="fy-mono" style={{ fontSize: 9.5 }}>
                        {previewJob.status === "cancelled"
                          ? "the preview was cancelled"
                          : previewJob.status === "needs-reconciliation"
                            ? "the preview is held in Activity"
                            : `the preview failed${previewJob.error ? ` — ${previewJob.error}` : ""}`}
                      </div>
                    )}
                    {!previewRunning &&
                      (previewJob === null || previewJob.status === "failed" || previewJob.status === "cancelled" || previewStale) && (
                        <>
                          {/* The build never makes a master look (SPEC-031 R-18): the world gets
                              this preview or none. Said beside the control that answers it, not
                              left for an empty plate on Art direction months later (issue 521). */}
                          <div className="fy-mono" style={{ fontSize: 9.5 }}>
                            without one, this world has no master look
                          </div>
                          <div className="fy-actioncard__actions" style={{ alignItems: "center" }}>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={previewEstimate === null}
                              onClick={() => generateLookPreview(genesisId)}
                            >
                              See the look{previewEstimate !== null ? ` · ~${formatMicroUsd(previewEstimate)}` : ""}
                            </Button>
                            {previewEstimate === null && (
                              <span className="fy-mono" style={{ fontSize: 9.5 }}>
                                needs an image provider
                              </span>
                            )}
                          </div>
                        </>
                      )}
                  </article>
                )}
                {buildMode && buildCardOpen && (
                  <BuildCard
                    plan={visibleBuildPlan}
                    pressed={buildPressed}
                    settling={chatRunning}
                    onDismiss={leaveBuild}
                    onBuild={() => {
                      if (buildRequestRef.current === null) buildRequestRef.current = ulid();
                      setBuildRequestId(buildRequestRef.current);
                      setBuildPressed(true);
                      beginFoundingBuild(genesisId, buildRequestRef.current, lookForBuild);
                    }}
                  />
                )}
                {/* The turn in flight, verb by verb — the same working surface world chat has.
                    A silent stretch while the model reads and writes is indistinguishable from
                    a hang, and this is the first conversation anyone has with the studio. */}
                {chatRunning && <Working label={g?.working ?? null} startedAt={g?.runStartedAt ?? null} />}
                {g?.status === "failed" && g.detail && <div className="fy-mono">the last turn failed — {g.detail}</div>}
                <div style={{ marginTop: "auto" }}>
                  <Composer
                    value={message}
                    onChange={setMessage}
                    onSubmit={sendGenesis}
                    placeholder="Keep going, or ask it to surprise you…"
                    agentLabel="world author"
                    busy={chatRunning || buildPressed}
                    busyLabel={buildPressed ? "founding the world…" : "shaping the draft…"}
                    onAttach={() => genesisAttachFiles(genesisId)}
                    onDictate={(text) => setMessage((prev) => (prev ? `${prev} ${text}` : text))}
                    {...(hostCanAttach()
                      ? {
                          onAttachFiles: (files: readonly File[]) => attachHostFiles(attachTarget, files),
                          onAttachText: (text: string) => attachHostText(attachTarget, text, "pasted-note.txt"),
                        }
                      : {})}
                    attachments={handed}
                    refusals={g?.refusals ?? []}
                  />
                </div>
              </>
            ) : (
              <>
            {/*
              Placeholders say the shape of an answer, never an answer (issue 230). Every field
              here used to hold the sample world's real values — "The Undersong", its logline,
              its genre, Maren Kest, The Vigil — sitting exactly where the user's own words go,
              so an entirely empty form looked filled in and Begin read as ready to press. They
              also anchored the author to one world's genre and naming at the moment they were
              meant to be inventing their own, and made that world's fiction feel like part of
              the app rather than one example among the worlds they could write.
            */}
            <div>
              <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Name</div>
              <Input
                placeholder="What this world is called"
                aria-label="What this world is called"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Logline</div>
              <Textarea
                placeholder="One sentence about this world"
                aria-label="One sentence about this world"
                value={logline}
                onChange={(e) => setLogline(e.target.value)}
                style={{ minHeight: 52 }}
              />
            </div>
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Tone</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {GENESIS_TONES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={cx("fy-filterchip", tone === t && "fy-filterchip--active")}
                      style={{ border: tone === t ? "none" : "1px solid var(--border)" }}
                      onClick={() => setTone(tone === t ? "" : t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <Input
                  placeholder="or your own words"
                  aria-label="or your own words"
                  value={GENESIS_TONES.includes(tone as (typeof GENESIS_TONES)[number]) ? "" : tone}
                  onChange={(e) => setTone(e.target.value)}
                  style={{ marginTop: 6 }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Genre</div>
                <Input aria-label="A genre" placeholder="A genre" value={genre} onChange={(e) => setGenre(e.target.value)} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>
                  First character <span className="fy-mono">optional</span>
                </div>
                {/* The separator is load-bearing — parseSeed splits on it — so the shape has to
                    teach it where the example used to demonstrate it. */}
                <Input
                  placeholder="Their name · one line about them"
                  aria-label="Their name · one line about them"
                  value={firstCharacter}
                  onChange={(e) => setFirstCharacter(e.target.value)}
                />
                {firstCharacter.trim().length > 0 && !charSeed && (
                  <span className="fy-mono" style={{ display: "block", marginTop: 4 }}>
                    name · one line — the separator splits who they are from what they are
                  </span>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>
                  First location <span className="fy-mono">optional</span>
                </div>
                <Input
                  placeholder="Its name · one line about it"
                  aria-label="Its name · one line about it"
                  value={firstLocation}
                  onChange={(e) => setFirstLocation(e.target.value)}
                />
              </div>
            </div>
            <div style={{ marginTop: "auto" }} className="fy-mono">
              a world is a folder under ArkeStudio\worlds — readable by hand, portable, never dependent on this app to
              exist
            </div>
              </>
            )}
          </div>
        </div>
        <div className="fy-gate__side">
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <div style={{ font: "600 15px var(--font-sans)" }}>The world so far</div>
            <span className="fy-mono" style={{ color: "var(--warning)" }}>
              {entries} entr{entries === 1 ? "y" : "ies"} · all proposed
            </span>
          </div>
          {/* Coverage (SPEC-031 R-7): what is covered and what is open, as labels and counts.
              The world's one image is on the list so a missing key-art brief is visible while
              it can still be answered, not as a line on the completion notice. */}
          {coverage && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {(
                [
                  { label: "premise", covered: coverage.premise },
                  { label: `cast ${coverage.cast}`, covered: coverage.cast > 0 },
                  { label: `places ${coverage.places}`, covered: coverage.places > 0 },
                  // Not on R-7's list, so present only once one exists — never an open chip.
                  ...(coverage.factions > 0 ? [{ label: `factions ${coverage.factions}`, covered: true }] : []),
                  { label: "through-line", covered: coverage.throughLine },
                  { label: "look", covered: coverage.look },
                  { label: "key image", covered: coverage.keyArt },
                ] as const
              ).map((c) => (
                <span
                  key={c.label}
                  className="fy-pill"
                  style={c.covered ? undefined : { opacity: 0.55 }}
                >
                  {c.label}
                  {c.covered ? "" : " · open"}
                </span>
              ))}
            </div>
          )}
          <div className="fy-draftcard" style={{ padding: "10px 10px 16px" }}>
            {/*
              Semantic tokens only (issue 911). Painted from the neutral ramp this was the
              brightest thing on the world door in dark mode — .dark leaves --neutral-* alone,
              so a ramp surface stays white on a near-black page. Same dashed-and-unfilled
              language as the pending frames, which paint from the same two tokens.
            */}
            <div
              style={{
                height: 118,
                borderRadius: 8,
                border: "1.5px dashed var(--border)",
                background: "var(--muted)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
              }}
            >
              <span style={{ font: "400 11px var(--font-sans)", color: "var(--muted-foreground)" }}>No world image yet</span>
              {/*
                There was a button here for months that could never be pressed: an image job
                needs a world folder to land in, and on this screen there is no world yet. A
                control that can never be enabled is a trap — it reads as broken, and it caught
                the same person twice. The sentence says where the thing actually happens.
              */}
              <span
                className="fy-mono"
                style={{ fontSize: 9, textAlign: "center", maxWidth: 190, lineHeight: 1.5 }}
              >
                key art is made from the logline in the world's hub, once you begin
              </span>
            </div>
            <div style={{ padding: "12px 8px 0" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
                <div style={{ font: "650 20px var(--font-sans)", letterSpacing: "-0.02em" }}>
                  {shownName || "Unnamed world"}
                </div>
                <span className="fy-mono" style={{ color: "var(--warning)", fontSize: 9.5 }}>
                  proposed
                </span>
              </div>
              <div style={{ font: "400 12.5px/1.55 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 5 }}>
                {shownLogline || (genMode === "chat" ? "The logline lands here as you talk." : "The logline lands here as you write it.")}
              </div>
              {(shownTone || shownGenre) && (
                <div style={{ display: "flex", gap: 7, marginTop: 10, flexWrap: "wrap" }}>
                  {shownTone && <span className="fy-pill">tone · {shownTone.toLowerCase()}</span>}
                  {shownGenre && <span className="fy-pill">{shownGenre.toLowerCase()}</span>}
                </div>
              )}
            </div>
          </div>
          {(railCharacters.length > 0 || railLocations.length > 0) && (
            <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              {railCharacters.slice(0, 2).map((c) => (
                <div key={c.name} className="fy-draftcard" style={{ flex: 1, minWidth: 150, marginTop: 0, padding: "12px 14px" }}>
                  <div className="fy-mono" style={{ fontSize: 10 }}>
                    CHARACTER
                  </div>
                  <div style={{ font: "600 13.5px var(--font-sans)", marginTop: 6 }}>{c.name}</div>
                  <div style={{ font: "400 11.5px/1.5 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 2 }}>
                    {c.sentence}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8 }}>
                    <span className="fy-dot fy-dot--sketch" style={{ width: 5, height: 5 }} />
                    <span className="fy-mono" style={{ fontSize: 9.5 }}>
                      {c.brief ? "sketch · brief kept" : "sketch · no face yet"}
                    </span>
                  </div>
                </div>
              ))}
              {railLocations.slice(0, 2).map((l) => (
                <div key={l.name} className="fy-draftcard" style={{ flex: 1, minWidth: 150, marginTop: 0, padding: "12px 14px" }}>
                  <div className="fy-mono" style={{ fontSize: 10 }}>
                    LOCATION
                  </div>
                  <div style={{ font: "600 13.5px var(--font-sans)", marginTop: 6 }}>{l.name}</div>
                  <div style={{ font: "400 11.5px/1.5 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 2 }}>
                    {l.sentence}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8 }}>
                    <span className="fy-dot fy-dot--sketch" style={{ width: 5, height: 5 }} />
                    <span className="fy-mono" style={{ fontSize: 9.5 }}>
                      {l.brief ? "sketch · brief kept" : "sketch"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {(blueprint?.threads.length ?? 0) > 0 && (
            <div className="fy-draftcard" style={{ padding: "12px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="fy-dot fy-dot--warn" style={{ width: 6, height: 6 }} />
                <span style={{ font: "600 12.5px var(--font-sans)" }}>Open threads</span>
                <span className="fy-mono">pull one to keep going</span>
              </div>
              <div style={{ font: "400 12px/1.7 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 7 }}>
                {blueprint!.threads.slice(0, 4).map((t, i) => (
                  <div key={i}>{t}</div>
                ))}
              </div>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 16 }} />
          <div style={{ display: "grid", gap: 8 }}>
            <Button
              variant="primary"
              disabled={!canCreate || buildCardOpen}
              onClick={() => {
                const proposed = blueprint?.look?.trim();
                const approvedLook = look.trim() || proposed;
                if (approvedLook) {
                  // Begin is the answer to a look already chosen here or proposed in chat. Keep
                  // new proposal words ready for an optional edit, but do not ask for approval twice.
                  if (look.trim().length === 0) {
                    setLook(approvedLook);
                    setLookSource("conversation");
                    conversationLookRef.current = approvedLook;
                    setPresetId(null);
                  }
                  if (buildMode) openBuildCard(approvedLook);
                  else begin(approvedLook);
                } else {
                  setStep("look");
                }
              }}
            >
              {submittedName ? "Creating…" : "Begin in this world"}
            </Button>
            {/* A bound is stated, never enforced in silence (SPEC-031 R-8). */}
            {(railCharacters.length > 4 || railLocations.length > 4 || railFactions.length > 4) && (
              <div className="fy-mono" style={{ textAlign: "center", color: "var(--warning)" }}>
                Begin seeds the first 4 of each · the rest are let go
              </div>
            )}
            <div style={{ font: "400 11px/1.5 var(--font-sans)", color: "var(--muted-foreground)", textAlign: "center" }}>
              One more question — how it should look — then the hub. Everything arrives as sketches:
              lock what holds, discard what doesn't.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Settings --------------------------------------------------------------

export function SettingsLayout() {
  const { connection, state } = useStore();
  return (
    <div className="fy-app" data-screen="settings">
      {/* A page, not a panel (SPEC-042 R-5). It was 90% of the window over a blurred scrim, with a
          close of its own that went to /worlds from wherever it was opened. At that size the
          modal framing bought nothing but a narrower pane, and the one thing a modal promises —
          to put you back where you were — it never did. The chrome's gear is the way out now,
          and it goes back to where it was pressed (R-6). */}
      <AppChrome current="settings" divided />
      <div className="fy-content fy-content--fixed">
        <div className="fy-settings">
          <nav className="fy-settings__rail" aria-label="Settings">
            <div className="fy-settings__title">Settings</div>
            {(
              [
                ["providers", "Providers"],
                ["models", "AI models"],
                ["general", "General"],
                ["harness", "Harness"],
                ["appearance", "Appearance"],
                ["notifications", "Notifications"],
                ["sign-in", "Sign-in"],
                ["sample-world", "Sample world"],
                ["diagnostics", "Diagnostics"],
                ["about", "About"],
              ] as const
            ).map(([slug, label]) => (
              <NavLink
                key={slug}
                to={`/settings/${slug}`}
                className={({ isActive }) => cx("fy-settings__tab", isActive && "fy-settings__tab--active")}
              >
                {label}
              </NavLink>
            ))}
            <div style={{ flex: 1 }} />
            <div className="fy-settings__version">v{state?.app.version ?? "0.1.0"}</div>
          </nav>
          <div className="fy-settings__pane">
            {/* Most panes in here draw from the coordinator's snapshot, and with no snapshot they
                draw the same thing they draw when a provider has nothing to offer: `—` in the
                capability rows, `not measured` in the machine header. A dev coordinator that died
                at import produces exactly that screen, which reads as a data bug in whatever you
                last changed (issue 599). */}
            {connection === "closed" && (
              <div className="fy-settings__waiting">
                <WaitingForCoordinator />
              </div>
            )}
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Vendor sign-in through the harness (SPEC-030 §2.4): the vendors with a connection, which one
 * authoring uses, and the hand-off to the vendor's own page. The list, its labels and its
 * method names are the harness's verbatim (R-7) — nothing here carries a vendor's name of its
 * own. Why a connection outranks a key, and why one can look healthy and then fail, live in
 * the spec, not on this screen.
 */
export function SettingsSignInScreen() {
  const { state } = useStore();
  const auth = state?.app.vendorAuth ?? null;
  const harnessReady = state?.app.health.harness.status === "healthy";
  useEffect(() => {
    if (harnessReady) refreshVendorAuth();
  }, [harnessReady]);
  // The default model's provider is which vendor authoring uses (R-10) — and it can change
  // while health stays healthy, because signing in or out changes the catalog. Keyed on the
  // stored connections, so the label follows the sign-in that just landed.
  const storedConnections = (auth?.vendors ?? [])
    .map((v) => `${v.id}:${v.connections.flatMap((c) => (c.kind === "stored" ? [c.id] : [])).join(",")}`)
    .join("|");
  useEffect(() => {
    if (harnessReady) listHarnessModels();
  }, [harnessReady, storedConnections]);
  // Authoring runs on the default model — and on any agent's model override, which routes past
  // it. The label follows every provider an agent can actually bill, not only the default's.
  const authoringProviders = new Set<string>();
  const defaultProvider = state?.app.harnessModels.find((m) => m.isDefault === true)?.provider;
  if (defaultProvider !== undefined) authoringProviders.add(defaultProvider);
  for (const agent of state?.app.agents ?? []) {
    const overrideProvider = agent.model?.split("/")[0];
    if (overrideProvider) authoringProviders.add(overrideProvider);
  }
  if (!auth || !auth.available) {
    return (
      <div data-screen="settings-signin" className="fy-set">
        <div className="fy-set__eyebrow">VENDOR SIGN-IN</div>
        <div className="fy-set__row">
          <div className="fy-set__name fy-set__name--wide">
            <div className="fy-set__title">Use a subscription you already pay for</div>
          </div>
          <div className="fy-set__field fy-set__field--empty">unavailable</div>
        </div>
        <div className="fy-set__note">{auth?.reason ?? "the harness has not started"}</div>
      </div>
    );
  }
  return (
    <div data-screen="settings-signin" className="fy-set">
      <div className="fy-set__eyebrow">VENDOR SIGN-IN</div>
      {auth.reason !== null && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>{auth.reason}</span>
        </div>
      )}
      {auth.vendors.length === 0 && <div className="fy-set__note">Nothing to sign in to yet — the harness is still listing vendors.</div>}
      {auth.vendors.map((vendor) => (
        <VendorSignInRow
          key={vendor.id}
          vendor={vendor}
          signIn={auth.signIn}
          linked={auth.carry === "linked"}
          usedForAuthoring={authoringProviders.has(vendor.id)}
        />
      ))}
      {auth.carryDetail !== null && <div className="fy-set__note">{auth.carryDetail}</div>}
    </div>
  );
}

/**
 * One vendor: its state, its connections, and every method the harness reports, offered at
 * once (R-9). A method with form fields opens them inline; equality-gated fields follow the
 * answers, which is all the measured builds express.
 */
function VendorSignInRow({
  vendor,
  signIn,
  linked,
  usedForAuthoring,
}: {
  vendor: VendorIntegration;
  signIn: VendorSignIn | null;
  linked: boolean;
  usedForAuthoring: boolean;
}) {
  const [openMethod, setOpenMethod] = useState<VendorAuthMethod | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [keyDraft, setKeyDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const stored = vendor.connections.filter((c) => c.kind === "stored");
  const hasEnvKey = vendor.connections.some((c) => c.kind === "env");
  const active = signIn !== null && signIn.vendor === vendor.id ? signIn : null;
  const stateWord = vendor.needsSignIn ? "sign-in needed" : stored.length > 0 ? "connected" : "not signed in";
  const visibleFields = (method: VendorAuthMethod) =>
    method.fields.filter((f) => f.whenEquals.every((w) => (answers[w.key] ?? "") === w.value));
  const fieldsAnswered = (method: VendorAuthMethod) =>
    visibleFields(method).every((f) => !f.required || (answers[f.key] ?? "").trim().length > 0);
  const begin = (method: VendorAuthMethod) => {
    const fields = visibleFields(method);
    const filled: Record<string, string> = {};
    for (const field of fields) {
      const value = (answers[field.key] ?? "").trim();
      if (value.length > 0) filled[field.key] = value;
    }
    if (method.kind === "key") {
      if (keyDraft.trim().length === 0) return;
      submitVendorKey(vendor.id, keyDraft.trim(), Object.keys(filled).length > 0 ? filled : undefined);
      setKeyDraft("");
    } else if (method.id !== null) {
      beginVendorSignIn(vendor.id, method.id, Object.keys(filled).length > 0 ? filled : undefined);
    }
    setOpenMethod(null);
    setAnswers({});
  };
  return (
    <>
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">{vendor.name}</div>
        </div>
        <span className={cx("fy-set__dot", stored.length > 0 && !vendor.needsSignIn && "fy-set__dot--ok", vendor.needsSignIn && "fy-set__dot--warn")} />
        <span className="fy-set__state">{stateWord}</span>
      </div>
      {/* R-11: with both a connection and a Studio key, name the one in effect. */}
      {stored.length > 0 && hasEnvKey && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--ok" />
          <span>uses this sign-in, not your key</span>
        </div>
      )}
      {usedForAuthoring && stored.length > 0 && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--ok" />
          <span>used for authoring</span>
        </div>
      )}
      {active !== null ? (
        <div className="fy-prov__keyline">
          <div className="fy-prov__eyebrow">{active.method.toUpperCase()}</div>
          {active.phase === "waiting" ? (
            <div className="fy-set__field">
              {/* The harness's instructions verbatim — for a device flow they carry the code. */}
              <span style={{ flex: 1 }}>{active.instructions ?? "waiting for the vendor…"}</span>
              {active.codeEntry && (
                <>
                  <Input
                    value={codeDraft}
                    onChange={(e) => setCodeDraft(e.target.value)}
                    placeholder="code from the vendor"
                    aria-label={`code for ${vendor.name}`}
                  />
                  <button
                    type="button"
                    className="fy-set__link"
                    disabled={codeDraft.trim().length === 0}
                    onClick={() => {
                      submitVendorSignInCode(vendor.id, codeDraft.trim());
                      setCodeDraft("");
                    }}
                  >
                    Submit
                  </button>
                </>
              )}
              <button type="button" className="fy-set__link" onClick={() => cancelVendorSignIn()}>
                Stop waiting
              </button>
            </div>
          ) : (
            <div className="fy-set__field">
              <span className="fy-set__dot fy-set__dot--warn" />
              <span style={{ flex: 1 }}>{active.detail ?? "the sign-in did not complete"}</span>
              <button type="button" className="fy-set__link" onClick={() => cancelVendorSignIn()}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="fy-set__field">
          {/* Every method the harness reports, offered at once — no fallback detection (R-9). */}
          {vendor.methods.map((method) => (
            <button
              type="button"
              key={method.id ?? method.kind}
              className="fy-set__link"
              onClick={() => {
                if (method.fields.length > 0 || method.kind === "key") {
                  setOpenMethod(openMethod === method ? null : method);
                  setAnswers({});
                } else if (method.id !== null) {
                  beginVendorSignIn(vendor.id, method.id);
                }
              }}
            >
              {method.label}
            </button>
          ))}
          {stored.map((connection) =>
            confirmRemove === connection.id ? (
              <button
                type="button"
                key={connection.id}
                className="fy-set__link"
                onClick={() => {
                  setConfirmRemove(null);
                  removeVendorConnection(vendor.id, connection.id);
                }}
              >
                {/* Two clicks and no dialog: this second click is the consent, and the words say
                    where the sign-out reaches (R-9a). */}
                {linked ? "signs your own installation out too — Remove" : "signs this studio out — Remove"}
              </button>
            ) : (
              <button
                type="button"
                key={connection.id}
                className="fy-set__link"
                onClick={() => setConfirmRemove(connection.id)}
              >
                Remove{stored.length > 1 ? ` · ${connection.label}` : ""}
              </button>
            ),
          )}
        </div>
      )}
      {openMethod !== null && active === null && (
        <div className="fy-prov__keyline">
          <div className="fy-prov__eyebrow">{openMethod.label.toUpperCase()}</div>
          <div className="fy-set__field">
            {visibleFields(openMethod).map((field) =>
              field.options !== null ? (
                <select
                  key={field.key}
                  className="fy-set__select"
                  aria-label={field.title}
                  value={answers[field.key] ?? ""}
                  onChange={(e) => setAnswers({ ...answers, [field.key]: e.target.value })}
                >
                  <option value="">{field.title}</option>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  key={field.key}
                  value={answers[field.key] ?? ""}
                  onChange={(e) => setAnswers({ ...answers, [field.key]: e.target.value })}
                  placeholder={field.placeholder ?? field.title}
                  aria-label={field.title}
                />
              ),
            )}
            {openMethod.kind === "key" && (
              <Input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="API key"
                aria-label={`API key for ${vendor.name}`}
              />
            )}
            <button
              type="button"
              className="fy-set__link"
              disabled={!fieldsAnswered(openMethod) || (openMethod.kind === "key" && keyDraft.trim().length === 0)}
              onClick={() => begin(openMethod)}
            >
              {openMethod.kind === "key" ? "Save" : "Continue"}
            </button>
            <button type="button" className="fy-set__link" onClick={() => setOpenMethod(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function SettingsNotificationsScreen() {
  const { state } = useStore();
  const preference = state?.app.backgroundNotifications ?? "issues-only";
  return (
    <div data-screen="settings-notifications" className="fy-set">
      <div className="fy-set__eyebrow">BACKGROUND NOTIFICATIONS</div>
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">When Arke Studio is in the background</div>
          <div className="fy-set__caps">Windows notifications open Activity when clicked</div>
        </div>
        <select
          className="fy-set__select"
          aria-label="Background notifications"
          value={preference}
          onChange={(event) =>
            setBackgroundNotifications(event.target.value as typeof preference)
          }
        >
          <option value="background-results-and-issues">Results and issues</option>
          <option value="issues-only">Issues only</option>
          <option value="off">Off</option>
        </select>
      </div>
      <div className="fy-set__note">
        issues include failed or uncertain generations, result preparation, and paused providers ·
        result notifications contain no world or character names
      </div>
    </div>
  );
}

const APPEARANCE_OPTIONS: Array<{ preference: ThemePreference; title: string; detail: string }> = [
  { preference: "system", title: "System", detail: "Follow Windows appearance" },
  { preference: "light", title: "Light", detail: "Always use the light theme" },
  { preference: "dark", title: "Dark", detail: "Always use the dark theme" },
];

export function SettingsAppearanceScreen() {
  const { state } = useStore();
  const preference = useThemePreference();
  const resolved = useResolvedTheme();
  const stored = state?.app.narrator ?? null;
  const narrator = stored && supportsVoiceUse(stored, "narration") ? stored : null;
  const worldIdForVoices = state?.world?.meta.worldId;
  const [narratorOpen, setNarratorOpen] = useState(false);
  return (
    <div data-screen="settings-appearance" className="fy-set fy-set--appearance">
      <div className="fy-set__eyebrow">THEME</div>
      <fieldset className="fy-theme-options">
        <legend className="fy-sr-only">Theme</legend>
        {APPEARANCE_OPTIONS.map((option) => (
          <label key={option.preference} className="fy-theme-option">
            <span className="fy-theme-option__copy">
              <span className="fy-set__title">{option.title}</span>
              <span className="fy-set__caps">{option.detail}</span>
            </span>
            <input
              type="radio"
              name="appearance-theme"
              value={option.preference}
              checked={preference === option.preference}
              onChange={() => setThemePreference(option.preference)}
            />
          </label>
        ))}
      </fieldset>
      <div className="fy-set__note">currently using {resolved}</div>
      {/*
       * The narrator arrived here from the Voice group inside Local runtime, and it is the one
       * thing on that group that was never about a runtime. It is a voice the app speaks in, and
       * it may be a cloud one — so Local AI is forbidden it (R-2) and Engines is wrong in kind,
       * because an engine is not a provider (R-72). What is left is how the app presents itself.
       */}
      {/* Who reads the app's prose aloud. A third role: a character's voice lives on their sheet,
          a reading voice belongs to one bench take, and this one narrates. It stays on the shipped
          local voice unless somebody chooses otherwise, because "read aloud" is a passive press and
          no other preference here spends money on one. */}
      <div className="fy-rt__keyline">
        <div className="fy-rt__eyebrow">NARRATOR</div>
        <div className="fy-set__field">
          <span className="fy-rt__path" data-testid="narrator-name">
            {narrator === null ? DEFAULT_NARRATOR.label : `${narrator.label ?? narrator.voiceId} · ${narrator.provider}`}
            {" · "}
            {narrator === null || narrator.provider === "kokoro"
              ? "reads on this machine · free"
              : "reads in the cloud · billed per character"}
          </span>
          <button type="button" className="fy-set__link" onClick={() => setNarratorOpen(true)}>
            Choose voice
          </button>
          {narrator !== null && (
            <button type="button" className="fy-set__link" data-testid="narrator-reset" onClick={() => setNarrator(null)}>
              Use the local voice
            </button>
          )}
        </div>
      </div>
      <VoicePickerDialog
        open={narratorOpen}
        use="narration"
        {...(worldIdForVoices !== undefined ? { worldId: worldIdForVoices } : {})}
        chosenId={narrator?.voiceId}
        chosenProvider={narrator?.provider}
        chosenModel={
          narrator?.model ??
          (narrator ? legacyVoiceModel(narrator.provider, narrator.voiceId) ?? undefined : undefined)
        }
        onClose={() => setNarratorOpen(false)}
        onPick={(voice: ReadingVoice) => {
          setNarratorOpen(false);
          setNarrator({ provider: voice.provider, model: voice.model, voiceId: voice.voiceId, label: voice.label });
        }}
      />
      {/*
       * The two themes, side by side. Fixed swatches rather than a live preview of the current
       * one: the point is to show what the choice above would look like, and a card that followed
       * the active theme would only ever show you what you can already see.
       */}
      <div className="fy-themeswatches" aria-hidden="true">
        {(["light", "dark"] as const).map((theme) => (
          <div key={theme} className={`fy-themeswatch fy-themeswatch--${theme}`}>
            <div className="fy-themeswatch__frame">
              <span className="fy-themeswatch__block" />
              <span className="fy-themeswatch__lines">
                <i />
                <i />
              </span>
            </div>
            <div className="fy-themeswatch__caption">{theme.toUpperCase()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Settings · Harness (SPEC-005 R-1). Master and detail, like Local runtime, because there will be
 * more than two engines and more than one setting each — a flat list of radio buttons would have
 * nowhere to put the second Claude Code option when it arrives.
 *
 * The rule this screen exists to enforce: a harness that is not on this machine cannot be
 * selected. Availability is detected rather than assumed, the control for an absent harness is
 * unavailable rather than merely ineffective, and the pane says which case it is — "not found"
 * and "too old" want different things from the reader. The coordinator refuses the same choice
 * independently, so this is the courtesy and not the guarantee.
 */
export function SettingsHarnessScreen() {
  const { state } = useStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const harness = state?.app.harness ?? null;
  const researchOn = state?.app.research.web === true;

  useEffect(() => {
    // Detection costs a subprocess, so it happens when the screen is opened rather than at boot.
    if (!harness) detectHarnesses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const harnesses = harness?.harnesses ?? [OPENCODE_AVAILABILITY];
  const engine = harness?.engine ?? "opencode";
  const asked = searchParams.get("harness");
  const current = harnesses.some((h) => h.id === asked) ? asked! : harnesses[0]!.id;
  const chosen = harnesses.find((h) => h.id === current) ?? harnesses[0]!;

  const [agentsOpen, setAgentsOpen] = useState(false);
  return (
    <div data-screen="settings-harness" className="fy-set fy-set--runtime">
      <div className="fy-rt">
        <div className="fy-rt__rail" role="tablist" aria-label="Harnesses">
          {harnesses.map((h) => (
            <button
              type="button"
              key={h.id}
              role="tab"
              aria-selected={h.id === current}
              className={cx("fy-rt__railitem", h.id === current && "is-current")}
              onClick={() => setSearchParams({ harness: h.id }, { replace: true })}
            >
              <span className={cx("fy-set__dot", TONE_CLASS[h.id === engine ? "ok" : h.installed ? "idle" : "warn"])} />
              <span>{h.label}</span>
              <span style={{ flex: 1 }} />
              <span className="fy-rt__count">
                {h.id === engine ? "in use" : h.installed ? "available" : "not here"}
              </span>
            </button>
          ))}
        </div>
        <div className="fy-rt__pane">
          <HarnessPane harness={chosen} engine={engine} detected={harness !== null} claudePath={harness?.claudePath ?? null} />
          {/*
            The one thing the Studio does that leaves this machine, so it lives with the other
            question about what the agent may do rather than behind a provider key. Off until
            asked: a conversation that reads the web has fetched a page on the author's line, and
            that is a decision, not a default.

            "Search", not "read pages", since 2026-08-23. It could only open a URL someone typed
            before, which is not what anyone means by asking it to go and research something.
          */}
          <div className="fy-rt__research">
            <button
              type="button"
              role="switch"
              aria-checked={researchOn}
              aria-label="Search online"
              className={cx("fy-prov__switch", researchOn && "is-on")}
              onClick={() => setResearchWeb(!researchOn)}
            >
              <span />
            </button>
            <div>
              <strong>Search online</strong>
              <p>{researchOn ? "Searches, reads, and cites pages." : "Stays offline."}</p>
            </div>
          </div>
          {/*
           * Which model runs each writing agent (SPEC-033 R-65).
           *
           * It was Advanced on Who does what, and it could not stay there: it admits local
           * models, which Cloud AI forbids in any state, and assigning models to authoring
           * agents is agent execution — which is what this screen is for.
           */}
          <button
            type="button"
            className="fy-set__link"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 14,
              paddingTop: 12,
              borderTop: "1px solid var(--border)",
              width: "100%",
              textAlign: "left",
            }}
            aria-expanded={agentsOpen}
            onClick={() => setAgentsOpen(!agentsOpen)}
          >
            {agentsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Advanced · which model runs each writing agent
          </button>
          {agentsOpen && <AgentsPanel />}
        </div>
      </div>
    </div>
  );
}

function HarnessPane({
  harness,
  engine,
  detected,
  claudePath,
}: {
  harness: HarnessAvailability;
  engine: HarnessEngine;
  detected: boolean;
  claudePath: string | null;
}) {
  const inUse = harness.id === engine;
  return (
    <>
      <RuntimeHead
        title={harness.label}
        caps={harness.bundled ? "BUNDLED" : "YOUR INSTALLATION"}
        tone={inUse ? "ok" : harness.installed ? "idle" : "warn"}
        state={inUse ? "in use" : harness.installed ? "available" : "not here"}
      />
      <RuntimeSection label="ON THIS MACHINE" />
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">{harness.bundled ? "Ships with Arke Studio" : "Found on this machine"}</div>
          <div className="fy-set__caps">
            {/* The refusal, in the words the coordinator sent — not a re-derived summary. */}
            {harness.blocked ?? (harness.version ? `version ${harness.version}` : "installed")}
          </div>
        </div>
        {!harness.bundled && (
          <Button variant="ghost" onClick={() => detectHarnesses()}>
            Check again
          </Button>
        )}
      </div>
      {!harness.bundled && (
        <>
          <RuntimeSection label="WHERE IT IS" />
          <div className="fy-set__row">
            <div className="fy-set__name fy-set__name--wide">
              <div className="fy-set__title">
                {claudePath ?? (harness.source === "path" ? "Found on the system path" : "No file chosen")}
              </div>
              <div className="fy-set__caps">
                {claudePath
                  ? harness.installed
                    ? "this file is what Arke Studio runs"
                    : "this file did not answer"
                  : "choose a file if Arke Studio cannot find yours"}
              </div>
            </div>
            {claudePath && (
              <Button variant="ghost" onClick={() => clearClaudeExecutable()}>
                Clear
              </Button>
            )}
            <Button variant="secondary" onClick={() => chooseClaudeExecutable()}>
              Choose…
            </Button>
          </div>
        </>
      )}
      <RuntimeSection label="USE FOR AUTHORING" />
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">{inUse ? "Runs the authoring work" : "Not in use"}</div>
          <div className="fy-set__caps">
            {inUse
              ? "takes effect on the next restart"
              : harness.installed
                ? "switching takes effect on the next restart"
                : "unavailable until it is installed"}
          </div>
        </div>
        <Button
          variant={inUse ? "secondary" : "primary"}
          disabled={inUse || !harness.installed || !detected}
          onClick={() => setHarnessEngine(harness.id)}
        >
          {inUse ? "In use" : "Use this"}
        </Button>
      </div>
    </>
  );
}

/**
 * The capabilities a default routes, in the order the capability table states them (R-47, R-89).
 *
 * Not every row it draws: `voice-stt` and `voice-clone` have no routing default, and a row here
 * means a model somebody picks. `llm` left with SPEC-034 R-17 — it wrote a setting nothing read,
 * and the model that does the writing is chosen on Harness.
 */
const ROUTED_CAPABILITIES: readonly Capability[] = CAPABILITY_ROWS.flatMap((row) =>
  row.capabilities.filter((c) => c === "image" || c === "video" || c === "voice-tts" || c === "music"),
);

/**
 * Settings · General (SPEC-034 R-14). Which model runs each capability by default.
 *
 * It was Cloud AI, and before that *Who does what*. What changes with the rename is the thing the
 * rename was blocked on: **a default may name a local model** (R-15). SPEC-033 R-61 filtered them
 * out because the screen it replaced let one be chosen with nothing to run it — `llm →
 * gemma4-12b` put all writing on this machine — but the defect was never *a local model
 * appeared*, it was *a model that could not run was selectable*, and fit verdicts with SPEC-028
 * R-35's eligibility refuse that directly now. R-15a wires that answer into the routing write, so
 * the option below being unselectable is the courtesy and the refusal is the guarantee.
 *
 * **A default is not a routing switch** (R-16). Where a piece of work runs stays a production's
 * decision at dispatch (SPEC-033 R-74), and that decision outranks the default it started from.
 *
 * Providers keeps its job unchanged. This screen **references** a provider and never configures
 * one: the remedy for an unconnected provider is a route to Providers, never a key field here.
 */
export function SettingsGeneralScreen() {
  const { state } = useStore();
  const navigate = useNavigate();
  const manifest = state?.app.manifest ?? null;
  const routing = state?.app.routing ?? { defaults: {}, faults: [] };
  const drift = state?.app.drift ?? [];
  const statuses = state?.app.providers ?? [];
  const eligibility = eligibilityInputs(state);
  /** Stored, tested, or neither — the three things Providers actually knows (SPEC-028 R-33). */
  const providerState = (id: ProviderId): string => {
    const status = statuses.find((p) => p.id === id);
    if (status?.configured !== true) return "not connected";
    if (status.validation === "valid") return "connected";
    if (status.validation === "invalid") return "key rejected";
    // `testing` is its own state and reads as one: a key mid-validation is not the same thing as
    // one nobody has tried, and the four words are the four the provider table actually has.
    return status.validation === "testing" ? "testing" : "untested";
  };
  /**
   * Where a model actually runs (R-16a), from the resolved engine rather than the provider flag.
   * `PROVIDERS.comfyui.local` is `true` for every recipe, so reading the flag would tell someone
   * their video drafts here while it renders on a box down the hall.
   */
  /**
   * What to call the thing a default comes from, which is not the same word on both halves.
   *
   * A keyed service is its own source and names itself. A local model's is the **engine**, which
   * is what frame 112d draws and what Providers' rail is keyed on: `Voxa · this machine` rather
   * than `Kokoro · this machine`, because the reader who wants to act on it goes to Voxa's pane.
   */
  const sourceOf = (model: ManifestModel): string => {
    const engine = engineOfProvider(model.provider);
    return engine === undefined ? PROVIDER_TABLE[model.provider].displayName : ENGINE_LABEL[engine];
  };

  const runsOn = (model: ManifestModel): string => {
    if (!PROVIDER_TABLE[model.provider].local) return providerState(model.provider);
    const gated = (state?.app.runtime?.models ?? []).find((m) => m.modelId === model.id);
    const locality =
      gated?.locality ??
      (model.provider === "comfyui" ? (state?.app.comfyui?.engine.locality ?? "local") : "local");
    return locality === "remote" ? "another machine" : "this machine";
  };
  return (
    <div data-screen="settings-general" className="fy-set">
      <div className="fy-set__eyebrow">DEFAULTS</div>
      {/* A default that cannot run is stated, never repaired (design turn 40d). It gets a callout
          rather than a footnote because the next dispatch of that capability has nowhere to go. */}
      {routing.faults.map((f) => (
        <Callout key={f.capability} tone="warning" title={`${CAPABILITY_LABEL[f.capability]} has nowhere to go.`}>
          {f.reason}
        </Callout>
      ))}
      {ROUTED_CAPABILITIES.map((capability) => {
        // Both halves, in one list (R-15). The picker is where R-61's filter used to be, and what
        // stands in its place is eligibility — the same answer the routing write consults, so an
        // option the screen greys out is one the write would refuse anyway (R-15a).
        const options = (manifest?.models ?? []).filter((m) => m.capability === capability);
        const selected = routing.defaults[capability];
        const selectedModel = options.find((m) => m.id === selected);
        const usable = (m: (typeof options)[number]) => modelEligible(m, eligibility);
        const stranded = selectedModel !== undefined && !usable(selectedModel);
        return (
          <div key={capability} className="fy-set__row">
            <span className="fy-set__routelabel">{CAPABILITY_LABEL[capability]}</span>
            <select
              className="fy-set__pill"
              aria-label={`Model for ${CAPABILITY_LABEL[capability]}`}
              disabled={options.length === 0}
              value={selected ?? ""}
              onChange={(e) => setRoutingDefault(capability, e.target.value)}
            >
              {options.length === 0 && <option value="">nothing in the manifest for this</option>}
              {selected === undefined && options.length > 0 && <option value="">no default set</option>}
              {[...options]
                .sort((a, b) => Number(usable(b)) - Number(usable(a)))
                .map((m) => (
                  <option key={m.id} value={m.id} disabled={!usable(m)}>
                    {PROVIDER_TABLE[m.provider].displayName} · {m.displayName}
                    {/* Not on the selected one: the collapsed select is read beside the state
                        text, which already says why, and twice on one row reads as two problems. */}
                    {usable(m) || m.id === selected ? "" : ` — ${strandReason(state, m)}`}
                  </option>
                ))}
            </select>
            {/* The capability copy is the manifest speaking (R-10): refs, frames, caps. */}
            {/* A model names its provider and where that provider's work runs — the connection
                state SPEC-028 R-33 requires for a keyed one, the resolved engine's locality for a
                local one (R-16a). Displayed rather than re-derived (R-63). */}
            {selectedModel && !stranded && (
              <span className="fy-set__state">
                {sourceOf(selectedModel)} · {runsOn(selectedModel)} ·{" "}
                {modelCapabilityCopy(selectedModel)}
              </span>
            )}
            {stranded && selectedModel && (
              <span className="fy-set__state">
                {sourceOf(selectedModel)} · {strandReason(state, selectedModel)}
              </span>
            )}
            <span className={cx("fy-set__dot", stranded ? "fy-set__dot--warn" : selectedModel && "fy-set__dot--ok")} />
          </div>
        );
      })}
      {/* Its label and the route, with no picker and no sentence (R-17): the absence of a control
          is what says the choice is not made here. */}
      <div className="fy-set__row">
        <span className="fy-set__routelabel">{CAPABILITY_LABEL.llm}</span>
        <button type="button" className="fy-set__link" onClick={() => navigate("/settings/harness")}>
          on Harness
        </button>
        <span style={{ flex: 1 }} />
      </div>

      {drift.length > 0 && (
        <>
          <div className="fy-set__eyebrow">MANIFEST DRIFT</div>
          {drift.map((d) => (
            <div key={d.modelId} className="fy-set__row">
              <div className="fy-set__name fy-set__name--wide">
                <div className="fy-set__title">{d.modelId}</div>
                <div className="fy-set__caps">
                  {PROVIDER_TABLE[d.provider].displayName} · {d.samples} reported charges
                </div>
              </div>
              <span className="fy-set__state">
                estimates off by ~{(d.medianDivergencePerMille / 10).toFixed(0)}%
              </span>
              <span className="fy-set__dot fy-set__dot--warn" />
            </div>
          ))}
          <div className="fy-set__note">the shipped manifest needs an update — estimates keep missing what was billed</div>
        </>
      )}
    </div>
  );
}

/**
 * The sample world (SPEC-016 R-6). The Undersong is the world this application was designed
 * against, and it ships whole: characters with reference kits, canon that contradicts itself in
 * places, a production part-way through, and a proposal still waiting at the gate.
 *
 * Installing is a copy, so it is safe to do twice and safe to ruin — which is the point of
 * having one. The pane says both, because a user who does not know the copy is theirs will
 * treat it as a museum piece and learn nothing from it.
 */
export function SettingsSampleWorldScreen() {
  const sample = useSampleWorld();
  const installing = sample?.installing === true;
  const available = sample?.available === true;
  return (
    <div data-screen="settings-sample-world" className="fy-set">
      <div className="fy-set__eyebrow">SAMPLE WORLD</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 14 }}>
        <span className="fy-set__aboutname">The Undersong</span>
        <span className="fy-set__aboutmeta">coastal fantasy · quiet dread</span>
      </div>
      <div className="fy-set__aboutline">A drowned god still sings beneath the harbour.</div>

      <div className="fy-set__row" style={{ marginTop: 14 }}>
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">Install a copy</div>
          <div className="fy-set__caps">
            {available
              ? "a cast with reference kits, canon, a production under way, and a proposal at the gate"
              : "this build does not carry it"}
          </div>
          {available && (
            <div className="fy-set__note">
              It lands beside your own worlds as an ordinary folder. Change it, break it, archive
              it — nothing here is read-only, and installing again gives you a fresh copy.
            </div>
          )}
        </div>
        {available && (
          <Button variant="primary" disabled={installing} onClick={() => installSampleWorld()}>
            {installing ? "Installing…" : "Install"}
          </Button>
        )}
      </div>

      {sample?.note && (
        <div className="fy-set__why" style={{ marginTop: 10 }}>
          <span className={cx("fy-set__dot", sample.note.refused ? "fy-set__dot--warn" : "fy-set__dot--ok")} />
          <span>{sample.note.text}</span>
        </div>
      )}
    </div>
  );
}

export function SettingsAboutScreen() {
  const { state } = useStore();
  const update = useUpdateStatus();
  const diagnostics = useDiagnosticsBundle();
  const [showNotices, setShowNotices] = useState(false);
  const updateCopy = (() => {
    if (!update) return "Updates are ready when you choose to check.";
    const version = update.targetVersion ? ` v${update.targetVersion}` : "";
    if (update.status === "checking") return "Checking for updates...";
    if (update.status === "available") return `Arke Studio${version} is available to download.`;
    if (update.status === "downloading") return `Downloading${version}${update.progressPercent !== null ? ` - ${Math.round(update.progressPercent)}%` : ""}.`;
    if (update.status === "ready") return `Arke Studio${version} is ready to install.`;
    if (update.status === "install-on-close") return update.detail ?? "The update will install after a clean close. Arke will remain closed.";
    if (update.status === "shutting-down") return "Finishing local work before installation...";
    if (update.status === "installing") return "Installing the update and reopening Arke Studio...";
    if (update.status === "updated") return `Arke Studio updated to${version}.`;
    if (update.status === "install-failed" || update.status === "error") return update.detail ?? "The update needs attention.";
    if (update.status === "externally-managed") return "Updates are managed outside this build.";
    if (update.status === "none") return "Arke Studio is up to date.";
    return "Check when you are ready. Nothing downloads without you.";
  })();
  return (
    <div data-screen="settings-about" className="fy-set fy-set--about">
      <div className="fy-set__eyebrow">ABOUT</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 14 }}>
        <span className="fy-set__aboutname">Arke</span>
        <span className="fy-set__aboutmeta">v{state?.app.version ?? "—"} · AGPL-3.0</span>
      </div>
      <div className="fy-set__aboutline">The world is the asset. Author once, produce everywhere.</div>

      <div className="fy-set__row" style={{ marginTop: 14 }}>
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">Updates</div>
          <div className="fy-set__caps">{updateCopy}</div>
          {(update?.status === "ready" || update?.status === "install-on-close") && (
            <div className="fy-set__note">Install when I close will not reopen Arke Studio.</div>
          )}
        </div>
        {update?.status === "available" && (
          <Button variant="primary" onClick={() => downloadUpdate()}>
            Download
          </Button>
        )}
        {update?.status === "ready" && (
          <>
            <Button variant="primary" onClick={() => installUpdateAndRestart()}>
              Install and restart
            </Button>
            <button type="button" className="fy-set__link" onClick={() => installUpdateOnClose()}>
              Install when I close
            </button>
          </>
        )}
        {update?.status !== "shutting-down" && update?.status !== "installing" && update?.status !== "ready" && update?.status !== "install-on-close" && (
          <button type="button" className="fy-set__link" onClick={() => checkUpdates()}>
            Check for updates
          </button>
        )}
      </div>

      {/* Its own row, as 35b has it: the licence is a fact about the product, not a suffix on the
          version number, and it is what the two links below belong to. */}
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">Open source</div>
          <div className="fy-set__caps">AGPL-3.0 licence · your canon is a readable format, leave any time</div>
        </div>
        <a
          className="fy-set__link"
          href="https://github.com/michaeljosiah/ArkeStudio"
          target="_blank"
          rel="noreferrer"
        >
          GitHub ↗
        </a>
        <button type="button" className="fy-set__link" onClick={() => setShowNotices((s) => !s)}>
          Third-party licences
        </button>
      </div>

      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">Your data</div>
          <div className="fy-set__caps">
            %USERPROFILE%\ArkeStudio · worlds, ledger, credentials — uninstalling deletes none of it
          </div>
        </div>
        <button type="button" className="fy-set__link" onClick={() => openDataFolder()}>
          Open folder
        </button>
      </div>

      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">Diagnostics</div>
          <div className="fy-set__caps">redacted at the boundary — no world content, no keys, no prompts</div>
        </div>
        <button type="button" className="fy-set__link" onClick={() => generateDiagnostics()}>
          Generate
        </button>
      </div>
      {diagnostics && (
        <Textarea readOnly value={diagnostics} style={{ minHeight: 160, marginTop: 10, font: "var(--type-mono, monospace)" }} />
      )}

      {/* Behind the link that names it, rather than a wall of licences under every visit. */}
      {showNotices && (
        <div className="fy-set__note">
          OpenCode (MIT) · Voxa (MIT) · espeak-ng (GPL, separate process, never linked) · ffmpeg
          (GPL build, separate process, never linked) · better-sqlite3 (MIT) · Electron (MIT) · Geist (OFL) — full
          notices in THIRD-PARTY-NOTICES.md beside the app
        </div>
      )}
      <div className="fy-set__copyright">© 2026 Michael Josiah</div>
    </div>
  );
}

// ---- Activity --------------------------------------------------------------

const TERMINAL_JOB = new Set(["succeeded", "failed", "cancelled"]);

function ProviderCallInspector({ jobId, onClose }: { jobId: string | null; onClose: () => void }) {
  const calls = useProviderCalls(jobId);
  useEffect(() => listProviderCalls(jobId), [jobId]);
  const copy = (call: ProviderCallRecord) => void navigator.clipboard.writeText(JSON.stringify(call, null, 2));
  return (
    <section className="fy-provider-calls" aria-label="Provider calls">
      <div className="fy-provider-calls__head">
        <div><div className="fy-eyebrow-sm">PROVIDER CALLS</div><div className="fy-mono">{jobId ?? "100 most recent calls"}</div></div>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <Callout tone="warning" title="Sensitive local history">
        Requests and responses may contain prompts and world content. Credentials and binary media are redacted or summarized.
      </Callout>
      {calls === null && <div className="fy-mono">loading call history…</div>}
      {calls?.length === 0 && <div className="fy-mono">No recorded calls. Calls made before this feature are not recoverable.</div>}
      {calls?.map((call) => (
        <details key={call.id} className="fy-provider-call" open={calls.length === 1}>
          <summary>
            <span>{call.operation}</span><span className="fy-mono">{call.method} {call.endpoint}</span>
            <Badge tone={call.status === "succeeded" || call.status === "accepted" ? "success" : call.status === "pending" ? "warning" : "danger"}>
              {call.status === "pending" ? "outcome unknown" : call.status}
            </Badge>
          </summary>
          <div className="fy-provider-call__meta">{shortDateTime(call.startedAt)} · attempt {call.attempt ?? "—"} · HTTP {call.httpStatus ?? "no response"} · {call.elapsedMs === null ? "still pending" : `${call.elapsedMs} ms`}</div>
          {call.error && <Callout tone="warning" title={`${call.error.name}${call.error.code ? ` · ${call.error.code}` : ""}`}>{call.error.message}</Callout>}
          <div className="fy-provider-call__payloads">
            <div><div className="fy-provider-call__label">REQUEST</div><pre>{JSON.stringify(call.request, null, 2)}</pre></div>
            <div><div className="fy-provider-call__label">RESPONSE</div><pre>{call.response === null ? "No response was witnessed." : JSON.stringify(call.response, null, 2)}</pre></div>
          </div>
          <Button variant="ghost" onClick={() => copy(call)}>Copy sensitive call JSON</Button>
        </details>
      ))}
    </section>
  );
}

export function ActivityScreen() {
  const { state } = useStore();
  const reconcileReport = useReconcileReport();
  const sidecar = useVoiceSidecarState();
  const exportsState = useExportsState();
  const navigate = useNavigate();
  const [scope, setScope] = useState<"active" | "all">("active");
  const [inspectedJobId, setInspectedJobId] = useState<string | null>(null);
  const [inspectAllCalls, setInspectAllCalls] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const activeWorldId = state?.world?.meta.worldId ?? null;
  // The alert threshold, set where it is reported (26a). Closed until asked for: the note says
  // what the alert is, and most visits to this screen are not about changing it.
  const [editingThreshold, setEditingThreshold] = useState(false);
  const [threshold, setThreshold] = useState<string | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const thresholdValue =
    threshold ?? String((state?.app.spend?.settings.thresholdMicroUsd ?? 0) / 1_000_000);
  const periodValue = period ?? String(state?.app.spend?.settings.periodDays ?? 7);

  const jobs = [...(state?.app.jobs ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const scoped = <T extends { worldId?: string }>(items: T[]): T[] =>
    scope === "all" || activeWorldId === null ? items : items.filter((i) => i.worldId === undefined || i.worldId === activeWorldId);

  const running = state ? computeRunning(state, { sidecar, exports: exportsState }) : [];
  const needsYou = state ? computeNeedsYou(state) : [];
  // Founding-build items that did not land (SPEC-031 R-48): rows derived from the build
  // record's own keys, so an item never dispatched — no route, no credential — is as visible
  // and as runnable as a failed one. Held items are deliberately absent: their queue rows
  // are already here, and resuming the lane is that row's action (row 32 — no duplicates).
  const NOT_LANDED = new Set(["failed", "skipped", "unauthorized"]);
  const builds = scoped([...(state?.app.builds ?? [])]).filter((build) => build.status !== "running");
  const buildMissing = builds
    .map((build) => ({ build, missing: build.items.filter((item) => NOT_LANDED.has(item.state)) }))
    .filter(({ missing }) => missing.length > 0);
  /** The build item a failed job belongs to, for the retry that lands as the build would (R-49). */
  const buildItemForJob = (jobId: string) => {
    for (const build of state?.app.builds ?? []) {
      const item = build.items.find((candidate) => candidate.jobId === jobId);
      if (item) return { build, item };
    }
    return null;
  };
  // Spend obeys the screen's scope like every other collection here (issue 305 §8). Bench jobs
  // omit productionId but keep worldId, so their ledger entries are world-owned already; what was
  // missing was reading that. The threshold alert below stays app-wide deliberately — it is one
  // durable app setting about one app-wide rolling total, not a per-world figure.
  //
  // The ledger cannot use `scoped` as it stands, because it is the one collection here whose
  // scope is not always a world id. A founding look preview is paid for before any world exists,
  // and while the job is re-associated to the world at Begin, the ledger entry keeps the genesis
  // it was actually spent under (SPEC-031 R-55) — that is the record of where the money went.
  // The build holds the join, so read it: dropping those entries would underreport every world
  // that was founded from a paid preview.
  // The build is pruned from the snapshot once every item has landed, which is exactly when
  // the founding went well — so the coordinator also keeps the pair it harvested before pruning
  // (issue 531). Both are read: the build for a founding in this session, the map after any
  // restart. Neither ever names another world's genesis as this one's.
  const genesisForActiveWorld = new Set([
    ...(state?.app.builds ?? []).filter((b) => b.worldId === activeWorldId).map((b) => b.genesisId),
    ...Object.entries(state?.app.worldGenesis ?? {})
      .filter(([worldId]) => worldId === activeWorldId)
      .map(([, genesisId]) => genesisId),
  ]);
  const inScope = (entry: LedgerEntry): boolean =>
    scope === "all" ||
    activeWorldId === null ||
    entry.worldId === activeWorldId ||
    genesisForActiveWorld.has(entry.worldId);
  const spend = state
    ? spendSummary(state.app.ledger.filter(inScope), state.app.spend?.settings.periodDays ?? 7, new Date())
    : null;
  const spendStatus = state?.app.spend ?? null;
  const spendThreshold = spendStatus?.settings.thresholdMicroUsd ?? 0;
  // The source-quality slot, and a failed read is the loudest source fact there is: the figure
  // beside it sums only what survived the read, a lower bound wearing the shape of a total.
  // Keyed on the published list's own read — latched to the seed — where the alert note below
  // states the fate of the evaluation's own, fresher read. The two can honestly differ.
  const sourceNote = state?.app.ledgerUnavailable
    ? "ledger could not be read"
    : spend?.mixed
      ? `mixed · ${spend.reportedEntries} measured, ${spend.derivedEntries} derived`
      : (spend?.derivedEntries ?? 0) > 0
        ? "derived from the manifest"
        : "provider-reported";
  /*
   * The threshold row. A fired alert outranks everything: `alerted` is only ever computed from
   * entries that were read, so the crossing is real even when a later read failed, and hiding
   * it would be the reverse of this screen's fault. Then the un-evaluated case — a status whose
   * read failed has an un-fired alert, which is not an all-clear (SPEC-008 R-19). A zero
   * threshold stays `off` throughout: an alert that is off asks nothing of the ledger.
   */
  const alertWindow = `Alert at ${formatMicroUsd(spendThreshold)} / ${spend?.periodDays ?? 7}d`;
  const alertNote = spendStatus?.alerted
    ? `Over the threshold: ${formatMicroUsd(spendStatus.rollingMicroUsd)} against ${formatMicroUsd(spendThreshold)}. Nothing is blocked.`
    : spendThreshold === 0
      ? `${alertWindow} · off`
      : spendStatus?.ledgerUnavailable
        ? `${alertWindow} · not evaluated`
        : alertWindow;
  const drift = state?.app.drift ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const recent = scoped(jobs.filter((j) => TERMINAL_JOB.has(j.status) && j.updatedAt.startsWith(today)));
  const settled = running.length === 0 && needsYou.length === 0;

  return (
    <div className="fy-app" data-screen="activity">
      <AppChrome back={{ label: "Home", to: "/worlds" }} context={{ label: "activity" }} current="activity" />
      <div className="fy-activity">
        <div className="fy-activity__main">
          <div className="fy-h1row">
            <h1 className="fy-h1">Activity</h1>
            <span className="fy-h1row__meta">
              {scoped(running).length} running · {scoped(needsYou).length} need{scoped(needsYou).length === 1 ? "s" : ""} you ·
              everything Arke is doing, and what it costs
            </span>
            <span className="fy-h1row__push" />
            <span className="fy-seg">
              <button
                type="button"
                className={cx("fy-seg__item", scope === "active" && "fy-seg__item--active")}
                onClick={() => setScope("active")}
              >
                This world
              </button>
              <button
                type="button"
                className={cx("fy-seg__item", scope === "all" && "fy-seg__item--active")}
                onClick={() => setScope("all")}
              >
                All worlds
              </button>
            </span>
          </div>
          {reconcileReport && reconcileReport.length > 0 && (
            <Callout title="What recovery did">
              {reconcileReport.map((r) => `${r.jobId.slice(0, 8)}… ${r.action}`).join(" · ")}
            </Callout>
          )}
          {settled ? (
            <div style={{ padding: "40px 0" }}>
              <EmptyState
                title="Nothing running, nothing waiting on you"
                hint="A settled state, not a blank — you can stop."
              />
            </div>
          ) : (
            <>
              <div className="fy-eyebrow-sm" style={{ margin: "18px 0 2px" }}>
                RUNNING
              </div>
              {scoped(running).length === 0 && <div className="fy-mono" style={{ padding: "10px 0" }}>nothing in flight</div>}
              {scoped(running).map((r) => (
                <div key={r.ref} className="fy-activityrow">
                  <span className="fy-dot fy-dot--live" />
                  <div className="fy-activityrow__main">
                    <div className="fy-activityrow__title">{r.title}</div>
                    <div className="fy-activityrow__sub">
                      {r.kind} · {r.detail}
                    </div>
                  </div>
                  <span className="fy-activityrow__meta">{r.percent !== null ? `${Math.round(r.percent)}%` : "running"}</span>
                  {r.cancellable && r.kind === "job" && (
                    <Button variant="ghost" onClick={() => cancelJob(r.ref)}>
                      Cancel
                    </Button>
                  )}
                  {r.kind === "job" && <Button variant="ghost" onClick={() => setInspectedJobId(r.ref)}>Calls</Button>}
                  {r.cancellable && r.kind === "export" && activeWorldId && (
                    <Button variant="ghost" onClick={() => cancelExportMsg(activeWorldId, r.ref)}>
                      Cancel
                    </Button>
                  )}
                </div>
              ))}
              <div className="fy-eyebrow-sm" style={{ margin: "18px 0 2px" }}>
                NEEDS YOU · {scoped(needsYou).length}
              </div>
              {scoped(needsYou).length === 0 && <div className="fy-mono" style={{ padding: "10px 0" }}>nothing waiting on you</div>}
              {scoped(needsYou).map((entry, i) => (
                <div key={`${entry.kind}-${entry.ref ?? entry.worldId ?? i}`} className="fy-activityrow" style={{ alignItems: "flex-start" }}>
                  <span className="fy-dot fy-dot--warn" style={{ marginTop: 5 }} />
                  <div className="fy-activityrow__main">
                    <div className="fy-activityrow__title" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {entry.title}
                      <Badge tone={entry.urgency <= 2 ? "warning" : "outline"}>class {entry.urgency}</Badge>
                      {entry.asOf && <Badge tone="outline">as of {shortDateTime(entry.asOf)} — not current</Badge>}
                    </div>
                    <div className="fy-activityrow__sub">{entry.detail}</div>
                    <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 8, flexWrap: "wrap" }}>
                      {entry.ref && jobs.some((job) => job.id === entry.ref) && <Button variant="ghost" onClick={() => setInspectedJobId(entry.ref!)}>Provider calls</Button>}
                      {entry.actions.includes("resolve") && entry.ref && (
                        <>
                          <Button onClick={() => resolveHeldJob(entry.ref!, "resubmit")}>Resubmit · may charge again</Button>
                          <Button variant="ghost" onClick={() => resolveHeldJob(entry.ref!, "discard")}>
                            Abandon · prior cost unknown
                          </Button>
                        </>
                      )}
                      {entry.actions.includes("retry-finalization") && entry.ref && (
                        <Button onClick={() => retryJobFinalization(entry.ref!)}>
                          Retry finalization · no regeneration or charge
                        </Button>
                      )}
                      {entry.actions.includes("settings") && entry.ref && (
                        <>
                          <Button onClick={() => resumeQueue(entry.ref!)}>Resume {entry.ref}</Button>
                          <Button variant="ghost" onClick={() => navigate("/settings/providers")}>
                            Settings
                          </Button>
                        </>
                      )}
                      {entry.actions.includes("reconcile") && entry.worldId && (
                        <Button onClick={() => navigate(`/w/${entry.worldId}`)}>Open world</Button>
                      )}
                      {entry.actions.includes("review") && entry.worldId && (
                        <Button onClick={() => navigate(entry.reviewPath ?? `/w/${entry.worldId}/productions`)}>Review</Button>
                      )}
                      {entry.actions.includes("open-proposal") && entry.worldId && (
                        <Button onClick={() => navigate(`/w/${entry.worldId}/proposals`)}>Review</Button>
                      )}
                      {entry.actions.includes("open-world") && entry.worldId && (
                        <Button
                          onClick={() => {
                            // Opening makes the counts precise (R-7).
                            openWorld(entry.worldId!);
                            navigate(`/w/${entry.worldId}`);
                          }}
                        >
                          Open — items become precise
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
          {buildMissing.map(({ build, missing }) => (
            <div key={build.buildId}>
              <div className="fy-eyebrow-sm" style={{ margin: "18px 0 2px" }}>
                THE FOUNDING BUILD · {missing.length} NOT LANDED
              </div>
              {missing.length > 1 && (
                <div className="fy-activityrow">
                  <span className="fy-dot" />
                  <div className="fy-activityrow__main">
                    <span>{build.worldName} · everything outstanding</span>
                  </div>
                  <Button onClick={() => runBuildItem(build.worldId)}>Run all {missing.length}</Button>
                </div>
              )}
              {missing.map((item) => (
                <div key={item.key} className="fy-activityrow">
                  <span className="fy-dot fy-dot--warn" />
                  <div className="fy-activityrow__main">
                    <span>{buildWorkingLine(item)}</span>
                    {item.detail && <span className="fy-mono">{item.detail}</span>}
                  </div>
                  {/* Lands exactly as the build would have — settled, anchored, designated (R-49). */}
                  <Button onClick={() => runBuildItem(build.worldId, item.key)}>Run</Button>
                </div>
              ))}
            </div>
          ))}
          <div className="fy-eyebrow-sm" style={{ margin: "18px 0 2px" }}>
            EARLIER TODAY
          </div>
          {recent.length === 0 && <div className="fy-mono" style={{ padding: "10px 0" }}>nothing finished today · the ledger holds everything</div>}
          {recent.slice(0, 20).map((job) => (
            <div key={job.id} className="fy-activityrow" style={{ display: "block" }}>
              <JobRow job={job} />
              {/* Where this one is re-run from, which is not one place (issue 226). The row used
                  to name the production's dispatch dialog under every failure, including the
                  reference work that belongs to no production and has no such dialog. */}
              {jobActions(job).includes("retry") &&
                (() => {
                  // A founding-build job retries through the build's own landing (SPEC-031
                  // R-49): the photo becomes the anchor, never a staged proposal.
                  const owned = buildItemForJob(job.id);
                  if (owned) {
                    return (
                      <>
                        <span className="scr-field__hint">failed — runs again and lands settled</span>
                        <Button variant="ghost" onClick={() => runBuildItem(owned.build.worldId, owned.item.key)}>
                          Run again
                        </Button>
                      </>
                    );
                  }
                  const origin = jobOrigin(job);
                  return origin ? (
                    <>
                      <span className="scr-field__hint">failed — run it again from {origin.where}</span>
                      <Button variant="ghost" onClick={() => navigate(origin.path)}>
                        {origin.label}
                      </Button>
                    </>
                  ) : (
                    <span className="scr-field__hint">failed — run it again from wherever you started it</span>
                  );
                })()}
              <Button variant="ghost" onClick={() => setInspectedJobId(job.id)}>Provider calls</Button>
              {/* Two clicks and no dialog, like archiving a world: the second click is the consent,
                  and the words say what survives it. Offered only where the state permits it
                  (R-13) — work still finishing, or a finalization the user can still retry, is
                  not history yet. */}
              {jobActions(job).includes("delete") &&
                (confirmingDelete === job.id ? (
                  <>
                    <span className="scr-field__hint">
                      Remove from this history? The ledger entry and anything it produced stay — spend does not
                      move.
                    </span>
                    <Button
                      onClick={() => {
                        deleteJob(job.id);
                        setConfirmingDelete(null);
                      }}
                    >
                      Delete
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmingDelete(null)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirmingDelete(job.id)}>
                    Delete
                  </Button>
                ))}
            </div>
          ))}
          {(inspectedJobId || inspectAllCalls) && (
            <ProviderCallInspector jobId={inspectAllCalls ? null : inspectedJobId} onClose={() => { setInspectedJobId(null); setInspectAllCalls(false); }} />
          )}
        </div>
        <div className="fy-activity__side">
          <div style={{ font: "600 13px var(--font-sans)" }}>
            {spend ? `Last ${spend.periodDays} days` : "Spend"}
          </div>
          {spend && (
            <>
              <div className="fy-spendtotal">
                {formatMicroUsd(spend.totalMicroUsd)} <span className="fy-mono">{sourceNote}</span>
              </div>
              {spend.byProvider
                .filter((p) => !p.unmetered)
                .map((p) => (
                  <div key={p.provider} className="fy-spendbar">
                    <span className="fy-spendbar__label">{p.provider}</span>
                    <div className="fy-spendbar__track">
                      <div
                        className="fy-spendbar__fill"
                        style={{
                          width: `${spend.totalMicroUsd > 0 ? Math.max(Math.round((p.microUsd / spend.totalMicroUsd) * 100), 2) : 0}%`,
                        }}
                      />
                    </div>
                    <span className="fy-spendbar__value">{formatMicroUsd(p.microUsd)}</span>
                  </div>
                ))}
              {spend.unmeteredRuns > 0 && (
                <div className="fy-mono" style={{ marginTop: 12 }}>
                  {spend.unmeteredRuns} unmetered run{spend.unmeteredRuns === 1 ? "" : "s"} — no provider charge
                </div>
              )}
              <div className="fy-notecard" style={{ background: "var(--background)" }}>
                <span className={`fy-dot fy-dot--${spendStatus?.alerted ? "warn" : "sketch"}`} />
                {alertNote}
                {/* Opens the control in place. It used to send you to Settings, which is where the
                    threshold lived; 26a puts the threshold on this screen, so it is here now. */}
                <button
                  type="button"
                  className="fy-spendalert__toggle"
                  aria-expanded={editingThreshold}
                  onClick={() => setEditingThreshold((open) => !open)}
                >
                  {editingThreshold ? "Close" : "Set"}
                </button>
              </div>
              {editingThreshold && (
                <div className="fy-spendalert">
                  <span className="fy-spendalert__label">alert at $</span>
                  <Input
                    aria-label="Alert threshold in dollars"
                    style={{ maxWidth: 92 }}
                    value={thresholdValue}
                    onChange={(e) => setThreshold(e.target.value)}
                  />
                  <span className="fy-spendalert__label">over</span>
                  <Input
                    aria-label="Alert window in days"
                    style={{ maxWidth: 62 }}
                    value={periodValue}
                    onChange={(e) => setPeriod(e.target.value)}
                  />
                  <span className="fy-spendalert__label">days</span>
                  <Button
                    onClick={() => {
                      const usdValue = Number.parseFloat(thresholdValue);
                      const days = Number.parseInt(periodValue, 10);
                      if (Number.isFinite(usdValue) && usdValue >= 0 && Number.isFinite(days) && days >= 1) {
                        setSpendThreshold(Math.round(usdValue * 1_000_000), Math.min(days, 365));
                        setThreshold(null);
                        setPeriod(null);
                        setEditingThreshold(false);
                      }
                    }}
                  >
                    Save
                  </Button>
                </div>
              )}
              {drift.map((d) => (
                <Callout key={d.modelId} tone="warning" title={`${d.modelId} estimates are drifting`}>
                  ~{(d.medianDivergencePerMille / 10).toFixed(0)}% off across {d.samples} provider-reported charges —
                  the shipped manifest needs an update.
                </Callout>
              ))}
            </>
          )}
          <div className="fy-mono" style={{ marginTop: 12 }}>
            unmetered runtimes report no provider charge
          </div>
          <div style={{ flex: 1 }} />
          <Button onClick={() => navigate("/settings/providers")}>Providers &amp; keys</Button>
          <Button variant="ghost" onClick={() => { setInspectedJobId(null); setInspectAllCalls(true); }}>All provider calls</Button>
        </div>
      </div>
    </div>
  );
}
