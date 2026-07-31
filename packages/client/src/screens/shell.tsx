import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { Badge, Button, Callout, Card, Input, StatusDot, Switch, Textarea, cx, type StatusDotTone } from "../components/ui.js";
import { EmptyState, PageHeader, KeyValue, Screen, Section } from "../components/layout.js";
import { JobRow } from "../domain/domain.js";
import { usd } from "../lib/format.js";
import { useStore } from "../lib/store.js";
import type { ComponentHealth } from "@arke-studio/contracts";

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
  return (
    <Screen id="new-world">
      <PageHeader title="New world" meta={<span>A folder is created under your ArkeStudio directory.</span>} />
      <div className="scr-form">
        <div className="scr-field">
          <label className="scr-field__label" htmlFor="nw-name">Name</label>
          <Input id="nw-name" placeholder="The Undersong" />
        </div>
        <div className="scr-field">
          <label className="scr-field__label" htmlFor="nw-logline">Logline</label>
          <Input id="nw-logline" placeholder="A drowned god still sings beneath the harbour." />
          <span className="scr-field__hint">One sentence. It anchors tone everywhere.</span>
        </div>
        <div className="scr-field">
          <label className="scr-field__label" htmlFor="nw-tone">Tone</label>
          <Input id="nw-tone" placeholder="quiet dread" />
        </div>
        <div className="scr-field">
          <label className="scr-field__label" htmlFor="nw-genre">Genre</label>
          <Input id="nw-genre" placeholder="coastal fantasy" />
        </div>
        <div>
          <Button variant="primary" disabled title="World creation lands with the world-on-disk capability (SPEC-002)">
            Create world
          </Button>
        </div>
        <Callout title="Not wired yet">
          This build renders the approved design over fixtures. Creating real world folders arrives
          with SPEC-002.
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

const PROVIDERS = [
  { id: "fal", label: "FAL", note: "images and video — most models route here" },
  { id: "higgsfield", label: "Higgsfield", note: "video" },
  { id: "elevenlabs", label: "ElevenLabs", note: "cloud voice and voice clones" },
  { id: "openai", label: "OpenAI", note: "authoring and voice" },
  { id: "anthropic", label: "Anthropic", note: "authoring" },
] as const;

export function SettingsProvidersScreen() {
  return (
    <div data-screen="settings-providers">
      <Section
        title="Provider keys"
        aside={<span>Stored encrypted at OS level, never inside a world (R-PROV-2)</span>}
      >
        <div className="scr-sectionlist">
          {PROVIDERS.map((p) => (
            <div key={p.id} className="scr-sheetsection">
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                <strong style={{ font: "var(--type-ui)" }}>{p.label}</strong>
                <span style={{ font: "var(--type-label)", color: "var(--muted-foreground)" }}>{p.note}</span>
                <span style={{ marginLeft: "auto" }}>
                  <Badge tone="outline">no key stored</Badge>
                </span>
              </div>
              <Input disabled placeholder="Key entry arrives with SPEC-008" />
            </div>
          ))}
        </div>
        <Callout title="One key per provider">
          A key entered once satisfies everything that provider declares — image, video or voice
          (R-PROV-1). Key storage and validation land with SPEC-008.
        </Callout>
      </Section>
    </div>
  );
}

export function SettingsLocalRuntimeScreen() {
  const { state } = useStore();
  return (
    <div data-screen="settings-local-runtime">
      <Section title="Local runtime">
        <div className="scr-sectionlist">
          <div className="scr-sheetsection">
            <HealthDot label="OpenCode (authoring harness)" health={state?.app.health.harness} />
            <span className="scr-field__hint">
              Bundled with the app; an existing install is used when found. Managed start-up lands
              with SPEC-005.
            </span>
          </div>
          <div className="scr-sheetsection">
            <HealthDot label="Voxa (local voice)" health={state?.app.health.voice} />
            <span className="scr-field__hint">
              Local TTS/STT — Kokoro and whisper.cpp under a supervised sidecar. Lands with SPEC-011.
            </span>
          </div>
          <div className="scr-sheetsection">
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
              <span style={{ font: "var(--type-ui)" }}>Ollama</span>
              <span style={{ marginLeft: "auto" }}>
                <Switch checked={false} disabled label="Use Ollama for cheap non-authoring work" />
              </span>
            </div>
            <span className="scr-field__hint">
              Called directly for cheap non-authoring work; offered for authoring when no cloud LLM
              is configured (R-PROV-7).
            </span>
          </div>
        </div>
      </Section>
    </div>
  );
}

export function SettingsWhoDoesWhatScreen() {
  return (
    <div data-screen="settings-who-does-what">
      <Section title="Who does what" aside={<span>Routing defaults — editable once SPEC-008 lands</span>}>
        <KeyValue
          rows={[
            { k: "Clips", v: "FAL · seedance-2.0" },
            { k: "Frames & stills", v: "FAL · flux-pro-1.1" },
            { k: "Cloud voice", v: "ElevenLabs · eleven-v3" },
            { k: "Local voice", v: "Voxa · Kokoro" },
            { k: "Authoring", v: "OpenCode → your configured LLM" },
            { k: "Cheap non-authoring", v: "Ollama (when running)" },
          ]}
        />
      </Section>
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
