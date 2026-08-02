// Supervised-child stand-in for supervisor tests. Behaviour is driven by env:
//   MODE=healthy | never-healthy | ignore-stop
//   DIE_AFTER_MS=<n> — exit(1) n ms after becoming reachable
import http from "node:http";

const mode = process.env.MODE ?? "healthy";
const port = Number(process.env.PORT);

const server = http.createServer((_req, res) => {
  if (mode === "never-healthy") {
    res.writeHead(500);
    res.end("not ready");
  } else {
    // The body carries this process's pid so shim tests can find the grandchild doing the
    // real work behind a .cmd wrapper.
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, pid: process.pid }));
  }
});
server.listen(port, "127.0.0.1");

if (process.env.DIE_AFTER_MS) {
  setTimeout(() => process.exit(1), Number(process.env.DIE_AFTER_MS));
}

if (mode === "ignore-stop") {
  // On POSIX this forces the supervisor down the SIGKILL path; on Windows kill() is already
  // TerminateProcess, so the process simply dies — both end with no orphan.
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}
