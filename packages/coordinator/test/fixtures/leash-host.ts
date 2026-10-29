// Stand-in for a supervising parent: spawns an idle child, leashes it to itself, reports
// the child pid, then idles until the test force-kills it. The force-kill runs none of this
// file's code — the child's death is the kernel's doing or nobody's.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { leashChildToParent, leashStorageReaderToParent } from "../../src/job-leash.js";

const shared = process.argv.includes("--shared-readers");
const leash = shared ? leashStorageReaderToParent : leashChildToParent;
if (shared) {
  for (let n = 0; n < 3; n++) {
    const warmup = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const closed = once(warmup, "close");
    const taken = await leash(warmup.pid!);
    warmup.kill("SIGKILL"); await closed;
    if (!taken.ok || n > 0 && !taken.reused) {
      console.error("short-lived readers did not reuse their parent-side job handle"); process.exit(2);
    }
  }
}

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});

const result = await leash(child.pid!);
if (!result.ok || shared && !result.reused) {
  console.error(`leash failed: ${result.reason ?? "unknown"}`);
  child.kill();
  process.exit(2);
}
console.log(`leashed ${child.pid}`);
setInterval(() => {}, 1000);
