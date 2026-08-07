import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProviderToolStatus } from "@arke-studio/contracts";
import { ProviderToolService, type ToolProbe } from "../../src/providers/tool.js";

/**
 * A provider whose credential lives in a tool we drive (issue #137). The states are the point:
 * "not installed", "signed out" and "waiting for the browser" send a person to three different
 * places, and collapsing any two of them into "not configured" is the failure this replaces.
 */

/**
 * Built with `join` rather than written as a literal Windows path. `basename` splits on the
 * running platform's separator, so a hard-coded `C:\tools\...` is the whole string on Linux and
 * this asserted nothing there — it failed in CI on exactly that.
 */
const TOOL_DIR = join("tools", "higgsfield");
const FOUND = { command: join(TOOL_DIR, "higgsfield.cmd"), source: "path" as const, version: "1.1.22" };

function service(probe: Partial<ToolProbe>) {
  const seen: ProviderToolStatus[] = [];
  const full: ToolProbe = {
    discover: async () => FOUND,
    whoAmI: async () => ({ account: null }),
    signIn: async () => ({ code: 0, detail: null }),
    ...probe,
  };
  return { svc: new ProviderToolService("higgsfield", full, (s) => seen.push(s)), seen };
}

describe("a provider whose credential is not ours (issue #137)", () => {
  it("separates absent from signed-out, because they are different remedies", async () => {
    const missing = service({ discover: async () => null });
    assert.equal((await missing.svc.refresh()).state, "absent");

    const out = service({
      whoAmI: async () => {
        throw new Error("Session expired");
      },
    });
    const status = await out.svc.refresh();
    assert.equal(status.state, "signed-out");
    assert.equal(status.detail, "Session expired");
  });

  it("carries a basename and never the path it resolved (R-6)", async () => {
    const { svc } = service({ whoAmI: async () => ({ account: "someone@example.test" }) });
    const status = await svc.refresh();
    assert.equal(status.state, "ready");
    assert.equal(status.account, "someone@example.test");
    assert.equal(status.executableName, "higgsfield.cmd");
    assert.ok(!JSON.stringify(status).includes(TOOL_DIR), "no directory crosses the boundary (R-6)");
  });

  it("publishes signing-in before it blocks, so the row is not silent for minutes", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { svc, seen } = service({
      signIn: async () => {
        await gate;
        return { code: 0, detail: null };
      },
      whoAmI: async () => ({ account: "someone@example.test" }),
    });
    const running = svc.signIn();
    // The browser is open and nothing has resolved: the state has to have been published.
    assert.equal(svc.current().state, "signing-in");
    assert.ok(seen.some((s) => s.state === "signing-in"));
    release!();
    assert.equal((await running).state, "ready");
  });

  it("a re-probe underneath a live sign-in does not flicker the row back", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { svc } = service({
      signIn: async () => {
        await gate;
        return { code: 0, detail: null };
      },
      whoAmI: async () => {
        throw new Error("Not authenticated");
      },
    });
    const running = svc.signIn();
    assert.equal((await svc.refresh()).state, "signing-in");
    release!();
    // The login exited 0, but the probe is what confirms it — and here the probe says no.
    assert.equal((await running).state, "signed-out");
  });

  it("a failed sign-in keeps the tool's own words rather than inventing a reason", async () => {
    const { svc } = service({ signIn: async () => ({ code: 1, detail: "port 8976 is in use" }) });
    const status = await svc.signIn();
    assert.equal(status.state, "signed-out");
    assert.equal(status.detail, "port 8976 is in use");
  });

  it("offers the documented command, not the path we resolved — a terminal has its own PATH", async () => {
    const { svc } = service({});
    assert.equal((await svc.refresh()).signInCommand, "higgsfield auth login");
  });
});
