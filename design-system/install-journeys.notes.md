# Installation journeys · turns 242–244

28 October 2026 · **Revision 5 · Approved by the owner. Implementation in progress.**

Owner feedback: keep specific voice providers/models out of onboarding; confirm OpenCode is
included in all paths; offer explicitly selected existing Claude Code and Codex installations.
Revision 2 implemented those changes in the drawings and walkthrough only. Revision 3 removes
the duplicate world-entry step and enhances the current Worlds landing page with Import a world
and Explore sample world. Guided and Advanced now share an explicit OpenCode cloud/local writing
choice, including the provider connection handoff and an illustrative checked-model result.
Revision 4 restores the sample as the second empty-state card, simplifies Guided/Lightweight
language, adds computer-aware Guided choices and detected-assistant selection, and draws the
actual ChatGPT/GitHub Copilot account picker with future Arke disabled.
Revision 5 replaces the straight world tiles with the actual first-run card treatment and
renames the account-entry action to “Set up an AI writing agent”, with a matching picker heading.

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
| Default additions | Check the computer first; offer a suitable local writing model, an online account or explicitly chosen compatible installed assistant. Include only supported voice/media tools | Only selected capabilities and dependencies; OpenCode offers the online/local choice; managed local sources preselected | None |
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

Guided is a **smart setup**: check the machine, qualified model catalogue, destinations and
compatible installed assistants before showing choices. A local writing offer needs at least
one supported model with a fitting device profile, usable context, memory and disk/temporary
space requirements. Check OS, CPU/backend and GPU/VRAM only where that model requires them;
absence of a GPU is not a universal rejection of CPU models. Installing Ollama alone does not
qualify this option. An unknown result must not appear as suitable: explain the incomplete check
and allow retry, an online account or manual writing. Do not start a download during discovery.
Picture/video and voice preparation each have their own supported profile checks, so an
unsuitable media engine is not included simply because the writing choice works.

When compatible Claude Code/Codex installations are found, Guided offers an explicit choice
between those assistants and “Let Arke set it up”. Skip that extra choice when none are found.
Installation discovery is not authentication: check the selected assistant's account/model
readiness separately, using its own supported sign-in flow. Do not read/copy personal credentials.
OpenCode remains the included default behind the nontechnical “Let Arke set it up” choice.

For OpenCode, the initial account UI offers **ChatGPT** and **GitHub Copilot**. **Arke** is visible
but disabled with “Coming later”; no endpoint, login or promised date exists. This shortlist is
for onboarding, not a removal of other providers from the general Settings catalogue. Only
enable a supported sign-in method reported by the actual bundled harness. This is a proposed
onboarding exception to SPEC-030 R-7's general catalogue rule, to amend with implementation.
The browser/account flow is then followed by account and available-model checks. Guided chooses
a supported recommended writing model from the connected account; Advanced retains model control.
No accessible model means no Ready state. Existing connections can be reused when actually
available, but a website login alone does not authorize Arke's isolated harness.

ChatGPT uses its account sign-in method. GitHub Copilot uses the supplied GitHub sign-in
instructions/device code, including any required deployment questions returned by that method.
No API-key entry is in this initial two-account picker. A selected online route excludes Ollama
and local writing weights; separately supported media/voice tools retain their own downloads.
Writing can be deferred without blocking manual authoring.

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

OpenCode v2 is already part of the base installer in **all three paths**. Guided and Lightweight
do not name it, Ollama, ComfyUI, Python/CUDA, Kokoro or Whisper in their normal product copy.
They say writing help, on this computer, online account, read aloud and picture/video tools.
Names remain where essential to choose an account or recognised existing assistant; Advanced and
technical details retain the actual dependency names. Ollama is downloaded only for a chosen
local writing route that can use a suitable model.

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
all health outcomes in the drawings are **illustrative**. The small-computer example retains
only voice support (0.2 GB / 1 GB / 2 GB), with online writing; these are not measured package
quotes or a hardware recommendation. Production must distinguish download,
retained disk and temporary peak on each real destination, count only missing selected files,
and label unknown estimates. Catalogue size metadata is not a proven installed-footprint quote.
Changed local download plans require a complete quote before installation. Reusing an existing
assistant alone needs no additional AI download, but still requires compatibility/account checks.

The first-run account shortlist follows the owner's requested ChatGPT/Copilot scope. Other
capability catalogues remain provider-neutral. The picker and waiting/result states are drawn
here, with existing sign-in services behind them; the prototype never accepts real credentials.
Checking a connection is not permission for a paid
generation. The current private Studio diagnostic conversation has a narrower qualified managed
Ollama route than ordinary writing; a hosted writing setup must not imply that private route is
available. Model-free Diagnostics remains available in every path.

## Current implementation and specification boundary

Read: SPEC-005 and SPEC-030 (draft), existing harness availability/settings/discovery/assembly,
`VendorAuthService`, client `SettingsSignInScreen` and adapter vendor-auth fixtures; SPEC-016
(draft) R-1–R-8 and its later managed-runtime/readiness amendments; ADR-004
(proposed); current `launch.tsx`, setup catalogue, desktop packaging and managed runtime guide.
The original SPEC-016 manual/offline onboarding intent and the later mandatory ComfyUI/Ollama
entry gate now need explicit reconciliation. The owner approved this reconciliation and implementation on 28 October 2026. SPEC-016 and
runtime setup requirements must be amended alongside implementation. The drawings remain a
simulated reference, not evidence of completed product behaviour. No unrelated recovery epic scope is
added by this design-only work.

Keep onboarding selections persisted without duplicate settings authorities. Stop optional
acquisition until a plan is accepted. On update, preserve existing installs/selections and show
new components as offers. Do not force existing users through a persona wizard or silently
download a new starter model. Separate readiness of a feature from presence of its files.

## Frames and review

- **242a, 242i–k, 242f–h/242l, then 242b–e:** shared choice, automatic computer check, conditional
  existing-assistant choice, suitable local/online or online/manual choices, actual account
  picker, browser sign-in waiting state, checked result and Guided package/progress/ready states.
- **243e then 243a–d:** included/existing harness choice, capabilities, managed/existing source
  controls, selected download review and partial-ready service failure. OpenCode writing routes
  through the same 242f–h connection step before source configuration.
- **244a–d:** Lightweight summary, enhanced existing Worlds page, later supported voice-provider choice,
  offline/narrow window.

The interactive walkthrough is a bounded design fixture. Navigation, capability selections,
source controls, Pause/Resume, narrow-window and review-theme controls operate locally. Static
drawings retain representative example states. No downloads, service requests, paid calls,
world creation, credential handling or filesystem mutation is attached to product controls.

The old `FirstRunScreen` has two doors: “Your first world” and “Or start from ours” when a sample
is available. `WorldPickerScreen` has Create plus existing world cards, and a sample link in its
empty state. The revised Worlds empty state keeps **two cards**, Create and Explore sample world
(The Undersong), and adds Import beside Open publication. It avoids an extra onboarding page.

Worlds derives its header/layout from current `WorldPickerScreen` and the empty-state card pair
from `FirstRunScreen` in `shell.tsx`. Revision 4 did not exactly match the first-run cards: it used
straight world-thumbnail tiles. The current first-run pair is 290px wide and at least 380px high,
with a dashed Create border at −1.5° and a solid sample border at +1.5°. Both straighten and lift
8px on desktop hover, with the existing drift, ring icons, card radius, type and button styles.
The regular existing-world grid has its own varying tilts; its Create tile defaults to upright.
These are different card treatments, not a missing tilt on every card in the app.

The generator now copies the actual card and button rule bodies from `fidelity.css`, `home.css`
and `ui.css` under a new drawing-only scope, with native Plus/Sparkle icons at the current 22px.
Narrow card rules preserve the current stacked layout and ±1° tilt; viewport queries become
container queries for the review frame. Placement remains the proposed Worlds layout, not an
exact copy of the old first-run page. Current source hashes are recorded. The new empty-state heading
applies only when there are no worlds; existing worlds retain their greeting, cards and archive
behaviour. Import uses the supported import flow. Sample availability/download/already-installed
states follow the existing sample flow; this drawing illustrates a bundled sample. The small
readiness line points to Activity/Settings rather than adding another onboarding destination.

Provider references checked 28 October 2026: [OpenCode v2 provider documentation](https://opencode.ai/v2/docs/providers/)
describes ChatGPT account sign-in and subsequent model selection. [OpenCode's Copilot instructions](https://opencode.ai/docs/providers/#github-copilot)
describe the GitHub device-code flow. The latter is general documentation, not qualification of
Arke's exact bundled version. Local adapter/client fixtures cover both method shapes; shipping
implementation must use the live supported method catalogue and repeat native qualification.

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

Revision 4 browser checks: the no-suitable-model example contains no local-writing radio and
offers online/manual routes; its accepted account plan omits both local writing and incompatible
media setup. The suitable-model example offers a local plan. The existing-assistants example
shows Claude Code/Codex and honours an explicit Codex selection before account checks. With no
detected assistants, Lightweight hides that extra choice. ChatGPT and Copilot open their distinct
waiting states; the review-only failure control leaves writing unready and success advances the
simulated account/model check. Arke is disabled. Advanced uses the same account picker and keeps
Copilot in the reviewed plan. Lightweight account setup returns directly to Worlds with no local
downloads. Guided/Lightweight summary text contained none of the dependency names listed above.
The two-card Worlds empty state and account picker were visually inspected and captured. The
559px account preview had no horizontal overflow and its choices exceeded 44px. These are fixture
checks only; there was no hardware scan, real sign-in, download or native provider qualification.

Revision 5 browser checks: both desktop cards measured 290 × 380px with a 14px radius, native
22px icons and computed rotations of −1.5°/+1.5°. Dashed/solid borders and existing button styles
were verified in light and dark. The narrow frame stacks full-width cards at −1°/+1° with no
horizontal overflow; a drawing layout override found during this check was corrected. The
desktop hover rule is copied from current source, not a claim of pointer-hover automation.
Create/sample buttons reach their existing-flow handoff descriptions. The new “Set up an AI
writing agent” action opens the explicitly labelled provider picker, and Back returns to
Lightweight. Updated Worlds, Lightweight and account-picker screenshots were saved for review.
This checks the proposed drawing; no installed application or installer was changed.
