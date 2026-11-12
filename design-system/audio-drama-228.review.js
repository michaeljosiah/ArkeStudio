import { screen, FRAMES, esc } from './audio-drama-228.view.mjs';
const canvas = document.querySelector('#canvas');
const dialog = document.querySelector('#detail');
const state = { approach: 'Narrated drama', source: true, actor: 'Reed', lin: false };
let view = location.hash.slice(1) || 'setup';
const views = new Set(FRAMES.map(f => f[2]));
function render(next = view) {
  view = views.has(next) ? next : 'setup';
  canvas.innerHTML = screen(view, { ...state, source: view === 'phone' ? !!state.phoneSource : state.source });
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  history.replaceState(null, '', '#' + view);
}
function detail(title, html) {
  dialog.innerHTML = `<h2>${title}</h2>${html}<form method="dialog"><button>Close</button></form>`;
  dialog.showModal();
}
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-view]');
  if (nav) { render(nav.dataset.view); return; }
  const button = e.target.closest('[data-ad]');
  if (!button) {
    if (view === 'studio' && e.target.closest('button,[data-audio-act]')) detail('The existing Audio Studio', '<p>This drawing reuses turn 226’s layout. Timeline playback and edits are not simulated in this adaptation review. No audio is loaded or generated.</p><p><a href="audio-studio.review.html">Explore the dedicated Audio Studio prototype</a></p>');
    return;
  }
  const act = button.dataset.ad;
  if (views.has(act)) { render(act); return; }
  if (act === 'approach') state.approach = button.dataset.value;
  else if (act === 'source') { if (view === 'phone') state.phoneSource = !state.phoneSource; else state.source = !state.source; }
  else if (act === 'keep-omission') state.omission = true;
  else if (act === 'assign') { state.lin = true; state.actor = 'Lin'; }
  else if (act === 'actor') state.actor = button.dataset.value;
  else if (act === 'direction') state.direction = button.dataset.value;
  else if (act === 'fix') state.fix = true;
  else if (act === 'intentional') state.intentional = true;
  else if (act === 'retain') state.decision = 'Adaptation retained with reason in this fixture. The deliberate check remains a conscious departure; source v5 is acknowledged, not substituted.';
  else if (act === 'revise') {
    state.decision = 'Revision proposed, not applied. Review the new dialogue and anchor-test cue before keeping a new script version.';
    render();
    detail('Proposed script revision', '<p><del>REED: Your tether doesn’t.</del></p><p><ins>REED: Hold. Let me check the anchor.</ins></p><p><del>SOUND: A boot scrapes; the tether takes the weight.</del></p><p><ins>SOUND: A short pull on the tether. The anchor holds.</ins></p><p>Two performances and one cue would need review if kept. This design fixture does not save an edit.</p>'); return;
  }
  else if (act === 'omission') { detail('An explicit omission', '<p>The repeated briefing is omitted; the missing resident is retained in Episode 2, Scene 3. The source coverage record keeps both decisions.</p><p>Use “Keep this omission” in the plan to record the example decision and unlock the pilot.</p>'); return; }
  else if (act === 'audition') { detail(state.lin ? 'Review before an audition' : 'Lin needs a voice', state.lin ? '<p>One exchange: narrator, Reed, Vale and Lin. Context travels with the lines. Only spoken text goes to the voice provider; direction is compiled for the selected model, and sound cues stay in the mix.</p><p>The implemented flow must show exact requests, voice/model IDs, unsupported direction and cost here. This fixture has no selected provider, price or generation action.</p>' : '<p>Assign Lin an actor voice or a recording in Performances. Her line cannot silently use the narrator.</p><p>No audio has been requested.</p>'); return; }
  else if (act === 'select') {
    const cue = ['wind', 'tether-cue', 'beat'].includes(button.dataset.block);
    detail(cue ? 'Cue · never spoken' : 'Spoken line', `<p>${esc(button.innerText)}</p><p>${cue ? 'Attached to this script beat. Moving the beat keeps its cue attached; deleting it requires a decision. Silence reserves time while ambience continues.' : 'Speaker identity is stable. Delivery belongs to this line; channel treatment belongs to the mix. Cast direction is resolved before building the request.'}</p><p>Source: Chapter 6 · pinned v4. The final request and source link remain inspectable.</p>`); return;
  }
  else if (act === 'insert') { detail('Add a script block', '<p>Dialogue · Narration · Sound · Ambience · Music · Silence · Scene direction</p><p>Dialogue and narration are spoken. Other blocks carry typed instructions and anchors; they are never inserted as words for the narrator to read. The full editor is a proposed implementation.</p>'); return; }
  else if (act === 'inspect') { detail('Listening evidence · example', '<p>00:18–00:22 of example mix v5, take 3. In the implementation this opens the exact mixed interval alongside the dry line.</p><p>No audio was assessed for this fixture. The uncovered final 28 seconds remains visible and blocks a complete review claim.</p>'); return; }
  else if (act === 'chat') { detail('Production Chat', '<p>Reuse turn 225’s global Chat, with the current episode, scene and selected passage as its subject. Specialist work arrives as proposals in the script or studio.</p><p>This drawing does not add a second assistant or replace the existing composer.</p><p><a href="chapter-page-227.review.html">See the writing room and shared Chat design</a></p>'); return; }
  render();
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button][data-ad]')) { e.preventDefault(); e.target.click(); }
});
render();
