const x = '<button class="x" aria-label="Dismiss">×</button>';
const note = (title, world) => `<div class="note"><i></i><div class="body"><b>${title}</b><small>${world}</small></div><div class="end"><button>View</button>${x}</div></div>`;
const row = (title, sub, quiet) => `<div class="row${quiet ? ' quiet' : ''}"><i></i><div class="main"><b>${title}</b><small>${sub}</small></div></div>`;
const panel = body => `<div class="panel"><div class="head">Activity</div><div class="tabs"><span>What’s new</span><b>Inbox</b><span>Spend</span></div><div class="status"><span>The Undersong</span><span>All worlds ▾</span></div><div class="inbody">${body}</div></div>`;
const empty = '<div class="empty">Nothing running, nothing waiting on you</div>';
export const frames = [
  { id: '268a', title: 'The notice, once. Replaces the banner', width: 880, height: 130, markup: `<div class="fn268">${note('2 files could not be read', 'The Undersong')}${note('1 record shares a name', 'The Undersong')}</div>` },
  { id: '268b', title: 'View opens the Inbox: the details stay here', width: 480, height: 500, markup: `<div class="fn268">${panel(`${empty}<div class="eyebrow">Could not be read · 2</div>${row('characters/maren-kest.md', 'invalid frontmatter at line 4')}${row('productions/undertow/scenes/s04.json', 'duplicate scene id s04')}<div class="eyebrow">Same name · 1</div>${row('props/lantern.md', 'answers to @lantern, as does “Old Lantern”')}`)}</div>` },
  { id: '268c', title: 'Past versions only: no notice, no dot, Inbox only', width: 480, height: 340, markup: `<div class="fn268">${panel(`${empty}<div class="eyebrow">History · 2</div>${row('Bible · version 4', 'differs from current', true)}${row('Maren Kest · version 1', 'missing', true)}`)}</div>` },
];
