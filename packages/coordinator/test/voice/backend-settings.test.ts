import assert from "node:assert/strict";
import { test } from "node:test";
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
