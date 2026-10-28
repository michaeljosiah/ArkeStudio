import { icons } from './install-journeys.icons.mjs';
export const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => icons[name] ?? '';
const btn = (label, target, primary = false) => `<button type="button" ${target ? `data-go="${target}"` : ''} class="ij-button${primary ? ' ij-primary' : ''}">${label}${primary ? icon('next') : ''}</button>`;
const row = (name, detail, state = 'Included', glyph = 'check') => `<div class="ij-row">${icon(glyph)}<div><strong>${name}</strong><p>${detail}</p></div><span class="ij-state">${state}</span></div>`;
const note = text => `<p class="ij-note">${text}</p>`;
const actions = (...buttons) => `<div class="ij-actions">${buttons.join('')}</div>`;
const head = (step, title, body) => `<div class="ij-step">${step}</div><h2 tabindex="-1">${title}</h2><p class="ij-lead">${body}</p>`;
const block = (title, body) => `<section class="ij-block"><h3>${title}</h3>${body}</section>`;
const location = `<div class="ij-location">${icon('folder')}<div><strong>Arke data &amp; local models</strong><span>D:\\Arke Studio · 180 GB free</span></div>${btn('Change folder', '243b')}</div>`;
const ready = `${row('Your workspace', 'Create, open and save worlds.', 'Ready')}${row('Local writing assistant', 'Starter model responds through Ollama.', 'Ready')}${row('Voice & dictation', 'Preset narration and English dictation.', 'Ready')}${row('Local media engine', 'ComfyUI is running. Add models when you need them.', 'Ready')}`;

export const screens = {
  choose: {
    id: '242a', title: 'One installer, three ways to begin', persona: 'Shared entry',
    body: () => `${head('WELCOME · SET UP YOUR STUDIO', 'Make Arke yours.', 'Choose how much to set up now. You can change this later in Settings.')}
      <div class="ij-choices">
      <button class="ij-choice" data-go="242f">${icon('laptop')}<span><strong>Set it up for me <small>Recommended</small></strong><span>Choose cloud or local writing. Arke handles the setup.</span><em>Review connections and downloads before starting</em></span>${icon('next')}</button>
      <button class="ij-choice" data-go="243e">${icon('settings')}<span><strong>Choose my setup</strong><span>Use your existing assistant, choose capabilities and folders.</span><em>OpenCode included · detected Claude Code or Codex optional</em></span>${icon('next')}</button>
      <button class="ij-choice" data-go="244a">${icon('folder')}<span><strong>Start lightweight</strong><span>Write, organise and use your own media. Add AI later.</span><em>No additional AI downloads</em></span>${icon('next')}</button>
      </div>${note('No Arke account is required. Your worlds stay on your computer.')}`,
  },
  '242b': {
    id: '242b', title: 'Guided · see the starter package before downloading', persona: 'Guided',
    body: () => `${head('GUIDED · REVIEW YOUR PLAN', 'A good place to start.', 'Arke will prepare your chosen writing connection and look after the local components below.')}
      <div data-guided-writing>${row('Writing assistant', 'Included OpenCode connects to Ollama + a starter text model.', 'Install', 'laptop')}</div>
      ${row('Voice & dictation', 'Kokoro preset voices + Whisper English dictation.', 'Default', 'mic')}
      ${row('Local media engine', 'ComfyUI, with its shared Python / GPU runtime.', 'Default', 'cpu')}
      ${note('Image and video models, voice cloning and larger text models can be added later from supported providers.')}
      ${location}<div class="ij-facts" data-guided-cost><div><span>Download</span><strong>About 8 GB</strong></div><div><span>Kept on disk</span><strong>About 17 GB</strong></div><div><span>Space during setup</span><strong>24 GB</strong></div></div>
      ${note('Example estimates for this drawing. Your plan will show the selected writing model, device compatibility and measured space before download.')}
      ${actions(btn('Writing connection', '242f'), btn('Install starter package', '242c', true))}`,
  },
  '242c': {
    id: '242c', title: 'Guided · useful before the downloads finish', persona: 'Guided',
    body: () => `${head('GUIDED · 2 OF 3', 'Your studio is taking shape.', 'You can start writing while local AI finishes setting up.')}
      ${row('Arke & your data folder', 'Workspace checked. You can create and save worlds.', 'Ready')}
      <div data-progress-writing>${row('Writing assistant', 'Ollama ready · downloading the starter model.', 'Downloading', 'download')}</div>
      <div class="ij-progress" data-local-progress><progress value="1.8" max="4.3" aria-label="Starter model download"></progress><span>1.8 of 4.3 GB · about 6 minutes left</span><button type="button" data-pause>Pause</button></div>
      ${row('Voice & dictation', 'Preset voices and English dictation.', 'Ready')}
      ${row('Local media engine', 'ComfyUI · verified download, unpacking files.', 'Installing', 'cpu')}
      ${note('Downloads and any next steps stay in Activity. Closing Arke pauses unfinished transfers; the next launch offers Resume.')}
      ${actions(btn('View download plan', '242b'), btn('Start writing', '244b', true))}`,
  },
  '242d': {
    id: '242d', title: 'Guided · a local component fails without blocking writing', persona: 'Guided',
    body: () => `${head('GUIDED · NEEDS ATTENTION', 'Keep going. We’ll keep your place.', 'The connection dropped while downloading the writing model. Your worlds are ready to use.')}
      ${row('Workspace', 'Create, save and import existing media.', 'Ready')}
      ${row('Writing assistant', '1.8 GB downloaded. Resume from the saved download.', 'Paused', 'warning')}
      ${row('Voice & local media engine', 'Installed components are kept.', 'Ready')}
      ${actions(btn('Resume download', '242c', true), btn('Start writing', '244b'))}
      ${block('Running low on space?', '<p>Choose another model folder or remove a component from this plan. Arke shows the revised download and space needed before continuing.</p>')}
      ${actions(btn('Change download plan', '243a'))}${note('No automatic paid fallback. An unavailable local feature explains what it needs when you use it.')}`,
  },
  '242e': {
    id: '242e', title: 'Guided · name what is actually ready', persona: 'Guided',
    body: () => `${head('GUIDED · 3 OF 3', 'Ready for your first world.', 'Your starter setup has passed its checks.')}${ready}
      ${note('Local images, video and voice cloning each need an additional model. The app shows the download before you add one.')}
      ${actions(btn('Open Arke', '244b', true))}`,
  },
  '243a': {
    id: '243a', title: 'Advanced · choose capabilities, not a wall of dependencies', persona: 'Advanced',
    body: () => `${head('CUSTOM · 1 OF 3', 'Choose what you need.', 'Core authoring is included. Select the capabilities to prepare now.')}
      <div class="ij-options">
      <label><input type="checkbox" name="writing" checked><span><strong>Writing assistance</strong><span data-writing-detail>OpenCode with a cloud provider or Ollama and a local model.</span></span></label>
      <label><input type="checkbox" name="media" checked><span><strong>Local images & video</strong><span>ComfyUI. Choose recipe models separately.</span></span></label>
      <label><input type="checkbox" name="voice"><span><strong>Preset voices & dictation</strong><span>Kokoro and Whisper. No GPU required.</span></span></label>
      </div>
      <p class="ij-note" data-selection-note>Choose sources, models and folders next. Only selected capabilities add downloads or readiness checks.</p>
      ${actions(btn('Back', '243e'), btn('Configure selected', '243b', true))}`,
  },
  '243b': {
    id: '243b', title: 'Advanced · managed by default, existing installs by explicit choice', persona: 'Advanced',
    body: () => `${head('CUSTOM · 2 OF 3', 'Make it fit your computer.', 'Arke-managed services are selected by default. Existing services stay under your control.')}
      <p class="ij-note" data-harness-summary>Writing harness: OpenCode · included. Local writing uses the model service below.</p>
      <div class="ij-field"><label>Local model service · Ollama</label><select aria-label="Writing engine source" data-source="writing"><option>Arke-managed (recommended)</option>Use an existing service</option></select><div data-existing="writing" hidden><label>Service address<input aria-label="Ollama service address" value="http://127.0.0.1:11434"></label></div></div>
      <div class="ij-field"><label>Media engine · ComfyUI</label><select aria-label="Media engine source" data-source="media"><option>Arke-managed (recommended)</option>Use an existing install folder</option>Connect to an existing service</option></select><div data-existing="media" hidden><label>Folder or address<input aria-label="ComfyUI location" placeholder="Choose a folder or enter the service address"></label></div></div>
      <div class="ij-field"><label>Local text model</label><select aria-label="Local text model"><option>Starter model · example 4.3 GB</option>Choose an installed compatible model</option>Choose another model in Settings later</option></select></div>
      ${location}
      <details><summary>Advanced</summary><p>Separate model and temporary-work folders, service addresses and download controls. Show only settings supported by the selected engine.</p><p>Existing-service checks report compatibility. Arke does not replace its Python, packages or model files.</p></details>
      ${actions(btn('Back', '243a'), btn('Review selected setup', '243d', true))}`,
  },
  '243c': {
    id: '243c', title: 'Advanced · one failed feature, three clear next steps', persona: 'Advanced',
    body: () => `${head('CUSTOM · 3 OF 3', 'One connection needs attention.', 'Writing is ready. The existing ComfyUI service did not respond.')}
      ${row('Workspace', 'Your chosen data folder is writable.', 'Ready')}
      ${row('Writing assistant', 'Selected engine and model checks passed.', 'Ready')}
      ${row('Local images & video', 'Could not reach your selected ComfyUI address.', 'Not ready', 'warning')}
      ${actions(btn('Check again', '243c'), btn('Edit connection', '243b'))}
      ${block('Choose how to continue', '<p>Start Arke with writing ready, or use an Arke-managed media engine and review its download first. Your existing service is left intact.</p>')}
      ${actions(btn('Review managed engine', '242b'), btn('Start with writing', '244b', true))}
      ${note('An unselected feature is “Not set up”, not an error. Connecting a service does not prove every model or recipe works.')}`,
  },
  '243d': {
    id: '243d', title: 'Advanced · approve only the selected dependencies', persona: 'Advanced',
    body: () => `${head('CUSTOM · REVIEW YOUR PLAN', 'Just what you chose.', 'Check the sources, models and space before starting any downloads.')}
      <div data-plan-rows>${row('Writing harness', 'OpenCode v2 is already included in Arke.', 'Included', 'laptop')}${row('Local model service', 'Arke-managed Ollama + selected starter text model.', 'Install', 'laptop')}${row('Local media engine', 'Arke-managed ComfyUI. Recipe weights added later.', 'Install', 'cpu')}</div>
      <div class="ij-facts" data-plan-cost><div><span>Download</span><strong>About 8 GB</strong></div><div><span>Kept on disk</span><strong>About 17 GB</strong></div><div><span>Space during setup</span><strong>24 GB</strong></div></div>
      ${note('Example quote. The final plan counts only missing selected files and checks each destination. Existing compatible services and models are reused.')}
      ${block('Ready when you are', '<p>Writing can begin as soon as your workspace is ready. Each selected AI capability becomes available after its own checks pass.</p>')}
      ${actions(btn('Edit choices', '243a'), btn('Install selected', '244b', true))}`,
  },
  '243e': {
    id: '243e', title: 'Advanced · use the included harness or an existing assistant', persona: 'Advanced',
    body: () => `${head('CUSTOM · YOUR WRITING ASSISTANT', 'Use the assistant you prefer.', 'OpenCode is included with Arke. You can choose a supported assistant already on this computer.')}
      <fieldset class="ij-options ij-harness"><legend>Writing harness</legend>
      <label><input type="radio" name="harness" value="opencode" checked><span><strong>OpenCode <small>Included · default</small></strong><span>Connect to local models through Ollama or a supported provider.</span></span></label>
      <label><input type="radio" name="harness" value="claude"><span><strong>Claude Code <small>Detected</small></strong><span>Use your existing installation. Check compatibility and account setup next.</span></span></label>
      <label><input type="radio" name="harness" value="codex"><span><strong>Codex <small>Detected</small></strong><span>Use your existing Codex installation and its account connection.</span></span></label>
      </fieldset>
      <p class="ij-note" data-harness-selection>OpenCode is selected. Local writing can use Ollama; hosted providers are optional.</p>
      ${note('OpenCode stays included whichever you choose. Selecting Claude Code or Codex does not require an Ollama download.')}
      <details><summary>Can’t see your installation?</summary><p>Choose the supported executable location, then check again. Arke reports an unsupported version or missing account setup before AI writing is enabled.</p>${btn('Locate existing installation', null)}</details>
      ${actions(btn('Back', 'choose'), btn('Choose capabilities', '243a', true))}`,
  },
  '242f': {
    id: '242f', title: 'Guided & Advanced · choose cloud or local writing', persona: 'Shared writing connection',
    body: () => `${head('WRITING ASSISTANCE · OPENCODE INCLUDED', 'Where should your writing AI run?', 'Choose the connection for your assistant. Arke uses OpenCode to work with the model you choose.')}
      <fieldset class="ij-options ij-harness"><legend>Writing connection</legend>
      <label><input type="radio" name="writing-route" value="local" checked><span><strong>On this computer</strong><span>Arke sets up Ollama and a compatible local model. Several GB to download; no provider account needed.</span></span></label>
      <label><input type="radio" name="writing-route" value="cloud"><span><strong>Use a cloud provider</strong><span>Connect a supported provider and choose a model. No Ollama or local writing-model download.</span></span></label></fieldset>
      <section class="ij-block"><h3 data-route-title>Local writing, ready to use</h3><p data-route-detail>Arke checks your computer, prepares Ollama and a suitable model, then checks that the model responds.</p></section>
      ${note('Cloud writing sends prompts to your selected provider. Internet access and a valid account or API key are required; usage charges may apply.')}
      ${actions(btn('Back', 'choose'), btn('Continue', '242b', true))}`,
  },
  '242g': {
    id: '242g', title: 'Guided & Advanced · connect the chosen cloud provider', persona: 'Shared writing connection',
    body: () => `${head('WRITING ASSISTANCE · CLOUD', 'Connect your writing provider.', 'Choose from the writing providers supported by OpenCode in Arke.')}
      ${block('Provider & model', '<p>Choose a supported provider, then sign in or add its API key using the connection method offered. Select a model available to that account.</p>')}
      ${row('Provider connection', 'An existing connection can be reused after checking it.', 'Required', 'cloud')}
      ${row('Writing model', 'Check access to the selected model before enabling AI writing.', 'Required', 'laptop')}
      ${note('Only supported sign-in methods are offered. A ChatGPT or Claude website login does not automatically connect OpenCode. Any chargeable test is shown before it runs.')}
      ${actions(btn('Use local writing', '242f'), btn('Choose provider & connect', '242h', true))}
      ${actions(btn('Set up writing later', '244b'))}`,
  },
  '242h': {
    id: '242h', title: 'Cloud writing · connected account and selected model checked', persona: 'Shared writing connection',
    body: () => `${head('WRITING ASSISTANCE · CLOUD', 'Your writing connection is ready.', 'OpenCode will use the provider and model you selected.')}
      ${row('Provider account', 'Selected connection authenticated.', 'Connected', 'cloud')}
      ${row('Writing model', 'Selected model access and writing capability checked.', 'Ready', 'check')}
      ${row('Local writing downloads', 'Ollama and local writing weights are not needed for this route.', 'None', 'laptop')}
      ${note('Prompts go to your selected provider. Internet access and the provider’s usage terms apply. You can change this connection in Settings.')}
      ${actions(btn('Change connection', '242g'), btn('Continue setup', '242b', true))}`,
  },
  '244a': {
    id: '244a', title: 'Lightweight · no additional AI downloads', persona: 'Lightweight',
    body: () => `${head('LIGHTWEIGHT · READY TO BEGIN', 'Start small. Make something.', 'Everything you need to write and organise is already in the app.')}
      ${row('Worlds & writing', 'Create worlds, edit by form and write your stories.')}
      ${row('Your existing media', 'Import, organise and preview your own files.')}
      ${row('Sample world', 'Explore the sample included with this build.')}
      <div class="ij-facts"><div><span>Additional AI download</span><strong>0 GB</strong></div><div><span>Local AI services</span><strong>Not started</strong></div></div>
      ${note('OpenCode is already included. AI features become available when you choose an assistant connection, a supported provider or local models. No account or internet is required for manual authoring.')}
      ${actions(btn('Use an existing assistant', '243e'))}
      ${actions(btn('Back', 'choose'), btn('Start using Arke', '244b', true))}`,
  },
  '244b': {
    id: '244b', title: 'All paths · enhance the existing Worlds landing page', persona: 'Shared destination', worlds: true,
    body: () => `<div class="fy-app" data-screen="world-picker"><div class="fy-titlebar"><div class="fy-titlebar__side"></div><button class="fy-titlebar__brand" data-go="244b"><span class="fy-brand__arke">Arke</span><span class="fy-brand__studio">Studio</span></button><div class="fy-titlebar__side fy-titlebar__side--right">${[['chat','Chat'],['cpu','System'],['bell','Activity'],['cog','Settings'],['user','Account']].map(([glyph,label])=>`<button class="fy-iconbtn" aria-label="${label}" data-message="The existing ${label} control opens its usual surface.">${icon(glyph)}</button>`).join('')}</div></div>
      <main class="fy-content"><div class="fy-home-hero"><div class="fy-hero__eyebrow">WELCOME TO YOUR STUDIO</div><h1 tabindex="-1" class="fy-hero__title fy-hero__title--home">Your first world starts here.</h1><div class="fy-home-count"><p class="fy-hero__lede">Nothing here yet.</p><button class="ij-home-action" data-message="The existing publication-opening flow opens.">${icon('book')}Open publication</button></div>
      <div class="ij-world-actions"><button class="ij-home-action" data-message="Open the supported world-folder import flow, with destination and validation before import.">${icon('upload')}Import a world</button><button class="ij-home-action" data-message="Explore the bundled sample through the current sample-world flow. Reuse its existing copy if already installed.">${icon('book')}Explore sample world</button></div></div>
      <div class="fy-home-cards"><button class="fy-worldcard fy-newworldcard" data-message="The existing New world form opens. No model is required."><span class="fy-worldcard__frame fy-worldcard__empty">${icon('plus')}</span><span class="fy-worldcard__name">Create a world</span></button></div>
      <div class="ij-world-status"><span data-world-status>Write and organise now. Add AI whenever you need it.</span><button class="ij-home-action" data-message="Open Settings to add or change capabilities.">Settings ${icon('next')}</button></div></main></div>`,
  },
  '244c': {
    id: '244c', title: 'Later · choose a supported voice provider when you need one', persona: 'Lightweight',
    body: () => `${head('LATER · ADD A CAPABILITY', 'Choose how to create voices.', 'When you need narration or voice cloning, choose from the providers Arke supports.')}
      ${row('Run on this computer', 'Choose a supported local provider and model.', 'Optional', 'cpu')}
      ${row('Use a hosted provider', 'Connect your account; review any usage costs.', 'Optional', 'cloud')}
      ${block('See what your choice needs', '<p>A local option shows its missing runtime, support files, model download and disk space. A hosted option shows its account requirements and pricing. Available choices reflect supported capabilities.</p>')}
      ${note('Voice cloning is optional and can be set up later in Settings. No provider or model is preselected here.')}
      ${actions(btn('Not now', '244b'), '<button class="ij-button ij-primary" data-message="Settings opens the supported voice-provider catalogue. This proposal does not choose or install a provider.">Browse supported providers</button>')}`,
  },
  '244d': {
    id: '244d', title: 'Lightweight · offline or incompatible hardware is a usable start', persona: 'Lightweight', compact: true,
    body: () => `${head('START WITH THE ESSENTIALS', 'Your ideas can start here.', 'This computer can run the editor. Local media generation is not available with this setup.')}
      ${row('Write & organise', 'Create and save worlds offline.', 'Ready')}
      ${row('Local AI', 'No download has started.', 'Not set up', 'cpu')}
      ${note('Connect a supported provider later, or configure a compatible local service in Settings. Arke will explain each feature’s requirements.')}
      ${actions(btn('Start using Arke', '244b', true), btn('Choose another setup', 'choose'))}`,
  },
};
export function screen(key, compact = false) {
  const s = screens[key] ?? screens.choose;
  if(s.worlds)return `<div class="ij ij-worlds ${compact ? 'ij-compact' : ''}" data-screen-label="${esc(s.title)}">${s.body()}</div>`;
  return `<div class="ij ${compact || s.compact ? 'ij-compact' : ''}" data-screen-label="${esc(s.title)}"><div class="fy-launch">
  <div class="fy-launch__art"><img class="fy-launch__media" src="../packages/client/public/launch-creation.webp" alt=""><div class="fy-launch__tag"><p class="fy-launch__tagline"><span>Build worlds.</span><span>Tell any story.</span></p><p class="fy-launch__line">Arke Studio lets you create, collaborate and bring your stories to life—anywhere.</p></div></div>
  <main class="fy-launch__column"><div class="fy-launch__mark"><span class="fy-launch__bar" aria-hidden="true"></span><span class="fy-launch__streak" aria-hidden="true"></span><span class="fy-launch__flare" aria-hidden="true"></span><h1 class="fy-launch__wordmark">Arke Studio</h1></div><div class="ij-content">${s.body()}</div></main></div></div>`;
}
export const FRAMES = Object.entries(screens).map(([key, s]) => ({...s, key, width:s.compact ? 560 : 1280, height:s.compact ? 760 : 850, markup:screen(key)}));
export const TURNS = [
  {id:242, title:'Install · guided setup and the shared entry', keys:['choose','242f','242g','242h','242b','242c','242d','242e'], rules:[
    ['Proposal', '28 October 2026. Draft for owner review. These are new journeys, not implemented installer behaviour. Current mandatory local-runtime startup is still in force until a separate approved implementation.'],
    ['One installer', 'Use the existing Windows desktop installer and bundled core. Preserve its destination choice and Launch Arke action. Do not add a second installer, persona-specific binary or website wizard in this turn. The persona choice happens on first app launch, before any optional AI acquisition.'],
    ['Current visual language', 'Use the current launch-creation poster, split/stacked launch shell, Jost wordmark, Geist typography, launch tokens and current native icons. Launch remains dark in both application themes. New controls use neutral surfaces and 44px minimum targets.'],
    ['Guided defaults', 'OpenCode is included. Offer local or cloud writing before the package review. Local chooses managed Ollama and one device-compatible starter writing model; cloud chooses a supported provider/account/model instead, excluding Ollama and local writing weights. Kokoro, Whisper and managed ComfyUI remain in the Guided package on supported hardware. Review the complete selected package before download.'],
    ['Optional', 'Voice cloning, image/video recipe weights, larger text models, cloud provider connections and remote-device access remain opt-in. Voice providers/models are selected later from the supported catalogue; no Ming-specific first-run choice. The media engine alone does not enable generation.'],
    ['Readiness', 'Core entry requires a connected coordinator, valid writable data location and working create/save path. The starter package is ready only after selected files are verified, selected engines are healthy and capability-specific checks pass. A small local model response can qualify the selected writing path; runtime health alone cannot.'],
    ['Useful while preparing', 'Start writing is available once the core is ready; selected local AI may finish in Activity. Pending or failed AI remains explicitly unavailable for the affected feature. Setup-complete and app-usable are distinct facts. No automatic provider or paid fallback.'],
    ['Estimates', 'The 8 GB download, 24 GB peak-space requirement, 180 GB free and timing in these frames are illustrative. Real review uses missing selected files, per-destination measured free space and verified expansion requirements. Show download size, disk retained and temporary peak separately; never total the entire optional catalogue. Unknown figures are labelled rather than invented.'],
    ['Recovery', 'Keep completed components and resumable download receipts. Offer Resume, change folder, edit plan and continue manually. Closing pauses unfinished transfers; restart makes their status explicit. Unselected components do not raise incidents.'],
    ['Hardware and permissions', 'Run non-mutating device/location checks before showing a local starter package. Unsupported hardware gets an explained manual/cloud/existing-service choice, not an incompatible mandatory download. A read-only or full core data folder still needs a valid destination before worlds can be saved.'],
    ['Writing connection', 'Use the same cloud/local connection step in Guided and Advanced when OpenCode writing is selected. Cloud requires a supported authenticated connection and selected usable model; local requires healthy Ollama plus a downloaded and responding compatible model. Show sign-in or API-key entry only as supported by the selected provider. No silent switch of route; unconfigured writing can be deferred without blocking manual authoring. The connected drawing is an illustrative result, not a real login.'],
  ]},
  {id:243, title:'Install · advanced setup with explicit choices', keys:['243e','243a','243b','243d','243c'], rules:[
    ['Proposal', 'Draft for owner review. Reuse the same installer, core and destination as Guided and Lightweight. No second settings system or new daemon.'],
    ['Capabilities first', 'Offer writing, local media and preset voice/dictation in familiar language. OpenCode writing then offers cloud or local, as in Guided; cloud is not a separate competing writing capability. Voice cloning is chosen later from supported providers. Reveal only selected controls and dependencies.'],
    ['Managed default', 'Arke-managed Ollama and ComfyUI are the default sources for selected local capabilities. Mere detection never adopts an existing install. Reuse requires an explicit source selection and compatibility check.'],
    ['Existing services', 'Use only source types already supported by the selected engine. A personal service stays under the user’s lifecycle; Arke does not silently install packages into it, upgrade it or promise to restart it. A URL-only ComfyUI connection cannot supply a local Python interpreter for Ming.'],
    ['Selected readiness', 'Check the capabilities selected for preparation. A failed service holds only its dependent features. The user can correct the connection, review a managed alternative or enter with the working capabilities. Never label an omitted capability broken.'],
    ['Providers', 'Cloud writing requires a connected supported provider and a selected usable model. Reuse existing connection and model-selection flows; these drawings neither collect nor store real credentials. Selecting cloud removes Ollama and local writing weights from the plan. Other selected local capabilities keep their own dependencies. Connection checks do not invoke an undisclosed paid generation.'],
    ['Advanced controls', 'Folders, supported addresses and transfer controls sit behind Advanced or the relevant source field. Keep normal users out of service details. Avoid a new arbitrary limit, universal model-size assumption or forced migration of existing model stores.'],
    ['Returning users', 'A saved plan and explicit overrides survive restart and app update. Start only selected managed owners needed by enabled features. Recheck capability readiness without rerunning onboarding or ejecting an open world. A changed package is offered with its cost before additional downloads.'],
    ['Included harness', 'OpenCode v2 remains bundled in every path. It is the default authoring harness and connects to Ollama for local writing. Bundled does not mean selected or always running; a selected alternative is not silently replaced by OpenCode on failure. Do not make nontechnical users choose a harness.'],
    ['Existing harness choice', 'Reuse SPEC-005 harness availability, discovery, explicit path and selection. Offer detected Claude Code and Codex with version/compatibility and authentication states kept distinct. This drawing illustrates detected installations; it is not a live scan. A ChatGPT or Claude website session alone is not a detected executable.'],
    ['Selection-specific readiness', 'Claude Code/Codex use their supported adapter and account flow. Do not require Ollama, download a local writing model or imply local routing merely because writing is selected. Keep hosted inference costs and content destination clear. Compatibility/account verification must not trigger undisclosed paid inference. The current private Studio diagnostic route remains separately qualified; manual Diagnostics still works.'],
  ]},
  {id:244, title:'Install · lightweight now, capabilities later', keys:['244a','244b','244c','244d'], rules:[
    ['Proposal', 'Draft for owner review. Lightweight is the same desktop application with zero additional AI downloads, not a separate product or a promise of a smaller base executable.'],
    ['Bundled baseline', 'The current base includes client, coordinator, OpenCode v2, Voxa, ffmpeg, native index and the bundled sample where present. They remain installer contents across all three paths. The 0 GB claim refers only to additional AI downloads; the installer and extracted app still occupy disk.'],
    ['No forced AI', 'Do not fetch/start ComfyUI, Ollama, text weights, Kokoro/Whisper weights or Ming for an unselected lightweight plan. Bundled tools may start only where needed by enabled core functions. No cloud account, key, GPU or network is required for manual authoring.'],
    ['Immediate use', 'Once the coordinator and writable workspace are ready, allow world creation by form, editing, browsing, bundled sample exploration and supported import/preview of existing media. AI chat, generated media, narration and dictation need their own configured capability.'],
    ['Add on first use', 'An unavailable AI action offers its capability, complete missing dependency list, download/storage costs, destination and alternative provider choice. Not now returns without losing the creative draft. After approval only this capability is prepared; existing verified dependencies are reused.'],
    ['Provider dependency clarity', 'A later local voice-provider selection reveals only that provider’s required runtime/support/model downloads, reusing compatible installed dependencies where possible. A hosted choice reveals account and usage costs. Never assume every supported voice provider shares one runtime or capabilities.'],
    ['Quiet states', 'Not set up is normal. Do not repeatedly nag, open dialogs or show fault badges for declined optional features. Actual failed accepted downloads can offer a contextual next step. Model-free diagnostics remain useful without a diagnostic model.'],
    ['Device scope', 'The compact frame is a narrow desktop window. Phones/tablets connecting to an existing host use the existing pairing journey; this design does not download desktop services onto a phone or bypass host approval.'],
    ['Approval boundary', 'Approval of these drawings would authorize the journey direction only. SPEC-016 R-1–R-5 and the later mandatory-runtime policy must be reconciled explicitly before implementation. Existing users keep their configuration; no migration or new startup downloads are performed by this review.'],
    ['One Worlds landing', 'All setup paths enter the existing /worlds page. Enhance WorldPickerScreen with Import a world and Explore sample world beside its current Create a world card and Open publication action; do not add a duplicate What will you create step. Existing worlds retain their current greeting, grid and archive behaviour. The sample follows availability and existing-copy state. Setup progress belongs in Activity, with only a small contextual status on Worlds.'],
  ]},
];
