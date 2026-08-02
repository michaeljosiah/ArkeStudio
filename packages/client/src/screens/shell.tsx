import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { Badge, Button, Callout, Input, StatusDot, Textarea, cx, type StatusDotTone } from "../components/ui.js";
import { EmptyState } from "../components/layout.js";
import { JobRow } from "../domain/domain.js";
import { Archive, ChevronLeft, Plus, X } from "../components/icons.js";
import { Portrait } from "../components/portrait.js";
import { Composer } from "../components/composer.js";
import { shortDateTime } from "../lib/format.js";
import {
  cancelExport as cancelExportMsg,
  cancelJob,
  checkUpdates,
  clearCredential,
  attachHostFiles,
  attachHostText,
  archiveWorld,
  createSheetFromSentence,
  createWorld,
  genesisAttachFiles,
  genesisChat,
  genesisDiscard,
  hostCanAttach,
  detectRuntimes,
  downloadUpdate,
  generateDiagnostics,
  openDataFolder,
  openThread,
  openWorld,
  resolveHeldJob,
  resumeQueue,
  setCredential,
  setRoutingDefault,
  setSpendThreshold,
  useArchiveNote,
  useDiagnosticsBundle,
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
  validateProvider,
} from "../lib/store.js";
import {
  computeNeedsYou,
  computeRunning,
  deriveCapabilityAvailability,
  formatMicroUsd,
  jobActions,
  modelCapabilityCopy,
  PROVIDERS as PROVIDER_TABLE,
  spendSummary,
  type Capability,
  type ComponentHealth,
  type ProviderId,
  type ProviderStatus,
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

/** The prototype's shared 44px titlebar for shell screens: back slot, mono label, Arke mark. */
function ShellTitlebar({ back, label, divided = true }: { back?: { label: string; to: string }; label: string; divided?: boolean }) {
  const navigate = useNavigate();
  return (
    <div className={cx("fy-titlebar", divided && "fy-titlebar--divided")}>
      <div className="fy-titlebar__side">
        {back && (
          <button
            type="button"
            className="fy-iconbtn"
            style={{ width: "auto", gap: 7, padding: "0 6px", font: "400 12px var(--font-sans)" }}
            onClick={() => navigate(back.to)}
          >
            <ChevronLeft size={13} />
            {back.label}
          </button>
        )}
      </div>
      <div className="fy-titlebar__center">{label}</div>
      <div className="fy-titlebar__side fy-titlebar__side--right">
        <span className="fy-titlebar__mark" onClick={() => navigate("/worlds")}>
          Arke
        </span>
      </div>
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

export function LaunchScreen() {
  const { connection, state } = useStore();
  const navigate = useNavigate();
  const env = useEnvCheck();
  const setup = useSetup();
  const downloading = setup?.running === true;

  // Setup never walks off on its own — the user continues when they're ready (no worlds →
  // first run; otherwise the picker, R-8).
  const ready = connection === "open" && state !== null;
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

  return (
    <div className="fy-app" data-screen="launch">
      <div className="fy-titlebar">
        <div className="fy-titlebar__side" />
        <div className="fy-titlebar__center" />
        <div className="fy-titlebar__side fy-titlebar__side--right">
          <span className="fy-titlebar__mark">Arke</span>
        </div>
      </div>
      <div className="fy-launch">
        <div className="fy-launch__reel">
          {/* The reel plays while the runtimes come down — the wait is the only time this
              screen is ever seen. Muted and silent by design; a setup screen does not get to
              make noise. Someone who has asked for less motion gets the still first frame. */}
          <video
            className="fy-launch__video"
            src={SETUP_REEL}
            autoPlay={!stillPreferred()}
            loop
            muted
            playsInline
            preload="auto"
          />
        </div>
        <div className="fy-launch__panel">
          <div className="fy-launch__row">
            <span className="fy-launch__title">Setting up your studio.</span>
          </div>
          <div className="fy-launch__row" style={{ marginTop: 10 }}>
            <span className="fy-mono">{activity}</span>
            <span style={{ flex: 1 }} />
            {speed !== null && speed > 0 && <span className="fy-mono">{mb(speed)}/s</span>}
          </div>
          <div className="fy-setupbar">
            <div className="fy-setupbar__fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="fy-launch__row" style={{ marginTop: 8 }}>
            <span className="fy-mono">{totalBytes > 0 ? `${mb(doneBytes)} of ${mb(totalBytes)}` : ""}</span>
            <span style={{ flex: 1 }} />
            <span className="fy-mono">{remaining !== null ? aboutLeft(remaining) : ""}</span>
          </div>
          {connection === "closed" && (
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
              {ready ? (downloading ? "Continue in the background →" : "Continue") : "Setting up…"}
            </Button>
          </div>
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
  return (
    <div className="fy-app" data-screen="first-run">
      <div className="fy-home-head">
        <div className="fy-home-brand">
          <span className="fy-home-brand__arke">Arke</span>
          <span className="fy-home-brand__studio">Studio</span>
        </div>
      </div>
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
          <div className="fy-firstrun__flank" style={{ transform: "rotate(4deg)" }} />
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
      <div className="fy-home-head">
        <div className="fy-home-brand">
          <span className="fy-home-brand__arke">Arke</span>
          <span className="fy-home-brand__studio">Studio</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Button variant="ghost" onClick={() => navigate("/activity")}>
            Activity
          </Button>
          <Button variant="ghost" onClick={() => navigate("/settings/providers")}>
            Settings
          </Button>
        </div>
      </div>
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
              hint="Create one, or drop an existing world folder into your ArkeStudio directory."
              action={<Button onClick={() => navigate("/first-run")}>Start</Button>}
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
                    <Portrait worldSlug={w.slug} path="world-art.png" label={`${w.name}: key art`} radius={10} />
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
                  {w.logline && <div className="fy-worldcard__logline">{w.logline}</div>}
                  <div className="fy-worldcard__meta">
                    <span
                      className={cx("fy-dot", (w.attention?.unreviewedTakes ?? 0) > 0 ? "fy-dot--warn" : "fy-dot--ok")}
                    />
                    {w.counts.characters} character{w.counts.characters === 1 ? "" : "s"} · {w.counts.productions}{" "}
                    production{w.counts.productions === 1 ? "" : "s"}
                    <span className="mono">{shortDateTime(w.updated)}</span>
                  </div>
                </div>
              </div>
            ))}
            <button type="button" className="fy-newworldcard" onClick={() => navigate("/worlds/new")}>
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
            </button>
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
  const handed = (g?.attachments ?? []).map((a) => ({ artifactId: a.name, file: a.name, kind: a.kind }));

  // The coordinator opens the new world and re-snapshots; when it lands, seed the optional
  // first sheets through the same gate everything else uses, then go there.
  useEffect(() => {
    if (!submittedName || !state?.world || state.world.meta.name !== submittedName) return;
    const worldId = state.world.meta.worldId;
    if (!seededRef.current) {
      seededRef.current = true;
      for (const c of railCharacters.slice(0, 4)) createSheetFromSentence(worldId, "character", c.name, c.sentence);
      for (const l of railLocations.slice(0, 4)) createSheetFromSentence(worldId, "location", l.name, l.sentence);
      for (const t of (draft?.threads ?? []).slice(0, 4)) {
        openThread(worldId, t.length > 80 ? `${t.slice(0, 77)}…` : t, t, []);
      }
      genesisDiscard(genesisId);
    }
    navigate(`/w/${worldId}`, { replace: true });
  }, [submittedName, state?.world, navigate, railCharacters, railLocations, draft, genesisId]);

  const canCreate = connection === "open" && shownName.length > 0 && submittedName === null;
  const entries = 1 + railCharacters.length + railLocations.length + (draft?.threads.length ?? 0);

  return (
    <div className="fy-app" data-screen="new-world">
      <ShellTitlebar back={{ label: "Back", to: "/worlds" }} label="Arke Studio · new world" />
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
                {chatRunning && (
                  <div className="fy-bubble--gate" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="fy-dot fy-dot--live" />
                    <span className="fy-mono">shaping the draft…</span>
                  </div>
                )}
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
            <div>
              <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Name</div>
              <Input placeholder="The Undersong" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Logline</div>
              <Textarea
                placeholder="A coastal city where a drowned god still sings, and some people can hear it."
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
                <Input placeholder="Coastal fantasy" value={genre} onChange={(e) => setGenre(e.target.value)} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>
                  First character <span className="fy-mono">optional</span>
                </div>
                <Input
                  placeholder="Maren Kest · tide-caller, the last one"
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
                  placeholder="The Vigil · the lighthouse that listens back"
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
              <Button disabled title="Image jobs need the world folder — generate from the hub once it exists">
                Generate from the logline
              </Button>
              <span className="fy-mono" style={{ fontSize: 9 }}>
                title · logline · tone ride along · comes back as a take
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
            <Button
              variant="primary"
              disabled={!canCreate}
              onClick={() => {
                setSubmittedName(shownName);
                createWorld({
                  name: shownName,
                  ...(shownLogline ? { logline: shownLogline } : {}),
                  ...(shownTone ? { tone: shownTone.toLowerCase() } : {}),
                  ...(shownGenre ? { genre: shownGenre.toLowerCase() } : {}),
                  // Whatever was handed to the conversation follows it in. Sent always, not
                  // only when something is attached: the sandbox is the source of truth for
                  // what is waiting, and the screen's idea of it can lag an event behind.
                  genesisId,
                });
              }}
            >
              {submittedName ? "Creating…" : "Begin in this world"}
            </Button>
            <div style={{ font: "400 11px/1.5 var(--font-sans)", color: "var(--muted-foreground)", textAlign: "center" }}>
              Opens the hub. Everything arrives as sketches — lock what holds, discard what doesn't.
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
      <div className="fy-scrim">
        {firstWorld && (
          <div className="fy-scrim__art">
            <Portrait worldSlug={firstWorld.slug} path="world-art.png" label="" radius={0} />
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
                    ["local-runtime", "Local runtime"],
                    ["who-does-what", "Who does what"],
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
  );
}

const KEYED_PROVIDERS: Array<{ id: ProviderId; note: string }> = [
  { id: "fal", note: "images and video — one key, both route here" },
  { id: "higgsfield", note: "images and video" },
  { id: "elevenlabs", note: "cloud voice and voice clones" },
  { id: "openai", note: "LLM and images" },
  { id: "anthropic", note: "LLM" },
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
  llm: "Direct LLM work",
  "voice-tts": "Voice",
  "voice-clone": "Voice cloning",
  "voice-stt": "Dictation",
};

function ProviderKeyRow({ id, note }: { id: ProviderId; note: string }) {
  const { state } = useStore();
  const [draft, setDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const status = state?.app.providers.find((p) => p.id === id);
  const info = PROVIDER_TABLE[id];
  const stored = status?.configured === true;
  const troubled = Boolean(status?.fault) || status?.validation === "invalid";
  const save = () => {
    if (draft.trim().length === 0) return;
    setCredential(id, draft.trim());
    setDraft("");
    setReplacing(false);
  };
  return (
    <>
      <div className="fy-set__row">
        <div className="fy-set__name">
          <div className="fy-set__title">{info.displayName}</div>
          <div className="fy-set__caps">{note}</div>
        </div>
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
        <span
          className={cx("fy-set__dot", troubled ? "fy-set__dot--warn" : stored && "fy-set__dot--ok")}
          title={troubled ? "this key was rejected" : stored ? "key stored" : "no key stored"}
        />
      </div>
      {status?.fault && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>{status.fault} — the work was not the problem; the credential was.</span>
        </div>
      )}
      <ProbeChips status={status} />
    </>
  );
}

export function SettingsProvidersScreen() {
  const { state } = useStore();
  const availability = deriveCapabilityAvailability(state?.app.providers ?? []);
  const spend = state?.app.spend ?? null;
  const [threshold, setThreshold] = useState<string | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const thresholdValue = threshold ?? (spend ? String(spend.settings.thresholdMicroUsd / 1_000_000) : "0");
  const periodValue = period ?? String(spend?.settings.periodDays ?? 7);
  return (
    <div data-screen="settings-providers" className="fy-set">
      <div className="fy-set__eyebrow">CLOUD PROVIDERS</div>
      {KEYED_PROVIDERS.map((p) => (
        <ProviderKeyRow key={p.id} id={p.id} note={p.note} />
      ))}
      <div className="fy-set__note">
        a provider is entered once · its key covers every capability it lists · stored encrypted at
        OS level, outside every world, and no export can carry one
      </div>

      <div className="fy-set__eyebrow">WHAT THIS MACHINE CAN DO</div>
      {availability.map((a) => (
        <div key={a.capability} className="fy-set__row">
          <div className="fy-set__name fy-set__name--wide">
            <div className="fy-set__title">{CAPABILITY_LABEL[a.capability]}</div>
            <div className="fy-set__caps fy-set__caps--tokens">{a.capability}</div>
          </div>
          <span className="fy-set__state">
            {a.available ? a.via.map((v) => PROVIDER_TABLE[v].displayName).join(", ") : (a.reason ?? "unavailable")}
          </span>
          <span className={cx("fy-set__dot", a.available && "fy-set__dot--ok")} />
        </div>
      ))}
      <div className="fy-set__note">
        derived from configured, validated providers · testing a key probes each capability
        separately, so one that authenticates but cannot do video says so here rather than at the
        end of composing a scene
      </div>

      <div className="fy-set__eyebrow">SPEND</div>
      {spend && (
        <div className="fy-set__row">
          <div className="fy-set__name fy-set__name--wide">
            <div className="fy-set__title">
              {formatMicroUsd(spend.rollingMicroUsd)} in the last {spend.settings.periodDays} day
              {spend.settings.periodDays === 1 ? "" : "s"}
            </div>
            <div className="fy-set__caps">
              {spend.settings.thresholdMicroUsd > 0
                ? `threshold ${formatMicroUsd(spend.settings.thresholdMicroUsd)}${spend.alerted ? " · over" : ""}`
                : "no threshold set"}
            </div>
          </div>
          <span className={cx("fy-set__dot", spend.alerted ? "fy-set__dot--warn" : "fy-set__dot--ok")} />
        </div>
      )}
      {spend?.alerted && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>
            Over the threshold. Dispatch still works — the money is yours; this is a warning, not a
            stop.
          </span>
        </div>
      )}
      <div className="fy-set__row">
        <span className="fy-set__routelabel">alert at $</span>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <Input style={{ maxWidth: 110 }} value={thresholdValue} onChange={(e) => setThreshold(e.target.value)} />
          <span className="fy-set__state">over</span>
          <Input style={{ maxWidth: 70 }} value={periodValue} onChange={(e) => setPeriod(e.target.value)} />
          <span className="fy-set__state">days</span>
          <Button
            onClick={() => {
              const usdValue = Number.parseFloat(thresholdValue);
              const days = Number.parseInt(periodValue, 10);
              if (Number.isFinite(usdValue) && usdValue >= 0 && Number.isFinite(days) && days >= 1) {
                setSpendThreshold(Math.round(usdValue * 1_000_000), Math.min(days, 365));
                setThreshold(null);
                setPeriod(null);
              }
            }}
          >
            Set
          </Button>
        </div>
      </div>
      <div className="fy-set__note">alerts on a rolling window, across all worlds · never blocks</div>
    </div>
  );
}

/**
 * The local runtimes on this machine: what arrived, what is still coming, and the way into
 * each one. Setup shows a bar and nothing else; this is where the detail lives (prototype 22a).
 */
function SetupComponents() {
  const setup = useSetup();
  if (!setup || setup.components.length === 0) return null;
  const size = (mbytes: number) => (mbytes >= 1024 ? `${(mbytes / 1024).toFixed(1)} GB` : `${mbytes} MB`);
  return (
    <>
      <div className="fy-set__eyebrow">
        ON THIS MACHINE
        {setup.running && (
          <button type="button" className="fy-set__link" style={{ float: "right" }} onClick={() => setupCancel()}>
            Stop all
          </button>
        )}
      </div>
      {setup.components.map((c) => {
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
              <span className="fy-set__state">
                {c.state === "present" ? "already here" : c.state === "downloading" ? `${pct}%` : c.state}
              </span>
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
              <span
                className={cx("fy-set__dot", settled && "fy-set__dot--ok", c.state === "failed" && "fy-set__dot--warn")}
              />
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
      <div className="fy-set__note">fetched once, then left alone</div>
    </>
  );
}

export function SettingsLocalRuntimeScreen() {
  const { state } = useStore();
  const runtime = state?.app.runtime ?? null;
  useEffect(() => {
    if (!runtime) detectRuntimes();
    // Detection runs once per mount when nothing is known yet; Re-detect is the manual path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const gbOrUnknown = (mb: number | null) => (mb === null ? "could not measure" : `${Math.round(mb / 1024)} GB`);
  return (
    <div data-screen="settings-local-runtime" className="fy-set">
      <div className="fy-set__eyebrow">THIS MACHINE</div>
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">
            {runtime
              ? `${gbOrUnknown(runtime.probes.vramMb)} VRAM · ${gbOrUnknown(runtime.probes.memMb)} memory`
              : "Not yet measured"}
          </div>
          <div className="fy-set__caps">
            {runtime ? `${gbOrUnknown(runtime.probes.diskFreeMb)} free disk` : "detection runs at start-up"}
          </div>
        </div>
        <button type="button" className="fy-set__link" onClick={() => detectRuntimes()}>
          Re-detect
        </button>
      </div>

      <SetupComponents />

      <div className="fy-set__eyebrow">LOCAL MODELS</div>
      {(runtime?.models ?? []).map((m) => (
        <div key={m.modelId} className={cx("fy-set__row--stack", "fy-set__row", m.state === "disabled" && "fy-set__row--off")}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="fy-set__name fy-set__name--wide">
              <div className="fy-set__title">{m.displayName}</div>
              <div className="fy-set__caps fy-set__caps--tokens">
                {PROVIDER_TABLE[m.provider].displayName} · {m.capability}
              </div>
            </div>
            <span className="fy-set__state">{m.state}</span>
            <span className={cx("fy-set__dot", m.state === "ready" && "fy-set__dot--ok", m.state === "disabled" && "fy-set__dot--warn")} />
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
      <div className="fy-set__note">
        models download once, meter never · what this machine cannot run stays visible, disabled,
        with the reason
      </div>

      <div className="fy-set__eyebrow">SUPERVISED RUNTIMES</div>
      <div className="fy-set__row">
        <HealthDot label="OpenCode (authoring harness)" health={state?.app.health.harness} />
      </div>
      <div className="fy-set__row">
        <HealthDot label="Voxa (local voice)" health={state?.app.health.voice} />
      </div>
    </div>
  );
}

/** The capability rows the routing surface offers, in product language. */
const ROUTED_CAPABILITIES: readonly Capability[] = ["video", "image", "voice-tts", "llm"];

export function SettingsWhoDoesWhatScreen() {
  const { state } = useStore();
  const manifest = state?.app.manifest ?? null;
  const routing = state?.app.routing ?? { defaults: {}, faults: [] };
  const drift = state?.app.drift ?? [];
  return (
    <div data-screen="settings-who-does-what" className="fy-set">
      <div className="fy-set__eyebrow">WHO DOES WHAT</div>
      {routing.faults.map((f) => (
        <div key={f.capability} className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>{f.reason}</span>
        </div>
      ))}
      {ROUTED_CAPABILITIES.map((capability) => {
        const options = (manifest?.models ?? []).filter((m) => m.capability === capability);
        const selected = routing.defaults[capability];
        const selectedModel = options.find((m) => m.id === selected);
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
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {PROVIDER_TABLE[m.provider].displayName} · {m.displayName}
                </option>
              ))}
            </select>
            {/* The capability copy is the manifest speaking (R-10): refs, frames, caps. */}
            {selectedModel && <span className="fy-set__state">{modelCapabilityCopy(selectedModel)}</span>}
          </div>
        );
      })}
      <div className="fy-set__note">
        defaults for new work · any production can override per dispatch, and the override travels
        with that dispatch alone
        {manifest ? ` · manifest v${manifest.manifestVersion}` : ""}
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

export function SettingsAboutScreen() {
  const { state } = useStore();
  const update = useUpdateStatus();
  const diagnostics = useDiagnosticsBundle();
  return (
    <div data-screen="settings-about" className="fy-set">
      <div className="fy-set__eyebrow">ABOUT</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 14 }}>
        <span className="fy-set__aboutname">Arke</span>
        <span className="fy-set__aboutmeta">v{state?.app.version ?? "—"} · MIT</span>
      </div>
      <div className="fy-set__aboutline">The world is the asset. Author once, produce everywhere.</div>

      <div className="fy-set__row" style={{ marginTop: 14 }}>
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">Updates</div>
          <div className="fy-set__caps">
            {update
              ? `${update.status}${update.version ? ` · ${update.version}` : ""}${update.detail ? ` — ${update.detail}` : ""}`
              : "checks are yours to run · nothing installs until you quit"}
          </div>
        </div>
        {update?.status === "available" && (
          <Button variant="primary" onClick={() => downloadUpdate()}>
            Download
          </Button>
        )}
        <button type="button" className="fy-set__link" onClick={() => checkUpdates()}>
          Check for updates
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

      <div className="fy-set__note">
        OpenCode (MIT) · Voxa (MIT) · espeak-ng (GPL, separate process, never linked) · ffmpeg
        (LGPL build, subprocess) · better-sqlite3 (MIT) · Electron (MIT) · Geist (OFL) — full
        notices in THIRD-PARTY-NOTICES.md beside the app
      </div>
    </div>
  );
}

// ---- Activity --------------------------------------------------------------

const TERMINAL_JOB = new Set(["succeeded", "failed", "cancelled"]);

export function ActivityScreen() {
  const { state } = useStore();
  const reconcileReport = useReconcileReport();
  const sidecar = useVoiceSidecarState();
  const exportsState = useExportsState();
  const navigate = useNavigate();
  const [scope, setScope] = useState<"active" | "all">("active");
  const activeWorldId = state?.world?.meta.worldId ?? null;

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
      <ShellTitlebar back={{ label: "Home", to: "/worlds" }} label="Arke · activity" />
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
                      {entry.actions.includes("resolve") && entry.ref && (
                        <>
                          <Button onClick={() => resolveHeldJob(entry.ref!, "resubmit")}>Resubmit anyway</Button>
                          <Button variant="ghost" onClick={() => resolveHeldJob(entry.ref!, "discard")}>
                            Abandon
                          </Button>
                        </>
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
                        <Button onClick={() => navigate(`/w/${entry.worldId}/productions`)}>Review</Button>
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
              {jobActions(job).includes("retry") && (
                <span className="scr-field__hint">failed — retry from its production's dispatch dialog</span>
              )}
            </div>
          ))}
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
                <span
                  style={{ marginLeft: "auto", cursor: "pointer", font: "400 11px var(--font-sans)" }}
                  onClick={() => navigate("/settings/providers")}
                >
                  Set
                </span>
              </div>
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
        </div>
      </div>
    </div>
  );
}
