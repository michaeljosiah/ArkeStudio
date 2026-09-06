import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import {
  ENGINE_LABEL,
  ENGINE_PROVIDERS,
  PROVIDERS as PROVIDER_TABLE,
  comfyUiWeightsRecipeId,
  deriveCapabilityAvailability,
  type EngineId,
  type ProviderId,
  type ProviderStatus,
  type ProviderWorkspace,
  type SetupComponent,
} from "@arke-studio/contracts";
import { cx } from "../components/ui.js";
import { Check, Cloud, Download, LinkMark, Monitor, Pencil, RefreshCw, Trash, User, X } from "../components/icons.js";
import { SetupTransferControl } from "../components/setup-transfer-control.js";
import { shortDateTime } from "../lib/format.js";
import {
  cancelProviderToolSignIn,
  clearCredential,
  refreshProviderTool,
  selectProviderWorkspace,
  setCredential,
  setupRetry,
  signInProviderTool,
  useSetup,
  useStore,
  validateProvider,
} from "../lib/store.js";
import {
  ComfyUiDetail,
  OllamaDetail,
  OtherComponentsDetail,
  VoxaDetail,
  comfyUiTone,
  componentsFor,
  componentsTone,
  processTone,
} from "./engine-panes.js";
import { MachineRow, VoiceLines } from "./local-models.js";
import {
  ActionButton,
  CAPABILITY_LABEL,
  HalfHeading,
  ProviderMark,
  RuntimeStatus,
  engineCapabilityWords,
  type RuntimeTone,
} from "./settings-parts.js";

/**
 * Settings · Providers (SPEC-042 R-1, R-3). How do I reach each source, and is it reachable now.
 *
 * A credential and nothing else. It held every model until SPEC-042: a model's kind was buried
 * one pane at a time, and its supplier was the only way in, so *which image model* meant opening
 * four panes and holding the answers in your head. The models are on AI models now, under the
 * kind they make; this surface keeps the key, the sign-in, and the engine's own machinery, and
 * says one thing about models — a count, and the way there (R-3).
 *
 * The switch lives wholly on AI models, and so does the credential's remedy where a supplier
 * cannot be reached (R-4) — rendered there as this pane's own control, never as a route back
 * here. That is the rule the split has to keep clearing, and SPEC-042 §2.2 is the argument that
 * it does.
 *
 * The same three columns as AI models (R-7): the rail, then who you connect to, then the
 * detail. The two groups are SPEC-034 R-3's words, unchanged — named for how a source is
 * reached, never for where its work runs.
 */

/** The keyed services, in the column's order. Higgsfield's credential is external (issue 137). */
export const KEYED_PROVIDERS: readonly ProviderId[] = ["fal", "higgsfield", "openai", "anthropic", "elevenlabs"];

const ENGINES: readonly EngineId[] = ["comfyui", "ollama", "voxa"];

/** Which setup component fetches this provider's tool, from the component's own declaration. */
function toolComponentFor(components: readonly SetupComponent[], provider: ProviderId): string | undefined {
  return components.find((c) => c.provider === provider)?.id;
}

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
 * One fact about a source: what it is, what it is, and the buttons that act on it — right-aligned
 * so the values form a column (SPEC-042 R-18).
 */
export function FactRow({ what, children, does }: { what: string; children: ReactNode; does?: ReactNode }) {
  return (
    <div className="fy-fact">
      <div className="fy-fact__what">{what}</div>
      <div className="fy-fact__is">{children}</div>
      {does !== undefined && <div className="fy-fact__does">{does}</div>}
    </div>
  );
}

/**
 * What the last validation actually proved, per capability. A key that authenticates but cannot
 * do video says so here rather than at the end of composing a scene (SPEC-008 R-3).
 */
function probeWords(status: ProviderStatus | undefined): string | null {
  if (!status || status.probes.length === 0) return null;
  const short = status.probes.filter((p) => !p.available);
  return short.length === 0
    ? `${status.probes.map((p) => CAPABILITY_LABEL[p.capability]).join(", ")} answered`
    : short.map((p) => `${CAPABILITY_LABEL[p.capability]} — ${p.reason ?? "unavailable"}`).join(" · ");
}

/**
 * Which account pays. One credential can reach several, and a generation billed to the wrong
 * one is not recoverable — so the choice is made here, in advance, rather than discovered on an
 * invoice. With a single account there is nothing to choose and the row just names it.
 */
function ProviderWorkspaceLine({ id, workspaces }: { id: ProviderId; workspaces: readonly ProviderWorkspace[] }) {
  if (workspaces.length === 0) return null;
  const selected = workspaces.find((w) => w.selected) ?? null;
  return (
    <>
      <FactRow what="Bills to">
        {workspaces.length === 1 ? (
          workspaceLabel(workspaces[0]!)
        ) : (
          <select
            className="fy-fact__select"
            aria-label="Billing account"
            value={selected?.id ?? ""}
            onChange={(e) => selectProviderWorkspace(id, e.target.value === "" ? null : e.target.value)}
          >
            {/* An explicit entry for "no workspace", because `workspace unset` is a real choice
                — it returns billing to the personal account rather than clearing it. */}
            <option value="">Personal account</option>
            {workspaces
              .filter((w) => w.name !== null)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {workspaceLabel(w)}
                </option>
              ))}
          </select>
        )}
      </FactRow>
      {workspaces.length > 1 && selected === null && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>This sign-in reaches {workspaces.length} accounts and none is selected — choose which one pays.</span>
        </div>
      )}
    </>
  );
}

/**
 * A provider whose credential is not ours to hold (issue 137). There is no key to paste: the
 * tool signs itself in, and the only questions the app can answer are whether it is here and
 * whether it is signed in. So the row is a state and the one action that changes it — plus the
 * command to type, always visible rather than revealed by a failure, because the in-app button
 * cannot serve every machine and finding that out at the moment it fails is too late.
 *
 * Drawn on Providers, and again under the supplier's heading on AI models where it is the
 * remedy for a supplier that cannot be reached (SPEC-042 R-4) — one control, in two places.
 */
export function ProviderToolLine({ id }: { id: ProviderId }) {
  const { state } = useStore();
  const setup = useSetup();
  const [copied, setCopied] = useState(false);
  const componentId = toolComponentFor(setup?.components ?? [], id);
  const component = setup?.components.find((c) => c.id === componentId);
  const fetching =
    component?.state === "downloading" ||
    component?.state === "paused" ||
    component?.state === "installing" ||
    component?.state === "queued";
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
      <FactRow
        what="Sign-in"
        does={
          <>
            {tool.state === "absent" &&
            component !== undefined &&
            (component.state === "downloading" || component.state === "paused") ? (
              <SetupTransferControl component={component} />
            ) : tool.state === "absent" ? (
              <ActionButton
                icon={<Download size={13} />}
                disabled={fetching}
                onClick={() => componentId !== undefined && setupRetry(componentId)}
              >
                {fetching ? "Installing…" : `Install${component ? ` · ${component.sizeMb} MB` : ""}`}
              </ActionButton>
            ) : null}
            {tool.state === "signing-in" ? (
              <ActionButton icon={<X size={13} />} onClick={() => cancelProviderToolSignIn(id)}>
                Stop waiting
              </ActionButton>
            ) : (
              <ActionButton icon={<User size={13} />} disabled={tool.state === "absent"} onClick={() => signInProviderTool(id)}>
                {tool.state === "ready" ? "Sign in again" : "Sign in"}
              </ActionButton>
            )}
            <ActionButton icon={<RefreshCw size={13} />} onClick={() => refreshProviderTool(id)}>
              Re-check
            </ActionButton>
          </>
        }
      >
        {label}
      </FactRow>
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
 * One provider's key, as a row (design turn 125d): what is stored, when it was last tested and
 * what answered, and the buttons that replace, remove and test it. Drawn on Providers, and again
 * under a supplier's heading on AI models as the remedy for a key that is missing (SPEC-042 R-4).
 */
export function ProviderKeyLine({ id }: { id: ProviderId }) {
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
  const cancel = () => {
    setDraft("");
    setReplacing(false);
  };
  const probes = probeWords(status);
  return (
    <>
      {stored && !replacing ? (
        <FactRow
          what="Key"
          does={
            <>
              <ActionButton icon={<Pencil size={13} />} onClick={() => setReplacing(true)}>
                Replace
              </ActionButton>
              <ActionButton icon={<Trash size={13} />} danger onClick={() => clearCredential(id)}>
                Remove
              </ActionButton>
            </>
          }
        >
          {/* No last-four: the key never comes back over the bridge, and inventing a tail would
              be a picture of a secret rather than the secret's state (SPEC-008 R-10). */}
          <span className="fy-fact__mono">•••••••••••• stored</span>
        </FactRow>
      ) : (
        <FactRow
          what="Key"
          does={
            <>
              <ActionButton icon={<Check size={13} />} disabled={draft.trim().length === 0} onClick={save}>
                Save
              </ActionButton>
              {replacing && (
                <ActionButton icon={<X size={13} />} onClick={cancel}>
                  Cancel
                </ActionButton>
              )}
            </>
          }
        >
          <input
            className="fy-fact__input"
            type="password"
            aria-label={`${info.displayName} API key`}
            placeholder={info.keyHint ?? "Paste API key…"}
            value={draft}
            autoFocus={replacing}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape" && replacing) cancel();
            }}
          />
        </FactRow>
      )}
      {stored && (
        <FactRow
          what="Last tested"
          does={
            <ActionButton
              icon={<RefreshCw size={13} />}
              disabled={status?.validation === "testing"}
              onClick={() => validateProvider(id)}
            >
              {status?.validation === "testing" ? "Testing…" : "Test again"}
            </ActionButton>
          }
        >
          {status?.validation === "invalid"
            ? "Key rejected"
            : status?.lastValidated !== undefined
              ? `${shortDateTime(status.lastValidated)}${probes ? `, ${probes}` : ""}`
              : "Not yet"}
        </FactRow>
      )}
      {status?.fault && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          {/* The reassurance is only true while a key is stored: then a fault is that key
              failing in use, and the generation it interrupted was not at fault. With nothing
              stored the fault is about the store itself (issue 227), and pointing at the
              credential would send the user to try a different key. */}
          <span>
            {status.fault}
            {stored ? " — the work was not the problem; the credential was." : ""}
          </span>
        </div>
      )}
    </>
  );
}

/** Stored, tested, or neither — in the words the head prints (SPEC-028 R-33). */
function connectionWords(id: ProviderId, status: ProviderStatus | undefined): { word: string; tone: RuntimeTone } {
  const external = PROVIDER_TABLE[id].credential === "external";
  const troubled = Boolean(status?.fault) || status?.validation === "invalid";
  if (troubled) return { word: external ? "sign-in needed" : "key rejected", tone: "warn" };
  if (status?.configured === true) return { word: "connected", tone: "ok" };
  return { word: external ? "not signed in" : "no key", tone: "idle" };
}

/** The one line Providers says about models (R-3): a count, and the way there. */
function ModelsAside({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <p className="fy-aside">
      {children}{" "}
      <button type="button" className="fy-aside__link" onClick={() => navigate("/settings/models")}>
        AI models
      </button>
    </p>
  );
}

/** A keyed service: its mark, its credential, and one line about its models (R-18). */
function ServicePane({ id }: { id: ProviderId }) {
  const { state } = useStore();
  const info = PROVIDER_TABLE[id];
  const status = state?.app.providers.find((p) => p.id === id);
  const { word, tone } = connectionWords(id, status);
  const models = (state?.app.manifest?.models ?? []).filter((m) => m.provider === id);
  const disabled = new Set(state?.app.models.disabled ?? []);
  // The same question the pickers ask: what this key actually unlocks, capability by capability.
  const unlocked = new Set(
    deriveCapabilityAvailability(state?.app.providers ?? [])
      .filter((a) => a.via.includes(id))
      .map((a) => a.capability),
  );
  const on = models.filter((m) => unlocked.has(m.capability) && !disabled.has(m.id)).length;
  const words = [...new Set(info.capabilities.map((c) => CAPABILITY_LABEL[c]))].join(", ");
  return (
    <div className="fy-pane" data-testid="provider-pane">
      <div className="fy-pane__head">
        <ProviderMark id={id} label={info.displayName} size="lg" />
        <span className="fy-pane__name">{info.displayName}</span>
        <span className="fy-pane__where">{words}</span>
        <span style={{ flex: 1 }} />
        <RuntimeStatus tone={tone}>{word}</RuntimeStatus>
      </div>
      <div className="fy-facts">
        {info.credential === "external" ? <ProviderToolLine id={id} /> : <ProviderKeyLine id={id} />}
      </div>
      <ModelsAside>
        {models.length === 0
          ? `Nothing in the shipped manifest routes to ${info.displayName} yet.`
          : `${models.length} ${info.displayName} model${models.length === 1 ? "" : "s"}, ${on} of them on.`}
      </ModelsAside>
    </div>
  );
}

/**
 * An engine: its machinery, unabridged, less its models (R-19). The detail is what SPEC-034 R-5
 * moved here and SPEC-033 R-70 lists; the model groups that sat under it are on AI models.
 */
function EnginePane({ engine, supporting }: { engine: EngineId; supporting: readonly SetupComponent[] }) {
  const { state } = useStore();
  const setup = useSetup();
  const navigate = useNavigate();
  const comfyui = state?.app.comfyui ?? null;
  const remote = engine === "comfyui" && comfyui?.engine.locality === "remote";
  const models = (state?.app.manifest?.models ?? []).filter((m) => ENGINE_PROVIDERS[engine].includes(m.provider));
  const ready =
    engine === "comfyui"
      ? (comfyui?.recipes ?? []).filter((r) => r.state === "ready").length
      : models.filter((m) =>
          (setup?.components ?? []).some((c) => c.provides?.includes(m.id) && (c.state === "ready" || c.state === "present")),
        ).length;
  return (
    <div className="fy-pane" data-testid="provider-pane">
      {engine === "comfyui" && <ComfyUiDetail />}
      {engine === "ollama" && <OllamaDetail components={supporting} />}
      {engine === "voxa" && (
        <VoxaDetail voiceRuntime={state?.app.voiceRuntime ?? null} health={state?.app.health.voice} components={supporting} />
      )}
      {/* Three readable lines, once (SPEC-033 R-48): the engine's own readiness per half, on
          the engine, so neither half collapses into the other's state. */}
      {engine === "voxa" && <VoiceLines />}
      {/* The figures every fit verdict turns on, once per pane rather than once per tile
          (SPEC-034 R-13). Absent where fit is not a question at all: a remote engine has no
          verdict for them to explain. */}
      {!remote && <MachineRow />}
      <div className="fy-rt__actions">
        <span style={{ flex: 1 }} />
        {/* Unconditional (SPEC-034 R-25): a link that appears only while something is
            transferring leaves no way to reach the surface that reports what a failed or
            cancelled fetch left behind. */}
        <ActionButton icon={<Download size={13} />} onClick={() => navigate("/settings/downloads")}>
          {setup?.running === true ? "Downloads · running" : "Downloads"}
        </ActionButton>
      </div>
      <ModelsAside>
        {models.length === 0
          ? `Nothing in the shipped manifest runs on ${ENGINE_LABEL[engine]} yet.`
          : remote
            ? `${models.length} ${ENGINE_LABEL[engine]} model${models.length === 1 ? "" : "s"}, served elsewhere.`
            : `${models.length} ${ENGINE_LABEL[engine]} model${models.length === 1 ? "" : "s"}, ${ready} of them ready.`}
      </ModelsAside>
    </div>
  );
}

interface Row {
  id: string;
  label: string;
  /** Only where something needs attention (R-9): a source that is fine says nothing beside its name. */
  note: string | null;
  kind: "service" | "engine" | "other";
}

export function SettingsProvidersScreen() {
  const { state } = useStore();
  const setup = useSetup();
  const [searchParams, setSearchParams] = useSearchParams();
  const providerStatus = state?.app.providers ?? [];
  const all = setup?.components ?? [];
  const comfyui = state?.app.comfyui ?? null;
  const voiceRuntime = state?.app.voiceRuntime ?? null;
  const unowned = componentsFor(all, null);
  /**
   * An engine's own supporting pieces. A component that provides a model is that model, and
   * AI models draws it; listing it here as well put two Downloads for one fetch on one screen,
   * which is the duplication `statedElsewhere` was invented to hide and SPEC-033 R-6 deletes.
   */
  const supporting = (engine: EngineId): SetupComponent[] =>
    componentsFor(all, engine).filter((c) => (c.provides ?? []).length === 0);

  const services: Row[] = KEYED_PROVIDERS.map((id) => {
    const status = providerStatus.find((s) => s.id === id);
    const { word, tone } = connectionWords(id, status);
    return { id, label: PROVIDER_TABLE[id].displayName, note: tone === "ok" ? null : word, kind: "service" };
  });
  const engineTone = (engine: EngineId): RuntimeTone =>
    engine === "comfyui"
      ? comfyUiTone(comfyui?.engine ?? null)
      : engine === "ollama"
        ? processTone(providerStatus.find((p) => p.id === "ollama")?.validation)
        : processTone(voiceRuntime?.processState);
  const engineNote = (engine: EngineId): string | null => {
    // `elsewhere` in place of a state (SPEC-034 R-9): for a machine down the hall, how it is
    // doing here is not a question with an answer.
    if (engine === "comfyui" && comfyui?.engine.locality === "remote") return "elsewhere";
    if (engineTone(engine) !== "warn") return null;
    return engine === "comfyui"
      ? (comfyui?.engine.state ?? "not running")
      : engine === "ollama"
        ? "not answering"
        : (voiceRuntime?.processState ?? "not running");
  };
  const engines: Row[] = ENGINES.map((engine) => ({
    id: engine,
    label: ENGINE_LABEL[engine],
    note: engineNote(engine),
    kind: "engine",
  }));
  // A component required by neither an engine nor a provider keeps a place, and that place is
  // drawn only where such a component exists (SPEC-034 R-8).
  const other: Row[] =
    unowned.length === 0
      ? []
      : [{ id: "other", label: "Other components", note: componentsTone(unowned) === "warn" ? "needs attention" : null, kind: "other" }];
  const rows = [...services, ...engines, ...other];

  // First run has no key anywhere, so opening on the first provider is not a preference — it is
  // the only pane there is. Once something is connected, that is the one worth landing on.
  const firstConnected = KEYED_PROVIDERS.find((id) => providerStatus.some((s) => s.id === id && s.configured));
  const asked = searchParams.get("provider");
  // A diagnostics remedy addresses a component rather than a pane (SPEC-034 R-24). The
  // component declares its owner, so resolve it from there — recipe weights carry no engine
  // field because their id is derived from the catalogue, so they resolve by that instead.
  const askedComponent = searchParams.get("component");
  const askedEntry = askedComponent === null ? null : (all.find((c) => c.id === askedComponent) ?? null);
  // A component that provides a model IS that model, and its controls are on AI models now
  // (SPEC-042 R-21): a remedy landing here would open a pane without the control it names.
  const providedModel =
    askedComponent === null
      ? null
      : (askedEntry?.provides?.[0] ?? comfyUiWeightsRecipeId(askedComponent) ?? null);
  const owning =
    askedComponent === null ? null : (askedEntry?.provider ?? askedEntry?.engine ?? null);
  const current =
    (asked !== null && rows.some((r) => r.id === asked) ? asked : null) ??
    (owning !== null && rows.some((r) => r.id === owning) ? owning : null) ??
    firstConnected ??
    rows[0]!.id;
  const currentRow = rows.find((r) => r.id === current) ?? rows[0]!;
  if (providedModel !== null && asked === null) {
    return <Navigate to={`/settings/models?model=${encodeURIComponent(providedModel)}`} replace />;
  }

  const column = (rowsOf: Row[]) =>
    rowsOf.map((r) => (
      <button
        type="button"
        key={r.id}
        role="tab"
        aria-selected={r.id === current}
        className={cx("fy-src", r.id === current && "is-current")}
        onClick={() => setSearchParams({ provider: r.id }, { replace: true })}
      >
        <ProviderMark id={r.id} label={r.label} />
        <span className="fy-src__name">{r.label}</span>
        {r.note !== null && <span className="fy-src__note">{r.note}</span>}
      </button>
    ));

  return (
    <div data-screen="settings-providers" className="fy-cols">
      <div className="fy-cols__list" role="tablist" aria-label="Providers">
        <HalfHeading icon={<Cloud size={14} />}>Services you connect</HalfHeading>
        {column(services)}
        <HalfHeading icon={<Monitor size={14} />}>Engines you run</HalfHeading>
        {column(engines)}
        {column(other)}
      </div>
      <div className="fy-cols__pane">
        {currentRow.kind === "service" ? (
          <ServicePane id={current as ProviderId} />
        ) : currentRow.kind === "other" ? (
          <div className="fy-pane">
            <OtherComponentsDetail components={unowned} />
          </div>
        ) : (
          <EnginePane engine={current as EngineId} supporting={supporting(current as EngineId)} />
        )}
      </div>
    </div>
  );
}

/** The engine's capability words, for callers outside this file that head a pane by engine. */
export { engineCapabilityWords, LinkMark };
