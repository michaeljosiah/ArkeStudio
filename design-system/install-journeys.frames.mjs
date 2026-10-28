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
      <button class="ij-choice" data-go="242b">${icon('laptop')}<span><strong>Set it up for me <small>Recommended</small></strong><span>Arke manages local writing, voice and the media engine.</span><em>Several GB · see the download plan first</em></span>${icon('next')}</button>
      <button class="ij-choice" data-go="243a">${icon('settings')}<span><strong>Choose my setup</strong><span>Select capabilities, folders and existing services.</span><em>Download only what you select</em></span>${icon('next')}</button>
      <button class="ij-choice" data-go="244a">${icon('folder')}<span><strong>Start lightweight</strong><span>Write, organise and use your own media. Add AI later.</span><em>No additional AI downloads</em></span>${icon('next')}</button>
      </div>${note('No Arke account is required. Your worlds stay on your computer.')}`,
  },
  '242b': {
    id: '242b', title: 'Guided · see the starter package before downloading', persona: 'Guided',
    body: () => `${head('GUIDED · 1 OF 3', 'A good place to start.', 'Arke will install and look after these local components for you.')}
      ${row('Writing assistant', 'Ollama + one starter text model suited to this PC.', 'Default', 'laptop')}
      ${row('Voice & dictation', 'Kokoro preset voices + Whisper English dictation.', 'Default', 'mic')}
      ${row('Local media engine', 'ComfyUI, with its shared Python / GPU runtime.', 'Default', 'cpu')}
      ${note('Image and video models, Ming voice cloning, larger text models and cloud connections are optional. Add them when needed.')}
      ${location}<div class="ij-facts"><div><span>Download</span><strong>About 8 GB</strong></div><div><span>Kept on disk</span><strong>About 17 GB</strong></div><div><span>Space during setup</span><strong>24 GB</strong></div></div>
      ${note('Example estimates for this drawing. Your plan will show the selected writing model, device compatibility and measured space before download.')}
      ${actions(btn('Back', 'choose'), btn('Install starter package', '242c', true))}`,
  },
  '242c': {
    id: '242c', title: 'Guided · useful before the downloads finish', persona: 'Guided',
    body: () => `${head('GUIDED · 2 OF 3', 'Your studio is taking shape.', 'You can start writing while local AI finishes setting up.')}
      ${row('Arke & your data folder', 'Workspace checked. You can create and save worlds.', 'Ready')}
      ${row('Writing assistant', 'Ollama ready · downloading the starter model.', 'Downloading', 'download')}
      <div class="ij-progress"><progress value="1.8" max="4.3" aria-label="Starter model download"></progress><span>1.8 of 4.3 GB · about 6 minutes left</span><button type="button" data-pause>Pause</button></div>
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
      <label><input type="checkbox" name="writing" checked><span><strong>Local writing assistant</strong><span>Ollama and one selected text model.</span></span></label>
      <label><input type="checkbox" name="media" checked><span><strong>Local images & video</strong><span>ComfyUI. Choose recipe models separately.</span></span></label>
      <label><input type="checkbox" name="voice"><span><strong>Preset voices & dictation</strong><span>Kokoro and Whisper. No GPU required.</span></span></label>
      <label><input type="checkbox" name="ming"><span><strong>Ming voice cloning</strong><span>Choose 0.5B or 7.9B; uses ComfyUI’s Python runtime.</span></span></label>
      <label><input type="checkbox" name="cloud"><span><strong>Connect a cloud provider</strong><span>Use your provider account. Usage charges may apply.</span></span></label></div>
      <p class="ij-note" data-selection-note>Choose sources, models and folders next. Only selected capabilities add downloads or readiness checks.</p>
      ${actions(btn('Back', 'choose'), btn('Configure selected', '243b', true))}`,
  },
  '243b': {
    id: '243b', title: 'Advanced · managed by default, existing installs by explicit choice', persona: 'Advanced',
    body: () => `${head('CUSTOM · 2 OF 3', 'Make it fit your computer.', 'Arke-managed services are selected by default. Existing services stay under your control.')}
      <div class="ij-field"><label>Writing engine · Ollama</label><select aria-label="Writing engine source" data-source="writing"><option>Arke-managed (recommended)</option>Use an existing service</option></select><div data-existing="writing" hidden><label>Service address<input aria-label="Ollama service address" value="http://127.0.0.1:11434"></label></div></div>
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
      <div data-plan-rows>${row('Local writing assistant', 'Arke-managed Ollama + selected starter text model.', 'Install', 'laptop')}${row('Local media engine', 'Arke-managed ComfyUI. Recipe weights added later.', 'Install', 'cpu')}</div>
      <div class="ij-facts" data-plan-cost><div><span>Download</span><strong>About 8 GB</strong></div><div><span>Kept on disk</span><strong>About 17 GB</strong></div><div><span>Space during setup</span><strong>24 GB</strong></div></div>
      ${note('Example quote. The final plan counts only missing selected files and checks each destination. Existing compatible services and models are reused.')}
      ${block('Ready when you are', '<p>Writing can begin as soon as your workspace is ready. Each selected AI capability becomes available after its own checks pass.</p>')}
      ${actions(btn('Edit choices', '243a'), btn('Install selected', '244b', true))}`,
  },
  '244a': {
    id: '244a', title: 'Lightweight · no additional AI downloads', persona: 'Lightweight',
    body: () => `${head('LIGHTWEIGHT · READY TO BEGIN', 'Start small. Make something.', 'Everything you need to write and organise is already in the app.')}
      ${row('Worlds & writing', 'Create worlds, edit by form and write your stories.')}
      ${row('Your existing media', 'Import, organise and preview your own files.')}
      ${row('Sample world', 'Explore the sample included with this build.')}
      <div class="ij-facts"><div><span>Additional AI download</span><strong>0 GB</strong></div><div><span>Local AI services</span><strong>Not started</strong></div></div>
      ${note('AI chat, generation, narration and dictation become available when you connect a provider or add local models. No account or internet is required for manual authoring.')}
      ${actions(btn('Back', 'choose'), btn('Start using Arke', '244b', true))}`,
  },
  '244b': {
    id: '244b', title: 'All paths · the same first world, with an honest capability summary', persona: 'Shared destination',
    body: () => `${head('YOUR STUDIO', 'What will you create?', 'Start with a world of your own, or explore one that’s already here.')}
      <div class="ij-choices">
      <button class="ij-choice" data-message="The existing New world form opens. No model is required.">${icon('folder')}<span><strong>Create a world</strong><span>Give it a name and begin with the form.</span></span>${icon('next')}</button>
      <button class="ij-choice" data-message="The existing world-folder import opens. The original stays yours.">${icon('folder')}<span><strong>Open or import a world</strong><span>Continue work you already have.</span></span>${icon('next')}</button>
      <button class="ij-choice" data-message="The bundled sample is copied to a new world identity, using the existing flow.">${icon('laptop')}<span><strong>Explore the sample world</strong><span>Included with this build. No download.</span></span>${icon('next')}</button></div>
      ${block('Add AI whenever you’re ready', '<p>Connect a provider or install a local capability in Settings. Each offer explains what it unlocks and what it downloads.</p>')}
      ${actions(btn('Explore local voice', '244c'))}${note('This drawing shows a manual-authoring start. The same destination reflects active downloads or configured AI when present.')}`,
  },
  '244c': {
    id: '244c', title: 'Lightweight · add one capability with its complete dependency cost', persona: 'Lightweight',
    body: () => `${head('ADD A CAPABILITY', 'Clone a voice with Ming.', 'Ming runs locally. Here is what this computer needs before you can use it.')}
      ${row('Ming 3 · 0.5B', 'Selected voice model. The larger 7.9B model is optional.', 'Selected', 'mic')}
      ${row('Shared Python / GPU runtime', 'Install Arke-managed ComfyUI, or reuse a checked selected install.', 'Required', 'cpu')}
      ${row('Ming support files', 'Small support files needed to run this voice model.', 'Required', 'download')}
      ${block('Review the complete download', '<p>The plan includes missing runtime, support files and model weights. Already verified files count as reused. Arke measures free space on each selected destination.</p>')}
      ${note('This preview has no live download quote. In the app, the action becomes available once the complete size and device checks are shown. No unrelated image/video weights are added.')}
      ${actions(btn('Not now', '244b'), '<button class="ij-button ij-primary" disabled>Calculating download…</button>')}`,
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
  return `<div class="ij ${compact || s.compact ? 'ij-compact' : ''}" data-screen-label="${esc(s.title)}"><div class="fy-launch">
  <div class="fy-launch__art"><img class="fy-launch__media" src="../packages/client/public/launch-creation.webp" alt=""><div class="fy-launch__tag"><p class="fy-launch__tagline"><span>Build worlds.</span><span>Tell any story.</span></p><p class="fy-launch__line">Arke Studio lets you create, collaborate and bring your stories to life—anywhere.</p></div></div>
  <main class="fy-launch__column"><div class="fy-launch__mark"><span class="fy-launch__bar" aria-hidden="true"></span><span class="fy-launch__streak" aria-hidden="true"></span><span class="fy-launch__flare" aria-hidden="true"></span><h1 class="fy-launch__wordmark">Arke Studio</h1></div><div class="ij-content">${s.body()}</div></main></div></div>`;
}
export const FRAMES = Object.entries(screens).map(([key, s]) => ({...s, key, width:s.compact ? 560 : 1280, height:s.compact ? 760 : 850, markup:screen(key)}));
export const TURNS = [
  {id:242, title:'Install · guided setup and the shared entry', keys:['choose','242b','242c','242d','242e'], rules:[
    ['Proposal', '28 October 2026. Draft for owner review. These are new journeys, not implemented installer behaviour. Current mandatory local-runtime startup is still in force until a separate approved implementation.'],
    ['One installer', 'Use the existing Windows desktop installer and bundled core. Preserve its destination choice and Launch Arke action. Do not add a second installer, persona-specific binary or website wizard in this turn. The persona choice happens on first app launch, before any optional AI acquisition.'],
    ['Current visual language', 'Use the current launch-creation poster, split/stacked launch shell, Jost wordmark, Geist typography, launch tokens and current native icons. Launch remains dark in both application themes. New controls use neutral surfaces and 44px minimum targets.'],
    ['Guided defaults', 'Propose managed Ollama, one device-compatible starter writing model, Kokoro preset voices, Whisper English dictation and managed ComfyUI on its supported hardware profile. Show and approve the complete package once before download. Arke chooses a suitable text model from qualified catalogue entries; no fixed model is promised on every PC.'],
    ['Optional', 'Ming 0.5B/7.9B, image/video recipe weights, larger text models, cloud provider connections and remote-device access remain opt-in. The media engine alone does not enable generation.'],
    ['Readiness', 'Core entry requires a connected coordinator, valid writable data location and working create/save path. The starter package is ready only after selected files are verified, selected engines are healthy and capability-specific checks pass. A small local model response can qualify the selected writing path; runtime health alone cannot.'],
    ['Useful while preparing', 'Start writing is available once the core is ready; selected local AI may finish in Activity. Pending or failed AI remains explicitly unavailable for the affected feature. Setup-complete and app-usable are distinct facts. No automatic provider or paid fallback.'],
    ['Estimates', 'The 8 GB download, 24 GB peak-space requirement, 180 GB free and timing in these frames are illustrative. Real review uses missing selected files, per-destination measured free space and verified expansion requirements. Show download size, disk retained and temporary peak separately; never total the entire optional catalogue. Unknown figures are labelled rather than invented.'],
    ['Recovery', 'Keep completed components and resumable download receipts. Offer Resume, change folder, edit plan and continue manually. Closing pauses unfinished transfers; restart makes their status explicit. Unselected components do not raise incidents.'],
    ['Hardware and permissions', 'Run non-mutating device/location checks before showing a local starter package. Unsupported hardware gets an explained manual/cloud/existing-service choice, not an incompatible mandatory download. A read-only or full core data folder still needs a valid destination before worlds can be saved.'],
  ]},
  {id:243, title:'Install · advanced setup with explicit choices', keys:['243a','243b','243d','243c'], rules:[
    ['Proposal', 'Draft for owner review. Reuse the same installer, core and destination as Guided and Lightweight. No second settings system or new daemon.'],
    ['Capabilities first', 'Offer writing, local media, preset voice/dictation, Ming cloning and hosted providers in familiar language. A capability selection reveals its existing runtime, model and location controls. Every dependent download belongs to the review before acceptance.'],
    ['Managed default', 'Arke-managed Ollama and ComfyUI are the default sources for selected local capabilities. Mere detection never adopts an existing install. Reuse requires an explicit source selection and compatibility check.'],
    ['Existing services', 'Use only source types already supported by the selected engine. A personal service stays under the user’s lifecycle; Arke does not silently install packages into it, upgrade it or promise to restart it. A URL-only ComfyUI connection cannot supply a local Python interpreter for Ming.'],
    ['Selected readiness', 'Check the capabilities selected for preparation. A failed service holds only its dependent features. The user can correct the connection, review a managed alternative or enter with the working capabilities. Never label an omitted capability broken.'],
    ['Providers', 'Provider setup is provider-neutral and optional. Existing connection flows handle credentials; these drawings neither collect nor store real credentials. Connection checks do not invoke an undisclosed paid generation.'],
    ['Advanced controls', 'Folders, supported addresses and transfer controls sit behind Advanced or the relevant source field. Keep normal users out of service details. Avoid a new arbitrary limit, universal model-size assumption or forced migration of existing model stores.'],
    ['Returning users', 'A saved plan and explicit overrides survive restart and app update. Start only selected managed owners needed by enabled features. Recheck capability readiness without rerunning onboarding or ejecting an open world. A changed package is offered with its cost before additional downloads.'],
  ]},
  {id:244, title:'Install · lightweight now, capabilities later', keys:['244a','244b','244c','244d'], rules:[
    ['Proposal', 'Draft for owner review. Lightweight is the same desktop application with zero additional AI downloads, not a separate product or a promise of a smaller base executable.'],
    ['Bundled baseline', 'The current base includes client, coordinator, OpenCode v2, Voxa, ffmpeg, native index and the bundled sample where present. They remain installer contents across all three paths. The 0 GB claim refers only to additional AI downloads; the installer and extracted app still occupy disk.'],
    ['No forced AI', 'Do not fetch/start ComfyUI, Ollama, text weights, Kokoro/Whisper weights or Ming for an unselected lightweight plan. Bundled tools may start only where needed by enabled core functions. No cloud account, key, GPU or network is required for manual authoring.'],
    ['Immediate use', 'Once the coordinator and writable workspace are ready, allow world creation by form, editing, browsing, bundled sample exploration and supported import/preview of existing media. AI chat, generated media, narration and dictation need their own configured capability.'],
    ['Add on first use', 'An unavailable AI action offers its capability, complete missing dependency list, download/storage costs, destination and alternative provider choice. Not now returns without losing the creative draft. After approval only this capability is prepared; existing verified dependencies are reused.'],
    ['Ming dependency clarity', 'Ming requires a compatible local Python runtime, its isolated support overlay and chosen weights. Prefer the checked managed ComfyUI runtime and reuse PyTorch/CUDA. No independent second GPU stack or silent modification of a personal environment. Variant selection and full byte quote precede download.'],
    ['Quiet states', 'Not set up is normal. Do not repeatedly nag, open dialogs or show fault badges for declined optional features. Actual failed accepted downloads can offer a contextual next step. Model-free diagnostics remain useful without a diagnostic model.'],
    ['Device scope', 'The compact frame is a narrow desktop window. Phones/tablets connecting to an existing host use the existing pairing journey; this design does not download desktop services onto a phone or bypass host approval.'],
    ['Approval boundary', 'Approval of these drawings would authorize the journey direction only. SPEC-016 R-1–R-5 and the later mandatory-runtime policy must be reconciled explicitly before implementation. Existing users keep their configuration; no migration or new startup downloads are performed by this review.'],
  ]},
];
