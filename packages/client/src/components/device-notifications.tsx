import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { computeNeedsYou, type ClientState } from "@arke-studio/contracts";
import { isRemoteSession } from "../lib/remote-session.js";
import { openActivityPanel } from "../lib/activity-panel.js";
import { cx } from "./ui.js";
const KEY = "arke-device-notifications";
const EVENT = "arke-device-notifications-changed";
function enabled() { try { return localStorage.getItem(KEY) === "on"; } catch { return false; } }
function subscribe(listener: () => void) { window.addEventListener(EVENT, listener); window.addEventListener("storage", listener); return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", listener); }; }
export function DeviceNotifications() {
  const on = useSyncExternalStore(subscribe, enabled, () => false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const supported = typeof Notification !== "undefined" && "serviceWorker" in navigator;
  const toggle = async () => {
    const wantOn = !(on && supported && Notification.permission === "granted");
    setBusy(true); setError("");
    try {
      if (wantOn) {
        if (!supported || await Notification.requestPermission() !== "granted") { setError("Notifications are blocked in this browser."); return; }
        await navigator.serviceWorker.register("/notification-worker.js");
      }
      localStorage.setItem(KEY, wantOn ? "on" : "off"); window.dispatchEvent(new Event(EVENT));
    } catch { setError("Notifications could not be enabled in this browser."); }
    finally { setBusy(false); }
  };
  return <div className="fy-device-notifications"><div><strong>Notify this phone</strong><small>{supported ? "while Studio is open in this browser" : "not available in this browser"}</small></div>
    <button type="button" role="switch" aria-label="Notify this phone" aria-checked={on && supported && Notification.permission === "granted"} disabled={busy || !supported} className={cx("fy-prov__switch", on && supported && Notification.permission === "granted" && "is-on")} onClick={() => void toggle()}><span /></button>
    {error && <p role="status">{error}</p>}
  </div>;
}
/** Preference and permission belong to this browser, never the PC's background-notification setting. */
export function useDeviceNotifications(state: ClientState | null) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!isRemoteSession() || !state) return;
    const notices = [
      ...computeNeedsYou(state).map(n => ({ id: `need:${n.kind}:${n.worldId ?? ""}:${n.ref ?? ""}`, title: n.title, body: n.detail })),
      ...state.app.jobs.filter(j => j.status === "succeeded" && (j.finalization === undefined || j.finalization.status === "complete")).map(j => ({ id: `ready:${j.id}`, title: "Your work is ready", body: `${j.provider} · ${j.model}` })),
    ];
    const added = notices.filter(n => seen.current !== null && !seen.current.has(n.id));
    seen.current = new Set(notices.map(n => n.id));
    if (!enabled() || document.visibilityState !== "hidden" || typeof Notification === "undefined" || Notification.permission !== "granted" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.getRegistration("/").then(async registration => {
      for (const n of added) await registration?.showNotification(n.title, { body: n.body, tag: n.id });
    }).catch(() => {});
  }, [state]);
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const open = (event: MessageEvent) => { if (event.data === "arke-open-activity") openActivityPanel("inbox"); };
    navigator.serviceWorker.addEventListener("message", open);
    return () => navigator.serviceWorker.removeEventListener("message", open);
  }, []);
}
