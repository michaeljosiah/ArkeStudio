import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNothingForbidden } from "../scripts/verify-packaged-runtimes.mjs";

/**
 * The "must never ship" half of the afterPack guard.
 *
 * Driven directly rather than through a package run: the staged-runtime assertions in front of it
 * want real PE headers and checksum manifests, and a twenty-minute pack is far too expensive to be
 * the only thing that ever fires these. What they catch produces a build that looks completely
 * normal, so a guard that has never itself been tried is not much of a guard.
 */

function resources() {
  const dir = mkdtempSync(join(tmpdir(), "arke-pack-"));
  mkdirSync(join(dir, "resources"), { recursive: true });
  return join(dir, "resources");
}

describe("what must never enter the installer", () => {
  it("refuses a build carrying the Claude Code runtime, and names the exclusion that slipped", () => {
    // The Agent SDK pulls a ~312MB per-platform claude.exe as an optionalDependency, under
    // "© Anthropic PBC. All rights reserved". Claude Code is bring-your-own — we drive the copy
    // the user installed — so shipping this one redistributes something that is not ours.
    const dir = resources();
    const nested = join(dir, "app.asar.unpacked", "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "claude.exe"), "stand-in for 312MB");
    assert.throws(() => assertNothingForbidden(dir), /Claude Code runtime entered the installer/);
    assert.throws(() => assertNothingForbidden(dir), /electron-builder\.yml/, "and says where to fix it");
    rmSync(dir, { recursive: true, force: true });
  });

  it("still refuses a model weight, in its own words rather than the runtime's", () => {
    const dir = resources();
    writeFileSync(join(dir, "ggml-base.en.bin"), "weights");
    assert.throws(() => assertNothingForbidden(dir), /model weight ggml-base\.en\.bin/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("catches the runtime packed INSIDE app.asar, where the name walk cannot see it", () => {
    // claude.exe is not a .node, so asarUnpack leaves it in the archive and readdirSync sees one
    // opaque file. The ceiling is derived from the thing excluded: past 300MB the archive is
    // carrying something the size of a Claude Code.
    const dir = resources();
    writeFileSync(join(dir, "app.asar"), Buffer.alloc(301 * 1024 * 1024));
    assert.throws(() => assertNothingForbidden(dir), /app\.asar is \d+MB/);
    assert.throws(() => assertNothingForbidden(dir), /proprietary runtime/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes a build that carries neither", () => {
    const dir = resources();
    writeFileSync(join(dir, "app.asar"), Buffer.alloc(8 * 1024 * 1024));
    mkdirSync(join(dir, "opencode2"), { recursive: true });
    writeFileSync(join(dir, "opencode2", "opencode2.exe"), "the harness we DO ship");
    assert.doesNotThrow(() => assertNothingForbidden(dir));
    rmSync(dir, { recursive: true, force: true });
  });
});
