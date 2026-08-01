// Stand-in for a supervising parent: spawns an idle child, leashes it to itself, reports
// the child pid, then idles until the test force-kills it. The force-kill runs none of this
// file's code — the child's death is the kernel's doing or nobody's.
import { spawn } from "node:child_process";
import { leashChildToParent } from "../../src/job-leash.js";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});

const result = await leashChildToParent(child.pid!);
if (!result.ok) {
  console.error(`leash failed: ${result.reason ?? "unknown"}`);
  child.kill();
  process.exit(2);
}
console.log(`leashed ${child.pid}`);
setInterval(() => {}, 1000);
