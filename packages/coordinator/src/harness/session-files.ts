import { join } from "node:path";
import type { HarnessAdapter, SessionConfigInput } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";

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
  adapter: Pick<HarnessAdapter, "sessionFiles" | "prepareSession">,
  dir: string,
  input: SessionConfigInput = {},
): Promise<void> {
  const prepared = { ...input, sessionCwd: dir };
  // Both seams, always. A harness takes its settings as files or as call options, and a
  // caller offering only one silently configures nothing for the harnesses using the other.
  adapter.prepareSession?.(prepared);
  for (const file of adapter.sessionFiles?.(prepared) ?? []) {
    await atomicWriteFile(join(dir, file.name), file.contents);
  }
}

/**
 * What Studio knows about a session, enriched with the Settings the coordinator holds.
 *
 * Read at call time rather than captured, so changing a model or a brief in Settings applies to
 * the next session rather than the next run — the property the old `buildConfig` wrapper had and
 * the reason this is a function rather than a value.
 */
export type SessionInput = (input: SessionConfigInput) => SessionConfigInput;
