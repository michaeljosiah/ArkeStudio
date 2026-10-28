import { icons } from './install-journeys.icons.mjs';
export const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => icons[name] ?? '';
const btn = (label, target, primary = false) => `<button type="button" ${target ? `data-go="${target}"` : ''} class="ij-button${primary ? ' ij-primary' : ''}">${label}${primary ? icon('next') : ''}</button>`;
const row = (name, detail, state = 'Included', glyph = 'check') => `<div class="ij-row">${icon(glyph)}<div><strong>${name}</strong><p>${detail}</p></div><span class="ij-state">${state}</span></div>`;
const note = text => `<p class="ij-note">${text}</p>`;
const actions = (...buttons) => `<div class="ij-actions">${buttons.join('')}</div>`;
const head = (step, title, body) => `<div class="ij-step">${step}</div><h2 tabindex="-1">${title}</h2><p class="ij-lead">${body}</p>`;
const block = (title, body) => `<section class="ij-block"><h3>${title}</h3>${body}</section>`;
const location = `<div class="ij-location">${icon('folder')}<div><strong>Your Arke folder</strong><span>D:\\Arke Studio · 180 GB free</span></div>${btn('Change folder', '243b')}</div>`;
const ready = `${row('Your workspace', 'Create, open and save worlds.', 'Ready')}${row('Writing help', 'Your writing assistant is ready to use.', 'Ready')}${row('Read aloud & dictation', 'Hear your words or speak instead of typing.', 'Ready')}${row('Picture & video tools', 'Add the downloads for the things you want to make.', 'Ready')}`;

export const screens = {
  choose: {
    id: '242a', title: 'One installer, three ways to begin', persona: 'Shared entry',
    body: () => `${head('WELCOME · SET UP YOUR STUDIO', 'Make Arke yours.', 'Choose how much to set up now. You can change this later in Settings.')}
      <div class="ij-choices">
      <button class="ij-choice" data-go="242i">${icon('laptop')}<span><strong>Set it up for me <small>Recommended</small></strong><span>Arke checks your computer and suggests a setup that fits.</span><em>You’ll see any downloads before they start</em></span>${icon('next')}</button>
      <button class="ij-choice" data-go="243e">${icon('settings')}<span><strong>Choose my setup</strong><span>Use your existing assistant, choose capabilities and folders.</span><em>OpenCode included · detected Claude Code or Codex optional</em></span>${icon('next')}</button>
      <button class="ij-choice" data-go="244a">${icon('folder')}<span><strong>Start lightweight</strong><span>Write, organise and use your own media. Add AI later.</span><em>No additional AI downloads</em></span>${icon('next')}</button>
      </div>${note('No Arke account is required. Your worlds stay on your computer.')}`,
  },
  '242b': {
    id: '242b', title: 'Guided · see the starter package before downloading', persona: 'Guided',
    body: () => `${head('GUIDED · REVIEW YOUR PLAN', 'A good place to start.', 'Arke will get your writing help and these tools ready for you.')}
      <div data-guided-writing>${row('Writing help on this computer', 'A writing assistant selected to suit your computer.', 'Set up', 'laptop')}</div>
      <div data-guided-voice>${row('Read aloud & dictation', 'Hear your words or speak instead of typing.', 'Set up', 'mic')}</div>
      <div data-guided-media>${row('Picture & video tools', 'Prepare the tools. Choose what you want to make later.', 'Set up', 'cpu')}</div>
      ${note('Extra creative tools and voices can be added later. We’ll show any download before you start.')}
      ${location}<div class="ij-facts" data-guided-cost><div><span>Download</span><strong>About 8 GB</strong></div><div><span>Kept on disk</span><strong>About 17 GB</strong></div><div><span>Space during setup</span><strong>24 GB</strong></div></div>
      ${note('This plan includes only what this computer can use. You can change your choices later.')}
      ${actions(btn('Change writing help', '242f'), btn('Set up these tools', '242c', true))}`,
  },
  '242c': {
    id: '242c', title: 'Guided · useful before the downloads finish', persona: 'Guided',
    body: () => `${head('SETTING THINGS UP', 'Your studio is taking shape.', 'You can start writing while local AI finishes setting up.')}
      ${row('Arke & your data folder', 'Workspace checked. You can create and save worlds.', 'Ready')}
      <div data-progress-writing>${row('Writing help', 'Downloading the writing support chosen for this computer.', 'Downloading', 'download')}</div>
      <div class="ij-progress" data-local-progress><progress value="1.8" max="4.3" aria-label="Starter model download"></progress><span>1.8 of 4.3 GB · about 6 minutes left</span><button type="button" data-pause>Pause</button></div>
      <div data-guided-voice>${row('Read aloud & dictation', 'Ready when you want to listen or speak.', 'Ready')}</div>
      <div data-guided-media>${row('Picture & video tools', 'Finishing the setup.', 'Setting up', 'cpu')}</div>
      ${note('Downloads and any next steps stay in Activity. Closing Arke pauses unfinished transfers; the next launch offers Resume.')}
      ${actions(btn('View download plan', '242b'), btn('Start writing', '244b', true))}`,
  },
  '242d': {
    id: '242d', title: 'Guided · a local component fails without blocking writing', persona: 'Guided',
    body: () => `${head('GUIDED · NEEDS ATTENTION', 'Keep going. We’ll keep your place.', 'The connection dropped while downloading writing support. Your worlds are ready to use.')}
      ${row('Workspace', 'Create, save and import existing media.', 'Ready')}
      ${row('Writing assistant', '1.8 GB downloaded. Resume from the saved download.', 'Paused', 'warning')}
      ${row('Your other tools', 'Completed downloads are kept.', 'Ready')}
      ${actions(btn('Resume download', '242c', true), btn('Start writing', '244b'))}
      ${block('Running low on space?', '<p>Choose another model folder or remove a component from this plan. Arke shows the revised download and space needed before continuing.</p>')}
      ${actions(btn('Change download plan', '243a'))}${note('Your other tools keep working. You can finish this download later.')}`,
  },
  '242e': {
    id: '242e', title: 'Guided · name what is actually ready', persona: 'Guided',
    body: () => `${head('SETUP CHECKED', 'Ready for your first world.', 'Your starter setup has passed its checks.')}${ready}
      ${note('Add more creative tools when you need them. You’ll see any extra downloads first.')}
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
    body: () => `${head('WRITING HELP · COMPUTER CHECKED', 'How would you like writing help?', 'We found writing support that fits this computer. You can also use an online account.')}
      <fieldset class="ij-options ij-harness"><legend>Choose where it runs</legend>
      <label><input type="radio" name="writing-route" value="local" checked><span><strong>On this computer</strong><span>Works offline after setup. A suitable download is available for this computer.</span></span></label>
      <label><input type="radio" name="writing-route" value="cloud"><span><strong>Use an online account</strong><span>Sign in with ChatGPT or GitHub Copilot. No large writing download.</span></span></label></fieldset>
      <section class="ij-block"><h3 data-route-title>A setup that fits</h3><p data-route-detail>Arke has checked the requirements for a supported writing model. We’ll show its download and space needed next.</p></section>
      ${note('Online writing needs internet access and uses your account’s allowance. Your requests are sent to the service you choose.')}
      ${actions(btn('Back', 'choose'), btn('Continue', '242b', true))}`,
  },
  '242g': {
    id: '242g', title: 'Writing provider · ChatGPT, GitHub Copilot and future Arke', persona: 'Shared account choice',
    body: () => `${head('AI WRITING AGENT · SIGN IN', 'Set up your AI writing agent.', 'Choose the account your agent will use to help you plan and write.')}
      <div class="ij-choices">
      <button class="ij-choice" data-provider="chatgpt">${icon('chat')}<span><strong>ChatGPT</strong><span>Sign in with your ChatGPT account.</span><em>Requires an eligible plan · uses your plan’s allowance</em></span>${icon('next')}</button>
      <button class="ij-choice" data-provider="copilot">${icon('cloud')}<span><strong>GitHub Copilot</strong><span>Sign in with your GitHub account.</span><em>Requires Copilot access · uses your plan’s allowance</em></span>${icon('next')}</button>
      <button class="ij-choice" disabled aria-describedby="ij-arke-soon">${icon('laptop')}<span><strong>Arke <small>Coming later</small></strong><span id="ij-arke-soon">Not available yet.</span></span></button></div>
      ${note('Your writing requests go to the service you choose. You can change this later in Settings.')}
      ${actions(btn('Back', '242f'), btn('Set up writing later', '244b'))}`,
  },
  '242h': {
    id: '242h', title: 'Cloud writing · connected account and selected model checked', persona: 'Shared writing connection',
    body: () => `${head('AI WRITING AGENT', 'Your AI writing agent is ready.', 'Your account is connected and ready for writing.')}
      <div data-connected-account>${row('ChatGPT', 'Signed in. An available writing model has been checked.', 'Ready', 'check')}</div>
      ${block('Ready to write', '<p data-connected-detail>Arke has chosen writing support available with your account. You can change it in Settings.</p>')}
      ${note('No large writing download is needed. Your account’s allowance applies.')}
      ${actions(btn('Change connection', '242g'), btn('Continue setup', '242b', true))}`,
  },
  '242i': {
    id:'242i', title:'Guided · automatically check what this computer can use', persona:'Guided',
    body:()=>`${head('SET IT UP FOR ME', 'Finding the right setup for you.', 'Arke is checking your computer and any writing assistants you already use.')}
      ${row('Your computer', 'Finding writing and creative tools that will work here.', 'Checking', 'laptop')}
      ${row('Space for your work', 'Checking where your files and downloads will fit.', 'Checking', 'folder')}
      ${row('Existing assistants', 'Looking for supported installations you can choose to use.', 'Checking', 'chat')}
      ${note('Nothing is being downloaded. We’ll only offer options this computer can use.')}
      ${actions(btn('Start without AI for now', '244b'))}`,
  },
  '242j': {
    id:'242j', title:'Guided · no suitable local writing model', persona:'Guided',
    body:()=>`${head('COMPUTER CHECKED', 'Online writing is a better fit here.', 'We couldn’t find suitable writing support for this computer. You can still write and organise your worlds.')}
      ${block('Use an account you already have', '<p>Connect ChatGPT or GitHub Copilot for writing help without a large download.</p>')}
      ${actions(btn('Choose an account', '242g', true), btn('Start without AI', '244b'))}
      ${note('You can change your setup later. Nothing has been downloaded.')}
      ${actions(btn('Back', 'choose'))}`,
  },
  '242k': {
    id:'242k', title:'Guided · offer compatible assistants found on this computer', persona:'Guided',
    body:()=>`${head('WE FOUND YOUR ASSISTANTS', 'Use what you already have?', 'These supported assistants are installed on this computer. Choose the one you’d like Arke to use.')}
      <fieldset class="ij-options ij-harness"><legend>Your writing assistant</legend>
      <label><input type="radio" name="harness" value="opencode" checked><span><strong>Let Arke set it up</strong><span>We’ll help you connect an account or use writing support that fits this computer.</span></span></label>
      <label data-detected="claude"><input type="radio" name="harness" value="claude"><span><strong>Claude Code <small>Found on this computer</small></strong><span>Use this installed assistant and its account.</span></span></label>
      <label data-detected="codex"><input type="radio" name="harness" value="codex"><span><strong>Codex <small>Found on this computer</small></strong><span>Use this installed assistant and its account.</span></span></label></fieldset>
      ${note('We’ll check the account before writing help is ready. You can change your assistant later.')}
      ${actions(btn('Back', 'choose'), btn('Continue', '242f', true))}`,
  },
  '242l': {
    id:'242l', title:'Writing provider · browser sign-in and waiting state', persona:'Shared account sign-in',
    body:()=>`${head('SIGN IN', 'Finish signing in with ChatGPT.', 'Your browser opens the account’s sign-in page. Return here when you’ve finished.')}
      <div data-signin-instructions>${block('Waiting for you to sign in…', '<p>Follow the steps in your browser. This page will update when the connection is ready.</p>')}</div>
      ${actions('<button class="ij-button" data-message="Reopen the current provider sign-in page supplied by the writing assistant. No real page opens in this preview.">Open sign-in page again</button>')}
      ${note('Arke checks that writing help is available with your account before continuing.')}
      ${actions(btn('Choose another account', '242g'), btn('Set up writing later', '244b'))}`,
  },
  '244a': {
    id: '244a', title: 'Lightweight · no additional AI downloads', persona: 'Lightweight',
    body: () => `${head('LIGHTWEIGHT · READY TO BEGIN', 'Start small. Make something.', 'Everything you need to write and organise is already in the app.')}
      ${row('Worlds & writing', 'Create worlds, edit by form and write your stories.')}
      ${row('Your existing media', 'Import, organise and preview your own files.')}
      ${row('Sample world', 'Explore the sample included with this build.')}
      <div class="ij-facts"><div><span>Extra downloads</span><strong>None</strong></div><div><span>Account needed</span><strong>No</strong></div></div>
      ${note('Write and organise without an account or internet connection. Add AI help whenever you want it.')}
      ${actions(btn('Set up an AI writing agent', '242g'), '<button class="ij-button" data-existing-choice data-go="242k" hidden>Use an existing assistant</button>')}
      ${actions(btn('Back', 'choose'), btn('Start using Arke', '244b', true))}`,
  },
  '244b': {
    id: '244b', title: 'All paths · enhance the existing Worlds landing page', persona: 'Shared destination', worlds: true,
    body: () => `<div class="fy-app" data-screen="world-picker"><div class="fy-titlebar"><div class="fy-titlebar__side"></div><button class="fy-titlebar__brand" data-go="244b"><span class="fy-brand__arke">Arke</span><span class="fy-brand__studio">Studio</span></button><div class="fy-titlebar__side fy-titlebar__side--right">${[['chat','Chat'],['cpu','System'],['bell','Activity'],['cog','Settings'],['user','Account']].map(([glyph,label])=>`<button class="fy-iconbtn" aria-label="${label}" data-message="The existing ${label} control opens its usual surface.">${icon(glyph)}</button>`).join('')}</div></div>
      <main class="fy-content fy-firstrun"><div class="fy-home-hero"><div class="fy-hero__eyebrow">WELCOME TO YOUR STUDIO</div><h1 tabindex="-1" class="fy-hero__title fy-hero__title--home">Your first world starts here.</h1><div class="fy-home-count"><p class="fy-hero__lede">Nothing here yet.</p><button class="ij-home-action" data-message="The existing publication-opening flow opens.">${icon('book')}Open publication</button></div>
      <div class="ij-world-actions"><button class="ij-home-action" data-message="Open the supported world-folder import flow, with destination and validation before import.">${icon('upload')}Import a world</button></div></div>
      <div class="fy-firstrun__doors"><div class="fy-fan__drift"><div class="fy-createcard" data-message="The existing New world form opens. No model is required."><div class="fy-createcard__ring">${icon('plus')}</div><div class="fy-createcard__title">Your first world</div><div style="margin-top:4px"><button type="button" class="ui-btn ui-btn--primary ui-btn--default">Create a world</button></div></div></div>
      <div class="fy-fan__drift" style="animation-delay:0.6s"><div class="fy-createcard fy-createcard--filled" data-message="Explore The Undersong through the current sample-world flow. Reuse its existing copy if installed; show size before any required download."><div class="fy-createcard__ring">${icon('sparkle')}</div><div class="fy-createcard__title">Or start from ours</div><div class="fy-createcard__sub">The Undersong: a cast, its canon, and a production part-way through. Yours to take apart.</div><div style="margin-top:4px"><button type="button" class="ui-btn ui-btn--secondary ui-btn--default">Explore sample world</button></div></div></div></div>
      <div class="ij-world-status"><span data-world-status>Write and organise now. Add AI whenever you need it.</span><button class="ij-home-action" data-message="Open Settings to add or change capabilities.">Settings ${icon('next')}</button></div></main></div>`,
  },
  '244c': {
    id: '244c', title: 'Later · choose a supported voice provider when you need one', persona: 'Lightweight',
    body: () => `${head('LATER · ADD A CAPABILITY', 'Choose how to create voices.', 'When you need narration or voice cloning, choose from the providers Arke supports.')}
      ${row('On this computer', 'Choose a voice tool that works on your computer.', 'Optional', 'cpu')}
      ${row('Use an online service', 'Connect your account; see any costs first.', 'Optional', 'cloud')}
      ${block('See what your choice needs', '<p>We’ll show any downloads and space needed, or the account and costs for an online service.</p>')}
      ${note('Voice cloning is optional and can be set up later in Settings. No provider or model is preselected here.')}
      ${actions(btn('Not now', '244b'), '<button class="ij-button ij-primary" data-message="Settings opens the supported voice-provider catalogue. This proposal does not choose or install a provider.">Browse supported providers</button>')}`,
  },
  '244d': {
    id: '244d', title: 'Lightweight · offline or incompatible hardware is a usable start', persona: 'Lightweight', compact: true,
    body: () => `${head('START WITH THE ESSENTIALS', 'Your ideas can start here.', 'You can write and organise here. Making pictures and videos on this computer isn’t available with this setup.')}
      ${row('Write & organise', 'Create and save worlds offline.', 'Ready')}
      ${row('AI help', 'No download has started.', 'Not set up', 'cpu')}
      ${note('Connect an online account or add tools later in Settings. Arke will explain what each choice needs.')}
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
  {id:242, title:'Install · guided setup and the shared entry', keys:['choose','242i','242k','242f','242j','242g','242l','242h','242b','242c','242d','242e'], rules:[
    ['Proposal', '28 October 2026. Draft for owner review. These are new journeys, not implemented installer behaviour. Current mandatory local-runtime startup is still in force until a separate approved implementation.'],
    ['One installer', 'Use the existing Windows desktop installer and bundled core. Preserve its destination choice and Launch Arke action. Do not add a second installer, persona-specific binary or website wizard in this turn. The persona choice happens on first app launch, before any optional AI acquisition.'],
    ['Current visual language', 'Use the current launch-creation poster, split/stacked launch shell, Jost wordmark, Geist typography, launch tokens and current native icons. Launch remains dark in both application themes. New controls use neutral surfaces and 44px minimum targets.'],
    ['Guided defaults', 'Check the computer and qualified model catalogue first. Offer local writing only when a supported model fits that device and destination; offer cloud accounts otherwise. If compatible installed assistants are found, let the user explicitly select one before preparing writing. Add Kokoro/Whisper and managed ComfyUI only when their own support checks pass. Review the resulting package before download. OpenCode stays included but its name is not essential in Guided copy.'],
    ['Optional', 'Voice cloning, image/video recipe weights, larger text models, cloud provider connections and remote-device access remain opt-in. Voice providers/models are selected later from the supported catalogue; no Ming-specific first-run choice. The media engine alone does not enable generation.'],
    ['Readiness', 'Core entry requires a connected coordinator, valid writable data location and working create/save path. The starter package is ready only after selected files are verified, selected engines are healthy and capability-specific checks pass. A small local model response can qualify the selected writing path; runtime health alone cannot.'],
    ['Useful while preparing', 'Start writing is available once the core is ready; selected local AI may finish in Activity. Pending or failed AI remains explicitly unavailable for the affected feature. Setup-complete and app-usable are distinct facts. No automatic provider or paid fallback.'],
    ['Estimates', 'The 8 GB download, 24 GB peak-space requirement, 180 GB free and timing in these frames are illustrative. Real review uses missing selected files, per-destination measured free space and verified expansion requirements. Show download size, disk retained and temporary peak separately; never total the entire optional catalogue. Unknown figures are labelled rather than invented.'],
    ['Recovery', 'Keep completed components and resumable download receipts. Offer Resume, change folder, edit plan and continue manually. Closing pauses unfinished transfers; restart makes their status explicit. Unselected components do not raise incidents.'],
    ['Hardware and permissions', 'Run non-mutating device/location checks before showing a local starter package. Unsupported hardware gets an explained manual/cloud/existing-service choice, not an incompatible mandatory download. A read-only or full core data folder still needs a valid destination before worlds can be saved.'],
    ['Writing connection', 'First-run OpenCode accounts are ChatGPT and GitHub Copilot. Arke is visible but disabled, with no sign-in action or availability date. Use the harness-reported supported account method; no API-key path is in this first-run shortlist. A connected account plus an accessible supported writing model is required before Ready. Local writing requires healthy Ollama and a responding model after download. Existing Claude Code/Codex keep their own adapter/account route.'],
    ['Smart eligibility', 'Local suitability uses a qualified model and its supported device profile, available RAM/VRAM where required, OS/CPU/backend compatibility, working context and disk/download peak. A missing GPU alone is not disqualifying if a supported CPU model fits. Ollama being installable is not proof of a suitable writing model. Unknown checks cannot be shown as suitable: explain the incomplete check, offer retry/online/manual, and do not download automatically. No invented universal RAM threshold or fixed model for every PC.'],
    ['Simple wording', 'Guided and Lightweight explain outcomes: writing help, on this computer, online account, read aloud and picture/video tools. Keep OpenCode, Ollama, ComfyUI, Python/CUDA, harness and API-key terminology in Advanced/technical details. Product names remain when needed to choose a recognised installed assistant or account.'],
    ['Existing assistant choice', 'Only compatible found installations are offered in Guided. Skip the choice when none exist. Keep installation discovery distinct from account/model readiness; selection checks the chosen assistant and offers its supported sign-in steps if needed. Do not copy personal sign-ins or change the selected assistant on failure. The example-computer controls are outside the product and do not scan this PC.'],
  ]},
  {id:243, title:'Install · advanced setup with explicit choices', keys:['243e','243a','243b','243d','243c'], rules:[
    ['Proposal', 'Draft for owner review. Reuse the same installer, core and destination as Guided and Lightweight. No second settings system or new daemon.'],
    ['Capabilities first', 'Offer writing, local media and preset voice/dictation in familiar language. OpenCode writing then offers cloud or local, as in Guided; cloud is not a separate competing writing capability. Voice cloning is chosen later from supported providers. Reveal only selected controls and dependencies.'],
    ['Managed default', 'Arke-managed Ollama and ComfyUI are the default sources for selected local capabilities. Mere detection never adopts an existing install. Reuse requires an explicit source selection and compatibility check.'],
    ['Existing services', 'Use only source types already supported by the selected engine. A personal service stays under the user’s lifecycle; Arke does not silently install packages into it, upgrade it or promise to restart it. A URL-only ComfyUI connection cannot supply a local Python interpreter for Ming.'],
    ['Selected readiness', 'Check the capabilities selected for preparation. A failed service holds only its dependent features. The user can correct the connection, review a managed alternative or enter with the working capabilities. Never label an omitted capability broken.'],
    ['Providers', 'The initial account picker offers ChatGPT and GitHub Copilot, plus disabled future Arke. Reuse the existing harness-owned sign-in and model flows behind this scoped onboarding shortlist (proposed amendment to SPEC-030 R-7); do not replace the general provider catalogue. Enable a row only when the shipped harness reports a supported sign-in method. Confirm account and model access; no undisclosed paid generation. Cloud excludes local writing downloads.'],
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
    ['One Worlds landing', 'All setup paths enter /worlds. Reuse the current FirstRunScreen card treatment: 290px by at least 380px, dashed Create card at -1.5 degrees and solid sample card at +1.5 degrees, native Plus/Sparkle rings, buttons and hover lift. Retain Import a world and the existing Open publication action in the Worlds header. This folds FirstRunScreen into the Worlds empty state instead of adding another onboarding destination. Existing worlds retain their grid/archive behaviour; an installed sample becomes its existing world card, not a duplicate offer. Sample availability/download size follow the current source.'],
  ]},
];
