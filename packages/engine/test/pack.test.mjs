import assert from "node:assert/strict";
import { it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile);
const npm = "npm";
async function run(command, args, cwd) {
  // npm supplies its CLI path to test scripts. Run it through Node on every platform, without a shell.
  if (command === npm) {
    if (!process.env.npm_execpath) throw new Error("Run this check through npm test.");
    args = [process.env.npm_execpath, ...args]; command = process.execPath;
  }
  return exec(command, args, { cwd, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
}
it("packed engine installs and executes with no source or workspace fallback", { timeout: 300000 }, async () => {
  await run(npm, ["run", "build"], process.cwd());
  const root = await mkdtemp(join(tmpdir(), "arke-packed-engine-"));
  try {
    const packed = JSON.parse((await run(npm, ["pack", "--json", "--pack-destination", root], process.cwd())).stdout)[0];
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await run(npm, ["install", "--omit=optional", "--no-audit", "--no-fund", join(root, packed.filename)], root);
    const core = await run(process.execPath, ["--input-type=module", "-e",
      'import { createEngine } from "@arke-studio/engine"; console.log(typeof createEngine);'], root);
    assert.match(core.stdout, /function/);
    await assert.rejects(run(process.execPath, ["--input-type=module", "-e",
      'await import("@arke-studio/engine/local");'], root), /adapter requires better-sqlite3/);
    await run(npm, ["install", "--no-audit", "--no-fund", "better-sqlite3@^12.11.1"], root);
    await cp(resolve("../../fixtures/worlds/the-undersong"), join(root, "app/worlds/the-undersong"), { recursive: true });
    await cp(resolve("test/consumer.mjs"), join(root, "consumer.mjs"));
    const result = await run(process.execPath, ["consumer.mjs"], root);
    assert.match(result.stdout, /external journey complete/);
    await writeFile(join(root, "consumer.ts"), 'import { createEngine, type EnginePolicy, type EngineContext } from "@arke-studio/engine";\nimport { JobQueue, FsWorldProvider } from "@arke-studio/engine/local";\nconst context: EngineContext = { actorId: "a", scopeId: "s", subjectId: "c", executorId: "w" };\nconst policy = {} as EnginePolicy;\nvoid [createEngine, JobQueue, FsWorldProvider, context, policy];\n');
    await run(process.execPath, [resolve("../../node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "consumer.ts"], root);
    const installed = JSON.parse(await readFile(join(root, "node_modules/@arke-studio/engine/package.json"), "utf8"));
    assert.deepEqual(Object.keys(installed.exports), [".", "./local"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
