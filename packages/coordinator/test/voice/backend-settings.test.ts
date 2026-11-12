import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientMessageSchema, REMOTE_COMMAND_ACCESS } from "@arke-studio/contracts";
import { AppSettingsFile } from "../../src/app-settings.js";
import { tempDir } from "../tmp.js";

test("speech backend choices persist without rewriting personal Voxa preferences", async () => {
  const file = new AppSettingsFile(join(await tempDir("arke-speech-settings-"), "settings.json"));
  await file.setVoxa({ executablePath: "C:/Personal/voxa.exe", extraArgs: ["--personal"] });
  await file.setVoxa({ backend: "pipecat" });
  const settings = await file.load();
  assert.deepEqual(settings.voxa, { backend: "pipecat", executablePath: "C:/Personal/voxa.exe", extraArgs: ["--personal"] });
  await file.setVoxa({ backend: "voxa" });
  assert.equal((await file.load()).voxa.executablePath, "C:/Personal/voxa.exe");
  assert.equal(ClientMessageSchema.safeParse({ kind: "set-speech-backend", backend: "pipecat" }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ kind: "set-speech-backend", backend: "unmanaged-python" }).success, false);
  assert.equal(REMOTE_COMMAND_ACCESS["set-speech-backend"], "host");
});


test("first-run speech default is persisted once while an upgrade preserves its prior settings byte for byte", async () => {
  const path = join(await tempDir("arke-first-speech-"), "settings.json"), file = new AppSettingsFile(path);
  assert.equal((await file.initializeSpeechBackend("pipecat")).voxa.backend, "pipecat");
  assert.equal((await new AppSettingsFile(path).load()).voxa.backend, "pipecat");
  await file.setVoxa({ backend: "voxa", executablePath: "C:/Personal/voxa.exe", extraArgs: ["--personal"] });
  const before = await readFile(path, "utf8");
  assert.equal((await file.initializeSpeechBackend("pipecat")).voxa.backend, "voxa");
  assert.equal(await readFile(path, "utf8"), before);
  const legacyPath = join(await tempDir("arke-legacy-speech-"), "settings.json"), legacy = new AppSettingsFile(legacyPath);
  await legacy.setVoxa({ extraArgs: ["--legacy"] });
  const legacyBefore = await readFile(legacyPath, "utf8");
  assert.equal((await legacy.initializeSpeechBackend("pipecat")).voxa.backend, undefined);
  assert.equal(await readFile(legacyPath, "utf8"), legacyBefore);
});
