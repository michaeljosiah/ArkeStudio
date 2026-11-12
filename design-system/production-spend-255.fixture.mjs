// One synthetic production, shared by every frame. Amounts are integer micro-dollars.
// These are design examples, not current provider prices or an author's production history.
import assert from 'node:assert/strict';
export const shots = [
  { id: '12', scene: 'The tide', title: 'Maren at the rail', selected: true },
  { id: '13', scene: 'The tide', title: 'The empty pier', selected: false },
  { id: '14', scene: 'The bell', title: 'The signal', selected: true },
];
export const jobs = [
  { id: 'pass-a', label: 'Board A · shots 12–13', model: 'Video model', outcome: 'Made', source: 'Reported', amount: 5_000_000, plan: [['12', 4], ['13', 6]], video: true },
  { id: 'shot-12', label: 'Shot 12 · another take', model: 'Video model', outcome: 'Made', source: 'Reported', amount: 1_800_000, plan: [['12', 5]], video: true },
  { id: 'failed-12', label: 'Shot 12 · failed attempt', model: 'Video model', outcome: 'Failed', source: 'Reported', amount: 1_200_000, plan: [['12', 5]], video: false },
  { id: 'shot-13', label: 'Shot 13 · another take', model: 'Video model', outcome: 'Made', source: 'Derived', amount: 2_000_000, plan: [['13', 5]], video: true },
  { id: 'shot-14', label: 'Shot 14 · video take', model: 'Video model', outcome: 'Made', source: 'Reported', amount: 2_400_000, plan: [['14', 5]], video: true },
  { id: 'still-14', label: 'Shot 14 · frame', model: 'Image model', outcome: 'Made', source: 'Reported', amount: 600_000, plan: [['14', 1]], video: false },
  { id: 'local-a', label: 'Board A · local take', model: 'Local video', outcome: 'Made', source: 'Unmetered', amount: 0, plan: [['12', 4], ['13', 6]], video: true },
  { id: 'plan-13', label: 'Shot 13 · frame', model: 'Codex image', outcome: 'Made', source: 'ChatGPT plan', amount: 0, plan: [['13', 1]], video: false },
];
export const money = amount => '$' + (amount / 1_000_000).toFixed(2);
export function shares(job) {
  const total = job.plan.reduce((sum, [, seconds]) => sum + seconds, 0);
  let allocated = 0;
  return job.plan.map(([shot, seconds], i) => {
    const amount = i === job.plan.length - 1 ? job.amount - allocated : Math.floor(job.amount * seconds / total);
    allocated += amount;
    return { shot, amount };
  });
}
export function summary(ids = shots.map(shot => shot.id)) {
  const included = jobs.filter(job => job.plan.some(([shot]) => ids.includes(shot)));
  return {
    amount: included.reduce((total, job) => total + shares(job).filter(share => ids.includes(share.shot)).reduce((sum, share) => sum + share.amount, 0), 0),
    generated: included.reduce((sum, job) => sum + (job.video ? job.plan.filter(([shot]) => ids.includes(shot)).length : 0), 0),
    selected: shots.filter(shot => ids.includes(shot.id) && shot.selected).length,
    local: included.filter(job => job.source === 'Unmetered').length,
    allowance: included.filter(job => job.source === 'ChatGPT plan').length,
  };
}
assert.deepEqual(summary(), { amount: 13_000_000, generated: 7, selected: 2, local: 1, allowance: 1 });
assert.equal(shots.reduce((sum, shot) => sum + summary([shot.id]).amount, 0), summary().amount);
assert.equal(summary(['12', '13']).amount, 10_000_000);
assert.equal(summary(['14']).amount, 3_000_000);
assert.equal(jobs.filter(job => job.source === 'Reported').reduce((sum, job) => sum + job.amount, 0), 11_000_000);
