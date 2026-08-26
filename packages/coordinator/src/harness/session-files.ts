import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { CreateSessionInput, HarnessAdapter, SessionConfigInput, SessionRef } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";

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
  input: SessionConfigInput = {},
): Promise<string> {
  const preparationId = randomUUID();
  const prepared = { ...input, preparationId };
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
  input: SessionConfigInput,
  session: CreateSessionInput,
  timeoutMs = 30_000,
): Promise<SessionRef> {
  return serialized(dir, async () => {
    const preparationId = await writeSessionFiles(adapter, dir, input);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("session creation timed out")), timeoutMs);
    try {
      return await adapter.createSession({ ...session, cwd: dir, preparationId, signal: abort.signal });
    } catch (error) {
      if (abort.signal.aborted) throw new Error("session creation timed out", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
      adapter.abandonSessionPreparation?.(preparationId);
    }
  });
}

/**
 * What Studio knows about a session, enriched with the Settings the coordinator holds.
 *
 * Read at call time rather than captured, so changing a model or a brief in Settings applies to
 * the next session rather than the next run — the property the old `buildConfig` wrapper had and
 * the reason this is a function rather than a value.
 */
export type SessionInput = (input: SessionConfigInput) => SessionConfigInput;
