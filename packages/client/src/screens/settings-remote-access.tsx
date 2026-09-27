import { useEffect, useState } from "react";
import { RemotePairingDurationSchema, type RemoteAccessCommand, type RemoteAccessReply, type RemoteAccessStatus } from "@arke-studio/contracts";
import { Button, Select } from "../components/ui.js";

export function SettingsRemoteAccessScreen() {
  const bridge = typeof window === "undefined" ? undefined : window.arke?.remoteAccess;
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [pairing, setPairing] = useState<RemoteAccessReply["pairing"]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const apply = (reply: RemoteAccessReply) => { setStatus(reply.status); if (reply.pairing) setPairing(reply.pairing); };
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const reply = await bridge({ kind: "status" }); if (live) apply(reply); }
      catch { if (live) setError("Remote access settings are unavailable while Studio is starting."); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { live = false; clearInterval(timer); };
  }, [bridge]);
  const command = async (input: RemoteAccessCommand) => {
    if (!bridge) return;
    setBusy(true); setError("");
    try { apply(await bridge(input)); if (input.kind === "disable") setPairing(undefined); }
    catch { setError("Studio could not complete that action. Try again."); }
    finally { setBusy(false); }
  };
  return <div className="fy-set remote-access" data-screen="settings-remote-access">
    <h1 className="fy-pane__name">Remote access</h1>
    {!bridge ? <p>Manage remote access and paired devices in Studio on your PC.</p> : <>
      <p>Open Studio from your phone through Tailscale. Paired devices have full access to this Studio session. Keep the PC awake and connected.</p>
      <p>Install and connect Tailscale, and enable MagicDNS and HTTPS certificates in its DNS settings.</p>
      {(error || status?.reason) && <p role="alert">{error || status?.reason}</p>}
      {status && <>
        <div className="remote-access__row"><span>{status.running ? "Remote access is running" : status.enabled ? "Remote access needs attention" : "Remote access is off"}</span>
          <Button disabled={busy} onClick={() => void command({ kind: status.enabled ? "disable" : "enable" })}>{status.enabled ? "Disable remote access" : "Enable remote access"}</Button>
        </div>
        {status.url && <p>Bookmark on your phone: <a href={status.url} target="_blank" rel="noreferrer">{status.url}</a></p>}
        <label><input type="checkbox" checked={status.startOnLogin} disabled={busy || !status.running || !status.startupSupported}
          onChange={event => void command({ kind: "startup", enabled: event.target.checked })} /> Start Studio when I sign in to this PC</label>
        {!status.startupSupported && <p>Automatic startup is available in the installed Windows and macOS app.</p>}
        <div className="remote-access__row"><span>Remember approved devices for</span>
          <Select label="Remember approved devices for" value={status.pairingDuration} disabled={busy}
            aria-describedby="remote-pairing-duration-help"
            onChange={event => void command({ kind: "duration", duration: RemotePairingDurationSchema.parse(
              event.target.value === "never" ? "never" : Number(event.target.value)) })}>
            <option value={30}>30 days</option><option value={90}>90 days</option>
            <option value={120}>120 days</option><option value="never">Never</option>
          </Select>
        </div>
        <p id="remote-pairing-duration-help">Applies to new approvals. Existing devices keep their current expiry. You can revoke any device at any time.</p>
        {status.running && <>
          <p>Closing the window keeps Studio running in the system tray. Use Quit Arke Studio in the tray to stop it.</p>
          <Button disabled={busy} onClick={() => void command({ kind: "pair" })}>Pair a device</Button>
          {pairing && pairing.expiresAt > Date.now() && <div role="status"><p>Enter this code on your phone, then approve its request here. It expires in five minutes and works once.</p><strong className="remote-access__code">{pairing.code}</strong></div>}
        </>}
        {status.pending.length > 0 && <section><h2>Waiting for approval</h2>{status.pending.map(device => <div className="remote-access__row" key={device.id}>
          <span>{device.name}</span><Button disabled={busy} onClick={() => void command({ kind: "approve", id: device.id })}>Approve {device.name}</Button>
          <Button disabled={busy} onClick={() => void command({ kind: "reject", id: device.id })}>Reject</Button>
        </div>)}</section>}
        <section><h2>Paired devices</h2>{status.devices.length === 0 ? <p>No paired devices.</p> : status.devices.map(device => <div className="remote-access__row" key={device.id}>
          <span>{device.name} · {device.expiresAt === null ? "Never expires" : `expires ${new Date(device.expiresAt).toLocaleDateString()}`}</span>
          <Button disabled={busy} onClick={() => void command({ kind: "revoke", id: device.id })}>Revoke {device.name}</Button>
        </div>)}</section>
      </>}
    </>}
  </div>;
}
