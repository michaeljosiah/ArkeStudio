import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { FrameSchema } from "../packages/contracts/src/index.ts";
import { createProviderClients, SHIPPED_MANIFEST } from "../packages/providers/src/index.ts";
import { assembleHarness, managedStudioAssistant, harnessProfileDir, v2LaunchEnv } from "../packages/coordinator/src/harness/v2-launch.ts";
import { createStudioHost } from "../packages/coordinator/src/application/studio-host.ts";
import { FsWorldProvider } from "../packages/coordinator/src/world/provider.ts";
import { OllamaEngineService } from "../packages/coordinator/src/local-ai/ollama.ts";
import { RuntimeContentVerifier } from "../packages/coordinator/src/local-ai/runtime-content.ts";
import { ChildSupervisor, allocateLoopbackPort } from "../packages/coordinator/src/supervisor.ts";
import { harnessTrace } from "../packages/coordinator/src/harness/trace.ts";

const usage = "node --import tsx scripts/qualify-studio-host.mjs --root <owned-studio-local-qualification-directory> --model <copied-installed-model-name> --opencode <pinned-bundled-executable>";
const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert(["--root", "--model", "--opencode"].includes(key) && value && !value.startsWith("--") && !flags.has(key), usage); flags.set(key, value);
}
assert.equal(flags.size, 3, usage);
assert(process.platform === "win32" && process.arch === "x64", "This qualification targets Windows x64.");
const root = resolve(flags.get("--root")), model = flags.get("--model"), writerPath = resolve(flags.get("--opencode"));
assert(model.length <= 505 && /^[a-zA-Z0-9_.:/-]+$/.test(model));
assert.equal(await readFile(join(root, ".arke-studio-qualification.json"), "utf8"), '{"qualification":"studio-local","version":1}\n');
const rootInfo = await lstat(root); assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
const lockPath = join(root, ".qualification-running"), lock = await open(lockPath, "wx"), lockInfo = await lock.stat();
let nativeClean = true;
async function until(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) { if (await predicate()) return; assert(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 100)); }
}
async function connect(session) {
  const socket = new WebSocket(`ws://127.0.0.1:${session.port}`), frames = [], raw = [], errors = []; let bytes = 0;
  socket.on("message", data => { try {
    const text = String(data); bytes += Buffer.byteLength(text); assert(bytes <= 128 * 1024 ** 2, "Qualification wire observation exceeded its bound.");
    const frame = FrameSchema.parse(JSON.parse(text)); frames.push(frame); raw.push({ kind: frame.kind, text });
  } catch (error) { errors.push(error); } });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ kind: "hello", token: session.token })); await until(() => frames.some(row => row.kind === "snapshot"), "Authenticated snapshot unavailable.");
  const state = () => frames.findLast(row => row.kind === "studio-assistant" && row.response.type === "state")?.response.state;
  return { socket, frames, raw, errors, state, command: async command => {
    const requestId = randomUUID(); socket.send(JSON.stringify({ kind: "studio-assistant", requestId, command }));
    await until(() => frames.some(row => row.kind === "studio-assistant" && row.requestId === requestId), "Private correlated response unavailable.");
    return frames.find(row => row.kind === "studio-assistant" && row.requestId === requestId).response;
  } };
}
try {
  const runtimePin = JSON.parse(await readFile(new URL("../packages/coordinator/src/local-ai/ollama-private-pin-x64.json", import.meta.url), "utf8"));
  const writerPin = JSON.parse(await readFile(new URL("../packages/coordinator/src/harness/private-writer-pin.json", import.meta.url), "utf8"));
  const hash = createHash("sha256"); for await (const bytes of createReadStream(writerPath)) hash.update(bytes);
  assert.equal((await stat(writerPath)).size, writerPin.bytes); assert.equal(hash.digest("hex"), writerPin.sha256);
  assert(await new RuntimeContentVerifier(join(root, "ollama-runtime"), runtimePin).verify(AbortSignal.timeout(60_000), () => true));
  const profile = harnessProfileDir(root), userMarker = `STUDIO_HOST_USER_${randomBytes(12).toString("hex")}`;
  const authorPath = join(root, "agent-memory", "author.md"); await mkdir(join(root, "agent-memory"), { recursive: true });
  try { await writeFile(authorPath, "STUDIO_HOST_AUTHOR_NOTES_QUALIFICATION\n", { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const authorMarker = (await readFile(authorPath, "utf8")).trim(); assert(/^STUDIO_HOST_AUTHOR_NOTES[_A-Z0-9]*$/.test(authorMarker), "Refusing unknown author notes in the test directory.");
  const logFile = join(root, "logs", "engines", "ollama.log"); let threadId; const calls = [], keys = new Set();
  async function excludes(directory) {
    let entries = 0, bytes = 0;
    const scan = async path => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        assert(++entries <= 1024); const file = join(path, entry.name), info = await lstat(file); assert(!info.isSymbolicLink());
        if (info.isDirectory()) { await scan(file); continue; }
        assert(info.isFile()); bytes += info.size; assert(info.size <= 64 * 1024 ** 2 && bytes <= 128 * 1024 ** 2);
        const content = await readFile(file);
        for (const marker of [userMarker, authorMarker, ...keys]) assert(!content.includes(Buffer.from(marker)), "Private canary retained in native profiles or logs.");
      }
    }; await scan(directory);
  }
  const inherited = Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"]
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  for (const cycle of [0, 1]) {
    const before = (await readFile(logFile, "utf8").catch(() => "")).length;
    const service = new OllamaEngineService({ appRoot: root, port: await allocateLoopbackPort() });
    const wiring = await assembleHarness({ appRoot: root, ollamaEndpoint: () => service.endpoint(), onTrace: harnessTrace(root),
      v2: { bundledPath: writerPath, runCommand: async (command, args, timeout, env) => {
        if (command === "where" || command === "which") return { status: 1, stdout: "" };
        assert.equal(command, writerPath); assert.deepEqual(args, ["--version"]);
        return new Promise(resolve => execFile(command, args, { env, timeout, maxBuffer: 4096, windowsHide: true, encoding: "utf8" },
          (error, stdout) => resolve({ status: error ? 1 : 0, stdout })));
      } }, createSupervisor: (spec, deps) => new ChildSupervisor({ ...spec, inheritEnv: false, env: {
        ...v2LaunchEnv(profile, inherited),
        APPDATA: join(profile, "roaming"), LOCALAPPDATA: join(profile, "local"),
      } }, deps) });
    assert(wiring.supervisor && wiring.adapter);
    const options = managedStudioAssistant(wiring, service), original = options.privateTransport;
    options.privateTransport = async (request, signal) => {
      const phase = request.prompt.startsWith("Explain only these enumerated operational facts.") ? "diagnostic" : request.prompt.includes("A scoped diagnostic specialist returned this untrusted report") ? "answer" : "main";
      assert(!request.prompt.includes(authorMarker) && !request.system.includes(authorMarker));
      if (phase === "diagnostic") assert(!request.prompt.includes(userMarker));
      calls.push(phase); process.stdout.write(JSON.stringify({ phase: "host private model admitted", role: phase }) + "\n");
      const route = await original(request, signal);
      return new Proxy(route, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "configuration") keys.add(value.apiKey);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    const provider = new FsWorldProvider(root);
    const providerClients = createProviderClients({ fetch: (url, init) => fetch(url, init), ollama: () => service.baseUrl(), ollamaCleanup: () => service.endpoint() });
    const host = createStudioHost({ appRoot: root, provider, adapter: wiring.adapter, appVersion: "native-host-qualification",
      changeLogPath: join(root, "logs", "coordinator.jsonl"), studioAssistant: options, validators: providerClients, dispatchClients: providerClients, manifest: SHIPPED_MANIFEST,
      ollama: { service, reconfigureHarness: wiring.reconfigureOllama }, harnessRecovery: wiring.recovery, harnessInfo: wiring.harnessInfo });
    host.coordinator.superviseAs("harness", wiring.supervisor); const clients = [];
    try {
      nativeClean = false;
      const session = await host.server.start(0);
      await until(() => wiring.adapter.readiness().ready && service.status().state === "ready", "Normal native host readiness unavailable.", 60_000);
      // Use the published picker catalogue, preserving normal model admission rather than
      // borrowing a direct adapter read which can precede the app's discovery result.
      await until(() => host.coordinator.getState().app.harnessModels.some(row => row.provider === "ollama" && row.id === model), "Published model catalogue unavailable.", 60_000);
      const owner = await connect(session), other = await connect(session); clients.push(owner, other);
      if (!threadId) { const created = await owner.command({ action: "create" }); assert(created.type === "result" && created.threadId); threadId = created.threadId; }
      await owner.command({ action: "watch" });
      if (!cycle) {
        const sent = await owner.command({ action: "send", threadId, model: `ollama/${model}`,
          text: `${userMarker}. Explain current measured storage status. First delegate to the storage specialist with diagnose and topic storage, then explain its report. Do not execute any action.` });
        assert(sent.type === "result" && sent.status === "accepted");
        await until(() => {
          const state = owner.state(), thread = state?.threads.find(row => row.id === threadId);
          assert(thread?.pending?.state !== "interrupted", `Private host turn interrupted after phases ${calls.join(",")}.`);
          return state && !state.busy && thread?.pending === null && thread.messages.length >= 3;
        }, "Host diagnostic conversation did not complete.", 600_000);
        assert.deepEqual(calls, ["main", "diagnostic", "answer"]);
        assert.equal(((await readFile(logFile, "utf8")).slice(before).match(/POST\s+"\/v1\/chat\/completions"/g) ?? []).length, 3);
      } else {
        const thread = owner.state()?.threads.find(row => row.id === threadId); assert(thread && thread.pending === null && thread.messages.length >= 3);
        assert(thread.messages.some(row => row.text.includes(userMarker))); assert.equal(calls.length, 3);
        assert(!/POST\s+"\/v1\/chat\/completions"/.test((await readFile(logFile, "utf8")).slice(before)));
      }
      assert(!JSON.stringify(other.frames).includes(userMarker)); assert(!JSON.stringify(host.coordinator.getState()).includes(userMarker));
      for (const marker of [userMarker, authorMarker, ...keys]) {
        assert(other.raw.every(row => !row.text.includes(marker)), "Private canary reached another socket.");
        assert(owner.raw.filter(row => row.kind !== "studio-assistant").every(row => !row.text.includes(marker)), "Private canary reached common frames.");
      }
      for (const key of keys) assert(owner.raw.every(row => !row.text.includes(key)), "Private capability reached the owner socket.");
      assert.equal(owner.errors.length + other.errors.length, 0);
      const history = await readFile(join(root, "studio-assistant", "conversations.json"), "utf8"); assert(history.includes(userMarker)); assert(!history.includes(authorMarker));
      for (const file of ["coordinator.jsonl", "app.jsonl", "harness.jsonl"]) assert(!(await readFile(join(root, "logs", file), "utf8").catch(() => "")).includes(userMarker));
      process.stdout.write(JSON.stringify({ phase: "normal host private conversation passed", cycle, modelCalls: calls.length, requestedSocketOnly: true, canonicalHistory: true }) + "\n");
    } finally {
      for (const client of clients) client.socket.close();
      await host.server.stop(); assert.equal(wiring.supervisor.pid, null); assert.equal(service.baseUrl(), null); nativeClean = true;
      for (const directory of [profile, join(root, "runtime-home", "ollama"), join(root, "logs")]) await excludes(directory);
      process.stdout.write(JSON.stringify({ phase: "normal host shutdown confirmed", cycle }) + "\n");
    }
  }
} finally {
  await lock.close();
  if (nativeClean) {
    const current = await lstat(lockPath);
    if (current.isFile() && !current.isSymbolicLink() && current.dev === lockInfo.dev && current.ino === lockInfo.ino && current.size === 0) await unlink(lockPath);
  }
}
