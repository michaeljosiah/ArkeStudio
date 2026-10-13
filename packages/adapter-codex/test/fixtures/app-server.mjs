import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
let sequence = 0;
let imageStarts = 0;
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
  else if (method === 'account/read') {
    const account = scenario.startsWith('image-apikey') ? { type: 'apiKey' } : scenario === 'image-logged-out' ? null : { type: 'chatgpt', email: 'a@example.test', planType: 'plus' };
    result(id, { account, requiresOpenaiAuth: true });
  }
  else if (method === 'modelProvider/capabilities/read') result(id, { imageGeneration: scenario !== 'image-unsupported', namespaceTools: true, webSearch: true });
  else if (method === 'model/list') {
    if (params.cursor) result(id, { data: [{ id: 'spark', model: scenario === 'duplicate-model' ? 'image-model' : 'text-only', displayName: 'Text Only', inputModalities: ['text'], isDefault: false }], nextCursor: null });
    else result(id, { data: [{ id: scenario === 'alias-collision' ? 'text-only' : 'catalog-alias', model: 'image-model', displayName: 'Image Model', inputModalities: scenario === 'empty-input' ? [] : scenario === 'image-input-only' ? ['image'] : ['text', 'image'], isDefault: true }], nextCursor: 'page2' });
  } else if (method === 'thread/start') {
    const thread = { id: scenario === 'duplicate-thread' ? 'thread-1' : `thread-${++sequence}`, model: params.model }; threads.set(thread.id, thread);
    const respond = () => result(id, { thread, model: scenario === 'substitute' ? 'wrong-model' : params.model, modelProvider: scenario === 'substitute-provider' ? 'wrong-provider' : params.modelProvider, instructionSources: scenario === 'instructions' ? ['private-instructions'] : [] });
    if (scenario === 'slow-create') setTimeout(respond, 150); else respond();
  } else if (method === 'thread/archive') result(id, {});
  else if (method === 'thread/unsubscribe') result(id, {});
  else if (method === 'turn/start') {
    const thread = threads.get(params.threadId); thread.turn = `turn-${++sequence}`;
    if (['timeout-once', 'announced-timeout-once', 'reject-once', 'recovery-init-fails', 'recovery-exits-after-init'].includes(scenario) && !recovered) {
      writeFileSync(process.env.ARKE_CODEX_TEST_STATE, 'uncertain turn was attempted');
      if (scenario === 'announced-timeout-once') {
        notify('turn/started', { threadId: thread.id, turn: { id: thread.turn } });
        notify('item/agentMessage/delta', { threadId: thread.id, turnId: thread.turn, itemId: 'early-answer', delta: 'announced before acknowledgment' });
      } else if (scenario !== 'timeout-once') write({ id, error: { code: -1, message: 'scripted turn rejection' } });
      return;
    }
    const base = { threadId: thread.id, turnId: thread.turn };
    if (scenario.startsWith('image-gen')) {
      // The first start is never answered and never announced; a later one proceeds normally.
      if (scenario === 'image-gen-hang-first' && ++imageStarts === 1) return;
      if (scenario === 'image-gen-hang-all') return;
      notify('turn/started', { threadId: thread.id, turn: { id: thread.turn } });
        result(id, { turn: { id: thread.turn } });
        if (scenario === 'image-gen-turn-hang') return;
        if (scenario === 'image-gen-turn-limit' || scenario === 'image-gen-turn-auth') {
          notify('turn/completed', { threadId: thread.id, turn: { id: thread.turn, status: 'failed', items: [], error: {
            codexErrorInfo: scenario === 'image-gen-turn-limit' ? 'usageLimitExceeded' : 'unauthorized',
          } } });
          return;
        }
        if (scenario === 'image-gen-refused') {
          // The image tool was refused at the output stage; the model answered in words and the turn completed.
          notify('item/completed', { ...base, item: { id: 'msg', type: 'agentMessage', text: 'The image request was rejected by the safety system,\n  so no image was made.' } });
          finish(thread.id, thread.turn);
          return;
        }
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fixture-image-bytes')]).toString('base64');
      const item = scenario === 'image-gen-limit' ? { id: 'img', type: 'imageGeneration', status: 'failed', result: '', failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: 1900000000 } }
        : scenario === 'image-gen-junk' ? { id: 'img', type: 'imageGeneration', status: 'completed', result: Buffer.from('not an image at all').toString('base64'), savedPath: '/etc/passwd' }
        : { id: 'img', type: 'imageGeneration', status: 'completed', result: png, revisedPrompt: 'revised', savedPath: '/etc/passwd' };
      setTimeout(() => {
          notify('item/completed', { ...base, item });
          if (scenario === 'image-gen-picture-hang') return;
        if (scenario === 'image-gen-late-failure') notify('turn/completed', { threadId: thread.id, turn: { id: thread.turn, status: 'failed', items: [] } });
        else finish(thread.id, thread.turn);
      }, 20);
      return;
    }
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
