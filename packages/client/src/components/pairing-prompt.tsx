import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import type { RemoteAccessCommand, RemoteAccessStatus } from "@arke-studio/contracts";
import { EditorDialog } from "./editor-dialog.js";
import { Button, IconButton } from "./ui.js";
import { Smartphone, X } from "./icons.js";

/**
 * A phone asking to pair, asked where you are (design turn 158j).
 *
 * The phone says "Approve Pixel 9 there", and someone working in a world should not have to go
 * looking for where "there" is. The request opens the house dialog over whatever the desktop app
 * shows. Closing it means decide later: the request waits in Settings › Remote access until it
 * runs out, and this dialog does not come back for it. One at a time, newest first, and none
 * while Settings › Remote access is open, because the list is already on screen.
 *
 * Desktop only. Approval is an owner control, so it stays on the private bridge and never
 * crosses the network: a browser has no `remoteAccess` and this renders nothing.
 */
export function PairingPrompt() {
  const bridge = typeof window === "undefined" ? undefined : window.arke?.remoteAccess;
  const { pathname } = useLocation();
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [later, setLater] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // The same two-second poll the Settings pane keeps; the status is a private IPC read.
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const reply = await bridge({ kind: "status" }); if (live) setStatus(reply.status); }
      catch { /* Studio still starting: the next poll asks again. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { live = false; clearInterval(timer); };
  }, [bridge]);

  const request = [...(status?.pending ?? [])]
    .filter((device) => device.expiresAt > now && !later.has(device.id))
    .sort((a, b) => b.expiresAt - a.expiresAt)[0];
  const covered = pathname === "/settings/remote-access";
  const open = request !== undefined && !covered;

  // A countdown that moves only while there is something to count.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  if (!bridge || request === undefined || covered) return null;

  const decide = async (kind: "approve" | "reject") => {
    setBusy(true);
    try { setStatus((await bridge({ kind, id: request.id } as RemoteAccessCommand)).status); }
    catch { /* Left open: the press can be tried again, and Settings has the same request. */ }
    finally { setBusy(false); }
  };
  const close = () => setLater((ids) => new Set(ids).add(request.id));
  const left = Math.max(0, Math.round((request.expiresAt - now) / 1000));
  // Requests live five minutes from the moment they are made, so the age is what is used up.
  const asked = 300 - left < 60 ? "Asked just now" : `Asked ${Math.floor((300 - left) / 60)} min ago`;

  return (
    <EditorDialog open onClose={close} width={440} labelledBy="fy-pairask-title" panelClassName="fy-upd fy-pairask">
      <div className="fy-upd__top">
        <span className="fy-pairask__phone" aria-hidden><Smartphone size={26} /></span>
        <h1 className="fy-upd__title" id="fy-pairask-title">Pair {request.name}?</h1>
        <div className="fy-upd__version">
          {asked} · {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left
        </div>
        <p className="fy-pairask__what">
          {status?.pairingDuration === "never"
            ? "Full access to this studio until you revoke it."
            : `Full access to this studio for ${status?.pairingDuration ?? 90} days.`}
        </p>
      </div>
      <div className="fy-upd__foot">
        <Button variant="primary" size="lg" className="fy-upd__btn" disabled={busy} onClick={() => void decide("approve")}>
          Approve
        </Button>
        <Button size="lg" className="fy-upd__btn" disabled={busy} onClick={() => void decide("reject")}>
          Reject
        </Button>
      </div>
      <IconButton label="Decide later" className="fy-upd__close" onClick={close}>
        <X size={13} />
      </IconButton>
    </EditorDialog>
  );
}
