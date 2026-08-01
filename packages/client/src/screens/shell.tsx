import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { Badge, Button, Callout, Card, Input, StatusDot, Switch, cx, type StatusDotTone } from "../components/ui.js";
import { EmptyState, PageHeader, KeyValue, Screen, Section } from "../components/layout.js";
import { JobRow } from "../domain/domain.js";
import { usd } from "../lib/format.js";
import {
  clearCredential,
  createWorld,
  detectRuntimes,
  setCredential,
  setRoutingDefault,
  setSpendThreshold,
  useStore,
  validateProvider,
} from "../lib/store.js";
import {
  deriveCapabilityAvailability,
  formatMicroUsd,
  modelCapabilityCopy,
  PROVIDERS as PROVIDER_TABLE,
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
  return (
    <div className="scr-frame__content" style={{ height: "100%" }}>
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
  return (
    <Screen id="first-run">
      <div className="scr-hero">
        <PageHeader title="Begin a world" />
        <p className="scr-hero__lede">
          A world is a folder on your disk — characters, canon, productions, all of it readable by
          hand and yours to keep. Nothing here requires an account or a key to start.
        </p>
      </div>
      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        <Button variant="primary" onClick={() => navigate("/worlds/new")}>
          Create your first world
        </Button>
        <Button disabled title="Folder import arrives with the artifacts capability (SPEC-015)">
          Already have a canon? Import a folder
        </Button>
      </div>
      <Callout title="Bring your own keys, later">
        Browsing, writing and canon never need a provider. Add FAL or other keys in Settings when
        you want image, video or cloud-voice generation.
      </Callout>
    </Screen>
  );
}

// ---- World picker ----------------------------------------------------------

export function WorldPickerScreen() {
  const { state } = useStore();
  const navigate = useNavigate();
  const worlds = state?.worlds ?? [];
  return (
    <Screen id="world-picker">
      <PageHeader
        title="Your worlds"
        actions={
          <Button variant="primary" onClick={() => navigate("/worlds/new")}>
            New world
          </Button>
        }
      />
      {worlds.length === 0 ? (
        <EmptyState
          title="No worlds yet"
          hint="Create one, or drop an existing world folder into your ArkeStudio directory."
          action={<Button onClick={() => navigate("/first-run")}>Start</Button>}
        />
      ) : (
        <div className="lay-cardgrid">
          {worlds.map((w) => (
            <Card key={w.worldId} className="scr-worldcard" onClick={() => navigate(`/w/${w.worldId}`)}>
              <div className="scr-worldcard__name">{w.name}</div>
              {w.logline && <div className="scr-worldcard__logline">{w.logline}</div>}
              <div className="scr-worldcard__counts">
                <span>{w.counts.characters} characters</span>
                <span>{w.counts.locations} locations</span>
                <span>{w.counts.canonEntries} canon entries</span>
                <span>{w.counts.productions} productions</span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Screen>
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
  return (
    <div data-screen="settings-about">
      <Section title="About">
        <KeyValue
          rows={[
            { k: "Version", v: state?.app.version ?? "—" },
            { k: "Your worlds", v: "Folders on your disk. Delete the app, keep the worlds." },
            { k: "Licences", v: "Third-party notices ship with packaging (SPEC-016)." },
          ]}
        />
      </Section>
    </div>
  );
}

// ---- Activity --------------------------------------------------------------

export function ActivityScreen() {
  const { state } = useStore();
  const jobs = [...(state?.app.jobs ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const ledger = state?.app.ledger ?? [];
  const byProvider = new Map<string, number>();
  for (const entry of ledger) {
    byProvider.set(entry.provider, (byProvider.get(entry.provider) ?? 0) + (entry.actualMicroUsd ?? entry.estimatedMicroUsd));
  }
  return (
    <Screen id="activity">
      <PageHeader title="Activity" meta={<span>Every job, every world, and what it cost.</span>} />
      <Section title="Spend" aside={<span>{ledger.length} ledger lines</span>}>
        <div className="lay-stats">
          {[...byProvider.entries()].map(([provider, micro]) => (
            <div key={provider} className="lay-stats__item">
              <div className="lay-stats__value">{usd(micro)}</div>
              <div className="lay-stats__label">{provider}</div>
            </div>
          ))}
          {byProvider.size === 0 && <EmptyState title="Nothing spent yet" />}
        </div>
      </Section>
      <Section title="Jobs">
        {jobs.length === 0 ? (
          <EmptyState title="No jobs yet" hint="Dispatches from every world land here." />
        ) : (
          <div className="scr-sectionlist">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        )}
      </Section>
    </Screen>
  );
}
