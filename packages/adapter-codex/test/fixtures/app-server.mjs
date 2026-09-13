import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
let sequence = 0;
const scenario = process.env.ARKE_CODEX_TEST_CASE;
const threads = new Map();
const write = data => process.stdout.write(JSON.stringify(data) + '\n');
const notify = (method, params) => write({ method, params });
const result = (id, result) => write({ id, result });
const log = data => { if (process.env.ARKE_CODEX_TEST_LOG) appendFileSync(process.env.ARKE_CODEX_TEST_LOG, JSON.stringify(data) + '\n'); };
const finish = (threadId, turnId) => notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); log(request);
  const { id, method, params = {} } = request;
  if (id === 'tool-request' && !method) {
    const thread = [...threads.values()][0];
    notify('item/agentMessage/delta', { threadId: thread.id, turnId: thread.turn, itemId: 'answer', delta: 'tool completed' });
    finish(thread.id, thread.turn); return;
  }
  if (method === 'initialize') result(id, {});
  else if (method === 'config/read') result(id, { config: { model_provider: 'openai', mcp_servers: { 'unsafe.name': { command: 'sentinel-secret' } } } });
  else if (method === 'model/list') {
    if (params.cursor) result(id, { data: [{ id: 'spark', model: 'text-only', displayName: 'Text Only', inputModalities: ['text'], isDefault: false }], nextCursor: null });
    else result(id, { data: [{ id: 'catalog-alias', model: 'image-model', displayName: 'Image Model', inputModalities: ['text', 'image'], isDefault: true }], nextCursor: 'page2' });
  } else if (method === 'thread/start') {
    const thread = { id: `thread-${++sequence}`, model: params.model }; threads.set(thread.id, thread);
    const respond = () => result(id, { thread, model: scenario === 'substitute' ? 'wrong-model' : params.model, modelProvider: params.modelProvider, instructionSources: scenario === 'instructions' ? ['private-instructions'] : [] });
    if (scenario === 'slow-create') setTimeout(respond, 150); else respond();
  } else if (method === 'thread/archive') result(id, {});
  else if (method === 'turn/start') {
    const thread = threads.get(params.threadId); thread.turn = `turn-${++sequence}`;
    const base = { threadId: thread.id, turnId: thread.turn };
    notify('turn/started', { threadId: thread.id, turn: { id: thread.turn } });
    const respond = () => result(id, { turn: { id: thread.turn } });
    if (scenario === 'slow-turn') { setTimeout(respond, 100); return; }
    respond();
    if (scenario === 'exit') { setTimeout(() => process.exit(1), 15); return; }
    if (scenario === 'malformed') { setTimeout(() => process.stdout.write('{bad\n'), 15); return; }
    if (scenario === 'hang') return;
    if (scenario === 'async-question') {
      notify('item/started', { ...base, item: { id: 'question', type: 'agentMessage', delivery: 'async', questions: [{ title: 'Should never reach UI' }], phase: 'final_answer', text: 'Should never reach UI' } });
      finish(thread.id, thread.turn); return;
    }
    if (scenario === 'image' || scenario === 'forbidden') {
      write({ id: 'tool-request', method: 'item/tool/call', params: { ...base, callId: 'tool-1', namespace: scenario === 'image' ? 'arke' : 'functions', tool: scenario === 'image' ? 'read' : 'exec', arguments: scenario === 'image' ? { path: 'frame.png' } : { command: 'read outside-secret' } } }); return;
    }
    notify('item/agentMessage/delta', { ...base, itemId: 'one', delta: 'Hello' });
    notify('item/agentMessage/delta', { ...base, itemId: 'one', delta: ' world' });
    notify('item/completed', { ...base, item: { id: 'one', type: 'agentMessage', phase: 'commentary', text: 'Hello world' } });
    notify('thread/tokenUsage/updated', { ...base, tokenUsage: { total: { totalTokens: 42 }, modelContextWindow: 100000 } });
    setTimeout(() => {
      notify('item/agentMessage/delta', { ...base, itemId: 'two', delta: 'Second item' });
      notify('item/completed', { ...base, item: { id: 'two', type: 'agentMessage', phase: 'final_answer', text: '{"reply":"Second item"}' } });
      finish(thread.id, thread.turn);
    }, 60);
  } else if (method === 'turn/interrupt') { result(id, {}); notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', items: [] } }); }
});
