import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Badge, Button, Callout, Card, Input, StatusDot, Switch, Textarea, cx, type StatusDotTone } from "../components/ui.js";
import { EmptyState, PageHeader, KeyValue, Screen, Section } from "../components/layout.js";
import { JobRow } from "../domain/domain.js";
import { Portrait } from "../components/portrait.js";
import { shortDateTime, usd } from "../lib/format.js";
import {
  cancelExport as cancelExportMsg,
  cancelJob,
  checkUpdates,
  clearCredential,
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
  // The home screen carries its own head (prototype 1a); the bar would double the nav there.
  const bare = useLocation().pathname === "/worlds";
  return (
    <div className="scr-frame__content" style={{ height: "100%" }}>
      {bare ? null : (
      <div className="scr-shellbar">
        <span className="scr-shellbar__brand">Arke Studio</span>
        <nav className="scr-shellbar__nav">
          <NavLink to="/worlds" className={({ isActive }) => cx("scr-navlink", isActive && "scr-navlink--active")}>
            Worlds
          </NavLink>
          <NavLink to="/activity" className={({ isActive }) => cx("scr-navlink", isActive && "scr-navlink--active")}>
            Activity
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => cx("scr-navlink", isActive && "scr-navlink--active")}>
            Settings
          </NavLink>
        </nav>
      </div>
      )}
      <Outlet />
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
    <Screen id="launch">
      <div className="scr-launch">
        <div className="scr-launch__mark">Arke Studio</div>
        <div className="scr-launch__probes">
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
      </div>
    </Screen>
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
    <Screen id="first-run">
      <div className="scr-hero">
        <PageHeader title="Begin a world" />
        <p className="scr-hero__lede">
          A world is a folder on your disk — characters, canon, productions, all of it readable by
          hand and yours to keep. Nothing here requires an account, a key, a download or a network
          to start.
        </p>
      </div>
      {env && !env.pathBudgetOk && (
        <Callout tone="warning" title="Your data folder sits too deep">
          {env.pathBudgetDetail}
        </Callout>
      )}
      {env && !env.nativeIndexOk && (
        <Callout tone="warning" title="The search index could not load">
          {env.nativeIndexDetail}
        </Callout>
      )}
      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        <Button variant="primary" onClick={() => navigate("/worlds/new")}>
          Create your first world
        </Button>
        <Button
          onClick={() => navigate("/worlds/new")}
          title="Create the world first; then Artifacts → Import folder files everything and offers to lift facts — gated, grounded, optional."
        >
          Already have a canon? Import a folder
        </Button>
      </div>
      <Section title="Optional, later, skippable" aside={<span>each names what it unlocks — none is required</span>}>
        <div className="scr-sectionlist">
          <div className="scr-sheetsection">
            <strong style={{ font: "var(--type-ui)" }}>Provider keys</strong>
            <span className="scr-field__hint">
              Unlock image and video generation (FAL, Higgsfield), cloud voice (ElevenLabs) and direct
              LLM work. Settings · Providers, whenever you want them. Writing, canon and browsing
              never need one.
            </span>
          </div>
          <div className="scr-sheetsection">
            <strong style={{ font: "var(--type-ui)" }}>Local voice models</strong>
            <span className="scr-field__hint">
              {localModels.length > 0
                ? `${localModels.map((m) => `${m.displayName} · ${((m.requires?.diskMb ?? 0) / 1024).toFixed(1)} GB`).join(" · ")} — about ${(totalMb / 1024).toFixed(1)} GB total. `
                : ""}
              Nothing downloads now: anything you use later downloads at that point, in the
              background, visible in Activity. A cloud-only session never waits for them.
            </span>
          </div>
        </div>
      </Section>
      <Callout title="The no-key path is the real one">
        Create the world, write canon by form, add characters and locations, link artifacts, browse
        all of it — offline if you like. Agents and generation are named where they are unavailable,
        never a locked door.
      </Callout>
    </Screen>
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
          <Button variant="primary" onClick={() => navigate("/worlds/new")}>
            New world
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
          </div>
        )}
      </div>
    </div>
  );
}

// ---- New world -------------------------------------------------------------

export function NewWorldScreen() {
  const { state, connection } = useStore();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [logline, setLogline] = useState("");
  const [tone, setTone] = useState("");
  const [genre, setGenre] = useState("");
  const [submittedName, setSubmittedName] = useState<string | null>(null);

  // The coordinator opens the new world and re-snapshots; when it lands, go there.
  useEffect(() => {
    if (submittedName && state?.world && state.world.meta.name === submittedName) {
      navigate(`/w/${state.world.meta.worldId}`, { replace: true });
    }
  }, [submittedName, state?.world, navigate]);

  const canCreate = connection === "open" && name.trim().length > 0 && submittedName === null;

  return (
    <Screen id="new-world">
      <PageHeader title="New world" meta={<span>A folder is created under your ArkeStudio directory.</span>} />
      <div className="scr-form">
        <div className="scr-field">
          <label className="scr-field__label" htmlFor="nw-name">Name</label>
          <Input id="nw-name" placeholder="The Undersong" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="scr-field">
          <label className="scr-field__label" htmlFor="nw-logline">Logline</label>
          <Input
            id="nw-logline"
            placeholder="A drowned god still sings beneath the harbour."
            value={logline}
            onChange={(e) => setLogline(e.target.value)}
          />
          <span className="scr-field__hint">One sentence. It anchors tone everywhere.</span>
        </div>
        <div className="scr-field">
          <label className="scr-field__label" htmlFor="nw-tone">Tone</label>
          <Input id="nw-tone" placeholder="quiet dread" value={tone} onChange={(e) => setTone(e.target.value)} />
        </div>
        <div className="scr-field">
          <label className="scr-field__label" htmlFor="nw-genre">Genre</label>
          <Input id="nw-genre" placeholder="coastal fantasy" value={genre} onChange={(e) => setGenre(e.target.value)} />
        </div>
        <div>
          <Button
            variant="primary"
            disabled={!canCreate}
            onClick={() => {
              setSubmittedName(name.trim());
              createWorld({
                name: name.trim(),
                ...(logline.trim() ? { logline: logline.trim() } : {}),
                ...(tone.trim() ? { tone: tone.trim() } : {}),
                ...(genre.trim() ? { genre: genre.trim() } : {}),
              });
            }}
          >
            {submittedName ? "Creating…" : "Create world"}
          </Button>
        </div>
        <Callout title="Yours, on disk">
          The world is a folder under ArkeStudio\worlds — readable by hand, portable, and never
          dependent on this app to exist.
        </Callout>
      </div>
    </Screen>
  );
}

// ---- Settings --------------------------------------------------------------

export function SettingsLayout() {
  return (
    <Screen id="settings">
      <PageHeader title="Settings" />
      <nav className="scr-settingsnav">
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
            className={({ isActive }) => cx("scr-navlink", isActive && "scr-navlink--active")}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </Screen>
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
    <Screen id="activity">
      <PageHeader
        title="Activity"
        meta={<span>Everything running, everything waiting on you, and what it cost — every world.</span>}
        actions={
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button variant={scope === "active" ? "primary" : "ghost"} onClick={() => setScope("active")}>
              This world
            </Button>
            <Button variant={scope === "all" ? "primary" : "ghost"} onClick={() => setScope("all")}>
              All worlds
            </Button>
          </div>
        }
      />
      {reconcileReport && reconcileReport.length > 0 && (
        <Callout title="What recovery did">
          {reconcileReport.map((r) => `${r.jobId.slice(0, 8)}… ${r.action}`).join(" · ")}
        </Callout>
      )}
      {settled ? (
        <Section title="All quiet">
          <EmptyState
            title="Nothing running, nothing waiting on you"
            hint="A settled state, not a blank — you can stop."
          />
        </Section>
      ) : (
        <>
          <Section title="Running" aside={<span>work worth watching — pushed, never polled</span>}>
            {scoped(running).length === 0 ? (
              <EmptyState title="Nothing in flight" />
            ) : (
              <div className="scr-sectionlist">
                {scoped(running).map((r) => (
                  <div key={r.ref} className="scr-cutrow">
                    <span className="mono">{r.kind}</span>
                    <span>{r.title}</span>
                    <span style={{ color: "var(--muted-foreground)" }}>
                      {r.detail}
                      {r.percent !== null ? ` · ${Math.round(r.percent)}%` : ""}
                    </span>
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
              </div>
            )}
          </Section>
          <Section
            title={`Needs you · ${scoped(needsYou).length}`}
            aside={<span>unresolved money first, then blocked work, then work already paid for</span>}
          >
            {scoped(needsYou).length === 0 ? (
              <EmptyState title="Nothing waiting on you" />
            ) : (
              <div className="scr-sectionlist">
                {scoped(needsYou).map((entry, i) => (
                  <div key={`${entry.kind}-${entry.ref ?? entry.worldId ?? i}`} className="scr-sheetsection">
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                      <Badge tone={entry.urgency <= 2 ? "warning" : "outline"}>class {entry.urgency}</Badge>
                      <strong style={{ font: "var(--type-ui)" }}>{entry.title}</strong>
                      {entry.asOf && (
                        <Badge tone="outline">as of {shortDateTime(entry.asOf)} — not current</Badge>
                      )}
                    </div>
                    <span className="scr-field__hint">{entry.detail}</span>
                    <div style={{ display: "flex", gap: "var(--space-2)" }}>
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
                ))}
              </div>
            )}
          </Section>
        </>
      )}
      <Section
        title="Spend"
        aside={
          spend && (
            <span>
              last {spend.periodDays} days
              {spend.mixed ? " · includes derived figures, not a measured total" : ""}
            </span>
          )
        }
      >
        {spend && (
          <>
            <div className="lay-stats">
              <div className="lay-stats__item">
                <div className="lay-stats__value">{formatMicroUsd(spend.totalMicroUsd)}</div>
                <div className="lay-stats__label">
                  {spend.mixed
                    ? `mixed · ${spend.reportedEntries} measured, ${spend.derivedEntries} derived`
                    : spend.derivedEntries > 0
                      ? "derived from the manifest"
                      : "provider-reported"}
                </div>
              </div>
              {spend.byProvider
                .filter((p) => !p.unmetered)
                .map((p) => (
                  <div key={p.provider} className="lay-stats__item">
                    <div className="lay-stats__value">{formatMicroUsd(p.microUsd)}</div>
                    <div className="lay-stats__label">{p.provider}</div>
                  </div>
                ))}
              {spend.unmeteredRuns > 0 && (
                <div className="lay-stats__item">
                  <div className="lay-stats__value">unmetered</div>
                  <div className="lay-stats__label">
                    {spend.unmeteredRuns} local run{spend.unmeteredRuns === 1 ? "" : "s"} — this machine's compute
                  </div>
                </div>
              )}
            </div>
            {state?.app.spend?.alerted && (
              <Callout title="Over the spend threshold">
                {formatMicroUsd(state.app.spend.rollingMicroUsd)} against{" "}
                {formatMicroUsd(state.app.spend.settings.thresholdMicroUsd)}. Nothing is blocked — the threshold is
                set in Settings · Providers.
              </Callout>
            )}
            {drift.map((d) => (
              <Callout key={d.modelId} tone="warning" title={`${d.modelId} estimates are drifting`}>
                ~{(d.medianDivergencePerMille / 10).toFixed(0)}% off across {d.samples} provider-reported charges —
                the shipped manifest needs an update.
              </Callout>
            ))}
          </>
        )}
      </Section>
      <Section title="Recent" aside={<span>terminal today · the ledger holds everything</span>}>
        {recent.length === 0 ? (
          <EmptyState title="Nothing finished today" />
        ) : (
          <div className="scr-sectionlist">
            {recent.slice(0, 20).map((job) => (
              <div key={job.id} className="scr-sheetsection">
                <JobRow job={job} />
                {jobActions(job).includes("retry") && (
                  <span className="scr-field__hint">failed — retry from its production's dispatch dialog</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </Screen>
  );
}
