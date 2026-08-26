import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assertPeArchitecture, verifyManifest } from "./runtime-support.mjs";

export default async function verifyPackagedRuntimes(context) {
  const arch = context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : null;
  if (!arch) throw new Error(`unsupported Electron package architecture ${context.arch}`);
  const resources = join(context.appOutDir, "resources");
  const voxa = join(resources, "voxa");
  const espeak = join(resources, "espeak-ng");
  assertPeArchitecture(join(voxa, "voxa.exe"), arch);
  assertPeArchitecture(join(espeak, "espeak-ng.exe"), arch);
  if (verifyManifest(voxa).arch !== arch || verifyManifest(espeak).arch !== arch) {
    throw new Error(`packaged runtime manifest does not match ${arch}`);
  }
  for (const runtime of [
    "msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll",
    ...(arch === "x64" ? ["vcruntime140_1.dll"] : []), "vcomp140.dll",
  ]) {
    if (!existsSync(join(voxa, runtime))) throw new Error(`packaged Voxa lacks ${runtime}`);
  }
  // The sample world (SPEC-016 R-6, R-8). An extraResources entry that quietly fails to copy
  // does not fail the build — the application simply reports having no sample world, which is
  // indistinguishable from a build that never carried one. This is the only place that tells
  // the difference before a user does.
  const sampleWorld = join(resources, "sample-world");
  if (!existsSync(join(sampleWorld, "world.json"))) {
    throw new Error("the sample world is missing from the installer (resources/sample-world/world.json)");
  }
  for (const expected of ["characters", "canon", "references", "productions", "world-art.png"]) {
    if (!existsSync(join(sampleWorld, expected))) {
      throw new Error(`the packaged sample world is incomplete — ${expected} did not copy`);
    }
  }

  /*
   * ffmpeg and ffprobe are one runtime, verified together (#253, Codex round 1).
   *
   * They are copied by one wholesale directory rule, so it is easy to believe staging ffmpeg
   * stages both. It does not: a build carrying only ffmpeg.exe installs cleanly, logs the probe
   * as unavailable, and silently disables every measurement — no track can become a clock and no
   * take gets a duration. Asserted here because that failure is invisible until somebody opens
   * the spine, by which time the installer has shipped.
   */
  const ffmpegDir = join(resources, "ffmpeg");
  /*
   * Both required now (#279). This previously tolerated *neither*, because neither was the state
   * every build was in -- nothing staged ffmpeg at all, electron-builder logged that the source
   * directory did not exist, and the installer shipped with export quietly unavailable. Two
   * releases went out that way. Now that prepare-runtimes stages them, absence is a packaging
   * failure rather than the status quo, and this is the check that keeps it from becoming the
   * status quo again.
   */
  for (const binary of ["ffmpeg.exe", "ffprobe.exe"]) {
    if (!existsSync(join(ffmpegDir, binary))) {
      throw new Error(
        `resources/ffmpeg is missing ${binary} — ffmpeg and ffprobe are one runtime, and a build without ` +
          `${binary} disables ${binary === "ffprobe.exe" ? "every media measurement" : "export"} with nothing on screen to say so`,
      );
    }
  }
  /*
   * The whole inventory, checksummed -- not one arbitrary library (Codex round 1).
   *
   * A shared build with any required DLL missing or corrupted leaves both executables present and
   * neither able to start, and "some .dll exists" reports that as healthy. prepare-runtimes
   * already writes the same checksum manifest the other runtimes are verified through, so this
   * verifies it the same way rather than inventing a weaker check for the one runtime that ships
   * its libraries loose.
   */
  if (verifyManifest(ffmpegDir).arch !== arch) {
    throw new Error(`resources/ffmpeg was staged for a different architecture than ${arch}`);
  }
  for (const fontFile of ["Geist-Regular.ttf", "LICENSE.Geist.txt"]) {
    if (!existsSync(join(resources, "fonts", fontFile))) {
      throw new Error(`resources/fonts is missing ${fontFile} — export slates cannot rely on host fonts`);
    }
  }
  const packagedFontHash = createHash("sha256")
    .update(readFileSync(join(resources, "fonts", "Geist-Regular.ttf")))
    .digest("hex");
  if (packagedFontHash !== "85a1c6b18a6b0a06dfe9fd4f6d6a5d4979f74ec861eaef4bc7868b5492b8a117") {
    throw new Error("resources/fonts/Geist-Regular.ttf does not match the reviewed v1.7.2 binary");
  }

  /*
   * The bundled v2 harness (issue 327 §9). Same stance as ffmpeg above: an extraResources
   * entry that quietly fails to copy does not fail the build, and the app then degrades to
   * "OpenCode: not found — authoring disabled" on machines with no PATH install — a fresh
   * machine's first run, exactly who the bundle exists for. The v1 entry lived that way for
   * every release to date; the v2 one is checked.
   */
  const opencode2 = join(resources, "opencode2");
  if (!existsSync(join(opencode2, "opencode2.exe"))) {
    throw new Error("resources/opencode2 is missing opencode2.exe — the bundled harness did not copy");
  }
  assertPeArchitecture(join(opencode2, "opencode2.exe"), arch);
  if (verifyManifest(opencode2).arch !== arch) {
    throw new Error(`resources/opencode2 was staged for a different architecture than ${arch}`);
  }

  assertNothingForbidden(resources);

  if (readdirSync(voxa).some((name) => name === "x64" || name === "arm64")) {
    throw new Error("packaged Voxa contains architecture staging directories");
  }
  const nativeIndex = join(resources, "app.asar.unpacked", "node_modules", "better-sqlite3-electron", "build", "Release", "better_sqlite3.node");
  if (existsSync(nativeIndex)) assertPeArchitecture(nativeIndex, arch);
}

/**
 * What must never be in an installer, whatever else is right about it.
 *
 * Exported so it can be exercised without a twenty-minute package run. These guard failures that
 * otherwise produce a build looking completely normal, and a guard for a silent failure that has
 * never itself been fired is not much of a guard.
 */
export function assertNothingForbidden(resources) {
  /*
   * `claude.exe` joins the model weights for a different reason: not size, licence.
   *
   * The Claude Agent SDK pulls a per-platform optionalDependency carrying the entire ~312MB
   * Claude Code runtime, under "© Anthropic PBC. All rights reserved". electron-builder copies
   * production dependencies on its own, so the exclusion in electron-builder.yml is the only
   * thing standing between depending on that SDK and shipping a proprietary binary in our
   * installer. An exclusion pattern that stops matching — a hoist that moves the path, a
   * rename upstream — fails silently and looks exactly like a normal build.
   */
  const forbidden = new Set([
    "kokoro-82m", "whisper-base-en", "model_quantized.onnx", "ggml-base.en.bin", "claude.exe",
  ]);
  const inspect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (forbidden.has(entry.name)) {
        throw new Error(
          entry.name === "claude.exe"
            ? "the Claude Code runtime entered the installer — it is proprietary and bring-your-own; check the " +
              "@anthropic-ai/claude-agent-sdk-* exclusion in electron-builder.yml"
            : `model weight ${entry.name} entered the installer`,
        );
      }
      if (entry.isDirectory()) inspect(join(dir, entry.name));
    }
  }
  inspect(resources);
  /*
   * The name walk above only sees loose files, and `claude.exe` is not a `.node`, so an
   * excluded-then-un-excluded binary would be packed INSIDE app.asar where readdirSync sees a
   * single opaque file. Checked by size rather than by reading the archive: the threshold is
   * derived from the thing being excluded rather than guessed — the runtime is ~312MB, so an
   * app.asar over 300MB is carrying something the size of a Claude Code, and a normal build of
   * bundled JS is three orders of magnitude under it. Parsing the asar header would be exact,
   * but a subtly wrong parse breaks every build, and this cannot.
   */
  const asar = join(resources, "app.asar");
  if (existsSync(asar)) {
    const bytes = statSync(asar).size;
    if (bytes > 300 * 1024 * 1024) {
      throw new Error(
        `app.asar is ${Math.round(bytes / 1024 / 1024)}MB — far past anything this app bundles. The likely ` +
          `cause is the Claude Agent SDK's per-platform binary escaping the exclusion in electron-builder.yml, ` +
          `which would ship a proprietary runtime we have no right to redistribute.`,
      );
    }
  }
}
