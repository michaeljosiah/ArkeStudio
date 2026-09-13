import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
let sequence = 0;
const scenario = process.env.ARKE_CODEX_TEST_CASE;
const recovered = !!process.env.ARKE_CODEX_TEST_STATE && existsSync(process.env.ARKE_CODEX_TEST_STATE);
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
  if (method === 'initialize') {
    if (scenario === 'recovery-init-fails' && recovered) write({ id, error: { code: -1, message: 'scripted initialization failure' } });
    else result(id, {});
  }
  else if (method === 'config/read') {
    result(id, { config: { model_provider: 'openai', mcp_servers: { 'unsafe.name': { command: 'sentinel-secret' } }, ...(scenario === 'changed-window-after-recovery' ? { model_context_window: recovered ? 8000 : 100000 } : {}) } });
    if (scenario === 'recovery-exits-after-init' && recovered) setTimeout(() => process.exit(1), 40);
  }
  else if (method === 'model/list') {
    if (params.cursor) result(id, { data: [{ id: 'spark', model: scenario === 'duplicate-model' ? 'image-model' : 'text-only', displayName: 'Text Only', inputModalities: ['text'], isDefault: false }], nextCursor: null });
    else result(id, { data: [{ id: scenario === 'alias-collision' ? 'text-only' : 'catalog-alias', model: 'image-model', displayName: 'Image Model', inputModalities: scenario === 'empty-input' ? [] : scenario === 'image-input-only' ? ['image'] : ['text', 'image'], isDefault: true }], nextCursor: 'page2' });
  } else if (method === 'thread/start') {
    const thread = { id: scenario === 'duplicate-thread' ? 'thread-1' : `thread-${++sequence}`, model: params.model }; threads.set(thread.id, thread);
    const respond = () => result(id, { thread, model: scenario === 'substitute' ? 'wrong-model' : params.model, modelProvider: params.modelProvider, instructionSources: scenario === 'instructions' ? ['private-instructions'] : [] });
    if (scenario === 'slow-create') setTimeout(respond, 150); else respond();
  } else if (method === 'thread/archive') result(id, {});
  else if (method === 'turn/start') {
    const thread = threads.get(params.threadId); thread.turn = `turn-${++sequence}`;
    if (['timeout-once', 'reject-once', 'recovery-init-fails', 'recovery-exits-after-init'].includes(scenario) && !recovered) {
      writeFileSync(process.env.ARKE_CODEX_TEST_STATE, 'uncertain turn was attempted');
      if (scenario !== 'timeout-once') write({ id, error: { code: -1, message: 'scripted turn rejection' } });
      return;
    }
    const base = { threadId: thread.id, turnId: thread.turn };
    if (scenario === 'wrong-callback') write({ id: 'wrong-request', method: 'item/tool/call', params: { threadId: thread.id, turnId: 'unsolicited-turn', callId: 'wrong-call', namespace: 'arke', tool: 'write', arguments: { path: 'should-not-exist.txt', content: 'wrong turn' } } });
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
    notify('thread/tokenUsage/updated', { ...base, tokenUsage: { total: { totalTokens: 42 }, modelContextWindow: (scenario === 'different-windows' && thread.model === 'text-only') || (scenario === 'changed-window-after-recovery' && recovered) ? 8000 : 100000 } });
    setTimeout(() => {
      notify('item/agentMessage/delta', { ...base, itemId: 'two', delta: 'Second item' });
      notify('item/completed', { ...base, item: { id: 'two', type: 'agentMessage', phase: 'final_answer', text: '{"reply":"Second item"}' } });
      finish(thread.id, thread.turn);
    }, 60);
  } else if (method === 'turn/interrupt') { result(id, {}); notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', items: [] } }); }
});
