import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { initStore } from "../lib/store.js";
import { CloudWay, LaunchFoot, LaunchFrame, remoteStudio } from "../screens/launch.js";
import { Laptop, Unplug } from "./icons.js";

/** The clean bookmark loads this gate before any world data. Authentication stays in an
 * HttpOnly cookie, so neither the React tree nor a URL ever contains a device credential.
 *
 * It draws on the launch surface (design turn 158i): a browser the studio does not know yet
 * pairs on the local way, and every other part of the first screen is the one a paired phone
 * sees. The plain "Connect to Studio" card that stood here is retired. */

type Gate = "checking" | "pair" | "pending" | "ready" | "offline";

/** "XXXX-XXXX" as it is typed. The gateway ignores spaces and dashes; the dash is for reading. */
export function formatPairingCode(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/** The browser's own name for the device when it gives one (Chromium on Android does), so the
 * PC's prompt reads "Pair Pixel 9?" rather than a name nobody chose. */
async function deviceModel(): Promise<string | null> {
  const hints = (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues?(keys: string[]): Promise<{ model?: string }> };
  }).userAgentData;
  try {
    const model = (await hints?.getHighEntropyValues?.(["model"]))?.model?.trim();
    return model ? model.slice(0, 60) : null;
  } catch { return null; }
}

export function RemoteEntry({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, setState] = useState<Gate>("checking");
  const [code, setCode] = useState("");
  const [name, setName] = useState("My phone");
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<{ title: string; line: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The band gives way while a field has the keyboard (158i). It comes back only once focus has
  // left the form, a beat later: collapsing on the field's own blur moved Request pairing out
  // from under the tap that blurred it, and the tap landed on nothing.
  const [typing, setTyping] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const leave = () => setTimeout(() => {
    if (!form.current?.contains(document.activeElement)) setTyping(false);
  }, 200);
  // Whether this browser has asked and is waiting: a pairing check that then answers anything but
  // "pending" or "approved" means the PC said no, or the request ran out.
  const asked = useRef(false);
  const posting = useRef(false);
  const revision = useRef(0);

  useEffect(() => { void deviceModel().then(model => { if (model) setName(model); }); }, []);

  useEffect(() => {
    let active = true;
    let checking = false;
    const controller = new AbortController();
    const check = async () => {
      if (checking || posting.current) return;
      checking = true;
      const checkedRevision = revision.current;
      const current = () => active && checkedRevision === revision.current;
      try {
        const session = await fetch("/remote/session", { signal: controller.signal });
        if (!current()) return;
        if (session.status === 204) { initStore(); setState("ready"); }
        else if (session.status === 401) {
          const pairing = await fetch("/remote/pair", { signal: controller.signal });
          if (!current()) return;
          if (pairing.status === 204) {
            initStore();
            setState("ready");
            // Just approved: they did the work, so this once they go straight in (158i).
            navigate("/starting", { replace: true });
            asked.current = false;
          } else if (pairing.status === 202) {
            asked.current = true;
            setState("pending");
          }
          else {
            if (asked.current) setError({ title: "Not approved", line: "Get a new code on your PC." });
            asked.current = false;
            setState("pair");
          }
        } else setState("offline");
      } catch { if (current()) setState("offline"); }
      finally { checking = false; }
    };
    void check();
    const timer = setInterval(() => { if (active) void check(); }, 3000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
    // `attempt` is Try again: the same check, now, rather than at the next tick.
  }, [attempt, navigate]);

  const pair = async () => {
    if (posting.current) return;
    // A check begun before this request must not replace its pending state with an old 410.
    posting.current = true;
    revision.current++;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/remote/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name: name.trim() || "My phone" }),
      });
      if (response.status === 202) { setCode(""); asked.current = true; setState("pending"); }
      else setError(response.status === 429
        ? { title: "Too many tries", line: "Wait a minute." }
        : { title: "That code didn’t work", line: "Get a new code on your PC." });
    } catch { setState("offline"); }
    finally { posting.current = false; setBusy(false); }
  };

  if (state === "ready") return <>{children}</>;

  const host = remoteStudio();
  let body: ReactNode;
  if (state === "pair") {
    body = (
      <form
        ref={form}
        className="fy-launch__pair"
        onFocus={() => setTyping(true)}
        onBlur={leave}
        onSubmit={event => { event.preventDefault(); setTyping(false); void pair(); }}
      >
        <label className="fy-launch__field">
          <span>Pairing code</span>
          <input
            className="fy-launch__code"
            value={code}
            placeholder="XXXX-XXXX"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={9}
            onChange={event => setCode(formatPairingCode(event.target.value))}
            required
          />
        </label>
        {error && (
          <div className="fy-launch__note" role="alert">
            <Unplug size={16} />
            <div><b>{error.title}</b>{error.line}</div>
          </div>
        )}
        <button type="submit" className="fy-launch__action" disabled={busy || code.replace(/-/g, "").length < 8 || !name.trim()}>
          Request pairing
        </button>
        {renaming ? (
          <label className="fy-launch__field">
            <span>Device name</span>
            <input className="fy-launch__name" value={name} maxLength={60} onChange={event => setName(event.target.value)} required />
          </label>
        ) : (
          <div className="fy-launch__named">
            As <b>{name}</b>
            <button type="button" onClick={() => setRenaming(true)}>Rename</button>
          </div>
        )}
      </form>
    );
  } else if (state === "pending") {
    body = (
      <div className="fy-launch__note" role="status">
        <i className="fy-launch__wait" aria-hidden />
        <div><b>Waiting for your PC</b>Approve {name} there.</div>
      </div>
    );
  } else if (state === "offline") {
    body = (
      <>
        <div className="fy-launch__note" role="status">
          <Unplug size={16} />
          <div><b>Not answering</b>Is Arke Studio open on your computer?</div>
        </div>
        <button type="button" className="fy-launch__action" onClick={() => setAttempt(n => n + 1)}>Try again</button>
      </>
    );
  } else {
    body = (
      <button type="button" className="fy-launch__action fy-launch__action--busy" aria-busy disabled>
        <span className="fy-launch__spin" aria-hidden />
        Checking
      </button>
    );
  }

  const pairing = state === "pair" || state === "pending";
  return (
    <LaunchFrame compact={state === "pair"} typing={state === "pair" && typing}>
      <div className="fy-launch__hello">
        {pairing ? (
          <>
            <h1>Pair this device</h1>
            <p>Get a code on your PC in Settings › Remote access.</p>
          </>
        ) : (
          <>
            <h1>Welcome back</h1>
            <p>Choose how you’d like to sign in.</p>
          </>
        )}
      </div>
      <div className="fy-launch__ways">
        <section className="fy-launch__way fy-launch__way--local">
          <span className="fy-launch__icon" aria-hidden><Laptop size={52} stroke={1.25} /></span>
          <h2 className="fy-launch__title">Your studio</h2>
          <p className="fy-launch__body"><span className="fy-launch__host">{host ?? "this studio"}</span></p>
          {body}
        </section>
        <CloudWay />
      </div>
      <LaunchFoot />
    </LaunchFrame>
  );
}
