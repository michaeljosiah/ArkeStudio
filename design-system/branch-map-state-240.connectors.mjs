// Local design fixture for the connector flow, not a second application routing engine.
export const CONNECTOR_MODES = ['connector-start', 'connector-pick', 'connector-edit', 'connector-rules', 'connector-added', 'connector-mobile'];
export const DESTINATIONS = [
  { id: 'escape', title: 'Above the Quiet', number: '16', description: 'The shuttle clears the collar', ending: 'Escape' },
  { id: 'fortress', title: 'The last room', number: '16', description: 'The crew return to the fortress', ending: 'Return' },
];
export const FACTS = [
  { id: 'dev', name: 'Dev Malik', values: ['Alive', 'Lost in pursuit', 'Lost at release', 'Lost in fortress'] },
  { id: 'wei', name: 'Lin Wei', values: ['Alive', 'Lost in communications', 'Lost in fortress'] },
  { id: 'imani', name: 'Imani Okoro', values: ['Alive', 'Lost at release', 'Lost in fortress'] },
  { id: 'ana', name: 'Ana Lucía Reyes', values: ['Alive', 'Lost in clinic', 'Lost at release', 'Lost in fortress'] },
  { id: 'elsie', name: 'Elsie Ward', values: ['Alive', 'Lost in bore', 'Lost in clinic', 'Lost in fortress'] },
  { id: 'tomas', name: 'Tomas Vale', values: ['Alive', 'Lost at brake', 'Lost at release', 'Lost in fortress'] },
];
export const emptyDraft = () => ({ from: 'launch', to: '', text: '', match: 'All conditions', conditions: [], effects: [] });
export const sampleDraft = () => ({
  ...emptyDraft(), to: 'escape', text: 'Ask Dev to hold the release',
  conditions: [{ fact: 'dev', comparison: 'is', value: 'Alive' }, { fact: 'wei', comparison: 'is not', value: 'Alive' }],
  effects: [{ fact: 'dev', value: 'Lost at release' }],
});
export function draftReady(draft) {
  const valid = row => FACTS.some(f => f.id === row.fact && f.values.includes(row.value));
  return draft?.from === 'launch' && DESTINATIONS.some(d => d.id === draft.to) && !!draft.text.trim()
    && draft.conditions.every(row => valid(row) && ['is', 'is not'].includes(row.comparison))
    && draft.effects.every(valid) && new Set(draft.effects.map(e => e.fact)).size === draft.effects.length;
}

export function connectorView(state, { icon, esc }) {
  const draft = state.draft || (['connector-rules', 'connector-mobile', 'connector-added'].includes(state.mode) ? sampleDraft() : emptyDraft());
  const saved = state.mode === 'connector-added';
  const choice = saved ? (state.createdChoice || draft) : draft;
  const started = state.mode !== 'connector-start';
  const picking = state.mode === 'connector-pick';
  const phone = state.mode === 'connector-mobile' || state.device === 'phone';
  const destination = DESTINATIONS.find(d => d.id === choice.to);
  const button = (label, action, extra = '', kind = '') => `<button type="button" class="${kind}" data-act="${action}" ${extra}>${esc(label)}</button>`;
  const select = (label, options, value, binding) => `<select aria-label="${esc(label)}" data-draft="${binding}">${options.map(o => { const item = typeof o === 'string' ? { id: o, name: o } : o; return `<option value="${esc(item.id)}" ${item.id === value ? 'selected' : ''}>${esc(item.name)}</option>`; }).join('')}</select>`;
  const field = (label, content) => `<label class="field"><span>${esc(label)}</span>${content}</label>`;
  const heading = (title, action, label) => `<div class="connector-section-head"><h3>${title}</h3>${action ? button(label, action, '', 'quiet') : ''}</div>`;
  const source = `<div class="connector-card source ${started ? 'selected' : ''}" style="left:40px;top:220px"><button type="button" class="connector-card-body" data-act="connector-source" ${picking ? 'disabled' : ''}><span class="num">15 · C6</span><strong>The launch collar</strong><span class="meta">Who holds the release?</span><span class="node-foot">${saved ? '3' : '2'} choices</span></button><button type="button" class="node-port ${!started ? 'port-focus' : ''}" data-act="begin-connector" aria-label="Add a choice from The launch collar" aria-expanded="${started && !saved}" title="Add a choice">${icon('plus')}</button>${!started ? '<span class="port-label">Add choice</span>' : ''}</div>`;
  const targetCards = DESTINATIONS.map((d, index) => `<button type="button" class="connector-card target ${picking ? 'can-pick' : ''} ${choice.to === d.id && started ? 'destination-selected' : ''}" style="left:550px;top:${index ? 394 : 84}px" data-act="choose-destination" data-target="${d.id}" aria-label="Select ${esc(d.title)} as destination"><span class="num">${d.number} · ${icon('flag')} ${d.ending}</span><strong>${d.title}</strong><span class="meta">${d.description}</span>${picking ? '<span class="target-hint">Choose this scene</span>' : choice.to === d.id && started ? '<span class="target-hint">Destination selected</span>' : ''}</button>`).join('');
  const newPath = started && destination ? `<path class="${saved ? 'unwalked' : 'draft-connection'}" d="${choice.to === 'escape' ? 'M260 292C405 292 405 160 550 160' : 'M260 292C405 292 405 455 550 455'}" marker-end="url(#connector-${state.mode})"/>` : picking ? '<path class="draft-connection" d="M260 292H425"/>' : '';
  const edgeLabel = started && destination ? `<button type="button" class="edge connector-edge ${saved ? 'selected' : ''}" style="left:316px;top:${choice.to === 'escape' ? '219' : '353'}px" data-act="${saved ? 'select-added' : 'connector-noop'}"><span data-draft-edge-label>${esc(choice.text || 'New choice')}</span><small>${saved ? 'Not walked' : 'Draft'}</small></button>` : '';
  const graph = `<div class="connector-banner" role="status">${picking ? icon('plus') + '<span>Choose a destination on the map, or use <b>To scene</b>.</span>' : started && !saved ? icon('branch') + '<span>New choice · not added yet</span>' : saved ? icon('check') + '<span>Choice added · not walked</span>' : icon('branch') + '<span>The launch collar selected · use + to add a way out</span>'}${started && !saved ? button('Cancel', 'cancel-connector', '', 'quiet') : ''}</div><div class="canvas"><div class="connector-map"><svg class="connections" viewBox="0 0 860 600" aria-hidden="true"><defs><marker id="connector-${state.mode}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 1 9 5 0 9" style="fill:currentColor;stroke:none"/></marker></defs><g marker-end="url(#connector-${state.mode})" class="existing-connections"><path d="M260 265C355 40 455 40 550 140"/><path d="M260 320C365 470 465 470 550 455"/></g>${newPath}</svg>${source}${targetCards}<span class="connector-existing-label" style="left:323px;top:67px">Remote release · Wei alive</span><span class="connector-existing-label" style="left:302px;top:483px">Return to the fortress</span>${edgeLabel}<div class="connector-legend">${started && !saved ? 'Draft connections do not change the story. Add choice saves the complete rule.' : 'Choices can share a destination and carry different consequences.'}</div></div></div>`;
  const mobileGraph = `<div class="canvas"><div class="map"><div class="mapnode"><span class="meta">15 · C6</span><strong>The launch collar</strong><span>2 choices · 1 draft</span></div><div class="mapnode"><strong>${destination?.title || 'Choose a destination'}</strong><span class="meta">The same draft is edited in the sheet.</span></div></div></div>`;

  let content, footer;
  if (!started) {
    content = `<div class="section"><div class="eyebrow">Selected scene · 15</div><h2>The launch collar</h2><p>Choose how the surviving crew leave.</p></div><div class="section"><h3>Ways out</h3><div class="condition"><span>Use Wei’s remote release</span>${icon('chevron')}</div><div class="condition"><span>Return to the fortress</span>${icon('chevron')}</div></div><div class="section"><p>Add another choice from this scene’s +. Select a destination, then write the choice and its rules.</p>${button('Add choice', 'begin-connector', '', 'stretch')}</div>`;
    footer = '<span class="meta">Enter or Space activates the + too.</span>';
  } else if (saved) {
    content = `<div class="section"><div class="eyebrow">Added · not walked</div><h2>${esc(choice.text)}</h2><span class="meta">The launch collar → ${esc(destination.title)}</span></div><div class="section"><h3>Available when · ${esc(choice.match)}</h3>${choice.conditions.length ? choice.conditions.map(c => `<div class="condition"><span>${esc(FACTS.find(f => f.id === c.fact).name)}</span><span class="muted">${esc(c.comparison)}</span><b>${esc(c.value)}</b></div>`).join('') : '<p>Always available.</p>'}</div><div class="section"><h3>Remember</h3>${choice.effects.length ? choice.effects.map(e => `<div class="condition"><span>${esc(FACTS.find(f => f.id === e.fact).name)}</span><span class="muted">→</span><b>${esc(e.value)}</b></div>`).join('') : '<p>No values change.</p>'}</div><div class="callout">The connection is saved with its text, conditions and values in one change. Preview is still needed.</div>`;
    footer = button('Edit choice', 'edit-added', '', 'stretch');
  } else {
    const conditions = draft.conditions.map((row, index) => `<div class="connector-rule-row">${select(`Condition ${index + 1} fact`, FACTS, row.fact, `conditions.${index}.fact`)}${select(`Condition ${index + 1} comparison`, ['is', 'is not'], row.comparison, `conditions.${index}.comparison`)}${select(`Condition ${index + 1} value`, FACTS.find(f => f.id === row.fact).values, row.value, `conditions.${index}.value`)}<button type="button" class="icon quiet remove-rule" data-act="remove-draft-condition" data-index="${index}" aria-label="Remove condition ${index + 1}">${icon('close')}</button></div>`).join('');
    const effects = draft.effects.map((row, index) => `<div class="connector-rule-row effect-row">${select(`Remember ${index + 1} fact`, FACTS, row.fact, `effects.${index}.fact`)}<span class="muted">→</span>${select(`Remember ${index + 1} value`, FACTS.find(f => f.id === row.fact).values, row.value, `effects.${index}.value`)}<button type="button" class="icon quiet remove-rule" data-act="remove-draft-effect" data-index="${index}" aria-label="Remove remembered value ${index + 1}">${icon('close')}</button></div>`).join('');
    content = `<div class="connector-form"><div class="pair">${field('From scene', '<input value="The launch collar" readonly>')}${field('To scene', select('To scene', [{ id: '', name: 'Choose…' }, ...DESTINATIONS.map(d => ({ id: d.id, name: d.title }))], draft.to, 'to'))}</div>${field('Choice text', `<textarea rows="2" data-draft="text" placeholder="What the player reads">${esc(draft.text)}</textarea>`)}<div class="connector-form-section">${heading('Available when', 'add-draft-condition', '+ Condition')}${draft.conditions.length ? select('Match conditions', ['All conditions', 'Any condition'], draft.match, 'match') + conditions : '<p class="meta">Always available. Add a condition to limit this choice.</p>'}</div><div class="connector-form-section">${heading('Remember', 'add-draft-effect', '+ Value')}${effects || '<p class="meta">No values change. Add a value to remember a consequence.</p>'}${effects ? '<p class="meta">Set these values after this choice is taken.</p>' : ''}</div>${draft.effects.some(e => e.fact === 'dev' && e.value === 'Lost at release') ? '<p class="connector-consequence">Dev stays at the release. The other surviving crew can escape.</p>' : ''}<p class="meta">Nothing is added until you press Add choice.</p></div>`;
    footer = `<div class="connector-form-actions">${button('Cancel', 'cancel-connector')}${button(state.isEditingAdded ? 'Save choice' : 'Add choice', 'save-connector', draftReady(draft) ? '' : 'disabled', 'primary')}</div>`;
  }
  const pane = `<aside class="panel connector-panel" aria-label="${!started ? 'Scene' : saved || state.isEditingAdded ? 'Choice' : 'New choice'}"><header class="panelhead"><strong class="tab">${!started ? 'Scene' : saved || state.isEditingAdded ? 'Choice' : 'New choice'}</strong><span class="tab muted">Arke</span><button type="button" class="icon quiet" data-act="cancel-connector" aria-label="${started && !saved ? 'Cancel new choice' : 'Close Inspector'}">${icon('close')}</button></header><div class="panelscroll">${content}</div><div class="panelbottom">${footer}</div></aside>`;
  return { graph: phone ? mobileGraph : graph, pane };
}
