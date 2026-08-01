import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { Badge, Button, Callout, Card, Input, StatusDot, Switch, Textarea, cx, type StatusDotTone } from "../components/ui.js";
import { EmptyState, PageHeader, KeyValue, Screen, Section } from "../components/layout.js";
import { JobRow } from "../domain/domain.js";
import { ChevronLeft, Plus, X } from "../components/icons.js";
import { Portrait } from "../components/portrait.js";
import { shortDateTime, usd } from "../lib/format.js";
import {
  cancelExport as cancelExportMsg,
  cancelJob,
  checkUpdates,
  clearCredential,
  createSheetFromSentence,
  createWorld,
  detectRuntimes,
  downloadUpdate,
  generateDiagnostics,
  openDataFolder,
  openWorld,
  resolveHeldJob,
  resumeQueue,
  setCredential,
  setRoutingDefault,
  setSpendThreshold,
  useDiagnosticsBundle,
  useEnvCheck,
  useExports as useExportsState,
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

export function LaunchScreen() {
  const { connection, state } = useStore();
  const navigate = useNavigate();

  const ready = connection === "open" && state !== null;
  useEffect(() => {
    if (!ready) return;
    // Hand off: no worlds → first run; otherwise the picker (R-8).
    const timer = setTimeout(() => {
      navigate(state!.worlds.length === 0 ? "/first-run" : "/worlds", { replace: true });
    }, 400);
    return () => clearTimeout(timer);
  }, [ready, navigate, state]);

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
          <span className="fy-launch__mark">Arke Studio</span>
        </div>
        <div className="fy-launch__panel">
          <div className="fy-launch__row">
            <span className="fy-launch__title">Setting up your studio.</span>
            <span style={{ flex: 1 }} />
            <span className="fy-mono">{ready ? "ready" : "probing…"}</span>
          </div>
          <div className="scr-launch__probes" style={{ marginTop: 10 }}>
            <HealthDot label="Coordinator" health={connection === "open" ? state?.app.health.coordinator : { status: "starting" }} />
            <HealthDot label="Authoring (OpenCode)" health={state?.app.health.harness} />
            <HealthDot label="Local voice (Voxa)" health={state?.app.health.voice} />
          </div>
          {connection === "closed" && (
            <Callout tone="warning" title="Waiting for the coordinator">
              The app keeps retrying on its own. If this is a dev browser session, start it with
              `npm run dev:coordinator`.
            </Callout>
          )}
          <div style={{ marginTop: 10, textAlign: "center", font: "400 11.5px var(--font-sans)", color: "var(--muted-foreground)" }}>
            Arke runs on your machine. Your worlds never leave it.
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- First run -------------------------------------------------------------

export function FirstRunScreen() {
  const navigate = useNavigate();
  const { state } = useStore();
  const env = useEnvCheck();
  const manifest = state?.app.manifest ?? null;
  // The real figures, from the manifest (D3 — the prototype's "2.1 GB" overstated by ~10×).
  const localModels = (manifest?.models ?? []).filter((m) => m.requires?.diskMb !== undefined && m.pricing.kind === "unmetered");
  const totalMb = localModels.reduce((a, m) => a + (m.requires?.diskMb ?? 0), 0);
  return (
    <div className="fy-app" data-screen="first-run">
      <ShellTitlebar label="Arke Studio" divided={false} />
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
        <div style={{ maxWidth: 640, margin: "34px auto 40px", textAlign: "center" }}>
          <div className="fy-mono" style={{ lineHeight: 1.7 }}>
            optional, later, skippable — provider keys unlock image, video and cloud voice; writing,
            canon and browsing never need one
            {localModels.length > 0
              ? ` · local voice models (${localModels.map((m) => `${m.displayName} ${((m.requires?.diskMb ?? 0) / 1024).toFixed(1)} GB`).join(", ")}, ~${(totalMb / 1024).toFixed(1)} GB) download in the background only when first used`
              : " · local models download in the background only when first used"}
          </div>
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

  const charSeed = parseSeed(firstCharacter);
  const locSeed = parseSeed(firstLocation);

  // The coordinator opens the new world and re-snapshots; when it lands, seed the optional
  // first sheets through the same gate everything else uses, then go there.
  useEffect(() => {
    if (!submittedName || !state?.world || state.world.meta.name !== submittedName) return;
    const worldId = state.world.meta.worldId;
    if (!seededRef.current) {
      seededRef.current = true;
      if (charSeed) createSheetFromSentence(worldId, "character", charSeed.name, charSeed.sentence);
      if (locSeed) createSheetFromSentence(worldId, "location", locSeed.name, locSeed.sentence);
    }
    navigate(`/w/${worldId}`, { replace: true });
  }, [submittedName, state?.world, navigate, charSeed, locSeed]);

  const canCreate = connection === "open" && name.trim().length > 0 && submittedName === null;
  const entries = 1 + (charSeed ? 1 : 0) + (locSeed ? 1 : 0);

  return (
    <div className="fy-app" data-screen="new-world">
      <ShellTitlebar back={{ label: "Back", to: "/worlds" }} label="Arke Studio · new world" />
      <div className="fy-gate" style={{ flex: 1, minHeight: 0 }}>
        <div className="fy-gate__main">
          <div className="fy-gate__head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-eyebrow-sm">NEW WORLD</div>
              <h1 className="fy-story__h1">Write it down. It starts existing.</h1>
            </div>
            <span className="fy-seg" style={{ marginTop: 4 }}>
              <button
                type="button"
                className="fy-seg__item"
                disabled
                style={{ cursor: "not-allowed", opacity: 0.55 }}
                title="Genesis chat arrives once the authoring gate speaks for worlds — the form drafts the same world"
              >
                Chat
              </button>
              <span className="fy-seg__item fy-seg__item--active">Form</span>
            </span>
          </div>
          <div className="fy-gate__body" style={{ gap: 14 }}>
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
                  {name.trim() || "Unnamed world"}
                </div>
                <span className="fy-mono" style={{ color: "var(--warning)", fontSize: 9.5 }}>
                  proposed
                </span>
              </div>
              <div style={{ font: "400 12.5px/1.55 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 5 }}>
                {logline.trim() || "The logline lands here as you write it."}
              </div>
              {(tone.trim() || genre.trim()) && (
                <div style={{ display: "flex", gap: 7, marginTop: 10, flexWrap: "wrap" }}>
                  {tone.trim() && <span className="fy-pill">tone · {tone.trim().toLowerCase()}</span>}
                  {genre.trim() && <span className="fy-pill">{genre.trim().toLowerCase()}</span>}
                </div>
              )}
            </div>
          </div>
          {(charSeed || locSeed) && (
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              {charSeed && (
                <div className="fy-draftcard" style={{ flex: 1, marginTop: 0, padding: "12px 14px" }}>
                  <div className="fy-mono" style={{ fontSize: 10 }}>
                    CHARACTER
                  </div>
                  <div style={{ font: "600 13.5px var(--font-sans)", marginTop: 6 }}>{charSeed.name}</div>
                  <div style={{ font: "400 11.5px/1.5 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 2 }}>
                    {charSeed.sentence}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8 }}>
                    <span className="fy-dot fy-dot--sketch" style={{ width: 5, height: 5 }} />
                    <span className="fy-mono" style={{ fontSize: 9.5 }}>
                      sketch · no face yet
                    </span>
                  </div>
                </div>
              )}
              {locSeed && (
                <div className="fy-draftcard" style={{ flex: 1, marginTop: 0, padding: "12px 14px" }}>
                  <div className="fy-mono" style={{ fontSize: 10 }}>
                    LOCATION
                  </div>
                  <div style={{ font: "600 13.5px var(--font-sans)", marginTop: 6 }}>{locSeed.name}</div>
                  <div style={{ font: "400 11.5px/1.5 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 2 }}>
                    {locSeed.sentence}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8 }}>
                    <span className="fy-dot fy-dot--sketch" style={{ width: 5, height: 5 }} />
                    <span className="fy-mono" style={{ fontSize: 9.5 }}>
                      sketch
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
          <div style={{ flex: 1, minHeight: 16 }} />
          <div style={{ display: "grid", gap: 8 }}>
            <Button
              variant="primary"
              disabled={!canCreate}
              onClick={() => {
                setSubmittedName(name.trim());
                createWorld({
                  name: name.trim(),
                  ...(logline.trim() ? { logline: logline.trim() } : {}),
                  ...(tone.trim() ? { tone: tone.trim().toLowerCase() } : {}),
                  ...(genre.trim() ? { genre: genre.trim().toLowerCase() } : {}),
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

function ProbeChips({ status }: { status: ProviderStatus | undefined }) {
  if (!status || status.probes.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
      {status.probes.map((p) => (
        <Badge key={p.capability} tone={p.available ? "success" : "outline"}>
          {p.capability} {p.available ? "✓" : `— ${p.reason ?? "unavailable"}`}
        </Badge>
      ))}
    </div>
  );
}

function ProviderKeyRow({ id, note }: { id: ProviderId; note: string }) {
  const { state } = useStore();
  const [draft, setDraft] = useState("");
  const status = state?.app.providers.find((p) => p.id === id);
  const info = PROVIDER_TABLE[id];
  return (
    <div className="scr-sheetsection">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        <strong style={{ font: "var(--type-ui)" }}>{info.displayName}</strong>
        <span style={{ font: "var(--type-label)", color: "var(--muted-foreground)" }}>{note}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          {status?.validation === "testing" && <Badge tone="outline">testing…</Badge>}
          {status?.validation === "valid" && <Badge>key valid</Badge>}
          {status?.validation === "invalid" && <Badge tone="outline">key rejected</Badge>}
          <Badge tone={status?.configured ? "success" : "outline"}>
            {status?.configured ? "key stored" : "no key stored"}
          </Badge>
        </span>
      </div>
      {status?.fault && (
        <Callout title={`${info.displayName} fault`}>
          {status.fault} — the work was not the problem; the credential was.
        </Callout>
      )}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Input
          type="password"
          placeholder={info.keyHint ?? "API key"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          disabled={draft.trim().length === 0}
          onClick={() => {
            setCredential(id, draft.trim());
            setDraft("");
          }}
        >
          Save key
        </Button>
        <Button variant="ghost" disabled={!status?.configured} onClick={() => validateProvider(id)}>
          Test
        </Button>
        <Button variant="ghost" disabled={!status?.configured} onClick={() => clearCredential(id)}>
          Remove
        </Button>
      </div>
      <ProbeChips status={status} />
    </div>
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
    <div data-screen="settings-providers">
      <Section title="Provider keys" aside={<span>Encrypted at OS level, outside every world — no export can carry one</span>}>
        <div className="scr-sectionlist">
          {KEYED_PROVIDERS.map((p) => (
            <ProviderKeyRow key={p.id} id={p.id} note={p.note} />
          ))}
        </div>
        <Callout title="Validation tells the truth">
          Testing a key probes each capability separately: a key that authenticates but cannot do
          video says so here, not at the end of composing a scene.
        </Callout>
      </Section>
      <Section title="What this machine can do" aside={<span>Derived from configured, validated providers</span>}>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          {availability.map((a) => (
            <Badge key={a.capability} tone={a.available ? "success" : "outline"}>
              {a.capability}
              {a.available
                ? ` · ${a.via.map((v) => PROVIDER_TABLE[v].displayName).join(", ")}`
                : ` — ${a.reason ?? "unavailable"}`}
            </Badge>
          ))}
        </div>
      </Section>
      <Section title="Spend" aside={<span>Alerts on a rolling window, across all worlds. Never blocks.</span>}>
        {spend && (
          <KeyValue
            rows={[
              {
                k: `Last ${spend.settings.periodDays} day${spend.settings.periodDays === 1 ? "" : "s"}`,
                v: formatMicroUsd(spend.rollingMicroUsd),
              },
              {
                k: "Threshold",
                v:
                  spend.settings.thresholdMicroUsd > 0
                    ? `${formatMicroUsd(spend.settings.thresholdMicroUsd)}${spend.alerted ? " — over" : ""}`
                    : "off",
              },
            ]}
          />
        )}
        {spend?.alerted && (
          <Callout title="Over the spend threshold">
            {formatMicroUsd(spend.rollingMicroUsd)} in the last {spend.settings.periodDays} days, against a threshold
            of {formatMicroUsd(spend.settings.thresholdMicroUsd)}. Dispatch still works — the money is yours; this is
            a warning, not a stop.
          </Callout>
        )}
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <span className="scr-field__label">Alert at $</span>
          <Input style={{ maxWidth: 120 }} value={thresholdValue} onChange={(e) => setThreshold(e.target.value)} />
          <span className="scr-field__label">over</span>
          <Input style={{ maxWidth: 80 }} value={periodValue} onChange={(e) => setPeriod(e.target.value)} />
          <span className="scr-field__label">days</span>
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
      </Section>
    </div>
  );
}

const RUNTIME_TONE: Record<"ready" | "disabled" | "unknown", StatusDotTone> = {
  ready: "ok",
  disabled: "muted",
  unknown: "busy",
};

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
    <div data-screen="settings-local-runtime">
      <Section
        title="This machine"
        aside={
          <Button variant="ghost" onClick={() => detectRuntimes()}>
            Re-detect
          </Button>
        }
      >
        {runtime ? (
          <KeyValue
            rows={[
              { k: "Dedicated VRAM", v: gbOrUnknown(runtime.probes.vramMb) },
              { k: "System memory", v: gbOrUnknown(runtime.probes.memMb) },
              { k: "Free disk", v: gbOrUnknown(runtime.probes.diskFreeMb) },
            ]}
          />
        ) : (
          <EmptyState title="Not yet measured" hint="Detection runs on demand and at start-up." />
        )}
      </Section>
      <Section title="Local models" aside={<span>Shown even when they cannot run — with the measured reason</span>}>
        <div className="scr-sectionlist">
          {(runtime?.models ?? []).map((m) => (
            <div key={m.modelId} className="scr-sheetsection">
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                <StatusDot tone={RUNTIME_TONE[m.state]} label={m.displayName} />
                <span style={{ font: "var(--type-label)", color: "var(--muted-foreground)" }}>
                  {PROVIDER_TABLE[m.provider].displayName} · {m.capability}
                </span>
                <span style={{ marginLeft: "auto" }}>
                  <Badge tone={m.state === "ready" ? "success" : "outline"}>{m.state}</Badge>
                </span>
              </div>
              {m.reason && <span className="scr-field__hint">{m.reason}</span>}
            </div>
          ))}
        </div>
      </Section>
      <Section title="Supervised runtimes">
        <div className="scr-sectionlist">
          <div className="scr-sheetsection">
            <HealthDot label="OpenCode (authoring harness)" health={state?.app.health.harness} />
          </div>
          <div className="scr-sheetsection">
            <HealthDot label="Voxa (local voice)" health={state?.app.health.voice} />
          </div>
        </div>
      </Section>
    </div>
  );
}

/** The capability rows the routing surface offers, in product language. */
const ROUTED_CAPABILITIES: Array<{ capability: Capability; label: string }> = [
  { capability: "video", label: "Clips" },
  { capability: "image", label: "Frames & stills" },
  { capability: "voice-tts", label: "Voice" },
  { capability: "llm", label: "Direct LLM work" },
];

export function SettingsWhoDoesWhatScreen() {
  const { state } = useStore();
  const manifest = state?.app.manifest ?? null;
  const routing = state?.app.routing ?? { defaults: {}, faults: [] };
  const drift = state?.app.drift ?? [];
  return (
    <div data-screen="settings-who-does-what">
      <Section
        title="Who does what"
        aside={<span>A default is a concrete model — what a dispatch will use is never ambiguous</span>}
      >
        {routing.faults.map((f) => (
          <Callout key={f.capability} title={`Routing fault — ${f.capability}`}>
            {f.reason}
          </Callout>
        ))}
        <div className="scr-sectionlist">
          {ROUTED_CAPABILITIES.map(({ capability, label }) => {
            const options = (manifest?.models ?? []).filter((m) => m.capability === capability);
            const selected = routing.defaults[capability];
            const selectedModel = options.find((m) => m.id === selected);
            return (
              <div key={capability} className="scr-sheetsection">
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                  <strong style={{ font: "var(--type-ui)" }}>{label}</strong>
                  <span style={{ marginLeft: "auto", font: "var(--type-label)", color: "var(--muted-foreground)" }}>
                    {selectedModel
                      ? `${PROVIDER_TABLE[selectedModel.provider].displayName} · ${selectedModel.displayName}`
                      : "no default set"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  {options.map((m) => (
                    <Button
                      key={m.id}
                      variant={m.id === selected ? "primary" : "ghost"}
                      onClick={() => setRoutingDefault(capability, m.id)}
                    >
                      {PROVIDER_TABLE[m.provider].displayName} · {m.displayName}
                    </Button>
                  ))}
                  {options.length === 0 && <span className="scr-field__hint">no models in the manifest for this</span>}
                </div>
                {/* The capability copy is the manifest speaking (R-10): refs, frames, caps. */}
                {options.length > 0 && (
                  <span className="scr-field__hint">
                    {options.map((m) => `${m.displayName} · ${modelCapabilityCopy(m)}`).join("  —  ")}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {manifest && (
          <span className="scr-field__hint">
            Manifest v{manifest.manifestVersion} · {manifest.generated}. Any production can override the routed model
            per dispatch; the override travels with that dispatch alone.
          </span>
        )}
      </Section>
      {drift.length > 0 && (
        <Section title="Manifest drift" aside={<span>Estimates keep missing what providers actually charge</span>}>
          {drift.map((d) => (
            <Callout key={d.modelId} title={`${d.modelId} — estimates off by ~${(d.medianDivergencePerMille / 10).toFixed(0)}%`}>
              Across {d.samples} provider-reported charges, the manifest price for {d.modelId} diverges from what{" "}
              {PROVIDER_TABLE[d.provider].displayName} actually billed. The shipped manifest needs an update.
            </Callout>
          ))}
        </Section>
      )}
    </div>
  );
}

export function SettingsAboutScreen() {
  const { state } = useStore();
  const update = useUpdateStatus();
  const diagnostics = useDiagnosticsBundle();
  return (
    <div data-screen="settings-about">
      <Section title="About">
        <KeyValue
          rows={[
            { k: "Version", v: state?.app.version ?? "—" },
            { k: "Licence", v: "MIT — Arke Studio is yours to inspect and keep" },
            {
              k: "Third-party",
              v: "OpenCode (MIT) · Voxa (MIT) · espeak-ng (GPL, separate process, never linked) · ffmpeg (LGPL build, subprocess) · better-sqlite3 (MIT) · Electron (MIT) · Geist (OFL) — full notices in THIRD-PARTY-NOTICES.md beside the app",
            },
            { k: "Your data", v: "%USERPROFILE%\\ArkeStudio — worlds, ledger, credentials. Uninstalling deletes none of it by default." },
          ]}
        />
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="ghost" onClick={() => openDataFolder()}>
            Open data folder
          </Button>
          <Button variant="ghost" onClick={() => generateDiagnostics()}>
            Diagnostics — safe to paste publicly
          </Button>
        </div>
      </Section>
      <Section
        title="Updates"
        aside={<span>checks are yours to run; nothing installs until you quit — running work is never interrupted</span>}
      >
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <Button onClick={() => checkUpdates()}>Check for updates</Button>
          {update && (
            <span className="scr-field__hint">
              {update.status}
              {update.version ? ` · ${update.version}` : ""}
              {update.detail ? ` — ${update.detail}` : ""}
            </span>
          )}
          {update?.status === "available" && <Button variant="primary" onClick={() => downloadUpdate()}>Download</Button>}
        </div>
      </Section>
      {diagnostics && (
        <Section title="Diagnostics bundle" aside={<span>redacted at the boundary — no world content, no keys, no prompts</span>}>
          <Textarea readOnly value={diagnostics} style={{ minHeight: 200, font: "var(--type-mono, monospace)" }} />
        </Section>
      )}
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
