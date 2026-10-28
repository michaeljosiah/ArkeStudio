# Installation journeys · turns 242–244

28 October 2026 · **Revision 3 · Draft for owner review. Not implemented.**

Owner feedback: keep specific voice providers/models out of onboarding; confirm OpenCode is
included in all paths; offer explicitly selected existing Claude Code and Codex installations.
Revision 2 implemented those changes in the drawings and walkthrough only. Revision 3 removes
the duplicate world-entry step and enhances the current Worlds landing page with Import a world
and Explore sample world. Guided and Advanced now share an explicit OpenCode cloud/local writing
choice, including the provider connection handoff and an illustrative checked-model result.

The owner requested journeys for people who want setup handled for them, technical users who
want control, and people who want minimal downloads. These turns build on the **current**
application launch screen: its creation poster, split/stacked shell, Jost wordmark, Geist
fonts, neutral controls, launch tokens and native icons. They introduce no replacement brand
or icon family. The review's light/dark control themes the review canvas; launch stays dark,
as it does in the application. A narrow drawing represents a desktop window, not installing
Windows runtimes on a phone.

## Shared journey

Download the existing Windows installer → choose installation location if desired → install
the base app → launch Arke → choose Guided, Advanced or Lightweight → check the writable
workspace → the existing **Worlds landing page** → create a world, import an existing world,
or explore the bundled sample. There is no separate “What will you create?” onboarding page.
Show the sample option only when the build carries it. No account is required for local work.
The Windows installer already supports changing the installation directory. This design leaves
that installer intact; the capability choice belongs inside Arke before AI downloads begin.

The same base package serves every path. It includes the client/coordinator, OpenCode v2,
Voxa, ffmpeg/native media tools, native index and included sample. The latest local x64
qualification installer measured 357,694,424 bytes (about 358 MB decimal); its installed size
is larger. Lightweight means **zero additional AI downloads**, not an already achieved
reduction of those bundled files. A separate slim installer is outside these turns.

## Persona map

| | Guided · turn 242 | Advanced · turn 243 | Lightweight · turn 244 |
|---|---|---|---|
| Promise | Arke chooses and manages a sensible starter setup | Choose capabilities and the sources that provide them | Start writing with minimal download |
| Default additions | Included OpenCode with a chosen cloud provider or managed Ollama + compatible local model; Kokoro, Whisper and managed ComfyUI on supported hardware | Only selected capabilities and dependencies; OpenCode offers the same cloud/local choice; managed local sources preselected | None |
| Optional | Image/video recipe weights, voice cloning from supported providers, larger text models, remote access | Existing Claude Code/Codex harness, local capabilities/models, cloud providers and supported overrides | All AI capabilities, existing supported assistant connections and remote access |
| Enter the app | Core connected; valid writable workspace; create/save path available | Same core checks | Same core checks, including offline |
| Claim AI ready | Cloud: authenticated provider and selected usable model. Local: verified files, healthy Ollama and a responding compatible model. Other selected tools pass their own checks | Same writing checks; qualify existing harness/account where selected; report independent capability results | Only after the user later selects and prepares a capability |
| Continue during failure | Write manually; resume or adjust accepted download | Fix source, review managed alternative, or continue with ready capabilities | Unconfigured AI stays quiet; manual work remains available |
| On reopening | Reuse verified installs; check enabled services; offer Resume for paused transfers | Preserve explicit overrides and selected capabilities | Do not acquire/start unselected local AI |

**App usable is different from local AI ready.** Guided setup can finish its accepted downloads
in Activity while the user writes. A failure must not be hidden behind a green “all ready” badge,
but it also must not prevent unrelated manual authoring. A full or unwritable **core data folder**
does need repair or a valid new destination before saving a world.

## Defaults needing review

Guided offers **cloud or local writing** through bundled OpenCode before reviewing downloads.
Cloud uses a supported provider's sign-in or API-key method, followed by model selection and
connection/model checks. Reuse the current provider and model flows; do not assume every provider
supports browser login, or that a ChatGPT/Claude website session authorizes OpenCode. A selected
cloud route adds no Ollama or local writing weights, while separately selected ComfyUI/voice tools
keep their own downloads. Both paths can defer AI writing and enter Worlds for manual work.

Local proposes a **usable writing model**, not just an empty Ollama service. The concrete model
must come from the existing qualified catalogue and device checks, with the selected model and
cost disclosed before the single Install action. The drawing's 4.3 GB starter is an example,
not a universal hardware recommendation. Unsupported local profiles lead to an explicit
manual/hosted/existing-service choice. There is no automatic cloud or paid fallback.

ComfyUI is included in Guided to preserve the requested managed-local foundation where supported.
Its engine alone cannot generate pictures or videos: recipe weights remain optional and are named
as such. Voice cloning is set up later by selecting from supported providers; no named voice
model or provider is promoted in first run. A selected local provider's actual dependencies
are then shown, with compatible existing runtimes reused. Hosted providers show their own
account and usage costs. Existing installations require explicit selection and compatibility
checks; their packages and lifecycle stay under their owner's control.

OpenCode v2 is already part of the base installer in **all three paths**. Guided uses it by
default and names it only as included context; nobody needs to make a technical harness choice
to begin. OpenCode is the harness; Ollama is its local model service, and is a separate optional
download when the chosen writing route needs it.

Advanced now starts with **Writing harness**: included OpenCode, or detected Claude Code/Codex.
The drawing's Detected labels are illustrative, not a scan of this computer. Reuse existing
`HarnessAvailability`, executable discovery/explicit paths, adapter qualification, account flows
and selection persistence (SPEC-005, draft). Detection is not authentication or capability proof.
Show absent/unsupported choices with the applicable next step; never silently select a found
binary. A website login to ChatGPT or Claude alone is not an installed supported harness.

Selecting Claude Code or Codex removes Ollama and local-writing-model downloads from that
writing plan. Each uses the account/model route supported by its own adapter; do not promise
Ollama routing or identical capabilities for all harnesses. OpenCode remains bundled without
becoming a silent fallback or a second mandatory running authoring process. A Lightweight user
can choose an existing assistant without preselecting local media downloads. Verification must
make any chargeable probe explicit; opening the selection screen cannot trigger paid inference.

The local 8 GB additional download / 17 GB retained / 24 GB peak and cloud-writing package
3.7 GB / 12 GB / 18 GB (3.5 GB download without voice), 180 GB available, locations, timing, progress and
all health outcomes in the drawings are **illustrative**. Production must distinguish download,
retained disk and temporary peak on each real destination, count only missing selected files,
and label unknown estimates. Catalogue size metadata is not a proven installed-footprint quote.
Changed local download plans require a complete quote before installation. Reusing an existing
assistant alone needs no additional AI download, but still requires compatibility/account checks.

Provider choice is provider-neutral. It is required to enable a selected cloud writing route;
AI writing itself can be deferred. Connection flows are not redesigned here and
the prototype never accepts real credentials. Checking a connection is not permission for a paid
generation. The current private Studio diagnostic conversation has a narrower qualified managed
Ollama route than ordinary writing; a hosted writing setup must not imply that private route is
available. Model-free Diagnostics remains available in every path.

## Current implementation and specification boundary

Read: SPEC-005 (draft), existing harness availability/settings/discovery/assembly; SPEC-016
(draft) R-1–R-8 and its later managed-runtime/readiness amendments; ADR-004
(proposed); current `launch.tsx`, setup catalogue, desktop packaging and managed runtime guide.
The original SPEC-016 manual/offline onboarding intent and the later mandatory ComfyUI/Ollama
entry gate now need explicit reconciliation. These drawings propose that reconciliation; they do
not silently change either policy or the running app. SPEC-016 and runtime setup requirements
must be amended after approval, alongside implementation. No unrelated recovery epic scope is
added by this design-only work.

Keep onboarding selections persisted without duplicate settings authorities. Stop optional
acquisition until a plan is accepted. On update, preserve existing installs/selections and show
new components as offers. Do not force existing users through a persona wizard or silently
download a new starter model. Separate readiness of a feature from presence of its files.

## Frames and review

- **242a, 242f–h, then 242b–e:** shared choice, cloud/local writing, provider-connection handoff,
  illustrative connected result, Guided package review, progress, interruption and ready states.
- **243e then 243a–d:** included/existing harness choice, capabilities, managed/existing source
  controls, selected download review and partial-ready service failure. OpenCode writing routes
  through the same 242f–h connection step before source configuration.
- **244a–d:** Lightweight summary, enhanced existing Worlds page, later supported voice-provider choice,
  offline/narrow window.

The interactive walkthrough is a bounded design fixture. Navigation, capability selections,
source controls, Pause/Resume, narrow-window and review-theme controls operate locally. Static
drawings retain representative example states. No downloads, service requests, paid calls,
world creation, credential handling or filesystem mutation is attached to product controls.

Worlds derives its layout from current `WorldPickerScreen` in `shell.tsx`, `chrome.tsx`,
`fidelity.css` and `home.css`. The generator copies the current base rules under a new drawing-only
scope and uses the native icons; current source hashes are recorded. The new empty-state heading
applies only when there are no worlds; existing worlds retain their greeting, cards and archive
behaviour. Import uses the supported import flow. Sample availability/download/already-installed
states follow the existing sample flow; this drawing illustrates a bundled sample. The small
readiness line points to Activity/Settings rather than adding another onboarding destination.

Build/validate from repository root:

```powershell
node design-system/install-journeys.mjs
node design-system/check-master.mjs --record
node design-system/build-review.mjs
node design-system/check-master.mjs
node design-system/build-review.mjs --check
node design-system/install-journeys.serve.mjs
```

The server exposes **only new turns 242–244 and their current application assets**. It does not
serve the previously blocked design master, consolidated review or earlier turns. Reviewing
these new drawings is not the still-outstanding turn-239 implementation comparison.

Review evidence, 28 October: the new HTTP page rendered in the in-app browser with current
Geist/launch assets. Guided navigation, simulated Pause, start-writing while downloads remain
pending, Advanced selection/review navigation and Lightweight were exercised. The 559px-wide
Lightweight preview had no horizontal overflow and both actions measured 44px high. Light and
dark review canvases preserve the dark launch surface. Native source-dropdown automation did
not change the selected option, so that interaction is not claimed as verified. Screenshots of
the shared entry and three persona screens were delivered in the conversation. Master anchor/
token/history checks and consolidated review generation/check passed; no application tests or
installer execution are implied by this design-only verification.

Revision 2 browser checks: selecting Codex in the new harness radio group updates the writing
capability, removes Ollama/local-text-model fields and retains the selected harness in the plan.
Entering that flow from Lightweight leaves media, voice and separate provider setup unselected;
the resulting plan shows zero additional AI download and a compatibility/account-check action.
Returning to the harness screen and selecting OpenCode updates the choice correctly. The new
243e screen was visually inspected and captured for the owner. These checks exercise the design
fixture, not installed harness discovery, authentication or inference.

Revision 3 browser checks: Guided local retains Ollama and the starter model. Guided cloud
passes through the provider handoff/result example, removes local writing downloads from its
plan and hides local-model progress. Advanced OpenCode uses the same choice; its cloud route
hides Ollama/model fields, retains selected ComfyUI and produces the corresponding plan.
Lightweight and in-progress Guided both enter the revised Worlds page. Import/sample controls
reach their described handoffs. Worlds was visually checked in light and dark, and at a 559px
content width with no horizontal overflow; both new actions measured 44px high. Screenshots of
Worlds and the writing choice were saved for review. No real connection, import, installation
or inference was performed by these design-fixture checks.
