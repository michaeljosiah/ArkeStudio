import { spawn } from "node:child_process";
import type { SetupDeps } from "./local-setup.js";

/**
 * The real seams for fetching local runtimes: streamed HTTP, and two foreign programs run as
 * ordinary subprocesses (Ollama's installer, then its CLI) — never linked, never in-process.
 * Shared by the desktop shell and the dev coordinator so both behave identically.
 */
export function nodeSetupDeps(): SetupDeps {
  return {
    async fetchStream(url, signal, rangeStart, validator) {
      const res = await fetch(url, {
        signal,
        redirect: "follow",
        headers: {
          "Accept-Encoding": "identity",
          ...(rangeStart === null ? {} : { Range: `bytes=${rangeStart}-` }),
          ...(rangeStart === null || validator === null || validator === undefined ? {} : { "If-Range": validator }),
        },
      });
      const len = res.headers.get("content-length");
      const contentRange = res.headers.get("content-range")?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
      const etag = res.headers.get("etag");
      const lastModified = res.headers.get("last-modified");
      const responseDate = res.headers.get("date");
      const modifiedAt = lastModified === null ? Number.NaN : Date.parse(lastModified);
      const datedAt = responseDate === null ? Number.NaN : Date.parse(responseDate);
      // RFC 7232 only permits Last-Modified as a strong validator when the origin's Date proves
      // the resource had not changed for at least sixty seconds before the response was sent.
      const strongLastModified = Number.isFinite(modifiedAt) && Number.isFinite(datedAt) && datedAt - modifiedAt >= 60_000
        ? lastModified
        : null;
      const responseValidator = etag !== null && !etag.startsWith("W/") ? etag : strongLastModified;
      const contentLength = safeInteger(len);
      const contentRangeStart = safeInteger(contentRange?.[1] ?? null);
      const contentRangeEnd = safeInteger(contentRange?.[2] ?? null);
      const contentRangeTotal = contentRange?.[3] === "*" ? null : safeInteger(contentRange?.[3] ?? null);
      return {
        ok: res.ok,
        status: res.status,
        contentLength,
        acceptRanges: res.headers.get("accept-ranges")?.trim().toLowerCase() === "bytes",
        contentRangeStart,
        contentRangeEnd,
        contentRangeTotal,
        validator: responseValidator,
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

function safeInteger(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
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
