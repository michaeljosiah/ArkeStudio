import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate, useSearchParams } from "react-router";
import { Badge, Button, Callout, Input, StatusDot, Textarea, cx, type StatusDotTone } from "../components/ui.js";
import { VoicePickerDialog } from "../components/voice-picker.js";
import { EmptyState } from "../components/layout.js";
import { JobRow } from "../domain/domain.js";
import { Archive, ChevronDown, ChevronRight, Plus, Sparkle, X } from "../components/icons.js";
import { AgentsPanel } from "./agents.js";
import { AppChrome } from "../components/chrome.js";
import type { StartupState } from "../arke-bridge.js";
import { Working } from "../components/working.js";
import { Portrait } from "../components/portrait.js";
import { Composer } from "../components/composer.js";
import { shortDateTime } from "../lib/format.js";
import { setThemePreference, useResolvedTheme, useThemePreference, type ThemePreference } from "../lib/theme.js";
import {
  cancelExport as cancelExportMsg,
  cancelJob,
  checkUpdates,
  chooseVoxaExecutable,
  cancelProviderToolSignIn,
  clearCredential,
  clearVoxaExecutable,
  attachHostFiles,
  attachHostText,
  archiveWorld,
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
  detectRuntimes,
  chooseComfyUiPath,
  chooseComfyUiModelsDir,
  clearComfyUiModelsDir,
  clearComfyUiEngine,
  setComfyUiUrl,
  useDetectedComfyUi,
  refreshComfyUi,
  verifyComfyUiRecipe,
  downloadUpdate,
  installUpdateAndRestart,
  installUpdateOnClose,
  generateDiagnostics,
  listProviderCalls,
  openDataFolder,
  openModelFolder,
  openThread,
  openWorld,
  resolveHeldJob,
  repairVoiceModels,
  restartVoxa,
  retryJobFinalization,
  resumeQueue,
  refreshProviderTool,
  selectProviderWorkspace,
  setCredential,
  signInProviderTool,
  setBackgroundNotifications,
  setModelEnabled,
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
  setupCancel,
  setupRetry,
  setupSkip,
  useReconcileReport,
  useStore,
  useUpdateStatus,
  useVoiceSidecar as useVoiceSidecarState,
  useVoiceRuntimeTest,
  useBundledVoxa,
  testLocalVoice,
  validateProvider,
  setNarrator,
  type ReadingVoice,
} from "../lib/store.js";
import { ArtStyleGrid, ArtStyleWords } from "../components/art-style-picker.js";
import { seedFrom } from "../lib/art-styles.js";
import { playClip, usePlayback } from "../lib/audio.js";
import {
  computeNeedsYou,
  computeRunning,
  deriveCapabilityAvailability,
  formatMicroUsd,
  jobActions,
  jobOrigin,
  modelCapabilityCopy,
  modelPriceCopy,
  PROVIDERS as PROVIDER_TABLE,
  spendSummary,
  type Capability,
  type ComponentHealth,
  type HarnessAvailability,
  type HarnessEngine,
  OPENCODE_AVAILABILITY,
  type ComfyUiEngineStatus,
  type LocalRuntimeStatus,
  type NarratorSettings,
  type ManifestModel,
  type ProviderId,
  type ProviderCallRecord,
  type ProviderStatus,
  type ProviderWorkspace,
  type SetupComponent,
  type VoiceRuntimeStatus,
  DEFAULT_NARRATOR,
} from "@arke-studio/contracts";

/** Shell screens: launch, first run, world picker, new world, settings, activity (§2.9). */

const HEALTH_TONE: Record<ComponentHealth["status"], StatusDotTone> = {
  healthy: "ok",
  starting: "busy",
  unhealthy: "danger",
  unavailable: "muted",
};

export function HealthDot({ label, health }: { label: string; health: ComponentHealth | undefined }) {
  const status = health?.status ?? "starting";
  return (
    <StatusDot
      tone={HEALTH_TONE[status]}
      label={`${label} — ${status}${health?.reason ? ` (${health.reason})` : ""}`}
    />
  );
}

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

export function StartupScreen() {
  const { connection, state } = useStore();
  const navigate = useNavigate();
  const env = useEnvCheck();
  const setup = useSetup();
  const downloading = setup?.running === true;
  const [startup, setStartup] = useState<StartupState | null>(() =>
    typeof window === "undefined" ? null : window.arke?.startupState?.() ?? null,
  );
  useEffect(() => window.arke?.onStartupState?.(setStartup), []);

  // Setup never walks off on its own — the user continues when they're ready (no worlds →
  // first run; otherwise the picker, R-8).
  const ready = connection === "open" && state !== null;
  // Nothing left to fetch and somewhere to go: the only state where this screen is finished
  // rather than working.
  const settled = ready && !downloading;
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
        (c.state === "downloading" || c.state === "installing"
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
  const active = components.find((c) => c.state === "downloading" || c.state === "installing");
  const outstanding = steps.find((s) => !s.settled);
  const activity = active
    ? `${active.state === "installing" ? "installing" : "downloading"} ${active.displayName.toLowerCase()}`
    : outstanding
      ? `checking ${outstanding.label.toLowerCase()}`
      : "everything ready";

  // Bytes and time remaining, only while there is something to measure.
  const totalBytes = components.reduce((sum, c) => sum + c.bytesTotal, 0);
  const doneBytes = components.reduce((sum, c) => sum + (c.state === "queued" ? 0 : c.state === "downloading" || c.state === "installing" ? c.bytesDone : c.bytesTotal), 0);
  const speed = active?.bytesPerSecond ?? null;
  const remaining = speed !== null && speed > 0 ? Math.round((totalBytes - doneBytes) / speed) : null;

  // Setup happens once. Every launch after it detects the runtimes already on this machine,
  // fetches nothing, and waits only for the coordinator to open — a few seconds with no
  // progress worth reporting. A bar creeping under "Setting up your studio" is then a lie
  // about what is happening and about how often it happens, so that panel is kept for the
  // launch that is actually doing the work: something queued, downloading or installing.
  const fetching = components.some(
    (c) => c.state === "queued" || c.state === "downloading" || c.state === "installing",
  );
  const setupRun = downloading || fetching;

  // The snapshot's version once there is a snapshot; the host's before that, so the one line
  // this screen keeps is not an empty "v" for the length of the wait.
  const version =
    state?.app.version ?? (typeof window === "undefined" ? null : window.arke?.appVersion ?? null);
  const enter = () => {
    if (!settled || !state) return;
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
          </div>
          <div className="fy-setupbar">
            <div className="fy-setupbar__fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="fy-startup__row" style={{ marginTop: 8 }}>
            <span className="fy-mono">{totalBytes > 0 ? `${mb(doneBytes)} of ${mb(totalBytes)}` : ""}</span>
            <span style={{ flex: 1 }} />
            <span className="fy-mono">{remaining !== null ? aboutLeft(remaining) : ""}</span>
          </div>
          {connection === "closed" && startup?.status !== "initializing" && (
            <Callout tone="warning" title="Waiting for the coordinator">
              The app keeps retrying on its own. If this is a dev browser session, start it with
              `npm run dev:coordinator`.
            </Callout>
          )}
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
              {connection === "closed" && startup?.status !== "initializing" && (
                <Callout tone="warning" title="Waiting for the coordinator">
                  The app keeps retrying on its own. If this is a dev browser session, start it
                  with `npm run dev:coordinator`.
                </Callout>
              )}
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
  const draft = g?.draft ?? null;

  // With a healthy harness, talking is the front door (prototype 12a) — unless the author
  // already picked the form themselves.
  useEffect(() => {
    if (harnessReady && !modeTouchedRef.current) setGenMode("chat");
  }, [harnessReady]);

  const charSeed = parseSeed(firstCharacter);
  const locSeed = parseSeed(firstLocation);
  const shownName = name.trim() || draft?.name?.trim() || "";
  const shownLogline = logline.trim() || draft?.logline?.trim() || "";
  const shownTone = tone.trim() || draft?.tone?.trim() || "";
  const shownGenre = genre.trim() || draft?.genre?.trim() || "";
  const draftCharacters = (draft?.characters ?? []).filter((c) => c.name !== charSeed?.name);
  const draftLocations = (draft?.locations ?? []).filter((l) => l.name !== locSeed?.name);
  const railCharacters = [...(charSeed ? [charSeed] : []), ...draftCharacters.map((c) => ({ name: c.name, sentence: c.line }))];
  const railLocations = [...(locSeed ? [locSeed] : []), ...draftLocations.map((l) => ({ name: l.name, sentence: l.line }))];
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
      for (const t of (draft?.threads ?? []).slice(0, 4)) {
        openThread(worldId, t.length > 80 ? `${t.slice(0, 77)}…` : t, t, []);
      }
      genesisDiscard(genesisId);
    }
    navigate(`/w/${worldId}`, { replace: true });
  }, [submittedName, state?.world, navigate, railCharacters, railLocations, draft, genesisId]);

  const canCreate = connection === "open" && shownName.length > 0 && submittedName === null;
  const entries = 1 + railCharacters.length + railLocations.length + (draft?.threads.length ?? 0);

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
      ...(draft?.bible && draft.bible.trim().length > 0 ? { bible: draft.bible.trim() } : {}),
      // Whatever was handed to the conversation follows it in. Sent always, not only when
      // something is attached: the sandbox is the source of truth for what is waiting, and the
      // screen's idea of it can lag an event behind.
      genesisId,
    });
  };

  if (step !== "draft") {
    return (
      <div className="fy-app" data-screen="new-world-art-direction">
        <AppChrome back={{ label: "Back", to: "/worlds" }} context={{ label: "new world · art direction" }} />
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
                <Button variant="ghost" disabled={!canCreate} onClick={() => begin()}>
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
              <h1 className="fy-artstep__h1">The preset writes a first draft.</h1>
              <p className="fy-artstep__lede">
                These are the words that ride along with every generation. Edit them, or replace
                them entirely. A preset seeds the text; it never locks it.
              </p>
              <ArtStyleWords selectedId={presetId} value={look} onChange={setLook} />
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
                  onClick={() => begin(look)}
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
                    {turn.text}
                  </div>
                ))}
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
                    busy={chatRunning}
                    busyLabel="shaping the draft…"
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
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Logline</div>
              <Textarea
                placeholder="One sentence about this world"
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
                  value={GENESIS_TONES.includes(tone as (typeof GENESIS_TONES)[number]) ? "" : tone}
                  onChange={(e) => setTone(e.target.value)}
                  style={{ marginTop: 6 }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Genre</div>
                <Input placeholder="A genre" value={genre} onChange={(e) => setGenre(e.target.value)} />
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
          <div className="fy-draftcard" style={{ padding: "10px 10px 16px" }}>
            <div
              style={{
                height: 118,
                borderRadius: 8,
                border: "1.5px dashed var(--neutral-300)",
                background: "var(--neutral-50)",
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
                      sketch · no face yet
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
                      sketch
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {(draft?.threads.length ?? 0) > 0 && (
            <div className="fy-draftcard" style={{ padding: "12px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="fy-dot fy-dot--warn" style={{ width: 6, height: 6 }} />
                <span style={{ font: "600 12.5px var(--font-sans)" }}>Open threads</span>
                <span className="fy-mono">pull one to keep going</span>
              </div>
              <div style={{ font: "400 12px/1.7 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 7 }}>
                {draft!.threads.slice(0, 4).map((t, i) => (
                  <div key={i}>{t}</div>
                ))}
              </div>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 16 }} />
          <div style={{ display: "grid", gap: 8 }}>
            <Button variant="primary" disabled={!canCreate} onClick={() => setStep("look")}>
              {submittedName ? "Creating…" : "Begin in this world"}
            </Button>
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
  const { state } = useStore();
  const navigate = useNavigate();
  const firstWorld = state?.worlds[0] ?? null;
  return (
    <div className="fy-app" data-screen="settings">
      {/* The scrim used to start at the top of the window and swallow the bar with it. It now
          sits under the chrome: the blurred world art is atmosphere, not a reason to lose the
          only fixed thing on screen. The panel keeps its own close — that is an exit, not a
          destination, and the two read differently. */}
      <AppChrome current="settings" divided={false} />
      <div className="fy-content">
      <div className="fy-scrim">
        {firstWorld && (
          <div className="fy-scrim__art">
            <Portrait worldSlug={firstWorld.slug} path={firstWorld.keyArt ?? ""} label="" radius={0} />
          </div>
        )}
        <div className="fy-scrim__wash" />
        <div className="fy-scrim__center">
          <div className="fy-settings">
            <div className="fy-settings__head">
              <div style={{ flex: 1 }}>
                <div className="fy-settings__title">Settings</div>
                <div className="fy-settings__sub">
                  providers &amp; runtime · one key per provider, however many jobs it does
                </div>
              </div>
              <button type="button" className="fy-settings__close" onClick={() => navigate("/worlds")}>
                <X size={14} />
              </button>
            </div>
            <div className="fy-settings__body">
              <div className="fy-settings__rail">
                {(
                  [
                    ["providers", "Providers"],
                    ["appearance", "Appearance"],
                    ["notifications", "Notifications"],
                    ["local-runtime", "Local runtime"],
                    ["harness", "Harness"],
                    ["who-does-what", "Who does what"],
                    ["sample-world", "Sample world"],
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
              </div>
              <div className="fy-settings__pane">
                <Outlet />
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

/**
 * The providers configured here, in the rail's order. Most take a key; Higgsfield takes a
 * sign-in through its own CLI instead (issue 137), which is a different row but the same
 * pane — it is still a credential and a list of models. What each one does is not a
 * hand-written note beside it: the pane reads the capabilities off the models that credential
 * reaches, so a manifest change cannot leave the description behind.
 */
const KEYED_PROVIDERS: Array<{ id: ProviderId }> = [
  { id: "fal" },
  { id: "higgsfield" },
  { id: "elevenlabs" },
  { id: "openai" },
  { id: "anthropic" },
];

/**
 * What the last validation actually proved, per capability. A key that authenticates but cannot
 * do video says so here rather than at the end of composing a scene (SPEC-008 R-3).
 */
function ProbeChips({ status }: { status: ProviderStatus | undefined }) {
  if (!status || status.probes.length === 0) return null;
  const short = status.probes.filter((p) => !p.available);
  return (
    <div className="fy-set__why">
      <span className={cx("fy-set__dot", short.length === 0 ? "fy-set__dot--ok" : "fy-set__dot--warn")} />
      <span>
        {short.length === 0
          ? `tested: ${status.probes.map((p) => p.capability).join(" · ")}`
          : short.map((p) => `${p.capability} — ${p.reason ?? "unavailable"}`).join(" · ")}
      </span>
    </div>
  );
}

/**
 * Each capability in the words the app uses elsewhere. "image" is the manifest's name for it;
 * "Frames & stills" is what it does, and what a still of a world is generated by.
 */
const CAPABILITY_LABEL: Record<Capability, string> = {
  image: "Frames & stills",
  video: "Clips",
  music: "Score & songs",
  llm: "Direct LLM work",
  "voice-tts": "Voice",
  "voice-clone": "Voice cloning",
  "voice-stt": "Dictation",
};

/**
 * A provider whose credential is not ours to hold (issue 137). There is no key to paste: the
 * tool signs itself in, and the only questions the app can answer are whether it is here and
 * whether it is signed in. So the row is a state and the one action that changes it — plus the
 * command to type, always visible rather than revealed by a failure, because the in-app button
 * cannot serve every machine and finding that out at the moment it fails is too late.
 */
/**
 * Which setup component fetches each tool. The app can install these itself, so "not
 * installed" is a state with an action rather than only an instruction.
 */
const TOOL_COMPONENT: Partial<Record<ProviderId, string>> = { higgsfield: "higgsfield-cli" };

/** A personal account has no name; saying so beats printing a UUID at somebody. */
function workspaceLabel(workspace: ProviderWorkspace): string {
  const name = workspace.name ?? "Personal account";
  const parts = [name];
  if (workspace.plan) parts.push(workspace.plan);
  if (workspace.credits !== null) {
    // The provider's own unit. Converting to money would mean inventing a rate we do not know.
    parts.push(`${workspace.credits} credit${workspace.credits === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

/**
 * Which account pays. One credential can reach several, and a generation billed to the wrong
 * one is not recoverable — so the choice is made here, in advance, rather than discovered on an
 * invoice. With a single account there is nothing to choose and the row just names it, because
 * "which account paid for that" should never need asking afterwards.
 */
function ProviderWorkspaceLine({
  id,
  workspaces,
}: {
  id: ProviderId;
  workspaces: readonly ProviderWorkspace[];
}) {
  if (workspaces.length === 0) return null;
  const selected = workspaces.find((w) => w.selected) ?? null;
  return (
    <>
      <div className="fy-prov__keyline">
        <div className="fy-prov__eyebrow">BILLS TO</div>
        {workspaces.length === 1 ? (
          <div className="fy-set__field">
            <span style={{ flex: 1 }}>{workspaceLabel(workspaces[0]!)}</span>
          </div>
        ) : (
          <div className="fy-set__field">
            <select
              className="fy-set__input"
              aria-label="Billing account"
              value={selected?.id ?? ""}
              onChange={(e) => selectProviderWorkspace(id, e.target.value === "" ? null : e.target.value)}
            >
              {/* An explicit entry for "no workspace", because `workspace unset` is a real
                  choice — it returns billing to the personal account rather than clearing it. */}
              <option value="">Personal account</option>
              {workspaces
                .filter((w) => w.name !== null)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {workspaceLabel(w)}
                  </option>
                ))}
            </select>
          </div>
        )}
      </div>
      {workspaces.length > 1 && selected === null && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>This sign-in reaches {workspaces.length} accounts and none is selected — choose which one pays.</span>
        </div>
      )}
    </>
  );
}

function ProviderToolLine({ id }: { id: ProviderId }) {
  const { state } = useStore();
  const setup = useSetup();
  const [copied, setCopied] = useState(false);
  const component = setup?.components.find((c) => c.id === TOOL_COMPONENT[id]);
  const fetching = component?.state === "downloading" || component?.state === "installing" || component?.state === "queued";
  const arrived = component?.state === "ready" || component?.state === "present";
  // The download finishing is not the row changing: discovery is what decides where the tool
  // is, so ask again rather than leaving "not installed" beside a tool that just landed.
  const published = state?.app.providerTools.find((t) => t.provider === id)?.state;
  useEffect(() => {
    if (arrived && published === "absent") refreshProviderTool(id);
  }, [arrived, published, id]);
  // No published status means discovery has not reported — a build with no probe wired, or the
  // moment before the first one lands. That is "we have not looked", which still owes the user
  // a row and a command; rendering nothing would leave the pane with no credential line at all.
  const tool = state?.app.providerTools.find((t) => t.provider === id) ?? {
    provider: id,
    state: "absent" as const,
    executableName: null,
    source: null,
    version: null,
    account: null,
    workspaces: [],
    detail: "the Higgsfield CLI has not been found on this machine",
    signInCommand: "higgsfield auth login",
  };
  const label =
    tool.state === "ready"
      ? (tool.account ?? "signed in")
      : tool.state === "signing-in"
        ? "waiting for the browser…"
        : tool.state === "absent"
          ? "not installed"
          : "signed out";
  const copy = () => {
    void navigator.clipboard?.writeText(tool.signInCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <>
      <div className="fy-prov__keyline">
        <div className="fy-prov__eyebrow">SIGN-IN</div>
        <div className="fy-set__field">
          <span style={{ flex: 1 }}>{label}</span>
          {tool.state === "absent" && (
            <button
              type="button"
              className="fy-set__link"
              disabled={fetching}
              onClick={() => setupRetry(TOOL_COMPONENT[id]!)}
            >
              {fetching ? "installing…" : `Install${component ? ` · ${component.sizeMb} MB` : ""}`}
            </button>
          )}
          {tool.state === "signing-in" ? (
            <button type="button" className="fy-set__link" onClick={() => cancelProviderToolSignIn(id)}>
              Stop waiting
            </button>
          ) : (
            <button
              type="button"
              className="fy-set__link"
              disabled={tool.state === "absent"}
              onClick={() => signInProviderTool(id)}
            >
              {tool.state === "ready" ? "Sign in again" : "Sign in"}
            </button>
          )}
          <button type="button" className="fy-set__link" onClick={() => refreshProviderTool(id)}>
            Re-check
          </button>
        </div>
      </div>
      <div className="fy-set__why">
        <span
          className={cx(
            "fy-set__dot",
            tool.state === "ready" ? "fy-set__dot--ok" : tool.state === "signing-in" ? "" : "fy-set__dot--warn",
          )}
        />
        <span>
          {tool.detail ??
            (tool.state === "ready"
              ? `${tool.executableName ?? "the CLI"}${tool.version ? ` ${tool.version}` : ""}${
                  tool.source === "bundled" ? " · fetched by Arke Studio" : " · found on this machine"
                }`
              : "")}
        </span>
      </div>
      <ProviderWorkspaceLine id={id} workspaces={tool.workspaces} />
      <div className="fy-set__note">
        {tool.state === "absent" ? "Install it, then sign in: " : "Or sign in from a terminal: "}
        <code>{tool.signInCommand}</code>{" "}
        <button type="button" className="fy-set__link" onClick={copy}>
          {copied ? "copied" : "Copy"}
        </button>
        {" · we will notice when it works."}
      </div>
    </>
  );
}

/**
 * One provider's key, on one line under its name (design turn 40a). The name is the pane's own
 * heading here, so the row carries the label KEY and nothing else: a provider is a key and a list
 * of models, and repeating the provider's name beside its key was the clutter the flat list had.
 */
function ProviderKeyLine({ id }: { id: ProviderId }) {
  const { state } = useStore();
  const [draft, setDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const status = state?.app.providers.find((p) => p.id === id);
  const info = PROVIDER_TABLE[id];
  const stored = status?.configured === true;
  const save = () => {
    if (draft.trim().length === 0) return;
    setCredential(id, draft.trim());
    setDraft("");
    setReplacing(false);
  };
  return (
    <>
      <div className="fy-prov__keyline">
        <div className="fy-prov__eyebrow">KEY</div>
        {stored && !replacing ? (
          <div className="fy-set__field">
            {/* No last-four: the key never comes back over the bridge, and inventing a tail
                would be a picture of a secret rather than the secret's state (R-10). */}
            <span style={{ flex: 1 }}>•••••••••••• stored</span>
            <button type="button" className="fy-set__link" onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button
              type="button"
              className="fy-set__link"
              disabled={status?.validation === "testing"}
              onClick={() => validateProvider(id)}
            >
              {status?.validation === "testing" ? "testing…" : "Test"}
            </button>
            <button type="button" className="fy-set__link" onClick={() => clearCredential(id)}>
              Remove
            </button>
          </div>
        ) : (
          <div className={cx("fy-set__field", draft.length === 0 && "fy-set__field--empty")}>
            <input
              className="fy-set__input"
              type="password"
              aria-label={`${info.displayName} API key`}
              placeholder={info.keyHint ?? "Paste API key…"}
              value={draft}
              autoFocus={replacing}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape" && replacing) {
                  setDraft("");
                  setReplacing(false);
                }
              }}
            />
            <button type="button" className="fy-set__link" disabled={draft.trim().length === 0} onClick={save}>
              Save
            </button>
            {replacing && (
              <button
                type="button"
                className="fy-set__link"
                onClick={() => {
                  setDraft("");
                  setReplacing(false);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
      {status?.fault && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          {/* The reassurance is only true while a key is stored: then a fault is that key
              failing in use, and the generation it interrupted was not at fault. With nothing
              stored the fault is about the store itself (issue 227), and pointing at the
              credential would send the user to try a different key. */}
          <span>{status.fault}{stored ? " — the work was not the problem; the credential was." : ""}</span>
        </div>
      )}
      <ProbeChips status={status} />
    </>
  );
}

/** A model this studio offers, or does not. The switch is the whole row's control. */
function ProviderModelRow({
  model,
  enabled,
  usable,
}: {
  model: ManifestModel;
  enabled: boolean;
  usable: boolean;
}) {
  return (
    <div className={cx("fy-prov__model", !usable && "fy-prov__model--off")}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={model.displayName}
        disabled={!usable}
        className={cx("fy-prov__switch", enabled && "is-on")}
        onClick={() => setModelEnabled(model.id, !enabled)}
      >
        <span />
      </button>
      <span className="fy-prov__modelname">{model.displayName}</span>
      {model.unverified === true && <em className="fy-prov__unverified">UNVERIFIED</em>}
      <span style={{ flex: 1 }} />
      <span className="fy-prov__price">
        {model.capability} · {modelPriceCopy(model)}
      </span>
    </div>
  );
}

/**
 * One provider: its key, then every model that key can reach, each with a switch (turn 40a).
 * Availability is per provider, per model — a model switched off appears in no picker and cannot
 * be a routing default — and the count says how many of how many, because "4 on" beside a
 * provider is the only number that answers what this key currently offers.
 */
function ProviderPane({ id }: { id: ProviderId }) {
  const { state } = useStore();
  const info = PROVIDER_TABLE[id];
  const status = state?.app.providers.find((p) => p.id === id);
  const configured = status?.configured === true;
  const troubled = Boolean(status?.fault) || status?.validation === "invalid";
  const models = (state?.app.manifest?.models ?? []).filter((m) => m.provider === id);
  const disabled = new Set(state?.app.models.disabled ?? []);
  // What this key actually unlocks, capability by capability — the same question the generation
  // pickers ask. A key can authenticate and still not do images, and this pane used to count
  // those image rows as ON and let them be switched while no picker would ever list them.
  const unlocked = new Set(
    deriveCapabilityAvailability(state?.app.providers ?? [])
      .filter((a) => a.via.includes(id))
      .map((a) => a.capability),
  );
  const reaches = (model: ManifestModel): boolean => unlocked.has(model.capability);
  const on = models.filter((m) => reaches(m) && !disabled.has(m.id)).length;
  const capabilities = [...new Set(models.map((m) => m.capability))];
  return (
    <div className="fy-prov__pane">
      <div className="fy-prov__head">
        <span className="fy-prov__title">{info.displayName}</span>
        <span className="fy-prov__caps">{capabilities.join(" · ").toUpperCase()}</span>
        <span style={{ flex: 1 }} />
        <span className={cx("fy-set__dot", troubled ? "fy-set__dot--warn" : configured && "fy-set__dot--ok")} />
        <span className="fy-set__state">
          {info.credential === "external"
            ? troubled
              ? "sign-in needed"
              : configured
                ? "connected"
                : "not signed in"
            : troubled
              ? "key rejected"
              : configured
                ? "connected"
                : "no key"}
        </span>
      </div>
      {/* A provider is a credential and a list of models — but whose credential differs, and
          the two need different rows: one takes a key, the other cannot be given one. */}
      {info.credential === "external" ? <ProviderToolLine id={id} /> : <ProviderKeyLine id={id} />}
      <div className="fy-prov__modelshead">
        <div className="fy-prov__eyebrow">MODELS</div>
        <span style={{ flex: 1 }} />
        <span className="fy-prov__count">
          {/* Without a key nothing here is on, whatever the switches say — the rail already uses
              an em dash for this state and the pane must not contradict it two inches away. */}
          {models.length === 0
            ? "NONE IN THE MANIFEST"
            : unlocked.size === 0
              ? `${models.length} UNAVAILABLE`
              : `${on} OF ${models.length} ON`}
        </span>
      </div>
      <div className="fy-prov__models">
        {models.map((model) => (
          // Switchable only once the key is stored: a model this studio cannot reach is not a
          // choice, and letting it be switched on would put it in pickers that must then refuse it.
          <ProviderModelRow
            key={model.id}
            model={model}
            enabled={reaches(model) && !disabled.has(model.id)}
            usable={reaches(model)}
          />
        ))}
      </div>
      <div className="fy-set__note">
        {models.length === 0
          ? `nothing in the shipped manifest routes to ${info.displayName} yet`
          : unlocked.size === 0
            ? configured
              ? `this key does not unlock ${info.displayName}'s capabilities — test it above, or replace it`
              : `add a key above — ${info.displayName}'s models become switchable once it is connected`
            : "a model switched off appears in no picker and cannot be a routing default · a default already pointing at one is flagged in Who does what, never re-routed for you"}
      </div>
    </div>
  );
}

export function SettingsProvidersScreen() {
  const { state } = useStore();
  const availability = deriveCapabilityAvailability(state?.app.providers ?? []);
  const disabledModels = new Set(state?.app.models.disabled ?? []);
  const manifestModels = state?.app.manifest?.models ?? [];
  const providerStatus = state?.app.providers ?? [];
  // First run has no key anywhere, so opening on the first provider is not a preference — it is
  // the only pane there is. Once something is connected, that is the one worth landing on.
  const firstConnected = KEYED_PROVIDERS.find((p) =>
    providerStatus.some((s) => s.id === p.id && s.configured),
  );
  const [selected, setSelected] = useState<ProviderId | null>(null);
  const current = selected ?? firstConnected?.id ?? KEYED_PROVIDERS[0]!.id;
  return (
    <div data-screen="settings-providers" className="fy-set">
      <div className="fy-prov">
        <div className="fy-prov__rail" role="tablist" aria-label="Providers">
          {KEYED_PROVIDERS.map((p) => {
            const connected = providerStatus.some((s) => s.id === p.id && s.configured);
            const models = manifestModels.filter((m) => m.provider === p.id);
            // Counted the same way the pane counts, which is the same way the pickers decide:
            // a model behind a capability this key does not unlock is not on.
            const unlocked = new Set(
              availability.filter((a) => a.via.includes(p.id)).map((a) => a.capability),
            );
            const on = models.filter(
              (m) => unlocked.has(m.capability) && !disabledModels.has(m.id),
            ).length;
            return (
              <button
                type="button"
                key={p.id}
                role="tab"
                aria-selected={p.id === current}
                className={cx("fy-prov__railitem", p.id === current && "is-current")}
                onClick={() => setSelected(p.id)}
              >
                <span className={cx("fy-set__dot", connected && "fy-set__dot--ok")} />
                <span>{PROVIDER_TABLE[p.id].displayName}</span>
                <span style={{ flex: 1 }} />
                {/* An em dash, not "0 on": without a key the question of how many models are on
                    does not arise, and a zero would read as a choice someone made. */}
                <span className="fy-prov__count">{connected ? `${on} on` : "—"}</span>
              </button>
            );
          })}
        </div>
        <ProviderPane id={current} />
      </div>
      {/*
       * The pane is the provider list and its detail, and nothing else (40a).
       *
       * Four things used to sit around it. "What this machine can do" is the same question as "who
       * does what", which turn 35 gave a tab of its own — a copy here answered it twice and they
       * could disagree. Spend belongs to Activity (26a), which already draws it by provider with
       * the alert note; the threshold control moved there with it, so the note's own "Set" opens
       * the thing it names rather than sending you to another screen to find it. The eyebrow and
       * the closing note went with them: 35a needed a heading because its pane was a flat list of
       * keys, and 40a's rail already says what this is.
       */}
    </div>
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
  const preference = useThemePreference();
  const resolved = useResolvedTheme();
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
 * A component this pane already states somewhere else, and the group that states it. Every one
 * of these arrived twice: the catalogue row said the weights were on disk, and the section below
 * said the engine was answering — two facts about one thing, two rows apart, in different words.
 *
 * Restated is not the same as redundant. A component that has not settled is only reachable from
 * Components (Download, Skip and Retry are that group's controls), so it stays listed until it
 * arrives and its own group can speak for it. Higgsfield is the exception with no state at all:
 * its install button lives on the Providers pane, which owns the credential it is for.
 */
const STATED_ELSEWHERE: Record<string, "providers" | "voice" | "comfyui" | "local-models"> = {
  "higgsfield-cli": "providers",
  "tts-kokoro-82m": "voice",
  "stt-whisper-base-en": "voice",
  "comfyui-runtime": "comfyui",
  "ollama-gemma4-e2b-it-qat": "local-models",
  "ollama-gemma4-12b": "local-models",
  "ollama-gemma4-26b": "local-models",
};

/** The three tones a runtime state comes in. Anything unmeasured is idle, never a fault (D12). */
type RuntimeTone = "ok" | "warn" | "idle";
const TONE_CLASS: Record<RuntimeTone, string> = {
  ok: "fy-set__dot--ok",
  warn: "fy-set__dot--warn",
  idle: "",
};

/** A dot leading the word it qualifies — the pairing every runtime row states its state with. */
function RuntimeStatus({ tone, children }: { tone: RuntimeTone; children: ReactNode }) {
  return (
    <span className="fy-set__status">
      <span className={cx("fy-set__dot", TONE_CLASS[tone])} />
      <span className="fy-set__state">{children}</span>
    </span>
  );
}

/**
 * The head every runtime detail opens with: what this is, what it does, and where it stands.
 * The same three-part head 40a gives a provider, because the rail is the heading either way.
 */
function RuntimeHead({
  title,
  caps,
  tone,
  state,
}: {
  title: string;
  caps: string;
  tone: RuntimeTone;
  state: string;
}) {
  return (
    <div className="fy-rt__head">
      <span className="fy-rt__title">{title}</span>
      <span className="fy-rt__caps">{caps}</span>
      <span style={{ flex: 1 }} />
      <RuntimeStatus tone={tone}>{state}</RuntimeStatus>
    </div>
  );
}

/** A labelled band inside a detail, with whatever acts on the band as a whole on its right. */
function RuntimeSection({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="fy-rt__sechead">
      <div className="fy-rt__eyebrow">{label}</div>
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}

/** What this machine measured, and the way to measure it again. */
function MachineDetail({ runtime }: { runtime: LocalRuntimeStatus | null }) {
  const gbOrUnknown = (mb: number | null) => (mb === null ? "could not measure" : `${Math.round(mb / 1024)} GB`);
  const probes: Array<[string, number | null]> = [
    ["VRAM", runtime?.probes.vramMb ?? null],
    ["Memory", runtime?.probes.memMb ?? null],
    ["Free disk", runtime?.probes.diskFreeMb ?? null],
  ];
  return (
    <>
      <RuntimeHead
        title="This machine"
        caps={runtime ? "MEASURED AT START-UP" : ""}
        tone={runtime ? "ok" : "idle"}
        state={runtime ? "measured" : "not yet measured"}
      />
      <RuntimeSection label="PROBES">
        <button type="button" className="fy-set__link" onClick={() => detectRuntimes()}>
          Re-detect
        </button>
      </RuntimeSection>
      {probes.map(([label, mb]) => (
        <div key={label} className="fy-set__row">
          <span className="fy-rt__rowname">{label}</span>
          <span style={{ flex: 1 }} />
          {/* A failed probe is unknown, never zero — a measurement nobody took is not a shortage. */}
          <span className="fy-set__state">{runtime ? gbOrUnknown(mb) : "not yet measured"}</span>
        </div>
      ))}
    </>
  );
}

/**
 * The catalogue: what has arrived and what has not. Setup shows a bar and nothing else; this is
 * where the detail lives (prototype 22a), and since turn 75 it is a group of its own rather than
 * a section every other group's rows had to be read past.
 */
function ComponentsDetail({ components, running }: { components: readonly SetupComponent[]; running: boolean }) {
  const size = (mbytes: number) => (mbytes >= 1024 ? `${(mbytes / 1024).toFixed(1)} GB` : `${mbytes} MB`);
  const outstanding = components.filter((c) => c.state !== "ready" && c.state !== "present");
  return (
    <>
      <RuntimeHead
        title="Components"
        caps={`${components.length} IN THE CATALOGUE`}
        tone={componentsTone(components)}
        state={outstanding.length === 0 ? "all here" : `${outstanding.length} outstanding`}
      />
      <RuntimeSection label="ON THIS MACHINE">
        {running && (
          <button type="button" className="fy-set__link" onClick={() => setupCancel()}>
            Stop all
          </button>
        )}
      </RuntimeSection>
      {components.map((c) => {
        const settled = c.state === "ready" || c.state === "present";
        const offered = c.state === "available";
        const pct = c.bytesTotal > 0 ? Math.min(100, Math.round((c.bytesDone / c.bytesTotal) * 100)) : 0;
        return (
          <div key={c.id} className={cx("fy-set__row", "fy-set__row--stack", c.state === "skipped" && "fy-set__row--off")}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="fy-set__name fy-set__name--wide">
                <div className="fy-set__title">{c.displayName}</div>
                <div className="fy-set__caps">
                  {c.purpose} · {size(c.sizeMb)}
                </div>
              </div>
              <RuntimeStatus tone={c.state === "failed" ? "warn" : settled ? "ok" : "idle"}>
                {c.state === "present" ? "already here" : c.state === "downloading" ? `${pct}%` : c.state}
              </RuntimeStatus>
              {offered && <Button onClick={() => setupRetry(c.id)}>Download · {size(c.sizeMb)}</Button>}
              {!settled && !offered && c.state !== "skipped" && (
                <button type="button" className="fy-set__link" onClick={() => setupSkip(c.id)}>
                  Skip
                </button>
              )}
              {(c.state === "skipped" || c.state === "failed" || c.state === "blocked") && (
                <button type="button" className="fy-set__link" onClick={() => setupRetry(c.id)}>
                  Retry
                </button>
              )}
            </div>
            {/* The bar only exists while something is actually moving. */}
            {c.state === "downloading" && (
              <div className="fy-set__bar">
                <div className="fy-set__barfill" style={{ width: `${pct}%` }} />
              </div>
            )}
            {c.detail !== undefined && (
              <div className="fy-set__why">
                <span className={cx("fy-set__dot", c.state === "failed" && "fy-set__dot--warn")} />
                <span>{c.detail}</span>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Failed beats moving beats arrived — the worst thing in the group is what its dot says. */
function componentsTone(components: readonly SetupComponent[]): RuntimeTone {
  if (components.some((c) => c.state === "failed" || c.state === "blocked")) return "warn";
  if (components.some((c) => c.state !== "ready" && c.state !== "present")) return "idle";
  return "ok";
}

const VOICE_ENGINES = ["kokoro", "whisper", "phonemizer"] as const;
const VOICE_ENGINE_LABEL: Record<(typeof VOICE_ENGINES)[number], string> = {
  kokoro: "Kokoro voice",
  whisper: "Whisper dictation",
  phonemizer: "espeak-ng phonemizer",
};

/**
 * The local voice runtime, the narrator it reads with, and the engines it supervises. Seven loose
 * links used to sit under this in one wrapped row; each one now hangs off the thing it acts on —
 * the path is changed on the field that shows the path — and only the three that act on the
 * runtime as a whole are left at the foot (turn 75).
 */
function VoiceDetail({
  voiceRuntime,
  narrator,
  health,
  worldIdForVoices,
}: {
  voiceRuntime: VoiceRuntimeStatus | null;
  narrator: NarratorSettings;
  health: ComponentHealth | undefined;
  worldIdForVoices: string | undefined;
}) {
  const voiceTest = useVoiceRuntimeTest();
  const playback = usePlayback();
  const [narratorOpen, setNarratorOpen] = useState(false);
  const playedTest = useRef<string | null>(null);
  useEffect(() => {
    if (voiceTest?.status !== "ready" || !voiceTest.audioBase64 || playedTest.current === voiceTest.requestId) return;
    playedTest.current = voiceTest.requestId;
    void playClip({
      id: voiceTest.requestId,
      url: `data:audio/wav;base64,${voiceTest.audioBase64}`,
      title: "Local voice test",
      sub: "settings · local runtime",
    });
  }, [voiceTest]);
  const sourceLabel =
    voiceRuntime?.source === "environment"
      ? "Environment override"
      : voiceRuntime?.source === "configured"
        ? "Configured Voxa"
        : voiceRuntime?.source === "bundled"
          ? "Bundled Voxa"
          : "Runtime missing";
  const engineTone = (engine: { state: string } | undefined): RuntimeTone =>
    engine?.state === "ready" ? "ok" : engine?.state === "unknown" || engine === undefined ? "idle" : "warn";
  const ready = VOICE_ENGINES.filter((e) => voiceRuntime?.engineStatus[e]?.state === "ready").length;
  return (
    <>
      <RuntimeHead
        title="Voice"
        caps="VOICE TTS · VOICE STT"
        tone={voiceRuntime?.detail === "Ready" ? "ok" : "warn"}
        state={voiceRuntime?.processState ?? "unconfigured"}
      />
      <div className="fy-rt__keyline">
        <div className="fy-rt__eyebrow">RUNTIME</div>
        <div className="fy-set__field">
          <span style={{ flex: 1 }}>
            {sourceLabel}
            {voiceRuntime?.version ? ` ${voiceRuntime.version}` : ""} ·{" "}
            {voiceRuntime?.architecture ?? voiceRuntime?.expectedArchitecture ?? "unknown architecture"}
          </span>
          <button type="button" className="fy-set__link" onClick={() => chooseVoxaExecutable()}>
            Change
          </button>
          {voiceRuntime?.bundledAvailable && voiceRuntime.source === "configured" && (
            <button type="button" className="fy-set__link" onClick={() => useBundledVoxa()}>
              Use bundled
            </button>
          )}
          {voiceRuntime?.configured && (
            <button type="button" className="fy-set__link" onClick={() => clearVoxaExecutable()}>
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="fy-set__why">
        <span className={cx("fy-set__dot", voiceRuntime?.detail === "Ready" ? "fy-set__dot--ok" : "fy-set__dot--warn")} />
        <span>{voiceRuntime?.detail ?? "Runtime discovery has not completed."}</span>
      </div>
      {voiceRuntime?.configurationWarning && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>{voiceRuntime.configurationWarning}</span>
        </div>
      )}

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
        {...(worldIdForVoices !== undefined ? { worldId: worldIdForVoices } : {})}
        chosenId={narrator?.voiceId}
        onClose={() => setNarratorOpen(false)}
        onPick={(voice: ReadingVoice) => {
          setNarratorOpen(false);
          setNarrator({ provider: voice.provider, voiceId: voice.voiceId, label: voice.label });
        }}
      />

      <RuntimeSection label="ENGINES">
        <span className="fy-rt__count">
          {ready} OF {VOICE_ENGINES.length} READY
        </span>
      </RuntimeSection>
      {VOICE_ENGINES.map((engine) => {
        const engineStatus = voiceRuntime?.engineStatus[engine];
        return (
          <div key={engine} className="fy-set__row">
            <div className="fy-set__name fy-set__name--wide">
              <div className="fy-set__title">{VOICE_ENGINE_LABEL[engine]}</div>
              <div className="fy-set__caps">{engineStatus?.detail ?? "Managed by Arke Studio"}</div>
            </div>
            <RuntimeStatus tone={engineTone(engineStatus)}>{engineStatus?.state ?? "unknown"}</RuntimeStatus>
          </div>
        );
      })}

      <div className="fy-rt__actions">
        <Button onClick={() => testLocalVoice()} disabled={voiceTest?.status === "testing"}>
          {voiceTest?.status === "testing" ? "Testing…" : "Test voice"}
        </Button>
        <button type="button" className="fy-set__link" onClick={() => restartVoxa()}>
          Restart
        </button>
        <button type="button" className="fy-set__link" onClick={() => repairVoiceModels()}>
          Repair models
        </button>
        <button type="button" className="fy-set__link" onClick={() => openModelFolder()}>
          Open folder
        </button>
        <span style={{ flex: 1 }} />
        <HealthDot label="Voxa local speech" health={health} />
      </div>
      {voiceTest && (
        <div className="fy-set__note">
          {voiceTest.detail}
          {voiceTest.status === "ready" && voiceTest.audioBase64 && playback.status !== "playing" && (
            <>
              {" · "}
              <button
                type="button"
                className="fy-set__link"
                onClick={() =>
                  void playClip({
                    id: voiceTest.requestId,
                    url: `data:audio/wav;base64,${voiceTest.audioBase64}`,
                    title: "Local voice test",
                    sub: "settings · local runtime",
                  })
                }
              >
                Play test
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Ready is ok; starting has not failed yet; every other state owes a reason, so it warns. */
function engineTone(engine: ComfyUiEngineStatus | null): RuntimeTone {
  if (engine === null) return "idle";
  if (engine.state === "ready") return "ok";
  return engine.state === "starting" ? "idle" : "warn";
}

/**
 * The ComfyUI engine and its recipes (SPEC-021 §2.2, §2.12, design turn 72). The engine row
 * states its source; detection offers are adopted, never typed; a disabled recipe carries its
 * one measured clause; and the weight rows live under Components, because they are catalogue
 * components like any other.
 */
function ComfyUiDetail() {
  const { state } = useStore();
  const comfyui = state?.app.comfyui ?? null;
  const [urlDraft, setUrlDraft] = useState("");
  const engine = comfyui?.engine ?? null;
  const sourceLabel =
    engine?.source === "user-path"
      ? "Your install"
      : engine?.source === "user-url"
        ? "Your URL · never spawned"
        : engine?.source === "managed"
          ? "Arke-managed"
          : "Not installed";
  const recipes = comfyui?.recipes ?? [];
  const ready = recipes.filter((r) => r.state === "ready").length;
  return (
    <div data-testid="comfyui-engine">
      <RuntimeHead
        title="ComfyUI"
        caps="IMAGE · VIDEO"
        tone={engineTone(engine)}
        state={engine?.state ?? "unknown"}
      />
      <div className="fy-rt__keyline">
        <div className="fy-rt__eyebrow">ENGINE</div>
        <div className="fy-set__field">
          <span className="fy-rt__path">
            {sourceLabel}
            {engine?.version ? ` · v${engine.version}` : ""}
            {engine?.location ? ` · ${engine.location}` : ""}
          </span>
          <button type="button" className="fy-set__link" onClick={() => chooseComfyUiPath()}>
            Change
          </button>
          {engine !== null && engine.source !== "absent" && engine.source !== "managed" && (
            <button type="button" className="fy-set__link" onClick={() => clearComfyUiEngine()}>
              Clear
            </button>
          )}
        </div>
      </div>
      {engine?.detail && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>{engine.detail}</span>
        </div>
      )}
      {/* Installs detection found: adopted by selection among the host's own offers (D10). */}
      {(engine?.detected ?? []).map((found) => (
        <div key={found.location} className="fy-set__why" data-testid="comfyui-detected">
          <span className="fy-set__dot" />
          <span>
            Found · {found.location}
            {found.version ? ` · v${found.version}` : ""}
          </span>
          <button type="button" className="fy-set__link" onClick={() => useDetectedComfyUi(found.location)}>
            Use this install
          </button>
        </div>
      ))}
      <div className="fy-rt__keyline">
        <div className="fy-rt__eyebrow">URL</div>
        <div className="fy-set__field">
          <input
            className="fy-set__input"
            aria-label="ComfyUI URL"
            placeholder="http://127.0.0.1:8188"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
          />
          <button
            type="button"
            className="fy-set__link"
            disabled={urlDraft.trim().length === 0}
            onClick={() => {
              setComfyUiUrl(urlDraft.trim());
              setUrlDraft("");
            }}
          >
            Use this URL
          </button>
        </div>
      </div>
      {/* No path here: the mapped folder is a setting the coordinator does not publish on the
          engine status, and a location this pane cannot read is one it must not draw. The two
          actions are the whole of what it can offer until modelsDir reaches the wire. */}
      <RuntimeSection label="MODELS FOLDER">
        <button type="button" className="fy-set__link" onClick={() => chooseComfyUiModelsDir()}>
          Map a folder
        </button>
        <button type="button" className="fy-set__link" onClick={() => clearComfyUiModelsDir()}>
          Use the engine's own
        </button>
      </RuntimeSection>

      <RuntimeSection label="RECIPES">
        <span className="fy-rt__count">
          {recipes.length === 0 ? "NONE IN THIS BUILD" : `${ready} OF ${recipes.length} READY`}
        </span>
      </RuntimeSection>
      {recipes.map((recipe) => (
        <div
          key={recipe.recipeId}
          className={cx("fy-set__row--stack", "fy-set__row", recipe.state === "disabled" && "fy-set__row--off")}
          data-testid="comfyui-recipe"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="fy-set__name fy-set__name--wide">
              <div className="fy-set__title">{recipe.displayName}</div>
              <div className="fy-set__caps fy-set__caps--tokens">
                {recipe.capability} · v{recipe.recipeVersion}
              </div>
            </div>
            <button type="button" className="fy-set__link" onClick={() => verifyComfyUiRecipe(recipe.recipeId)}>
              Re-verify
            </button>
            <RuntimeStatus tone={recipe.state === "ready" ? "ok" : recipe.state === "disabled" ? "warn" : "idle"}>
              {recipe.state}
            </RuntimeStatus>
          </div>
          {/* Kept visible, disabled, with the measured reason — never quietly absent (R-10). */}
          {recipe.reason && (
            <div className="fy-set__why">
              <span className={cx("fy-set__dot", recipe.state === "disabled" && "fy-set__dot--warn")} />
              <span>{recipe.reason}</span>
            </div>
          )}
        </div>
      ))}
      <div className="fy-rt__actions">
        <button type="button" className="fy-set__link" onClick={() => refreshComfyUi()}>
          Refresh
        </button>
      </div>
    </div>
  );
}

/** The manifest's local models, gated against what this machine measured (R-22). */
function LocalModelsDetail({ runtime }: { runtime: LocalRuntimeStatus | null }) {
  const models = runtime?.models ?? [];
  const ready = models.filter((m) => m.state === "ready").length;
  return (
    <>
      <RuntimeHead
        title="Local models"
        caps="FREE · NEVER METERED"
        tone={models.some((m) => m.state === "disabled") ? "warn" : models.length === 0 ? "idle" : "ok"}
        state={runtime === null ? "not yet measured" : `${ready} of ${models.length} ready`}
      />
      <RuntimeSection label="ON THIS MACHINE" />
      {models.map((m) => (
        <div key={m.modelId} className={cx("fy-set__row--stack", "fy-set__row", m.state === "disabled" && "fy-set__row--off")}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="fy-set__name fy-set__name--wide">
              <div className="fy-set__title">{m.displayName}</div>
              <div className="fy-set__caps fy-set__caps--tokens">
                {PROVIDER_TABLE[m.provider].displayName} · {m.capability}
              </div>
            </div>
            <RuntimeStatus tone={m.state === "ready" ? "ok" : m.state === "disabled" ? "warn" : "idle"}>
              {m.state}
            </RuntimeStatus>
          </div>
          {/* Kept visible, disabled, with the measured reason — never quietly absent. */}
          {m.reason && (
            <div className="fy-set__why">
              <span className="fy-set__dot fy-set__dot--warn" />
              <span>{m.reason}</span>
            </div>
          )}
        </div>
      ))}
      {runtime === null && <div className="fy-set__note">detection runs at start-up · Re-detect is under This machine</div>}
    </>
  );
}

/** The authoring harness. Voxa is not here: Voice states it, beside the runtime it describes. */
function HarnessDetail({ health }: { health: ComponentHealth | undefined }) {
  const status = health?.status ?? "starting";
  return (
    <>
      <RuntimeHead
        title="Authoring harness"
        caps="OPENCODE"
        tone={status === "healthy" ? "ok" : status === "starting" ? "idle" : "warn"}
        state={status === "healthy" ? "ready" : status}
      />
      <RuntimeSection label="SUPERVISED" />
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">OpenCode</div>
          <div className="fy-set__caps">{health?.reason ?? "supervised by Arke Studio"}</div>
        </div>
        <HealthDot label="OpenCode (authoring harness)" health={health} />
      </div>
    </>
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
          */}
          <div className="fy-rt__research">
            <button
              type="button"
              role="switch"
              aria-checked={researchOn}
              aria-label="Read pages online"
              className={cx("fy-prov__switch", researchOn && "is-on")}
              onClick={() => setResearchWeb(!researchOn)}
            >
              <span />
            </button>
            <div>
              <strong>Read pages online</strong>
              <p>{researchOn ? "A conversation can open a page you name." : "Nothing is read online."}</p>
            </div>
          </div>
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

/** The groups the rail offers, in the order it offers them. */
type RuntimeGroupId = "machine" | "components" | "voice" | "comfyui" | "models" | "harness";

/**
 * Local runtime, master and detail (design turn 75). The rail is the heading: what used to be
 * nine eyebrows in one scroll is now six groups, each stating one thing once. Selection rides in
 * the address so a group can be linked to, and so the pane can be rendered at a given group
 * without a click — the flat version had no way to ask for one section.
 */
export function SettingsLocalRuntimeScreen() {
  const { state } = useStore();
  const setup = useSetup();
  const runtime = state?.app.runtime ?? null;
  const voiceRuntime = state?.app.voiceRuntime ?? null;
  const narrator = state?.app.narrator ?? null;
  const comfyui = state?.app.comfyui ?? null;
  // The catalogue is fetched per world; Settings uses whichever world is open.
  const worldIdForVoices = state?.world?.meta.worldId;
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (!runtime) detectRuntimes();
    // Detection runs once per mount when nothing is known yet; Re-detect is the manual path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // LOCAL MODELS is drawn from a detection that may not have returned, or may have failed. Until
  // it does, that group is empty, and hiding a settled component on its behalf would leave the
  // component stated nowhere at all.
  const modelsAreListed = (runtime?.models.length ?? 0) > 0;
  const components = (setup?.components ?? []).filter((c) => {
    const restated = STATED_ELSEWHERE[c.id];
    if (restated === undefined) return true;
    // Providers owns the credential this tool is for, so its row there is the only one needed —
    // installed or not. The rest are only spoken for once they have arrived.
    if (restated === "providers") return false;
    if (restated === "local-models" && !modelsAreListed) return true;
    return c.state !== "ready" && c.state !== "present";
  });
  const outstanding = components.filter((c) => c.state !== "ready" && c.state !== "present").length;
  const voiceEnginesReady = VOICE_ENGINES.filter((e) => voiceRuntime?.engineStatus[e]?.state === "ready").length;
  const recipes = comfyui?.recipes ?? [];
  const models = runtime?.models ?? [];
  const harness = state?.app.health.harness;
  const harnessStatus = harness?.status ?? "starting";

  const groups: Array<{ id: RuntimeGroupId; label: string; tone: RuntimeTone; count: string }> = [
    {
      id: "machine",
      label: "This machine",
      tone: runtime ? "ok" : "idle",
      // The figure the gating actually turns on, so the rail answers "will this run here?".
      count: runtime?.probes.vramMb == null ? "—" : `${Math.round(runtime.probes.vramMb / 1024)} GB VRAM`,
    },
    {
      id: "components",
      label: "Components",
      tone: componentsTone(components),
      count: outstanding === 0 ? "all here" : `${outstanding} left`,
    },
    {
      id: "voice",
      label: "Voice",
      tone: voiceEnginesReady === VOICE_ENGINES.length ? "ok" : voiceRuntime === null ? "idle" : "warn",
      count: `${voiceEnginesReady} of ${VOICE_ENGINES.length}`,
    },
    {
      id: "comfyui",
      label: "ComfyUI",
      tone: engineTone(comfyui?.engine ?? null),
      count: recipes.length === 0 ? "—" : `${recipes.filter((r) => r.state === "ready").length} of ${recipes.length}`,
    },
    {
      id: "models",
      label: "Local models",
      tone: models.some((m) => m.state === "disabled") ? "warn" : models.length === 0 ? "idle" : "ok",
      count: models.length === 0 ? "—" : `${models.filter((m) => m.state === "ready").length} of ${models.length}`,
    },
    {
      id: "harness",
      label: "Authoring harness",
      tone: harnessStatus === "healthy" ? "ok" : harnessStatus === "starting" ? "idle" : "warn",
      count: harnessStatus === "healthy" ? "ready" : harnessStatus,
    },
  ];

  const asked = searchParams.get("group");
  const current = groups.some((g) => g.id === asked) ? (asked as RuntimeGroupId) : groups[0]!.id;
  return (
    <div data-screen="settings-local-runtime" className="fy-set fy-set--runtime">
      <div className="fy-rt">
        <div className="fy-rt__rail" role="tablist" aria-label="Local runtimes">
          {groups.map((g) => (
            <button
              type="button"
              key={g.id}
              role="tab"
              aria-selected={g.id === current}
              className={cx("fy-rt__railitem", g.id === current && "is-current")}
              onClick={() => setSearchParams({ group: g.id }, { replace: true })}
            >
              <span className={cx("fy-set__dot", TONE_CLASS[g.tone])} />
              <span>{g.label}</span>
              <span style={{ flex: 1 }} />
              <span className="fy-rt__count">{g.count}</span>
            </button>
          ))}
        </div>
        <div className="fy-rt__pane">
          {current === "machine" && <MachineDetail runtime={runtime} />}
          {current === "components" && <ComponentsDetail components={components} running={setup?.running === true} />}
          {current === "voice" && (
            <VoiceDetail
              voiceRuntime={voiceRuntime}
              narrator={narrator}
              health={state?.app.health.voice}
              worldIdForVoices={worldIdForVoices}
            />
          )}
          {current === "comfyui" && <ComfyUiDetail />}
          {current === "models" && <LocalModelsDetail runtime={runtime} />}
          {current === "harness" && <HarnessDetail health={harness} />}
        </div>
      </div>
    </div>
  );
}

/** The capability rows the routing surface offers, in product language. */
const ROUTED_CAPABILITIES: readonly Capability[] = ["video", "image", "music", "voice-tts", "llm"];

export function SettingsWhoDoesWhatScreen() {
  const { state } = useStore();
  const navigate = useNavigate();
  // The writing agents fold beneath Advanced (design 54b): the routing defaults are the
  // everyday answer, the per-agent overrides are the expert's. Closed by default, and a
  // control rather than a tab — it does not survive navigation.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const manifest = state?.app.manifest ?? null;
  const configured = new Set((state?.app.providers ?? []).filter((p) => p.configured).map((p) => p.id));
  const routing = state?.app.routing ?? { defaults: {}, faults: [] };
  const disabled = new Set(state?.app.models.disabled ?? []);
  const drift = state?.app.drift ?? [];
  return (
    <div data-screen="settings-who-does-what" className="fy-set">
      <div className="fy-set__eyebrow">WHO DOES WHAT</div>
      {/* A default that cannot run is stated, never repaired (design turn 40d). It gets a callout
          rather than a footnote because the next dispatch of that capability has nowhere to go. */}
      {routing.faults.map((f) => (
        <Callout key={f.capability} tone="warning" title={`${CAPABILITY_LABEL[f.capability]} has nowhere to go.`}>
          {f.reason}
        </Callout>
      ))}
      {ROUTED_CAPABILITIES.map((capability) => {
        const options = (manifest?.models ?? []).filter((m) => m.capability === capability);
        const selected = routing.defaults[capability];
        const selectedModel = options.find((m) => m.id === selected);
        // A model whose provider has no key cannot run, and neither can one switched off in
        // Providers. Both stay listed, so the option is known to exist, and stay unselectable, so
        // a dispatch cannot be routed into a dead end and fail after the estimate was accepted.
        const usable = (m: (typeof options)[number]) =>
          !disabled.has(m.id) && (configured.has(m.provider) || PROVIDER_TABLE[m.provider].local === true);
        const stranded = selectedModel !== undefined && !usable(selectedModel);
        // Two ways to be stranded, and they need different repairs: find a key, or turn it back on.
        const strandReason =
          selectedModel === undefined
            ? ""
            : disabled.has(selectedModel.id)
              ? "turned off in Providers"
              : `routed here, but ${PROVIDER_TABLE[selectedModel.provider].displayName} has no key`;
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
                    {usable(m) || m.id === selected
                      ? ""
                      : disabled.has(m.id)
                        ? " — turned off in Providers"
                        : ` — needs a ${PROVIDER_TABLE[m.provider].displayName} key`}
                  </option>
                ))}
            </select>
            {/* The capability copy is the manifest speaking (R-10): refs, frames, caps. */}
            {selectedModel && !stranded && <span className="fy-set__state">{modelCapabilityCopy(selectedModel)}</span>}
            {stranded && <span className="fy-set__state">{strandReason}</span>}
            <span className={cx("fy-set__dot", stranded ? "fy-set__dot--warn" : selectedModel && "fy-set__dot--ok")} />
          </div>
        );
      })}
      <div className="fy-set__note">
        defaults for new work · any production can override per dispatch
        {manifest ? ` · manifest v${manifest.manifestVersion}` : ""}
      </div>
      <button
        type="button"
        className="fy-set__link"
        style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)", width: "100%", textAlign: "left" }}
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen(!advancedOpen)}
      >
        {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Advanced · which model runs each writing agent
      </button>
      {advancedOpen && <AgentsPanel />}
      {/* The way out, at the foot (40d): every repair this screen can suggest — turn a model back
          on, or find a key for one — is made on the Providers tab. */}
      <div className="fy-set__actions">
        <Button variant="secondary" onClick={() => navigate("/settings/providers")}>
          Open Providers
        </Button>
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
  const spend = state ? spendSummary(state.app.ledger, state.app.spend?.settings.periodDays ?? 7, new Date()) : null;
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
                        <Button onClick={() => navigate(`/w/${entry.worldId}`)}>Open</Button>
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
                {formatMicroUsd(spend.totalMicroUsd)}{" "}
                <span className="fy-mono">
                  {spend.mixed
                    ? `mixed · ${spend.reportedEntries} measured, ${spend.derivedEntries} derived`
                    : spend.derivedEntries > 0
                      ? "derived from the manifest"
                      : "provider-reported"}
                </span>
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
                  {spend.unmeteredRuns} local run{spend.unmeteredRuns === 1 ? "" : "s"} — unmetered, this machine's
                  compute
                </div>
              )}
              <div className="fy-notecard" style={{ background: "var(--background)" }}>
                <span className={`fy-dot fy-dot--${state?.app.spend?.alerted ? "warn" : "sketch"}`} />
                {state?.app.spend?.alerted && state.app.spend
                  ? `Over the threshold: ${formatMicroUsd(state.app.spend.rollingMicroUsd)} against ${formatMicroUsd(state.app.spend.settings.thresholdMicroUsd)}. Nothing is blocked.`
                  : `Alert at ${formatMicroUsd(state?.app.spend?.settings.thresholdMicroUsd ?? 0)} / ${spend.periodDays}d${(state?.app.spend?.settings.thresholdMicroUsd ?? 0) === 0 ? " · off" : ""}`}
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
            local runs are free · the local runtimes don't meter
          </div>
          <div style={{ flex: 1 }} />
          <Button onClick={() => navigate("/settings/providers")}>Providers &amp; keys</Button>
          <Button variant="ghost" onClick={() => { setInspectedJobId(null); setInspectAllCalls(true); }}>All provider calls</Button>
        </div>
      </div>
    </div>
  );
}
