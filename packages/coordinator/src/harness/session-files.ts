import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { CreateSessionInput, HarnessAdapter, SessionConfigInput, SessionRef } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { loadSkillBodies } from "./skills.js";

const setupByDir = new Map<string, Promise<void>>();

async function serialized<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const absolute = resolve(dir).replaceAll("\\", "/");
  const key = process.platform === "win32" || process.platform === "darwin" ? absolute.toLowerCase() : absolute;
  const previous = setupByDir.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  setupByDir.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (setupByDir.get(key) === tail) setupByDir.delete(key);
  }
}

/**
 * Lay down whatever the wired harness needs beside a session's work, before the session opens.
 *
 * This used to be a config WRITER threaded from the host through six call sites, each of which
 * wrote `opencode.json` unconditionally — which was fine while every harness was OpenCode, and
 * became a lie the moment one of them took its confinement as call options instead. An adapter
 * that needs nothing on disk now says so by offering nothing, and nothing is written.
 *
 * The writing stays here rather than in the adapters on purpose: extended-length paths and
 * atomic replacement are solved once in this package, and two adapters solving them again would
 * solve them differently.
 */
export async function writeSessionFiles(
  adapter: Pick<HarnessAdapter, "sessionFiles" | "prepareSession" | "abandonSessionPreparation">,
  dir: string,
  pending: SessionConfigInput | Promise<SessionConfigInput> = {},
  signal?: AbortSignal,
): Promise<string> {
  // A configuration still being decided (issue 1247) is bounded like the creation it feeds:
  // a caller that gave up must not find a session created for it once discovery settles.
  const input = signal === undefined ? await pending : await Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
  const preparationId = randomUUID();
  const prepared = { ...input, preparationId, skillBodies: await loadSkillBodies(input) };
  // Both seams, always. A harness takes its settings as files or as call options, and a
  // caller offering only one silently configures nothing for the harnesses using the other.
  try {
    adapter.prepareSession?.(prepared);
    for (const file of adapter.sessionFiles?.(prepared) ?? []) {
      await atomicWriteFile(join(dir, file.name), file.contents);
    }
    return preparationId;
  } catch (error) {
    adapter.abandonSessionPreparation?.(preparationId);
    throw error;
  }
}

/** Write configuration and create its session as one per-directory critical section. */
export async function createPreparedSession(
  adapter: HarnessAdapter,
  dir: string,
  input: SessionConfigInput | Promise<SessionConfigInput>,
  session: CreateSessionInput,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<SessionRef> {
  return serialized(dir, async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("session creation timed out")), timeoutMs);
    // The caller's stop, combined with the bound: a run stopped while its configuration waits
    // on discovery (issue 1247) must not find a session created for it once discovery settles.
    const stop = () => abort.abort(signal!.reason);
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    try {
      const preparationId = await writeSessionFiles(adapter, dir, input, abort.signal);
      try {
        // A stop that landed while the files were written creates nothing: not every adapter
        // refuses an already-fired signal, and a session opened for a stopped run is an orphan.
        abort.signal.throwIfAborted();
        return await adapter.createSession({ ...session, cwd: dir, preparationId, signal: abort.signal });
      } finally {
        adapter.abandonSessionPreparation?.(preparationId);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("session creation stopped", { cause: error });
      if (abort.signal.aborted) throw new Error("session creation timed out", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  });
}

/**
 * What Studio knows about a session, enriched with the Settings the coordinator holds.
 *
 * Read at call time rather than captured, so changing a model or a brief in Settings applies to
 * the next session rather than the next run — the property the old `buildConfig` wrapper had and
 * the reason this is a function rather than a value.
 *
 * May answer later rather than now (issue 1247): the local default it fills in is read from the
 * harness catalogue, and a session that opens before the catalogue's first fetch has to wait for
 * it — the alternative was that first session quietly running on the cloud default. The writers
 * above take the promise, so a caller that only hands the input on has nothing to await.
 */
export type SessionInput = (input: SessionConfigInput) => SessionConfigInput | Promise<SessionConfigInput>;
