# Recovery acceptance and user journeys

Epic #2194 / PR #2197 is not fully accepted. Component tests and a green build do not establish
the complete user experience. This record separates the 28 October 2026 application walkthrough,
native lifecycle checks and outstanding qualification.

## Repeat the browser journey

Build the real client for the isolated host, then start the qualifier from an interactive terminal:

```powershell
$env:VITE_ARKE_WS = 'ws://127.0.0.1:4416'
$env:ARKE_DEV_ORIGIN = 'http://127.0.0.1:4415'
npm run build --workspace @arke-studio/client
node --import tsx scripts/qualify-recovery-ui.mjs .dev/recovery-ui-new-run
```

The directory must be new and inside this checkout's `.dev`. The qualifier copies the public
fixture world and uses production client/coordinator composition, authenticated sockets and real
settings/history files. It serves only client build assets. Its private `session.private.json`
provides the normal browser session capability; never copy that capability into documentation,
screenshots or a public asset/bootstrap endpoint. Open the UI with the normal `arke-session`
fragment handoff. Restart mints a new capability; reconnect using the new handoff and reload.
This developer-browser step does not qualify desktop startup IPC.

Runtime responses and available capacity are synthetic. Both runtime overrides are explicitly
selected within the test profile. Installers/model downloads refuse, and no paid provider or
personal world is used. In the qualifier's terminal, one JSON command per line controls faults:

```json
{"action":"report"}
{"action":"storage","freeGiB":1}
{"action":"storage","freeGiB":100}
{"action":"health","healthy":false}
{"action":"health","healthy":true}
{"action":"restart"}
{"action":"stop"}
```

`observations.json` retains non-secret policy/readiness observations. Synthetic faults do not
prove real model installation, physical disk exhaustion, actual runtime compatibility or GPU
release. Keep the scenario and actual native-model qualification results distinct.

## Observed results

| Journey | Evidence and result |
|---|---|
| Local sign-in → Settings → Diagnostics | Real app navigation completed. Ordinary recovery controls are visible; Advanced starts closed. |
| Change download preferences → Save | The authenticated command returned a correlated confirmation and the control file held the selected values. |
| Defaults without Save → coordinator restart | The previous saved 65-file/45-minute preferences survived. Merely editing defaults did not overwrite them. |
| Clear/retype a number | Found and fixed an empty input becoming zero. A blank now remains editable; invalid values disable Save and ranges are visible. |
| Change a saved draft or restore defaults | Found and fixed a stale Saved message. The draft now says Unsaved changes until explicitly saved. |
| Open/refresh Ollama while another engine is working | Found and fixed GPU admission during a read-only health check. The native application regression holds Ming's lane, checks healthy/failed/healthy transitions and forbids competing unloads. |
| Healthy Ollama with no installed language model | Found and fixed the provider rail saying not answering. Runtime readiness is independent of model availability. |
| Disk-pressure event | A 1-GiB synthetic reading produced a proactive notice, System/Activity attention and a retained incident before a world was opened. A stale reading became unknown, not healthy. |
| Runtime health loss and restoration | The local-AI readiness gate changed false/true with both services' health. System showed unavailable/failed states and Diagnostics retained the event. |
| System → Diagnostics | A direct handoff opened the live Diagnostics page. Unknown GPU readings remained unknown. |
| Keyboard and phone | System Tab/Escape and focus return passed. Settings actions remained reachable at 390×844 and reduced 390×500. Light/dark rendering was inspected. This is not physical keyboard/device acceptance. |
| Native managed-service recovery | Seventeen focused application/readiness/lifecycle cases passed, including real owned child crashes, durable retry policy, cleanup uncertainty and cancelled setup activation. Runtime responses in those child fixtures are synthetic. |
| Actual local Studio delegation | One run interrupted at the diagnostic phase after two real completions. A test-only observer on a subsequent explicit run saw valid response schemas/references, all three completions, requester-only privacy, canonical history restoration without replay and both native shutdowns. The first failure remains unexplained. |

The native-model observation records only response byte counts, schema validity and reference
counts, not prompts/replies/credentials. It delegates to the original runner and leaves its
execution/ownership checks intact. A successful rerun does not resolve the earlier failure.

## Open acceptance

- **Live Studio reliability:** explain the first diagnostic interruption and establish a
  useful, recoverable user-facing failure path. Do not call this route reliably accepted based
  on the successful rerun or automatically replay its interrupted request.
- **Diagnostics clarity:** the walkthrough still shows dense repeated consequences and a generic
  absence-of-remedy line for an unreachable explicitly selected external service. Review clear
  user-directed next steps without claiming Arke owns that service.
- Actual mandatory managed-runtime downloads/installation and packaged Electron startup,
  desktop notifications, microphone/speaker interaction and physical GPU handover need their
  own application/device checks. This isolated browser fixture does not establish them.
- Complete output/scratch/export admission, remaining repair owners and Studio controls,
  other-platform/fault coverage and the approved turn-239 matched visual comparison remain
  open under SPEC-061/062. This journey is not a substitute for the design-master comparison.

Restore temporary viewport overrides and stop the qualifier's original host when finished.
Clear the two build environment variables before the normal production build. Retained test
worlds/private fixture conversations are not automatic cleanup candidates.
