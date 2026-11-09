// One headless Chrome for the smoke scripts (issue 2813). Each script used to carry its own copy
// of this: finding Chrome, a throwaway profile, the DevTools port, a CDP client and cleanup. Fifty
// copies drifted apart, and most never removed their profile.
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `ARKE_CHROME`, then `CHROME`, then where Chrome installs by default. */
export function chromePath() {
  return process.env.ARKE_CHROME ?? process.env.CHROME ?? (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
}

/** Asks `read` until it answers with something truthy; a throw counts as not yet. */
export async function until(read, { ms = 20_000, what = "headless Chrome" } = {}) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; } catch { /* not yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Headless Chrome on a temporary profile, connected to its first page. `args` add to the launch
 * flags (a pointer emulation, say). `close()` ends the socket and the process, then removes the
 * profile; call it in a `finally`.
 */
export async function openChrome({ args = [] } = {}) {
  const chrome = chromePath();
  await access(chrome);
  const profile = await mkdtemp(join(tmpdir(), "arke-chrome-"));
  const child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, ...args, "about:blank"], { windowsHide: true, stdio: "ignore" });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let socket;
  const close = async () => {
    socket?.close();
    child.kill();
    await exited;
    // Chrome can hold a profile file for a moment after it exits; a leftover temp folder is not
    // worth failing a smoke run over.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  };
  try {
    const port = await until(async () => (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
  } catch (error) {
    await close();
    throw error;
  }
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data), task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  });
  /** One DevTools protocol call. */
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  /** The value of an expression in the page, awaited, as a user gesture; a page error throws. */
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  /** The viewport as a PNG, written to `path`. */
  const screenshot = async (path) => {
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await writeFile(path, Buffer.from(data, "base64"));
  };
  return { cdp, evaluate, screenshot, close };
}
