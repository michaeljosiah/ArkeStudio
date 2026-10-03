import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ComponentHealth } from "@arke-studio/contracts";
import type { StartupState } from "../arke-bridge.js";
import { SetupTransferControl } from "../components/setup-transfer-control.js";
import { ArrowRight, Check, CircleAlert, Cloud, Laptop, LinkOff, Unplug } from "../components/icons.js";
import { reconnectNow, useEnvCheck, useSetup, useStore } from "../lib/store.js";

/**
 * The launch surface (design master turn 158; supersedes 76a, carries 76b and 15a).
 *
 * Every start opens here — each desktop launch, and every new browser session that reaches a
 * studio — and it is the warm-up: the connection, the first snapshot, the setup checks and the
 * world list all run behind it from the first paint, because the store connects at boot, not
 * on a press. So the way in is live at once.
 *
 * Two routes, one surface. `/` is the surface at rest. `/starting` is the same surface after
 * the press: it goes on by itself the moment the studio is ready, and turns into setup only if
 * a runtime part is still to come down. Keeping the press in the route rather than in component
 * state is what lets a render test, which cannot press, draw either side.
 */

/**
 * The owner-supplied creation film and its opening frame (SPEC-001 R-8). Public assets stay
 * plain files, with relative paths because the packaged app opens over file://. The initial
 * 30-second film keeps its supplied resolution; the upscaled master can replace it in place.
 */
const LOOP_POSTER = "./launch-creation.webp";
const LOOP_VIDEO = "./launch-creation.mp4";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The studio's name when this page reached it from another device, otherwise null.
 *
 * In the desktop app, or in a browser on the studio's own machine, the local way really is
 * local and says so. Reached over a tunnel from a phone, "on this device" would be false: the
 * way names the machine it goes to instead. A tailnet name's first label is the machine's name
 * (`michael-desktop.tail1234.ts.net`); an address has no shorter form, so it stays whole.
 */
export function remoteStudio(): string | null {
  if (typeof window === "undefined" || window.arke !== undefined) return null;
  const host = window.location?.hostname ?? "";
  if (host === "" || LOOPBACK.has(host)) return null;
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  return host.split(".")[0] ?? host;
}

/** Has this machine asked for less movement? Server-rendered tests have no matchMedia. */
function stillPreferred(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Has this browser asked to save data? Only Chromium says, which is the browser that matters here. */
function dataSaver(): boolean {
  return typeof navigator !== "undefined" &&
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

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
        : { state: (connection === "closed" || connection === "auth-refused") ? "retrying…" : "starting…", settled: false }),
    },
    {
      label: "Your data folder",
      ...(envChecked ? { state: "checked", settled: true } : { state: "checking…", settled: false }),
    },
    { label: "Authoring (OpenCode)", ...outcome(state?.app.health.harness) },
    { label: "Local voice (Voxa)", ...outcome(state?.app.health.voice) },
  ];
}

function mb(bytes: number, precision = 0): string {
  const m = bytes / (1024 * 1024);
  return m >= 1024 ? `${(m / 1024).toFixed(1)} GB` : `${m.toFixed(precision)} MB`;
}

/** "about 3 min left" — rounded, because a precise wrong number is worse than a vague right one. */
function aboutLeft(seconds: number): string {
  if (seconds < 45) return "under a minute left";
  const mins = Math.round(seconds / 60);
  return mins <= 1 ? "about a minute left" : `about ${mins} min left`;
}

function LaunchArt({ version, remote }: { version: string | null; remote: boolean }) {
  // Muted, looping, no controls. The still whenever motion is not wanted, when the browser is
  // saving data, and on any session reaching the studio from elsewhere: a phone on a tunnel
  // should not pull video before it can show a button.
  const still = remote || stillPreferred() || dataSaver();
  return (
    <div className="fy-launch__art">
      {still ? (
        <img className="fy-launch__media" src={LOOP_POSTER} alt="" aria-hidden />
      ) : (
        <video
          className="fy-launch__media"
          src={LOOP_VIDEO}
          poster={LOOP_POSTER}
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          aria-hidden
        />
      )}
      <div className="fy-launch__tag">
        <p className="fy-launch__tagline">
          <span>Build worlds.</span>
          <span>Tell any story.</span>
        </p>
        <p className="fy-launch__line">Arke Studio lets you create, collaborate and bring your stories to life—anywhere.</p>
      </div>
      {version !== null && <span className="fy-launch__version">v{version}</span>}
    </div>
  );
}

/**
 * The surface's frame: the loop, and the column with the lockup at its head. The pairing gate in
 * front of a remote session (components/remote-entry.tsx) draws its states inside the same frame,
 * so a phone meets one designed first screen rather than a plain card and then this one.
 */
export function LaunchFrame({ children, compact = false, typing = false }: { children: React.ReactNode; compact?: boolean; typing?: boolean }) {
  const { state } = useStore();
  const version =
    state?.app.version ?? (typeof window === "undefined" ? null : window.arke?.appVersion ?? null);
  return (
    <div className={`fy-launch${compact ? " fy-launch--compact" : ""}${typing ? " fy-launch--typing" : ""}`} data-screen="startup">
      <LaunchArt version={version} remote={remoteStudio() !== null} />
      <main className="fy-launch__column">
        <Wordmark />
        {children}
      </main>
    </div>
  );
}

function Wordmark() {
  return (
    <div className="fy-launch__mark">
      <span className="fy-launch__bar" aria-hidden />
      <span className="fy-launch__streak" aria-hidden />
      <span className="fy-launch__flare" aria-hidden />
      <h1 className="fy-launch__wordmark" aria-label="Arke Studio">Arke Studio</h1>
    </div>
  );
}

/** Named, not offered: present at reduced strength, and nothing on it can be pressed. */
export function CloudWay() {
  return (
    <section className="fy-launch__way fy-launch__way--soon">
      <span className="fy-launch__icon" aria-hidden><Cloud size={52} stroke={1.25} /></span>
      <h2 className="fy-launch__title">Cloud Login</h2>
      <span className="fy-launch__soon">Soon</span>
      <p className="fy-launch__body">
        <span className="fy-launch__body--long">Sign in to Arke Studio Cloud<br />to access your worlds anywhere.</span>
        <span className="fy-launch__body--short">Your worlds, anywhere.</span>
      </p>
      <button type="button" className="fy-launch__action fy-launch__action--off" disabled>Coming soon</button>
    </section>
  );
}

export function StartupScreen() {
  const { connection, state } = useStore();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pressed = pathname === "/starting";
  const env = useEnvCheck();
  const setup = useSetup();
  const fetching = setup?.components.some((component) =>
    component.state === "queued" || component.state === "downloading" ||
    component.state === "paused" || component.state === "installing",
  ) === true;
  const [startup, setStartup] = useState<StartupState | null>(() =>
    typeof window === "undefined" ? null : window.arke?.startupState?.() ?? null,
  );
  useEffect(() => window.arke?.onStartupState?.(setStartup), []);

  const desktop = typeof window !== "undefined" && window.arke !== undefined;
  const remote = remoteStudio();

  // The host paints the caption buttons; over this surface they have to be the dark ones in
  // every theme. Released on the way out so the rest of the app gets its own chrome back.
  useEffect(() => {
    window.arke?.chromeOverPlate?.(true);
    return () => window.arke?.chromeOverPlate?.(false);
  }, []);

  // "Not answering" is a latch, not the live status: between retries the socket reads
  // `connecting` again, and a card that flickered between the two would say nothing.
  const [unanswered, setUnanswered] = useState(false);
  useEffect(() => {
    if (connection === "open") setUnanswered(false);
    else if (connection === "closed") setUnanswered(true);
  }, [connection]);

  const ready = connection === "open" && state !== null;
  // Nothing left to fetch and somewhere to go: the only state where the press goes straight in.
  const settled = ready && !fetching;
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

  // Setup happens once. Every start after it detects the runtimes already on this machine and
  // fetches nothing, so the setup panel is kept for the start that is actually doing the work:
  // something queued, downloading, paused or installing.
  const setupRun = fetching;

  const destination = (): string | null => {
    if (!state) return null;
    // A run cut off by closing the app returns to the building screen, continuing (SPEC-031
    // R-33) — before the library, because the author left mid-build and is coming back to it.
    const midBuild = state.app.builds.find((build) => build.status === "running");
    if (midBuild) return `/building/${midBuild.worldId}`;
    return state.worlds.length === 0 ? "/first-run" : "/worlds";
  };

  // After the press, the surface goes on by itself the moment the studio is ready. A failed
  // host start stops it: the way in shows the failure instead.
  const failed = startup?.status === "failed";
  useEffect(() => {
    if (!pressed || !settled || failed) return;
    const to = destination();
    if (to !== null) navigate(to, { replace: true });
    // destination reads state, which settled already tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pressed, settled, failed]);

  const press = () => navigate("/starting", { replace: true });
  const background = () => {
    const to = destination();
    if (to !== null) navigate(to, { replace: true });
  };

  const showSetup = pressed && setupRun && !settled && !failed;

  // The local way's one action, in whatever state the studio is in. The states replace the
  // button, never the screen (158g, 158h).
  let action: React.ReactNode;
  if (failed) {
    action = (
      <>
        <div className="fy-launch__note" role="alert">
          <CircleAlert size={16} />
          <div><b>The studio could not start</b><span className="fy-launch__host">{startup?.detail}</span></div>
        </div>
        <button type="button" className="fy-launch__action" onClick={() => window.arke?.retryStartup?.()}>Retry</button>
        <div className="fy-launch__aside">
          <button type="button" onClick={() => window.arke?.openDataFolder?.()}>Open data folder</button>
          <i aria-hidden />
          <button type="button" onClick={() => window.arke?.quit?.()}>Quit</button>
        </div>
      </>
    );
  } else if (connection === "auth-refused") {
    // Nothing on a phone can fix an expired capability, so there is no button. A developer's
    // browser on the studio's own machine gets the developer's instruction.
    action = (
      <div className="fy-launch__note" role="alert">
        <LinkOff size={16} />
        {remote !== null
          ? <div><b>This link has expired</b>Open a new one from Arke Studio on your computer.</div>
          : <div><b>Session link is out of date</b>Restart the frontend and open the new Arke session link from its terminal.</div>}
      </div>
    );
  } else if (unanswered && !desktop) {
    action = (
      <>
        <div className="fy-launch__note" role="status">
          <Unplug size={16} />
          <div><b>Not answering</b>{remote !== null ? "Is Arke Studio open on your computer?" : "Check that your Studio server is running."}</div>
        </div>
        <button type="button" className="fy-launch__action" onClick={reconnectNow}>Try again</button>
      </>
    );
  } else if (pressed && !settled) {
    action = (
      <button type="button" className="fy-launch__action fy-launch__action--busy" aria-busy disabled>
        <span className="fy-launch__spin" aria-hidden />
        {desktop ? "Starting" : "Connecting"}
      </button>
    );
  } else {
    action = (
      <button type="button" className="fy-launch__action" onClick={press}>
        {remote !== null ? "Continue" : "Continue Locally"}
        <ArrowRight size={18} />
      </button>
    );
  }

  return (
    <LaunchFrame>
        {showSetup ? (
          <>
            <section className="fy-launch__setup" aria-live="polite">
              <div className="fy-launch__setuphead">
                <h1>Setting up your studio</h1>
                <span className="fy-launch__pct">{percent}%</span>
                {active !== undefined && (
                  <span className="fy-launch__transfer"><SetupTransferControl component={active} showIcon /></span>
                )}
              </div>
              <div className="fy-launch__track">
                <div className="fy-launch__fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="fy-launch__meta">
                <b>{activity}</b>
                {speed !== null && speed > 0 && <span>{mb(speed, 1)}/s</span>}
                <i />
                <span>
                  {totalBytes > 0 ? `${mb(doneBytes)} of ${mb(totalBytes)}` : ""}
                  {totalBytes > 0 && remaining !== null ? " · " : ""}
                  {remaining !== null ? aboutLeft(remaining) : ""}
                </span>
              </div>
              <ul className="fy-launch__steps">
                {steps.map((step) => (
                  <li key={step.label}>
                    <i className={`fy-launch__dot ${step.settled ? "fy-launch__dot--ok" : "fy-launch__dot--run"}`} aria-hidden>
                      {step.settled && <Check size={12} />}
                    </i>
                    {step.label}
                    <span>{step.state}</span>
                  </li>
                ))}
              </ul>
            </section>
            <div className="fy-launch__once">
              <span>One-time setup.</span>
              <button
                type="button"
                className="fy-launch__action fy-launch__action--line"
                disabled={!ready}
                title={ready ? undefined : "Waiting for the studio core"}
                onClick={background}
              >
                Continue in the background
                <ArrowRight size={16} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="fy-launch__hello">
              <h1>Welcome back</h1>
              <p>Choose how you’d like to sign in.</p>
            </div>
            <div className="fy-launch__ways">
              <section className="fy-launch__way fy-launch__way--local">
                <span className="fy-launch__icon" aria-hidden><Laptop size={52} stroke={1.25} /></span>
                <h2 className="fy-launch__title">{remote !== null ? "Your studio" : "Local Login"}</h2>
                {!failed && <p className="fy-launch__body">
                  {remote !== null ? (
                    <span className="fy-launch__host">{remote}</span>
                  ) : (
                    <>
                      <span className="fy-launch__body--long">Access your local Arke Studio<br />installation on this device.</span>
                      <span className="fy-launch__body--short">Your Arke Studio on this device.</span>
                    </>
                  )}
                </p>}
                {action}
              </section>
              <CloudWay />
            </div>
            <LaunchFoot />
          </>
        )}
    </LaunchFrame>
  );
}

/** Inert with Cloud: both come alive together when Arke Cloud ships. */
export function LaunchFoot() {
  return (
    <p className="fy-launch__foot" aria-disabled>
      Don’t have an account?<span>Create account</span>
    </p>
  );
}
