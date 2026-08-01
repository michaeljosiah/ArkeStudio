import { spawn } from "node:child_process";
import type { SetupDeps } from "./local-setup.js";

/**
 * The real seams for fetching local runtimes: streamed HTTP, and two foreign programs run as
 * ordinary subprocesses (Ollama's installer, then its CLI) — never linked, never in-process.
 * Shared by the desktop shell and the dev coordinator so both behave identically.
 */
export function nodeSetupDeps(): SetupDeps {
  return {
    async fetchStream(url, signal) {
      const res = await fetch(url, { signal, redirect: "follow" });
      const len = res.headers.get("content-length");
      return {
        ok: res.ok,
        status: res.status,
        contentLength: len === null ? null : Number(len),
        body: res.body === null ? empty() : streamOf(res.body as ReadableStream<Uint8Array>),
      };
    },

    run(command, args, signal) {
      return new Promise((resolve) => {
        const child = spawn(command, [...args], { windowsHide: true, shell: false });
        let output = "";
        const onAbort = () => child.kill();
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (c: Buffer) => (output += c.toString()));
        child.stderr?.on("data", (c: Buffer) => (output += c.toString()));
        child.on("error", (err) => {
          signal.removeEventListener("abort", onAbort);
          resolve({ code: 1, output: String(err) });
        });
        child.on("exit", (code) => {
          signal.removeEventListener("abort", onAbort);
          resolve({ code: code ?? 1, output });
        });
      });
    },

    async which(command) {
      return new Promise((resolve) => {
        const child = spawn(process.platform === "win32" ? "where" : "which", [command], { windowsHide: true });
        let out = "";
        child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
        child.on("error", () => resolve(null));
        child.on("exit", (code) => resolve(code === 0 && out.trim() !== "" ? (out.trim().split(/\r?\n/)[0] ?? null) : null));
      });
    },

    async probeUrl(url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
        return res.ok;
      } catch {
        return false;
      }
    },

    async diskFreeMb(dir) {
      try {
        const { statfs } = await import("node:fs/promises");
        const fs = await statfs(dir);
        return Math.floor((fs.bavail * fs.bsize) / (1024 * 1024));
      } catch {
        return null;
      }
    },
  };
}

async function* streamOf(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* empty(): AsyncIterable<Uint8Array> {
  /* a body-less response contributes nothing */
}
