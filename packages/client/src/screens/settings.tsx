// Settings: its layout and the screens the shell held (issue 2816).
import {
  Key, Sparkle, Shield, Sliders, Wifi, Cpu, Palette, Bell, User, Book, ChartLine, Info,
  ChevronRight, X, ChevronDown, Pencil, RotateCcw,
} from "../components/icons.js";
import { useMediaQuery } from "../lib/media-query.js";
import { Navigate, useNavigate, useLocation, Outlet, NavLink, useSearchParams } from "react-router";
import {
  useStore, refreshVendorAuth, listHarnessModels, submitVendorKey, beginVendorSignIn,
  submitVendorSignInCode, cancelVendorSignIn, removeVendorConnection, setBackgroundNotifications,
  detectHarnesses, setResearchWeb, setImageInspection, setWorldImageInspection,
  chooseCodexExecutable, chooseClaudeExecutable, clearCodexExecutable, clearClaudeExecutable,
  setHarnessEngine, setRoutingDefault, setNarrator, type ReadingVoice, useSampleWorld,
  refreshSampleWorldDownload, cancelSampleWorldDownload, installSampleWorld,
  discardSampleWorldDownload, useUpdateStatus, useDiagnosticsBundle, downloadUpdate,
  installUpdateAndRestart, installUpdateOnClose, checkUpdates, openDataFolder, generateDiagnostics,
} from "../lib/store.js";
import { settingsReturnPath } from "../lib/settings-return.js";
import { useThemePreference, type ThemePreference, setThemePreference } from "../lib/theme.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { PageSheet } from "../components/page-sheet.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { cx, IconButton, Input, Select, Button, Textarea } from "../components/ui.js";
import { WaitingForCoordinator } from "./shell.js";
import { useEffect, useState } from "react";
import { FactRow } from "./settings-providers.js";
import { OnYourPC } from "../components/on-your-pc.js";
import {
  type VendorIntegration, type VendorSignIn, type VendorAuthMethod, OPENCODE_AVAILABILITY,
  type HarnessAvailability, type HarnessEngine, type ComponentHealth, type Capability,
  supportsVoiceUse, narratorAppliesTo, DEFAULT_NARRATOR, legacyVoiceModel,
  PROVIDERS as PROVIDER_TABLE, readerName, readerPriceLabel, modelEligible,
} from "@arke-studio/contracts";
import { DeviceNotifications } from "../components/device-notifications.js";
import { AgentsPanel } from "./agents.js";
import {
  TONE_CLASS, RuntimeHead, RuntimeSection, CAPABILITY_ROWS, CAPABILITY_LABEL, ActionButton,
  HalfHeading,
} from "./settings-parts.js";
import { ProviderMark } from "../components/provider-mark.js";
import { eligibilityInputs } from "../components/dispatch-bar.js";
import { modelFacts } from "../components/models-card.js";
import { PromptToolsSetting } from "../components/prompt-tools.js";
import { VoicePickerDialog } from "../components/voice-picker.js";

// ---- Settings --------------------------------------------------------------

const SETTINGS_SECTIONS = [
  ["providers", "Providers", Key], ["models", "AI models", Sparkle], ["adapters", "Content & safety", Shield],
  ["general", "General", Sliders], ["remote-access", "Remote access", Wifi], ["harness", "Harness", Cpu],
  ["appearance", "Appearance", Palette], ["notifications", "Notifications", Bell], ["sign-in", "Sign-in", User],
  ["sample-world", "Sample world", Book], ["diagnostics", "Diagnostics", ChartLine], ["about", "About", Info],
] as const;
export function SettingsIndex() {
  return useMediaQuery("(max-width: 599px)") ? null : <Navigate to="providers" replace />;
}
export function SettingsLayout() {
  const { connection, state } = useStore();
  const navigate = useNavigate();
  // Leaving is one act whichever way the sheet closes — Escape, the scrim, the X — and it goes
  // to the route the gear remembered (SPEC-042 R-6), which is the screen already showing behind
  // the sheet: a change of address, not of screen.
  const leave = () => navigate(settingsReturnPath());
  const phone = useMediaQuery("(max-width: 599px)");
  const compact = useMediaQuery("(max-width: 1099px)");
  const { pathname, search } = useLocation();
  const slug = pathname.split("/")[2];
  const section = SETTINGS_SECTIONS.find(([id]) => id === slug);
  const providerDetail = slug === "providers" && ["provider", "component"].some(key => new URLSearchParams(search).has(key));
  const theme = useThemePreference();
  const summary = (id: string): string => {
    if (id === "providers") return `${state?.app.providers.filter(p => p.configured).length ?? 0} connected`;
    if (id === "models") return "images, video, voice, music";
    if (id === "adapters") return state?.app.adapters?.adultContent.enabled ? "enabled" : "standard";
    if (id === "general") return "defaults for new work";
    if (id === "remote-access") return isRemoteSession() ? "this device is paired" : "pairing and devices";
    if (id === "harness") return state?.app.health.harness.status === "healthy" ? "running" : "unavailable";
    if (id === "appearance") return theme;
    if (id === "notifications") return isRemoteSession() ? "on this device" : "background notifications";
    if (id === "sign-in") return isRemoteSession() ? "on your PC" : "vendor connections";
    if (id === "about") return `v${state?.app.version ?? "—"}`;
    return id === "diagnostics" ? "studio health" : "a world to explore";
  };
  if (phone) return <PageSheet open onClose={leave} title={section?.[1] ?? (slug === "downloads" ? "Downloads" : "Settings")} className="fy-settings-phone"
    resetKey={pathname + search}
    footer={<span>{slug === "general" ? "new work only" : slug === "remote-access" && isRemoteSession() ? "connected through your PC" : `Arke Studio ${state?.app.version ?? "—"}${isRemoteSession() ? " · remote" : ""}`}</span>}
    {...(slug ? { onBack: () => navigate(providerDetail || slug === "downloads" ? "/settings/providers" : "/settings") } : {})}>
    <div className="fy-settings-phone__content" data-screen="settings">
      {slug ? <Outlet /> : <nav className="fy-settings-sections" aria-label="Settings sections">{SETTINGS_SECTIONS.map(([id, label, Glyph]) =>
        <NavLink key={id} to={`/settings/${id}`}><Glyph size={20} /><span><strong>{label}</strong><small>{summary(id)}</small></span><ChevronRight size={18} /></NavLink>)}</nav>}
    </div>
  </PageSheet>;
  return (
    /* A sheet, not a page (design turn 150; SPEC-042 R-5 amended). The page of turn 124 answered
       a panel whose close went to /worlds from wherever it was opened; R-6 fixed that by
       remembering the route, and with the remembered route rendering behind the sheet the modal
       keeps the one promise it makes. The editor's sheet (SPEC-039 R-5) at 95% of the window,
       with no head of its own — the rail says what it is — and the X as its one added control. */
    <EditorDialog open onClose={leave} width="95vw" height="95dvh" labelledBy="fy-settings-title" panelClassName="fy-settings__sheet">
      <div className="fy-settings" data-screen="settings">
        <nav className="fy-settings__rail" aria-label="Settings panes">
          <div className="fy-settings__title" id="fy-settings-title">Settings</div>
          {SETTINGS_SECTIONS.map(([slug, label, Glyph]) => (
            <NavLink key={slug} to={`/settings/${slug}`} className={({ isActive }) => cx("fy-settings__tab", isActive && "fy-settings__tab--active")}>
              {compact && <Glyph size={16} />}{label}
            </NavLink>
          ))}
          <div style={{ flex: 1 }} />
          {/* Bare, as the rail is drawn (turns 125, 149, 150; issue 1216): the `v` is the release
              tag's and stays on About and the update dialog, where the tag is what is named. */}
          <div className="fy-settings__version">{state?.app.version ?? (typeof window === "undefined" ? undefined : window.arke?.appVersion) ?? "—"}</div>
        </nav>
        <div className="fy-settings__pane">
          {/* Most panes in here draw from the coordinator's snapshot, and with no snapshot they
              draw the same thing they draw when a provider has nothing to offer: `—` in the
              capability rows, `not measured` in the machine header. A dev coordinator that died
              at import produces exactly that screen, which reads as a data bug in whatever you
              last changed (issue 599). */}
          {(connection === "closed" || connection === "auth-refused") && (
            <div className="fy-settings__waiting">
              <WaitingForCoordinator />
            </div>
          )}
          <Outlet />
        </div>
        <IconButton label="Close" className="fy-settings__close" onClick={leave}>
          <X size={13} />
        </IconButton>
      </div>
    </EditorDialog>
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
  if (isRemoteSession()) return <div data-screen="settings-signin" className="fy-set"><h1 className="fy-pane__name">Sign-in</h1>
    {(auth?.vendors ?? []).map(v => <FactRow key={v.id} what={v.name}>{v.connections.some(c => c.kind === "stored") ? "connected" : "not connected"}</FactRow>)}
    <OnYourPC>keys and sign-ins</OnYourPC></div>;
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
      {/* Most people have one account: the rest wait under a line, unless one is mid sign-in. */}
      {(() => {
        const row = (vendor: (typeof auth.vendors)[number]) => (
          <VendorSignInRow
            key={vendor.id}
            vendor={vendor}
            signIn={auth.signIn}
            linked={auth.carry === "linked"}
            usedForAuthoring={authoringProviders.has(vendor.id)}
          />
        );
        const inUse = auth.vendors.filter((vendor) => vendor.needsSignIn || vendor.connections.length > 0 || auth.signIn?.vendor === vendor.id);
        const others = auth.vendors.filter((vendor) => !inUse.includes(vendor));
        if (inUse.length === 0 || others.length === 0) return auth.vendors.map(row);
        return <>{inUse.map(row)}<details className="fy-set__others"><summary>Other services · {others.length}</summary>{others.map(row)}</details></>;
      })()}
      {auth.carryDetail !== null && <div className="fy-set__note">{auth.carryDetail}</div>}
    </div>
  );
}

/**
 * One vendor: its state, its connections, and every method the harness reports, offered at
 * once (R-9). A method with form fields opens them inline; equality-gated fields follow the
 * answers, which is all the measured builds express.
 */
export function VendorSignInRow({
  vendor,
  signIn,
  linked,
  usedForAuthoring,
  setup = false,
}: {
  vendor: VendorIntegration;
  signIn: VendorSignIn | null;
  linked: boolean;
  usedForAuthoring: boolean;
  setup?: boolean;
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
          {!setup && stored.map((connection) =>
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
                <Select
                  key={field.key}
                  label={field.title}
                  value={answers[field.key] ?? ""}
                  onChange={(e) => setAnswers({ ...answers, [field.key]: e.target.value })}
                >
                  <option value="">{field.title}</option>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
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
  if (isRemoteSession()) return <div data-screen="settings-notifications" className="fy-set"><DeviceNotifications /></div>;
  return (
    <div data-screen="settings-notifications" className="fy-set">
      <div className="fy-set__eyebrow">BACKGROUND NOTIFICATIONS</div>
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">When Arke Studio is in the background</div>
          <div className="fy-set__caps">Windows notifications open Activity when clicked</div>
        </div>
        {/* The house control, not the platform's (issue 1010, U2). */}
        <Select
          label="Background notifications"
          value={preference}
          onChange={(event) =>
            setBackgroundNotifications(event.target.value as typeof preference)
          }
        >
          <option value="background-results-and-issues">Results and issues</option>
          <option value="issues-only">Issues only</option>
          <option value="off">Off</option>
        </Select>
      </div>
    </div>
  );
}

const APPEARANCE_OPTIONS: Array<{ preference: ThemePreference; title: string }> = [
  { preference: "dark", title: "Dark" },
  { preference: "light", title: "Light" },
  { preference: "system", title: "System" },
];

export function SettingsAppearanceScreen() {
  const preference = useThemePreference();
  return (
    <div data-screen="settings-appearance" className="fy-set fy-set--appearance">
      <div className="fy-set__eyebrow">APPEARANCE</div>
      <div className="fy-appearance__theme">
        <div className="fy-appearance__copy">
          <h2 className="fy-appearance__title">Theme</h2>

        </div>
        <fieldset className="fy-theme-options">
          <legend className="fy-sr-only">Theme</legend>
          {APPEARANCE_OPTIONS.map((option) => (
            <label key={option.preference} className="fy-theme-option">
              <input
                className="fy-sr-only"
                type="radio"
                name="appearance-theme"
                value={option.preference}
                checked={preference === option.preference}
                onChange={() => setThemePreference(option.preference)}
              />
              <span>{option.title}</span>
            </label>
          ))}
        </fieldset>
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
  const { state, connection } = useStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const harness = state?.app.harness ?? null;
  const researchOn = state?.app.research.web === true;
  const hasSnapshot = state !== null;

  useEffect(() => {
    // A file page can mount before the transport opens. Its first discovery request would be
    // dropped, so wait for the snapshot and ask again when an unfinished connection recovers.
    if (connection === "open" && hasSnapshot && harness === null) detectHarnesses();
  }, [connection, hasSnapshot, harness]);

  const harnesses = harness?.harnesses ?? [OPENCODE_AVAILABILITY];
  const engine = harness?.engine ?? "opencode";
  const generation = state?.app.harnessInfo?.generation;
  const runningEngine = generation === "claude" || generation === "codex"
    ? generation
    : generation === "v2" ? "opencode" : harness?.launchEngine ?? null;
  const harnessHealth = state?.app.health.harness;
  const activeStatus = harnessHealth?.status === "healthy" ? "running now"
    : harnessHealth?.status === "starting" ? "starting" : "unavailable";
  const asked = searchParams.get("harness");
  const current = harnesses.some((h) => h.id === asked) ? asked! : (harnesses.find((h) => h.id === engine) ?? harnesses[0]!).id;
  const chosen = harnesses.find((h) => h.id === current) ?? harnesses[0]!;

  const [agentsOpen, setAgentsOpen] = useState(false);
  const requestedAgent = searchParams.get("agent");
  const focusAgent = state?.app.agents.some(agent => agent.name === requestedAgent) ? requestedAgent! : undefined;
  useEffect(() => {
    if (focusAgent !== undefined) setAgentsOpen(true);
  }, [focusAgent]);
  if (isRemoteSession()) return <div data-screen="settings-harness" className="fy-set"><h1 className="fy-pane__name">Harness</h1>
    <FactRow what="Engine">{harnesses.find(h => h.id === runningEngine)?.label ?? "—"} · {activeStatus}</FactRow>
    <OnYourPC>harness and executables</OnYourPC>
    <div className="fy-set__row"><span className="fy-set__name--wide">Search online</span><button type="button" role="switch" aria-label="Search online" aria-checked={researchOn} className={cx("fy-prov__switch", researchOn && "is-on")} onClick={() => setResearchWeb(!researchOn)}><span /></button></div>
    <AgentsPanel {...(focusAgent ? { focusAgent } : {})} />
  </div>;
  if (!hasSnapshot) return (
    <div data-screen="settings-harness" className="fy-set fy-set--runtime">
      {(connection !== "closed" && connection !== "auth-refused") && <WaitingForCoordinator />}
    </div>
  );
  return (
    <div data-screen="settings-harness" className="fy-set fy-set--runtime">
      <div className="fy-rt">
        <div className="fy-rt__rail" role="tablist" aria-label="Harnesses">
          {harness !== null && harnesses.map((h) => (
            <button
              type="button"
              key={h.id}
              role="tab"
              aria-selected={h.id === current}
              className={cx("fy-rt__railitem", h.id === current && "is-current")}
              onClick={() => setSearchParams({ harness: h.id }, { replace: true })}
            >
              <span className={cx("fy-set__dot", TONE_CLASS[h.id === runningEngine && activeStatus === "running now" ? "ok" : h.installed ? "idle" : "warn"])} />
              <span>{h.label}</span>
              <span style={{ flex: 1 }} />
              <span className="fy-rt__count">
                {h.id === runningEngine ? activeStatus : h.blocked ? (h.bundled ? "unavailable" : h.version !== null || h.source !== null ? "needs attention" : "not here") : h.id === engine ? "next restart" : h.installed ? "available" : "not here"}
              </span>
            </button>
          ))}
        </div>
        <div className="fy-rt__pane">
          {harness === null && (
            <div className="fy-set__note" role="status">
              {connection === "open" && hasSnapshot ? "Detecting available harnesses…" : "Connecting to detect available harnesses…"}
              <Button disabled={connection !== "open"} onClick={() => detectHarnesses()}>Check again</Button>
            </div>
          )}
          {harness !== null && <HarnessPane
            harness={chosen}
            engine={engine}
            runningEngine={runningEngine}
            health={harnessHealth}
            detected={harness !== null}
            canDetect={connection === "open" && hasSnapshot}
            executablePath={chosen.id === "codex" ? harness?.codexPath ?? null : harness?.claudePath ?? null}
          />}
          {harness?.launchOverride && (
            <div className="fy-set__note" role="status">
              ARKE_HARNESS selects {harnesses.find(h => h.id === harness.launchOverride)?.label ?? harness.launchOverride} at launch.
              {" "}Clear the override to use the saved engine.
            </div>
          )}
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
          <div className="fy-rt__research">
            <button
              type="button"
              role="switch"
              aria-checked={state?.app.imageInspection?.cloud !== false}
              aria-label="Allow cloud image inspection"
              className={cx("fy-prov__switch", state?.app.imageInspection?.cloud !== false && "is-on")}
              onClick={() => setImageInspection(state?.app.imageInspection?.cloud === false)}
            >
              <span />
            </button>
            <div><strong>Allow cloud image inspection</strong></div>
          </div>
          {/* The switch answers it for most people: the rest fold, and only matter while it is on (issue 2467). */}
          {state?.app.imageInspection?.cloud !== false && <details><summary className="fy-set__link">By world and provider</summary>
          <p>When Arke inspects an image, the conversation names the images that may be shared with the selected provider. Local inspection stays on this device.</p>
          {state?.world && <div className="fy-set__row"><label><input type="checkbox"
            checked={state.world.meta.cloudImageInspection !== false}
            onChange={event => setWorldImageInspection(state.world!.meta.worldId, event.target.checked)} /> Allow cloud image inspection for this world</label></div>}
          {[...new Set(["anthropic", "openai", ...(state?.app.harnessModels ?? []).map(model => model.provider),
            ...Object.keys(state?.app.imageInspection?.providers ?? {})])].map(provider => <div className="fy-set__row" key={provider}><label><input type="checkbox"
            checked={state?.app.imageInspection?.providers[provider] !== false}
            onChange={event => setImageInspection(event.target.checked, provider)} /> Allow cloud image inspection by {provider === "anthropic" ? "Anthropic" : provider === "openai" ? "OpenAI" : provider === "ollama" ? "Ollama on another device" : provider}</label></div>)}
          </details>}
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
          {agentsOpen && <AgentsPanel focusAgent={focusAgent} />}
        </div>
      </div>
    </div>
  );
}

function HarnessPane({
  harness,
  engine,
  runningEngine,
  health,
  detected,
  canDetect,
  executablePath,
}: {
  harness: HarnessAvailability;
  engine: HarnessEngine;
  runningEngine: HarnessEngine | null;
  health?: ComponentHealth;
  detected: boolean;
  canDetect: boolean;
  executablePath: string | null;
}) {
  const selected = harness.id === engine;
  const active = harness.id === runningEngine;
  const running = active && health?.status === "healthy";
  const chooseExecutable = harness.id === "codex" ? chooseCodexExecutable : chooseClaudeExecutable;
  const clearExecutable = harness.id === "codex" ? clearCodexExecutable : clearClaudeExecutable;
  return (
    <>
      <RuntimeHead
        title={harness.label}
        caps={harness.bundled ? "BUNDLED" : "YOUR INSTALLATION"}
        tone={active && !running && health?.status !== "starting" ? "warn" : running ? "ok" : harness.installed ? "idle" : "warn"}
        state={active ? running ? "running now" : health?.status === "starting" ? "starting" : "unavailable" : harness.blocked ? (harness.bundled ? "unavailable" : harness.version !== null || harness.source !== null ? "needs attention" : "not here") : selected ? "next restart" : harness.installed ? "available" : "not here"}
      />
      <RuntimeSection label="ON THIS MACHINE" />
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">{harness.bundled ? "Ships with Arke Studio" : harness.installed || harness.version !== null || harness.source !== null ? "Found on this machine" : "Not found on this machine"}</div>
          <div className="fy-set__caps">
            {/* The refusal, in the words the coordinator sent — not a re-derived summary. */}
            {harness.blocked ?? (harness.version ? `version ${harness.version}` : "installed")}
          </div>
        </div>
        <Button variant="ghost" disabled={!canDetect} onClick={() => detectHarnesses()}>
          Check again
        </Button>
      </div>
      {!harness.bundled && (
        <>
          <RuntimeSection label="WHERE IT IS" />
          <div className="fy-set__row">
            <div className="fy-set__name fy-set__name--wide">
              <div className="fy-set__title">
                {executablePath ?? (harness.source === "path" ? "Found on the system path" : "No file chosen")}
              </div>
              <div className="fy-set__caps">
                {executablePath
                  ? harness.installed
                    ? "used when this harness starts"
                    : "this file did not answer"
                  : "choose a file if Arke Studio cannot find yours"}
              </div>
            </div>
            {executablePath && (
              <Button variant="ghost" onClick={() => clearExecutable()}>
                Clear
              </Button>
            )}
            <Button variant="secondary" onClick={() => chooseExecutable()}>
              Choose…
            </Button>
          </div>
        </>
      )}
      <RuntimeSection label="USE FOR AUTHORING" />
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">
            {active && !running ? health?.status === "starting" ? "Starting harness" : "Harness unavailable" : selected ? active ? "Runs the authoring work" : "Selected for the next restart" : running ? "Running until restart" : harness.installed ? "Available for authoring" : "Not available for authoring"}
          </div>
          <div className="fy-set__caps">
            {active && !running
              ? health?.reason ?? (health?.status === "starting" ? "starting the harness" : "the harness is unavailable")
              : selected
              ? running ? "new sessions use this harness" : "restart Arke Studio to switch"
              : harness.installed
                ? "switching takes effect on the next restart"
                : harness.bundled ? "unavailable for now" : "unavailable until it is installed"}
          </div>
        </div>
        <Button
          variant={selected ? "secondary" : "primary"}
          disabled={selected || !harness.installed || !detected}
          onClick={() => setHarnessEngine(harness.id)}
        >
          {selected ? "Selected" : "Use this"}
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
 * Settings · General (SPEC-034 R-14, design turn 149). Which model runs each capability by
 * default, and who reads the app's prose aloud.
 *
 * It was Cloud AI, and before that *Who does what*. What changed with the rename is the thing the
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
 * **One row grammar, borrowed whole from Providers** (turn 149): a label, its value, its state at
 * the row's gap, and on the narrator's row alone a button at the end. Turn 124 put the state
 * *under* a select stretched to the column, which is the caption turn 137 forbade everywhere
 * else, and the page had grown three row shapes under one eyebrow. The state now sits beside a
 * 300px control, says three words at most, and never repeats the provider — that is the first
 * word in the control. A default that cannot run is stated on its row, in the warning colour,
 * and nowhere else: the callout that said the same fault above the list is gone.
 *
 * Providers keeps its job unchanged. This screen **references** a provider and never configures
 * one: the remedy for a missing credential is on AI models' supplier heading (SPEC-042 R-4), and
 * the rail is the route — nothing on a row navigates.
 */
export function SettingsGeneralScreen() {
  const phone = useMediaQuery("(max-width: 599px)");
  const { state } = useStore();
  const stored = state?.app.narrator ?? null;
  const worldIdForVoices = state?.world?.meta.worldId;
  // A cloned narrator is its own world's (SPEC-046 R-37): elsewhere, and with no world open, the
  // row names the shipped voice that reads there rather than a recording this world lacks.
  const narrator = stored && supportsVoiceUse(stored, "narration") && narratorAppliesTo(stored, worldIdForVoices) ? stored : null;
  const [narratorOpen, setNarratorOpen] = useState(false);
  // Reset takes a second press (2026-10-02): on a phone it sat alone at the row's end, and one
  // stray tap cleared a chosen narrator with nothing to say it had. The first press asks; the
  // question lapses on its own.
  const [resetArmed, setResetArmed] = useState(false);
  useEffect(() => {
    if (!resetArmed) return;
    const lapse = setTimeout(() => setResetArmed(false), 4000);
    return () => clearTimeout(lapse);
  }, [resetArmed]);
  // The question is about the narrator it was asked over: opening the picker or a new choice
  // withdraws it, so the next press asks again rather than clearing the new voice.
  useEffect(() => setResetArmed(false), [narratorOpen, narrator?.provider, narrator?.voiceId]);
  const navigate = useNavigate();
  const manifest = state?.app.manifest ?? null;
  const routing = state?.app.routing ?? { defaults: {}, faults: [] };
  const drift = state?.app.drift ?? [];
  const eligibility = eligibilityInputs(state);
  // The state cell's words, shared with the Models card so the two never disagree (turn 153).
  const { strandState, sourceOf, runsOn } = modelFacts(state);
  const warn = (words: string) => (
    <span className="fy-fact__state fy-fact__state--warn">
      <span className="fy-set__dot fy-set__dot--warn" aria-hidden="true" />
      {words}
    </span>
  );

  // Who reads the app's prose aloud. A third role: a character's voice lives on their sheet, a
  // reading voice belongs to one bench take, and this one narrates. It stays on the shipped local
  // voice unless somebody chooses otherwise, because "read aloud" is a passive press and no other
  // preference here spends money on one. The row says the reader and its price the way the Voice
  // page's rows do (SPEC-046 R-30) — `Kokoro · free`, `Voxtral · $0.016 per 1k` — and nothing
  // more: the price is the whole warning.
  const reader = narrator === null
    ? { provider: DEFAULT_NARRATOR.provider as string, model: DEFAULT_NARRATOR.model as string | null }
    : { provider: narrator.provider, model: narrator.model ?? legacyVoiceModel(narrator.provider, narrator.voiceId) };
  const readerRow =
    (manifest?.models ?? []).find((m) => m.provider === reader.provider && m.id === reader.model && m.capability === "voice-tts") ?? null;
  const readerLocal = (PROVIDER_TABLE as Record<string, { local?: boolean } | undefined>)[reader.provider]?.local === true;
  const readerChip = [readerName(reader, readerRow), readerPriceLabel(readerRow) ?? (readerLocal ? "free" : null)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div data-screen="settings-general" className="fy-set fy-set--general">
      <h1 className="fy-pane__name">General</h1>
      {!isRemoteSession() && <FactRow what="Studio setup"><button type="button" className="fy-fact__link" onClick={() => navigate(state?.app.onboarding?.plan.step === "done" ? "/settings/models" : "/setup")}>{state?.app.onboarding?.plan.step === "done" ? "Manage AI models & tools" : "Set up an AI writing agent & tools"}</button></FactRow>}
      <FactRow what="Production tools"><PromptToolsSetting /></FactRow>
      {ROUTED_CAPABILITIES.map((capability) => {
        const candidates = (manifest?.models ?? []).filter((m) => m.capability === capability && m.upscale === undefined);
        const usable = (m: (typeof candidates)[number]) =>
          (capability !== "voice-tts" || supportsVoiceUse(m, "preview")) && modelEligible(m, eligibility);
        // Speech setup failures belong on AI models, where the full reason and repair live.
        // Keep identity separate from availability: native option text also sizes the control.
        const options = candidates.filter((m) => capability !== "voice-tts" || usable(m));
        const selected = routing.defaults[capability];
        const selectedModel = candidates.find((m) => m.id === selected);
        const stranded = selectedModel !== undefined && !usable(selectedModel);
        const hiddenSelection = capability === "voice-tts" && (stranded || (selected !== undefined && selectedModel === undefined));
        // A stored default whose model left the manifest (SPEC-008 §2.7). Listed under its own id
        // so the control shows what is stored rather than the first option it happens to hold.
        const missing = selected !== undefined && selectedModel === undefined;
        const source = selectedModel === undefined ? undefined : sourceOf(selectedModel);
        return (
          <FactRow key={capability} what={CAPABILITY_LABEL[capability]}>
            <Select
              wrapClassName="fy-default"
              label={`Model for ${CAPABILITY_LABEL[capability]}`}
              disabled={options.length === 0}
              value={selected ?? ""}
              onChange={(e) => setRoutingDefault(capability, e.target.value)}
              {...(source === undefined ? {} : { mark: <ProviderMark id={source.id} label={source.label} size="xs" /> })}
            >
              {options.length === 0 && !hiddenSelection && <option value="" disabled>No models</option>}
              {selected === undefined && options.length > 0 && <option value="" disabled>Not set</option>}
              {/* Retain a saved default without offering it again or silently picking a replacement. */}
              {hiddenSelection && <option value={selected} disabled hidden>
                {selectedModel ? `${sourceOf(selectedModel).label} · ${selectedModel.displayName}` : selected}
              </option>}
              {missing && !hiddenSelection && <option value={selected} disabled>{selected}</option>}
              {[...options]
                .sort((a, b) => Number(usable(b)) - Number(usable(a)))
                .map((m) => (
                  <option key={m.id} value={m.id} disabled={!usable(m)}>
                    {sourceOf(m).label} · {m.displayName}
                  </option>
                ))}
            </Select>
            {/* The provider is the control's first word, so the state is what R-16a asks for
                after it: where the model runs, or what its credential is doing. Displayed rather
                than re-derived (R-63). */}
            {selectedModel && !stranded && runsOn(selectedModel) !== "not tested" && <span className="fy-fact__state">{runsOn(selectedModel)}</span>}
            {selectedModel && stranded && warn(capability === "voice-tts" && !supportsVoiceUse(selectedModel, "preview") ? "reader unavailable" : strandState(selectedModel))}
            {missing && warn("not in the manifest")}
          </FactRow>
        );
      })}
      {/* Its label and the route, with no picker and no sentence (R-17): the absence of a control
          is what says the choice is not made here. */}
      {!phone && <FactRow what={CAPABILITY_LABEL.llm}>
        <button type="button" className="fy-fact__link" onClick={() => navigate("/settings/harness")}>
          Set in Harness
        </button>
      </FactRow>}
      <FactRow
        what="Narrator"
        does={
          <>
            {!phone && <ActionButton icon={<Pencil size={13} />} onClick={() => setNarratorOpen(true)}>
              Change
            </ActionButton>}
            {narrator !== null && (
              <ActionButton
                icon={<RotateCcw size={13} />}
                hint={`${DEFAULT_NARRATOR.label} · Kokoro · free`}
                testId="narrator-reset"
                onClick={() => {
                  if (!resetArmed) {
                    setResetArmed(true);
                    return;
                  }
                  setResetArmed(false);
                  setNarrator(null);
                }}
              >
                {resetArmed ? `Reset to ${DEFAULT_NARRATOR.label}?` : "Reset"}
              </ActionButton>
            )}
          </>
        }
      >
        {phone ? <button type="button" className="fy-narrator-default" aria-label="Change narrator" data-testid="narrator-change" onClick={() => setNarratorOpen(true)}><span>{narrator === null ? DEFAULT_NARRATOR.label : (narrator.label ?? narrator.voiceId)} · {narrator ? (PROVIDER_TABLE[narrator.provider as keyof typeof PROVIDER_TABLE]?.displayName ?? narrator.provider) : "Kokoro"}</span><ChevronDown size={14} /></button> : <span data-testid="narrator-name">{narrator === null ? DEFAULT_NARRATOR.label : (narrator.label ?? narrator.voiceId)}</span>}
        <span className="fy-fact__state">{readerChip}</span>
      </FactRow>
      {phone && <FactRow what={CAPABILITY_LABEL.llm}>
        <button type="button" className="fy-fact__link" onClick={() => navigate("/settings/harness")}>
          Set in Harness
        </button>
      </FactRow>}
      <VoicePickerDialog
        open={narratorOpen}
        use="narration"
        {...(worldIdForVoices !== undefined ? { worldId: worldIdForVoices } : {})}
        chosenId={narrator?.voiceId ?? DEFAULT_NARRATOR.voiceId}
        chosenProvider={narrator?.provider ?? DEFAULT_NARRATOR.provider}
        chosenModel={
          narrator?.model ??
          (narrator ? legacyVoiceModel(narrator.provider, narrator.voiceId) ?? undefined : DEFAULT_NARRATOR.model)
        }
        onClose={() => setNarratorOpen(false)}
        onPick={(voice: ReadingVoice) => {
          setNarratorOpen(false);
          setNarrator({ provider: voice.provider, model: voice.model, voiceId: voice.voiceId, label: voice.label });
        }}
      />
      {drift.length > 0 && (
        <>
          <HalfHeading icon={<ChartLine size={14} />} aside={`${drift.length} model${drift.length === 1 ? "" : "s"}`}>
            Manifest drift
          </HalfHeading>
          {drift.map((d) => (
            <FactRow key={d.modelId} what={d.modelId}>
              <span>
                {PROVIDER_TABLE[d.provider].displayName} · {d.samples} reported charges
              </span>
              {warn(`estimates off by ~${(d.medianDivergencePerMille / 10).toFixed(0)}%`)}
            </FactRow>
          ))}
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
  const download = sample?.download;
  const retained = download?.retainedBytes ?? 0;
  const lowSpace = download?.freeBytes != null && download.requiredBytes != null && download.freeBytes < download.requiredBytes;
  const space = (bytes: number) => `${(bytes / 1073741824).toFixed(2)} GiB`;
  useEffect(() => { if (!isRemoteSession()) refreshSampleWorldDownload(); }, []);
  return (
    <div data-screen="settings-sample-world" className="fy-set">
      <div className="fy-set__eyebrow">SAMPLE WORLD</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 14 }}>
        <span className="fy-set__aboutname">The Undersong</span>
        <span className="fy-set__aboutmeta">coastal fantasy · quiet dread</span>
      </div>
      <div className="fy-set__aboutline">A harbour, its records, and the cost of calling it back.</div>
      {sample?.download && <div className="fy-set__why" style={{ marginTop: 14, maxWidth: 720 }}>
        <div><p>{sample.download.summary}</p><p>Release {sample.download.version} · {(sample.download.bytes / 1048576).toFixed(0)} MiB download. Internet required. Installs an editable copy in your library; existing worlds are never replaced.</p></div>
      </div>}

      <div className="fy-set__row" style={{ marginTop: 14 }}>
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">{sample?.download ? "Download a copy" : "Install a copy"}</div>
          <div className="fy-set__caps">
            {available ? sample?.download ? "Novel illustrated · audiobook and video unfinished" : "cast · canon · a production · a proposal" : "not available in this build"}
          </div>
        </div>
        {available && (isRemoteSession() ? <OnYourPC>download and install the story</OnYourPC> : installing && sample?.cancellable ? (
          <Button variant="ghost" onClick={() => cancelSampleWorldDownload()}>Cancel download</Button>
        ) : (
          <Button variant="primary" disabled={installing || lowSpace} onClick={() => installSampleWorld()}>
            {installing ? "Finishing…" : retained ? "Resume and install" : download ? "Download and install" : "Install"}
          </Button>
        ))}
      </div>

      {download && <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">Disk space</div>
          <div className="fy-set__aboutline">{download.requiredBytes == null ? "Checking space…" : `${space(download.requiredBytes)} free needed · ${download.freeBytes == null ? "available space unknown" : `${space(download.freeBytes)} available`}`}</div>
          {lowSpace && <div className="fy-set__aboutline">Free up space before downloading.</div>}
        </div>
        {!isRemoteSession() && <Button variant="ghost" disabled={installing} onClick={() => refreshSampleWorldDownload()}>Check space</Button>}
      </div>}
      {(download?.hasRetainedData || retained > 0) && !installing && <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">Saved download</div>
          <div className="fy-set__aboutline">{retained ? `${space(retained)} kept for this release. Checked again before installation.` : "Saved data cannot be resumed. Remove it to start again."}</div>
        </div>
        {!isRemoteSession() && <Button variant="ghost" onClick={() => discardSampleWorldDownload()}>Remove downloaded data</Button>}
      </div>}

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
        </div>
        {update?.status === "available" && (isRemoteSession() ? <OnYourPC>download and install updates</OnYourPC> :
          <Button variant="primary" onClick={() => downloadUpdate()}>
            Download
          </Button>
        )}
        {update?.status === "ready" && (isRemoteSession() ? <OnYourPC>install and restart</OnYourPC> :
          <>
            <Button variant="primary" onClick={() => installUpdateAndRestart()}>
              Install and restart
            </Button>
            <button type="button" className="fy-set__link" title="Install on close without reopening Arke Studio" onClick={() => installUpdateOnClose()}>
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
          <div className="fy-set__caps">AGPL-3.0 licence · your world stays in files you can read</div>
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
            %USERPROFILE%\ArkeStudio · kept if you uninstall
          </div>
        </div>
        {isRemoteSession() ? <OnYourPC>your data folder</OnYourPC> : <button type="button" className="fy-set__link" onClick={() => openDataFolder()}>Open folder</button>}
      </div>

      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">Diagnostics</div>
          <div className="fy-set__caps">No world content, keys or prompts</div>
        </div>
        {isRemoteSession() ? <OnYourPC>export diagnostics</OnYourPC> : <button type="button" className="fy-set__link" onClick={() => generateDiagnostics()}>Show report</button>}
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
