# Installation journeys · turns 242–244

28 October 2026 · **Draft for owner review. Not approved or implemented.**

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
workspace → create a world, open/import an existing world, or explore the bundled sample.
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
| Default additions | Managed Ollama, one compatible starter text model, Kokoro, Whisper, managed ComfyUI on supported hardware | Only selected capabilities and dependencies; managed engine sources preselected | None |
| Optional | Image/video recipe weights, Ming variants, larger text models, providers, remote access | Each local capability/model, cloud provider and supported source override | All AI capabilities and remote access |
| Enter the app | Core connected; valid writable workspace; create/save path available | Same core checks | Same core checks, including offline |
| Claim local AI ready | Verified selected files; running healthy engines; model/capability checks | Only the chosen capability's checks; report independent results | Only after the user later selects and prepares a capability |
| Continue during failure | Write manually; resume or adjust accepted download | Fix source, review managed alternative, or continue with ready capabilities | Unconfigured AI stays quiet; manual work remains available |
| On reopening | Reuse verified installs; check enabled services; offer Resume for paused transfers | Preserve explicit overrides and selected capabilities | Do not acquire/start unselected local AI |

**App usable is different from local AI ready.** Guided setup can finish its accepted downloads
in Activity while the user writes. A failure must not be hidden behind a green “all ready” badge,
but it also must not prevent unrelated manual authoring. A full or unwritable **core data folder**
does need repair or a valid new destination before saving a world.

## Defaults needing review

Guided proposes a **usable writing model**, not just an empty Ollama service. The concrete model
must come from the existing qualified catalogue and device checks, with the selected model and
cost disclosed before the single Install action. The drawing's 4.3 GB starter is an example,
not a universal hardware recommendation. Unsupported local profiles lead to an explicit
manual/hosted/existing-service choice. There is no automatic cloud or paid fallback.

ComfyUI is included in Guided to preserve the requested managed-local foundation where supported.
Its engine alone cannot generate pictures or videos: recipe weights remain optional and are named
as such. Ming reuses that compatible local Python/PyTorch/CUDA installation, with its isolated
support overlay and selected 0.5B or 7.9B weights. A remote ComfyUI endpoint does not provide a
local Python environment. Existing installations require explicit selection and compatibility
checks; their packages and lifecycle stay under their owner's control.

The 8 GB additional download, 17 GB retained files, 24 GB peak space, 180 GB available, locations, timing, progress and
all health outcomes in the drawings are **illustrative**. Production must distinguish download,
retained disk and temporary peak on each real destination, count only missing selected files,
and label unknown estimates. Catalogue size metadata is not a proven installed-footprint quote.
The Ming offer deliberately keeps its download button unavailable while its full quote is missing.

Provider choice is optional and provider-neutral. Connection flows are not redesigned here and
the prototype never accepts real credentials. Checking a connection is not permission for a paid
generation. The current private Studio diagnostic conversation has a narrower qualified managed
Ollama route than ordinary writing; a hosted writing setup must not imply that private route is
available. Model-free Diagnostics remains available in every path.

## Current implementation and specification boundary

Read: SPEC-016 (draft) R-1–R-8 and its later managed-runtime/readiness amendments; ADR-004
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

- **242a–e:** shared choice, Guided package review, in-progress start, interrupted download,
  completed capability checks.
- **243a–d:** capabilities, managed/existing source controls, selected download review and
  partial-ready service failure.
- **244a–d:** Lightweight summary, shared world entry, later Ming offer, offline/narrow window.

The interactive walkthrough is a bounded design fixture. Navigation, capability selections,
source controls, Pause/Resume, narrow-window and review-theme controls operate locally. Static
drawings retain representative example states. No downloads, service requests, paid calls,
world creation, credential handling or filesystem mutation is attached to product controls.

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
