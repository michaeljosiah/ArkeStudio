import { useEffect, useState, type ReactNode } from "react";
import { Button, Input } from "./ui.js";
import { initStore } from "../lib/store.js";

/** The clean bookmark loads this gate before any world data. Authentication stays in an
 * HttpOnly cookie, so neither the React tree nor a URL ever contains a device credential. */
export function RemoteEntry({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "pair" | "pending" | "ready" | "offline">("checking");
  const [code, setCode] = useState("");
  const [name, setName] = useState("My phone");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let checking = false;
    const controller = new AbortController();
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const session = await fetch("/remote/session", { signal: controller.signal });
        if (!active) return;
        if (session.status === 204) { initStore(); setState("ready"); }
        else if (session.status === 401) {
          const pairing = await fetch("/remote/pair", { signal: controller.signal });
          if (!active) return;
          if (pairing.status === 204) { initStore(); setState("ready"); }
          else setState(pairing.status === 202 ? "pending" : "pair");
        } else setState("offline");
      } catch { if (active) setState("offline"); }
      finally { checking = false; }
    };
    void check();
    const timer = setInterval(() => { if (active) void check(); }, 3000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, []);
  const pair = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/remote/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name }) });
      if (response.status === 202) { setCode(""); setState("pending"); }
      else setError(response.status === 429 ? "Too many attempts. Wait a minute and try again." : "This code is invalid or expired. Create a new code on the PC.");
    } catch { setState("offline"); }
    finally { setBusy(false); }
  };
  if (state === "ready") return <>{children}</>;
  return <main className="remote-entry"><section className="remote-entry__card">
    <h1>{state === "offline" ? "Studio is unavailable" : state === "pending" ? "Approve on your PC" : "Connect to Studio"}</h1>
    {state === "checking" && <p>Checking this device…</p>}
    {state === "offline" && <p>Keep the PC awake, Studio running, and Tailscale connected on both devices. Reconnecting automatically…</p>}
    {state === "pending" && <p>In Studio on your PC, open Settings → Remote access and approve this device.</p>}
    {state === "pair" && <form onSubmit={event => { event.preventDefault(); void pair(); }}>
      <p>On your PC, open Settings → Remote access → Pair a device. Pairing gives this browser access to your Studio session.</p>
      <label>Device name<Input value={name} maxLength={60} onChange={event => setName(event.target.value)} required /></label>
      <label>Pairing code<Input value={code} autoComplete="one-time-code" autoCapitalize="characters" maxLength={12} onChange={event => setCode(event.target.value)} required /></label>
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={busy || !code.trim() || !name.trim()}>Request pairing</Button>
      <p>After approval, bookmark this address. The PC sets how long this browser is remembered. Clearing its site data or revoking it on the PC requires pairing again.</p>
    </form>}
  </section></main>;
}
