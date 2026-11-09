// Opt-in real cloud turn. Owned test world/profile; audio remains in memory.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { newId, ClientMessageSchema } from "../packages/contracts/src/index.ts";
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
import { VoiceBackgroundOwner } from "../packages/coordinator/src/voice/background.ts";
import { executeVoiceBackground } from "../packages/coordinator/src/voice/background-worker.ts";
import { voiceBackgroundTools } from "../packages/coordinator/src/voice/background-tools.ts";
import { ConversationActionLifecycle } from "../packages/coordinator/src/arke-actions/lifecycle.ts";

const flags = new Map(), names = ["root", "speech", "kokoro", "whisper", "espeak", "ffmpeg", "opencode", "auth-root"];
const backgroundMode = process.argv.includes("--background");
const argv = process.argv.filter(arg => arg !== "--background");
for (let i = 2; i < argv.length; i += 2) {
  const key = argv[i]?.slice(2), value = argv[i + 1];
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
let assembled, speech, store, query, voice, background;
let releaseRead;
const heldRead = new Promise(resolve => { releaseRead = resolve; });
let readEntered = false;
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
  try { credentials = source.prepare("SELECT * FROM credential WHERE integration_id = ? AND (active = 1 OR active IS NULL) LIMIT 2").all("github-copilot"); }
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
    logFile: join(root, "speech-startup.log"), maxRestarts: 0,
    healthPath: "/health", healthHeaders: () => ({ Authorization: "Bearer " + capability }), readyTimeoutMs: 90_000 });
  speech.on("status", event => console.log(JSON.stringify({ speechStatus: event.status, reason: event.reason })));
  await speech.start(); await until(() => { assert(speech.status !== "failed", "Speech runtime startup failed; inspect owned startup log."); return speech.status === "healthy"; }, "Speech runtime did not become healthy.");
  const local = new VoxaClient((url, init) => fetch(url, init), () => `http://127.0.0.1:${speech.port}`, { capability: () => capability });
  async function utterance(text) {
    const wav = decodeWav(await local.synthesize({ voiceId: "bf_emma", text })); assert(wav);
    return Buffer.from(encodePcm16Wav(resample(wav.mono, wav.rate, 16000), 16000)).subarray(44);
  }
  const audios = [];
  for (const text of (backgroundMode ? [
    "Please look up the Undersong in the canon in the background. Tell me when the lookup has started.",
    "While that lookup continues, please say one short sentence about a quiet river.",
  ] : Array(2).fill("Hello Arke. Please say one short sentence about a quiet river."))) audios.push(await utterance(text));
  const world = join(root, "world"); await cp(join(project, "fixtures/worlds/the-undersong"), world, { recursive: true });
  store = await WorldStore.open(world); query = new WorldQueryServer(() => store);
  const id = newId("cv"), chat = new WorldChatStore(conversationDir(world, id));
  await chat.create(id, at()); await chat.append({ type: "conversation.created", title: "Live qualification", entryContext: { kind: "world" } }, { at: at() });
  if (backgroundMode) background = new VoiceBackgroundOwner({
    withStore: async (worldId, work) => { assert.equal(worldId, store.worldId); return work(store); },
    execute: (retained, operation, context, signal) => executeVoiceBackground({ adapter: assembled.adapter, query,
      sessionInput: input => input, scratchRoot: join(root, "scratch"), beforeRead: async stop => {
        readEntered = true;
        await Promise.race([heldRead, new Promise((_, reject) => {
          if (stop.aborted) reject(stop.reason);
          else stop.addEventListener("abort", () => reject(stop.reason), { once: true });
        })]);
      } }, retained, operation, context, signal),
  });
  const dependencies = conversationRunDependencies(store, {
    adapter: assembled.adapter, sessionInput: input => input, scratchRoot: join(root, "scratch"), summaryDir: join(root, "summary"),
    ...(background ? { voiceTools: context => voiceBackgroundTools(background, context) } : {}),
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
    store: () => store, current: selected => selected === store, runner: () => ({
      prepareVoice: async (...args) => { console.log("qualification voice binding: started"); const value = await runner.prepareVoice(...args); console.log("qualification voice binding: completed"); return value; },
      voice: (...args) => runner.voice(...args),
    }),
    narrator: async () => ({ provider: "kokoro", voiceId: "bf_emma" }), refresh: async () => {}, background: () => background });
  const session = randomUUID(), started = performance.now();
  const requester = { signal: control.signal, reply: () => false, voice: (_id, response) => { reports.push({ response, ms: performance.now() - started }); if (response.type === "state") console.log(JSON.stringify({ liveState: response.state, ms: Math.round(performance.now() - started) })); return true; } };
  const open = ClientMessageSchema.parse({ kind: "voice-conversation", session, command: { action: "open", worldId: store.worldId, conversationId: id, silenceMs: 650, cloudConsent: true } });
  voice.handle(open, requester);
  await until(() => { assert(!reports.some(row => row.response.type === "state" && row.response.state === "failed"), "Live session failed during opening."); return reports.some(row => row.response.type === "state" && row.response.state === "listening"); }, "Live session did not open.");
  const turns = [];
  let interruptedWhileReadHeld = false;
  for (let turn = 0; turn < 2; turn++) {
    const offset = reports.length;
    const current = () => reports.slice(offset);
    if (backgroundMode && turn === 1) await until(() => readEntered, "Worker did not enter an actual source tool.");
    const feeding = (async () => {
    for (const part of [Buffer.alloc(16000), audios[turn], Buffer.alloc(64000)]) for (let offset = 0; offset < part.length; offset += 1280) {
      const chunk = part.subarray(offset, offset + 1280);
      voice.handle({ kind: "voice-conversation", session, command: { action: "audio", audioBase64: chunk.toString("base64") } }, requester);
      await new Promise(resolve => setTimeout(resolve, chunk.length / 32));
    }
    })();
    await until(() => {
      const rows = current(), firstAudio = rows.findIndex(row => row.response.type === "audio");
      assert(!rows.some(row => row.response.type === "state" && row.response.state === "failed"), "Live host reported failure; see static qualification stages.");
      if (backgroundMode && turn === 1 && firstAudio >= 0 && !interruptedWhileReadHeld) {
        interruptedWhileReadHeld = true;
        voice.handle({ kind: "voice-conversation", session, command: { action: "interrupt" } }, requester);
      }
      return rows.some(row => row.response.type === "text" && row.response.role === "studio" && row.response.final)
        && firstAudio >= 0 && rows.slice(firstAudio + 1).some(row => row.response.type === "state" && row.response.state === "listening");
    }, "Real cloud turn/playback did not finish.");
    await feeding;
    const view = foldConversation(id, at(), (await chat.read()).events).view;
    assert.equal(view.messages.length, (turn + 1) * 2);
    const rows = current(), heard = rows.find(row => row.response.type === "text" && row.response.role === "user");
    const first = rows.find(row => row.response.type === "audio");
    const text = rows.find(row => row.response.type === "text" && row.response.role === "studio");
    turns.push({ turn: turn + 1, pcmBytes: rows.filter(row => row.response.type === "audio").reduce((sum, row) => sum + Buffer.from(row.response.audioBase64, "base64").length, 0),
      recognitionToFirstTextMs: Math.round(text.ms - heard.ms), recognitionToFirstAudioMs: Math.round(first.ms - heard.ms) });
  }
  let backgroundEvidence;
  if (backgroundMode) {
    assert(readEntered && interruptedWhileReadHeld);
    const before = await background.list(store.worldId, id);
    assert.equal(before.length, 1); assert.equal(before[0].status, "running");
    const offset = reports.length;
    releaseRead();
    let completed;
    await until(async () => {
      const rows = await background.list(store.worldId, id);
      assert(!rows.some(row => ["failed", "cancelled", "unknown"].includes(row.status)), "Real source lookup failed.");
      completed = rows[0]; return completed?.status === "completed" && completed.speechAttempted;
    }, "Background result was not safely offered.");
    await until(() => {
      const rows = reports.slice(offset), audio = rows.findIndex(row => row.response.type === "audio");
      return audio >= 0 && rows.slice(audio + 1).some(row => row.response.type === "state" && row.response.state === "listening");
    }, "Background result speech did not finish.");
    const journal = await chat.read();
    const outcomes = journal.events.filter(row => row.event.type === "voice.operation" && row.event.message);
    assert.equal(outcomes.length, 1);
    assert(outcomes[0].event.receipts.some(receipt => receipt.status === "complete" && receipt.consulted.length));
    assert.match(completed.result, /drowned god/i); assert.match(completed.result, /Sources:.*CANON-/);
    const claims = journal.events.filter(row => row.event.type === "voice.operation" && row.event.operation.speechAttempted);
    assert.equal(claims.length, 1);
    backgroundEvidence = { realSourceRead: true, foregroundFinishedWhileReadHeld: true, interruptPreservedWorker: true,
      writtenOutcomes: outcomes.length, spokenAttempts: claims.length };
  }
  const result = { model, userMessages: 2, assistantMessages: 2, turns, ...(backgroundEvidence ? { background: backgroundEvidence } : {}), physicalMicrophoneQualified: false };
  await writeFile(join(root, "evidence.json"), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally {
  releaseRead(); const draining = background?.stop();
  console.log("qualification cleanup: voice"); control.abort(); await voice?.stop();
  console.log("qualification cleanup: speech"); await speech?.stop();
  console.log("qualification cleanup: writing"); await assembled?.adapter?.dispose?.(); await assembled?.supervisor?.stop();
  // Native MCP keep-alive connections must close before the HTTP server drains.
  await draining;
  console.log("qualification cleanup: world"); await query?.stop(); await store?.close();
  if (copied.length) {
    const target = new DatabaseSync(join(nativeAuth, "opencode.db"));
    try { target.exec("PRAGMA secure_delete = ON"); for (const id of copied) target.prepare("DELETE FROM credential WHERE id = ?").run(id); target.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
    finally { target.close(); }
  }
}
