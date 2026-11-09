// Opt-in real cloud turn. Owned test world/profile; audio remains in memory.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { newId } from "../packages/contracts/src/index.ts";
import { VoxaClient, decodeWav, encodePcm16Wav, resample } from "../packages/voice/src/index.ts";
import { assembleHarness, harnessProfileDir } from "../packages/coordinator/src/harness/v2-launch.ts";
import { ChildSupervisor } from "../packages/coordinator/src/supervisor.ts";
import { WorldStore } from "../packages/coordinator/src/world/store.ts";
import { WorldChatStore, conversationDir } from "../packages/coordinator/src/world-chat/store.ts";
import { WorldChatRunner } from "../packages/coordinator/src/world-chat/run.ts";
import { foldConversation } from "../packages/coordinator/src/world-chat/fold.ts";
import { WorldQueryServer } from "../packages/coordinator/src/harness/world-query.ts";
import { conversationRunDependencies } from "../packages/coordinator/src/application/conversation-runs.ts";
import { createVoiceConversationHost } from "../packages/coordinator/src/application/voice-conversation.ts";
import { ConversationActionLifecycle } from "../packages/coordinator/src/arke-actions/lifecycle.ts";

const flags = new Map(), names = ["root", "speech", "kokoro", "whisper", "espeak", "ffmpeg", "opencode", "auth-root"];
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.slice(2), value = process.argv[i + 1];
  assert(names.includes(key) && value && !flags.has(key), "Pass explicit qualification paths; see testing guide.");
  flags.set(key, resolve(value));
}
assert.equal(flags.size, names.length);
const root = flags.get("root"), speechRoot = flags.get("speech"), model = "github-copilot/claude-haiku-4.5";
const project = fileURLToPath(new URL("../", import.meta.url));
await mkdir(root); // Refuse every existing directory, including another run's profile.
process.chdir(root);
await writeFile(join(root, ".arke-live-qualification"), "1\n", { flag: "wx" });
const nativeAuth = join(harnessProfileDir(root), ".local/share/opencode");
await mkdir(nativeAuth, { recursive: true });
const copied = [];
let assembled, speech, store, query, voice;
const control = new AbortController(), reports = [], at = () => new Date().toISOString();
async function until(predicate, label, ms = 120_000) {
  const end = Date.now() + ms;
  while (!await predicate()) { assert(Date.now() < end, label); await new Promise(resolve => setTimeout(resolve, 50)); }
}
try {
  assembled = await assembleHarness({ appRoot: root, engine: "opencode", v2: { configuredPath: flags.get("opencode") } });
  assert(assembled.adapter && assembled.supervisor);
  await assembled.supervisor.start();
  await until(() => assembled.supervisor.status === "healthy", "OpenCode did not become healthy.", 60_000);
  await assembled.supervisor.stop();
  // Native v2 stores connections in SQLite, not legacy auth/account JSON. Copy
  // only the selected integration's active credential into this new owned DB,
  // with the native owner stopped. No personal sessions/messages are copied.
  const source = new DatabaseSync(join(flags.get("auth-root"), "opencode.db"), { readOnly: true });
  let credentials;
  try { credentials = source.prepare("SELECT * FROM credential WHERE integration_id = ? AND active = 1 LIMIT 2").all("github-copilot"); }
  finally { source.close(); }
  assert.equal(credentials.length, 1, "Exactly one already connected native Copilot account is required.");
  const target = new DatabaseSync(join(nativeAuth, "opencode.db"));
  try {
    assert.equal(target.prepare("SELECT COUNT(*) AS count FROM credential").get().count, 0);
    const columns = ["id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_updated"];
    for (const row of credentials) {
      target.prepare(`INSERT INTO credential (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(key => row[key]));
      copied.push(row.id);
    }
  } finally { target.close(); credentials = null; }
  await assembled.supervisor.start();
  await until(() => assembled.supervisor.status === "healthy", "Seeded OpenCode did not become healthy.", 60_000);
  await assembled.adapter.init(); assert(assembled.adapter.readiness().ready);
  let models;
  await until(async () => {
    try { models = await assembled.adapter.listModels(); return true; }
    catch (error) { if (error.status === 503) return false; throw error; }
  }, "OpenCode's provider catalogue did not activate.", 90_000);
  const selected = models.find(row => row.provider + "/" + row.id === model);
  const integration = (await assembled.adapter.listIntegrations()).find(row => row.id === "github-copilot");
  console.log(JSON.stringify({ selectedModelPresent: !!selected, connectedAccounts: integration?.connections?.length ?? 0 }));
  assert(selected, "The connected account did not offer the pinned audition model.");
  const capability = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  speech = new ChildSupervisor({ id: "qualification-speech", command: join(speechRoot, "python/python.exe"),
    args: ["-E", "-s", "-B", join(project, "packages/voice/runtime/service.py"), "--port", "{port}",
      ...["kokoro", "whisper", "espeak"].flatMap(key => ["--" + key, flags.get(key)]), "--decoder", flags.get("ffmpeg")],
    inheritEnv: false, env: { SystemRoot: process.env.SystemRoot, ARKE_SPEECH_CAPABILITY: capability,
      HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", NUMBA_CACHE_DIR: join(root, "numba") },
    healthPath: "/health", healthHeaders: () => ({ Authorization: "Bearer " + capability }), readyTimeoutMs: 90_000 });
  await speech.start(); await until(() => speech.status === "healthy", "Speech runtime did not become healthy.");
  const local = new VoxaClient((url, init) => fetch(url, init), () => `http://127.0.0.1:${speech.port}`, { capability: () => capability });
  const sample = await local.synthesize({ voiceId: "bf_emma", text: "Hello Arke. Please say one short sentence about a quiet river." });
  const wav = decodeWav(sample); assert(wav);
  const audio = Buffer.from(encodePcm16Wav(resample(wav.mono, wav.rate, 16000), 16000)).subarray(44);
  const world = join(root, "world"); await cp(join(project, "fixtures/worlds/the-undersong"), world, { recursive: true });
  store = await WorldStore.open(world); query = new WorldQueryServer(() => store);
  const id = newId("cv"), chat = new WorldChatStore(conversationDir(world, id));
  await chat.create(id, at()); await chat.append({ type: "conversation.created", title: "Live qualification", entryContext: { kind: "world" } }, { at: at() });
  const dependencies = conversationRunDependencies(store, {
    adapter: assembled.adapter, sessionInput: input => input, scratchRoot: join(root, "scratch"), summaryDir: join(root, "summary"),
    activeStore: () => store, query, actions: new ConversationActionLifecycle({ worldId: store.worldId, worldPath: world }),
    jobs: () => [], exports: async () => [], actionExports: () => [], researchAllowed: () => false,
    resolveLanguageModel: async () => ({ modelId: model, sessionModel: model }), onTurnFailed: () => {}, onProgress: () => {},
  });
  for (const key of ["prepare", "createSession", "release"]) {
    const original = dependencies[key];
    dependencies[key] = async (...args) => {
      console.log(`qualification ${key}: started`);
      try { const value = await original(...args); console.log(`qualification ${key}: completed`); return value; }
      catch (error) {
        const categories = ["timed out", "not ready", "usable model route", "stopped", "model", "session preparation", "native", "location", "scope", "ownership", "schema", "ENOENT", "EPERM", "fetch failed"];
        console.log(JSON.stringify({ stage: key, error: error.name, categories: categories.filter(word => String(error.message).includes(word)) }));
        throw error;
      }
    };
  }
  const runner = new WorldChatRunner(dependencies);
  voice = createVoiceConversationHost({ endpoint: async () => ({ url: `ws://127.0.0.1:${speech.port}/live`, headers: { Authorization: "Bearer " + capability } }),
    store: () => store, current: selected => selected === store, runner: () => runner,
    narrator: async () => ({ provider: "kokoro", voiceId: "bf_emma" }), refresh: async () => {} });
  const session = randomUUID(), started = performance.now();
  const requester = { signal: control.signal, reply: () => false, voice: (_id, response) => { reports.push({ response, ms: performance.now() - started }); return true; } };
  voice.handle({ kind: "voice-conversation", session, command: { action: "open", worldId: store.worldId, conversationId: id, silenceMs: 650, cloudConsent: true } }, requester);
  await until(() => reports.some(row => row.response.type === "state" && row.response.state === "listening"), "Live session did not open.");
  const feeding = (async () => {
    for (const part of [Buffer.alloc(16000), audio, Buffer.alloc(64000)]) for (let offset = 0; offset < part.length; offset += 1280) {
      const chunk = part.subarray(offset, offset + 1280);
      voice.handle({ kind: "voice-conversation", session, command: { action: "audio", audioBase64: chunk.toString("base64") } }, requester);
      await new Promise(resolve => setTimeout(resolve, chunk.length / 32));
    }
  })();
  await until(() => {
    assert(!reports.some(row => row.response.type === "state" && row.response.state === "failed"), "Live host reported failure; see static qualification stages.");
    return reports.some(row => row.response.type === "text" && row.response.role === "studio" && row.response.final)
    && reports.some(row => row.response.type === "audio");
  }, "Real cloud turn/playback did not finish.");
  await feeding;
  const view = foldConversation(id, at(), (await chat.read()).events).view;
  assert.equal(view.messages.length, 2); assert.equal(view.messages[0].role, "user"); assert.equal(view.messages[1].role, "studio");
  const heard = reports.find(row => row.response.type === "text" && row.response.role === "user");
  const first = reports.find(row => row.response.type === "audio");
  const result = { model, userMessages: 1, assistantMessages: 1, pcmBytes: reports.filter(row => row.response.type === "audio").reduce((sum, row) => sum + Buffer.from(row.response.audioBase64, "base64").length, 0),
    recognitionToFirstAudioMs: Math.round(first.ms - heard.ms), physicalMicrophoneQualified: false };
  await writeFile(join(root, "evidence.json"), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally {
  console.log("qualification cleanup: voice"); control.abort(); await voice?.stop();
  console.log("qualification cleanup: speech"); await speech?.stop();
  console.log("qualification cleanup: writing"); await assembled?.adapter?.dispose?.(); await assembled?.supervisor?.stop();
  // Native MCP keep-alive connections must close before the HTTP server drains.
  console.log("qualification cleanup: world"); await query?.stop(); await store?.close();
  if (copied.length) {
    const target = new DatabaseSync(join(nativeAuth, "opencode.db"));
    try { for (const id of copied) target.prepare("DELETE FROM credential WHERE id = ?").run(id); target.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
    finally { target.close(); }
  }
}
