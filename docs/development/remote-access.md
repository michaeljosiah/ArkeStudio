# Opening Studio from another device

You can use the browser frontend from a phone, a tablet or a second computer while Studio runs
on your main machine. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) carries the
connection. The desktop app supports remembered device pairing. The source-run
[standalone server](standalone-server.md) and `dev:coordinator` also retain the development
session-link setup described below.

Everything still runs on the main machine: your worlds, the Studio server, the writing assistant
and any local generation. The other device only shows the browser frontend.

## Everyday access from the desktop app

1. Connect Tailscale on the PC and phone using the same tailnet. Enable MagicDNS and HTTPS
   certificates on the Tailscale admin console's DNS page. Certificate issuance publishes the
   machine's full DNS name in the Certificate Transparency log.
2. In Studio on the PC, open **Settings → Remote access → Enable remote access**. Studio serves
   the built frontend on loopback port 8793 and chooses an available Tailscale HTTPS address.
   It tries port 443, then 8443, 9443 and 10443–19443 in increments of 1000, skipping existing
   TCP, web and Funnel mappings. Existing services keep working; no terminal cleanup is needed.
   The complete address, including any alternate port, appears in the link and QR code.
3. Scan the QR code in Settings with your phone's camera, or use **Copy link** to transfer the
   clean HTTPS address. The QR is generated locally and contains only that address, not a
   credential or pairing code. Choose **Pair a device** on the PC. Enter the code and a device name on the phone. Approve the matching request on
   the PC. Codes work once, expire after five minutes and stop working after five wrong guesses.
4. Bookmark the clean address on the phone. It contains no credential. This browser remains
   authorized across browser and Studio restarts. **Remember approved devices for** offers
   **30 days**, **90 days** (default), **120 days** or **Never**. The setting at approval applies
   to that new device; existing devices keep their expiry. Never approvals remain valid until
   revoked. Clearing browser site data, expiry or revocation requires pairing again.
5. Optionally enable **Start Studio when I sign in to this PC** in the installed Windows or
   macOS app. Closing the window keeps the host in the system tray; use the tray's **Quit Arke
   Studio** action to stop it. The PC must be awake and signed in. This is not wake-on-LAN or a
   service that starts before user login.

Desktop and phone operate the same coordinator and world session. A paired device can work on
worlds, choose models and defaults, and read diagnostics. Keys, sign-ins, machine controls,
diagnostic exports and pairing management stay on the PC. Revoke a device
in Settings to stop its active connections and future access. The remote gateway uses a secure,
HttpOnly, same-site cookie sealed with a random browser key stored in origin-scoped IndexedDB.
Cookies are shared across ports, but this key is not: a service on another port cannot replay a
captured cookie. The service worker attaches the key only to same-origin remote and media
requests and refuses redirects. WebSockets carry the key in a subprotocol, never in URLs;
the server echoes only the fixed protocol name. The private process capability never reaches
the browser. Browser storage and service workers must be available. Browsers paired before
this protection was added must pair again once; plaintext legacy cookies are refused.
Copy link uses the desktop's native clipboard. If it fails, the address remains visible for
manual copying. Scanning opens the browser and does not bypass pairing or PC approval.
Browsers can remove saved cookies. Never approvals use a persistent cookie renewed on visits;
[Chromium caps cookie lifetimes at 400 days](https://developer.chrome.com/blog/cookie-max-age-expires/),
so a browser unused beyond that period can require pairing again even though its approval has
no scheduled expiry. Timed approvals always keep their original deadline.
Native file selection, dropped host files and desktop-rendered playblasts require the desktop
app. The gateway rejects their host-file commands, including manually supplied filesystem paths.
These commands and the other named PC-only commands receive a typed `host-only` refusal;
the socket remains connected. The client shows the relevant state with **On your PC**.
Conversation cards that choose host files or render desktop playblasts also require approval
on the PC. The gateway restricts every remote decision, and the conversation lifecycle checks
the stored action before approval or replay; ordinary authored decisions and denial remain available.
Provider keys are displayed only as set or not set, never as a key or fingerprint.

On a paired browser, **Settings → Remote access** shows only that browser's name and pairing
dates. **Notify this phone** requests permission on that device and remembers the preference
in that browser. Notifications cover new work and decisions while Studio is open in a background
browser tab; they do not enable push delivery after the browser closes or change PC notifications.
Settings, Activity and Account use sheets below 600px; wider touch screens retain the dialog
and side panel with larger controls (design turn 175, #1373).

**Disable remote access** stops hosting, removes only its matching Serve mapping and turns off
automatic startup, retaining the last address for the next setup. Ordinary Quit removes the mapping before releasing the local hosting port;
the next app start prefers the same bookmarked address, even when port 443 becomes free.
If another service has taken that address, Studio chooses a free one; copy or scan the new
address in Settings and pair your devices again. Before publishing a changed address (or recovering
without a recorded address), Studio durably revokes previous device approvals; if that fails,
hosting does not start. Studio never replaces another service or enables Funnel.
If Tailscale cannot remove the
mapping, Studio keeps the port reserved and reports that shutdown failed; restore Tailscale
and retry Quit. The built desktop page keeps its existing loopback
policy; only the copy served to the phone gets the remote same-origin policy.
On startup, an inert listener reserves the port before either settings or device records are
read. Stale forwarding is withdrawn before loading the device registry. If settings are damaged,
recovery discovers only the exact private Serve mapping to Studio's fixed port; other mappings
are preserved. Failed cleanup retains the listener until Disable or Quit can remove the mapping.
Damaged records remain untouched. A failed desktop startup also drains the previous host before
Retry can construct a replacement. An ordinary first launch does not require Tailscale.
Studio saves its ownership record before publishing HTTPS, so a process exit during Enable
still leaves enough information for this recovery on the next start.

If the PC or Tailscale is offline, an already open page retries. A new tab may show the browser's
own network error because no page can be served. Resume the PC and connect Tailscale, then reload.
If connections time out with another VPN active, test with that VPN disconnected; our Windows
check failed with NordLynx active and succeeded after disconnecting NordVPN. This changes which
network carries ordinary internet traffic during that test.

## Development session links

This mode still requires a new private link after a server restart and keeps it only for the
current browser tab. It is useful for development; use desktop pairing for everyday phone use.

### How it fits together

```mermaid
flowchart LR
  Phone[Browser on another device] -->|https, port 443| Serve[Tailscale Serve on your machine]
  Phone -->|wss and https, port 8443| Serve
  Serve -->|http| Vite[Vite frontend on 127.0.0.1:5173]
  Serve -->|ws and http| Server[Studio server on 127.0.0.1:8791]
```

The Studio server never listens beyond loopback. Tailscale Serve listens on your tailnet, adds
HTTPS with your machine's `ts.net` certificate, and forwards to loopback. Only devices on your
tailnet can reach it. Every connection to the server still needs the session capability in the
link Vite prints.

There is deliberately no option to make the server listen on a network address. That would
send the capability over the network unencrypted. Use Serve instead.

## Before you start

- Install Tailscale on the main machine and on the other device, and sign both in to the same
  tailnet.
- In the Tailscale admin console, turn on **MagicDNS** and **HTTPS certificates** (both are on
  the DNS page). Enabling HTTPS publishes your machine names and tailnet name in the public
  Certificate Transparency log; see [Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates).
- Find the main machine's tailnet name. In PowerShell:

  ```powershell
  $name = (tailscale status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
  $name   # for example studio.tail1234.ts.net
  ```

The examples below use `$name` for that value. Use the same terminal, or set it again in each
one.

## Start it

**1. Start the Studio server** with the tailnet address as its allowed browser origin:

```powershell
npm run server -- --root C:\ArkeData --origin "https://$name"
```

To use the development coordinator instead, set the origin in its terminal:

```powershell
$env:ARKE_DEV_ORIGIN = "https://$name"
npm run dev:coordinator
```

**2. Publish both ports on your tailnet.** The page goes on 443 and the server on 8443:

```powershell
tailscale serve --bg --https=443 http://127.0.0.1:5173
tailscale serve --bg --https=8443 http://127.0.0.1:8791
tailscale serve status
```

If Serve says it is not enabled for your tailnet, follow the link it prints. `--bg` keeps the
mapping after you close the terminal, and after a restart.

**3. Start the frontend** in a second terminal:

```powershell
$env:VITE_ARKE_WS = "wss://${name}:8443"
$env:ARKE_DEV_LOCAL_WS = "ws://127.0.0.1:8791"
$env:ARKE_DEV_ORIGIN = "https://$name"
npm run dev --workspace @arke-studio/client -- --host 127.0.0.1
```

| Setting | What it is |
|---|---|
| `VITE_ARKE_WS` | Where the other device reaches the server, through Serve. Must be `wss:`. |
| `ARKE_DEV_LOCAL_WS` | The server on this machine that Serve forwards to. Vite reads the session from it. |
| `ARKE_DEV_ORIGIN` | The address the other device opens. Must be `https:` and match the server's `--origin`. |

`--host 127.0.0.1` makes Vite listen on the address Serve forwards to. On some machines
`localhost` resolves only to IPv6, and Serve would find nothing on `127.0.0.1`. Name the
workspace as shown: the root `npm run dev` script does not pass extra arguments on to Vite.

Before printing a link, Vite checks the session through Serve's 8443 mapping. When it succeeds
the terminal shows:

```
Arke session: https://studio.tail1234.ts.net/#/?arke-session=…
```

**4. Open that link on the other device.** The page removes the capability from the address bar
and keeps it only in that browser tab. A new tab needs the link again.

Use the **Arke session** link, not Vite's **Local** link. `127.0.0.1` or `localhost` on a phone
means the phone itself, not the PC, and typically reports that the connection was refused.

## Keep the link private

Anyone on your tailnet who has the link has full control of the session, the same as you. Don't
paste it into chats or notes.

The link stops working when the server restarts. Restart the frontend as well, and open the new
link it prints.

## Limit who can reach it

Vite does not ask for the capability, so anyone who can reach port 443 on this machine can load
the frontend's pages. Only the client and contracts packages and `node_modules` are served, not
the rest of your checkout.

If your tailnet has only your own devices, there is nothing more to do. If it includes other
people, or this machine is shared with another tailnet, limit the ports to your own devices.
New tailnets let every member reach every device. A policy whose only access rule is this grant
lets each member reach only their own devices:

```json
"grants": [
  { "src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"] }
]
```

This replaces the default rule that allows everything, so add back any other access you rely
on. See [Tailscale's grant examples](https://tailscale.com/docs/reference/examples/grants).

Never use **Tailscale Funnel** for this. Funnel publishes the port to the whole internet.

## Stop it

Stop the frontend and the server with Ctrl+C, then turn off the two mappings:

```powershell
tailscale serve --https=443 off
tailscale serve --https=8443 off
```

Otherwise they come back after a restart and point at whatever is next on those ports. Avoid
`tailscale serve reset` unless nothing else on this machine uses Serve: it clears every mapping,
not only these two.

## If it doesn't work

| What you see | What to check |
|---|---|
| `Arke session link not printed: A remote VITE_ARKE_WS must use wss: …` | `VITE_ARKE_WS` must start with `wss://`. |
| `Arke session link not printed: … needs ARKE_DEV_LOCAL_WS …` | Set `ARKE_DEV_LOCAL_WS` to `ws://127.0.0.1:8791`, including the port. |
| `Arke session link not printed: … ARKE_DEV_ORIGIN …` | Set `ARKE_DEV_ORIGIN` to `https://` and your tailnet name. A remote origin also needs the two settings above. |
| `Could not verify the Arke session …` | The server isn't running from this checkout; the 8443 mapping is missing (`tailscale serve status`); or the server's `--origin` doesn't exactly match `ARKE_DEV_ORIGIN`. |
| The browser can't reach the page at all | The 443 mapping is missing, or Vite isn't on `127.0.0.1:5173`. Check `tailscale serve status` and the `--host` flag. |
| Connection refused on the phone | Check that you opened the HTTPS **Arke session** address rather than Vite's `127.0.0.1` or `localhost` link. |
| The HTTPS address times out while both services run | Check Tailscale on both devices and whether another VPN conflicts. Our Windows test worked after disconnecting NordVPN. Restart Vite after restoring connectivity so its session probe can print the link. |
| Vite shows "Blocked request. This host is not allowed" | Vite was started without all three settings, or with a different name. Restart it with them. |
| **Session link is out of date** | The server restarted. Restart the frontend and open the new link. |
| **Waiting for the coordinator** | The server has stopped, or the 8443 mapping is missing. |
| Pictures and video don't load | The 8443 mapping. Media comes from the server, not from Vite. |
| The console shows `Refused to connect to 'wss://…'` | The page was served without the proxied settings. Restart Vite with all three. |
| Studio works, but a source edit does not appear | Check the browser console for `[vite] connected.`. Hot reload uses the frontend's HTTPS origin (443 in this guide), separately from the coordinator on 8443. Keep both mappings, and check whether the edit needs a full page reload. |

## What the browser can't do

A few features rely on the desktop app's native bridge and are missing from any browser,
remote or local. Studio says so where each one appears:

- attaching files, and dropping files onto the window (use Import media instead)
- stage export
- keeping a recorded line
- opening the data folder

Saving media and copying images do work. They use the browser's own download and clipboard, so
the browser may ask for permission first.

Provider keys also behave differently. `npm run server` cannot store them securely without a
cipher from its host, and the development coordinator keeps them only until it stops. The
writing assistant and local generation use whatever is installed and signed in on the main
machine.

## Checks this setup is built on

The rules above are enforced in `packages/client/dev-session-plugin.ts` and covered by
`packages/client/test/dev-session-remote.test.ts`. The operational rule is in
[CLAUDE.md](../../CLAUDE.md#the-coordinator-session-is-authenticated-issue-825), and the change
was made in [PR #1297](https://github.com/michaeljosiah/ArkeStudio/pull/1297).

Desktop pairing is implemented by coordinator `remote-access/devices.ts` and `gateway.ts`,
desktop `remote-access.ts` and `tailscale-serve.ts`, and the client's remote entry/settings
screens (issue #1311; SPEC-001 §2.5 and SPEC-016). Coordinator and desktop
`test/remote-access.test.ts` cover proof persistence, code expiry/replay, owner approval,
origin/host checks, media, WebSockets, revocation, mapping ownership and host restart.
Automated checks do not replace the actual phone and second-computer acceptance journeys.

### Real Serve verification — 2026-09-27

The host checks below used Windows, Tailscale **1.102.3**, Vite **7.3.6**, and the Codex
in-app browser reporting **Chrome 153.0.0.0**. TLS certificate verification stayed enabled.
These are checks from the hosting PC through its real tailnet HTTPS address; they do not
establish that another device can connect.

| Check | Observed result |
|---|---|
| Frontend HTTPS on 443 | Page loaded with the declared remote coordinator in its CSP; no process capability in the served HTML. |
| Coordinator HTTPS on 8443 | Authenticated `HEAD /session` returned 204 and `X-Arke-Session: authenticated`. |
| Coordinator WebSocket through Serve | An authenticated WSS hello returned a Studio snapshot. |
| Authenticated media range | Fixture PNG returned 206 and the requested 32 bytes. The request without a capability returned 401. |
| Vite connection on the frontend origin | Browser console reported `[vite] connected.` through the existing 443 mapping. |
| Actual hot update | A temporary Vite fixture behind an isolated 8444 mapping changed its visible label from `Before update` to `After update` after a module edit, without a manual reload. The console reported the hot update. It used the repository's development-session plugin and page CSP. |
| Source change requiring a page reload | Editing the fixture's entry module refreshed the page automatically and displayed the new content. |
| Removing a background mapping | `tailscale serve --https=8444 off` removed the test's `--bg` mapping. Serve's remaining configuration matched its initial configuration, preserving the existing 443 and 8443 mappings. Earlier checks also removed background mappings on 8443 and 443 individually. |

The temporary fixture contained no world data or session capability. It was removed after
the check. Desktop pairing has separate live HTTPS coverage described in [testing](testing.md#remembered-remote-access).

### Complete the other-device checks

[Issue #1305](https://github.com/michaeljosiah/ArkeStudio/issues/1305) remains open until both
the phone and a second computer complete the development-session journey. At the host check,
the Android phone was online in Tailscale; no second computer was connected. Being online
does not establish that the browser journey passed.

On **each** other device:

1. Connect Tailscale. Record the device OS, browser name/version and Tailscale version.
2. Open the private **Arke session** link from the host's Vite terminal, rather than its Local
   link. Check that Studio loads and removes `arke-session` from the address bar. Keep the
   capability out of screenshots and issue comments.
3. Open a fixture world and view an image. This checks that the authenticated coordinator and
   media paths work from that device, rather than only loading the frontend shell. Reload the
   same tab and confirm it still connects.
4. With that page open, make a small, reversible visible source edit on the host. Check that
   the browser updates without a manual reload, then restore the edit and verify it updates
   back. Record whether Vite applied a hot update or automatically reloaded the whole page.
5. Record the result and any exact error in #1305. A phone-sized window on the host is not a
   substitute for either device. Close the issue only when both device results are recorded.
