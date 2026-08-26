import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import {
  deriveCapabilityAvailability,
  PROVIDERS,
  type CapabilityProbe,
  type DomainEvent,
  type ProviderId,
  type ProviderStatus,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { ProviderService } from "../../src/providers/service.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";

/**
 * Local runtimes are asked, not assumed (issue 462).
 *
 * A keyless provider is `configured` the moment it exists, and `deriveCapabilityAvailability`
 * reads *configured + untested* as **available**. Nothing ever moved one off `untested`, so
 * every local runtime was reporting its capabilities as served whether or not anything could
 * serve them — most sharply whisper.cpp, which had no client at all and still counted as the
 * provider for `voice-stt`.
 */

const LOCAL = (Object.keys(PROVIDERS) as ProviderId[]).filter((id) => PROVIDERS[id].credential === "none");

/** Validators for every keyless provider, each answering for its own declared capabilities. */
function localValidators(
  answer: (id: ProviderId) => { available: boolean; reason?: string },
): Record<string, { validateKey: () => Promise<CapabilityProbe[]> }> {
  return Object.fromEntries(
    LOCAL.map((id) => [
      id,
      {
        validateKey: async (): Promise<CapabilityProbe[]> => {
          const { available, reason } = answer(id);
          return PROVIDERS[id].capabilities.map((capability) =>
            available ? { capability, available } : { capability, available, reason: reason ?? "not running" },
          );
        },
      },
    ]),
  );
}

async function statusesAfterStart(
  validators: Record<string, { validateKey: () => Promise<CapabilityProbe[]> }>,
): Promise<ProviderStatus[]> {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => "2026-08-26T12:00:00.000Z" });
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    validators,
    observeEvent: (event) => events.push(event),
  });
  try {
    await coordinator.start(0);
    // The probe is fired inside start() and deliberately not awaited there — the first paint
    // must not wait on four runtimes to answer. So the frame arrives a moment later.
    const deadline = Date.now() + 10_000;
    let latest: ProviderStatus[] | undefined;
    while (Date.now() < deadline) {
      for (const event of events) {
        if (event.type === "provider.status") latest = event.providers;
      }
      if (latest?.some((s) => LOCAL.includes(s.id) && s.validation !== "untested")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(latest, "start() must publish what the local runtimes answered");
    return latest;
  } finally {
    await coordinator.stop();
    await provider.close();
  }
}

describe("a local runtime is asked what it can serve (issue 462)", () => {
  it("a runtime that is not running takes its capabilities out of the availability set", async () => {
    const statuses = await statusesAfterStart(
      localValidators(() => ({ available: false, reason: "the Voxa sidecar is not running" })),
    );

    // The whole of the issue: whisper.cpp is the only provider for voice-stt, so a whisper.cpp
    // that cannot answer must make voice-stt unavailable rather than leave it offered.
    const availability = deriveCapabilityAvailability(statuses);
    const stt = availability.find((a) => a.capability === "voice-stt");
    assert.equal(stt?.available, false, "voice-stt was being offered by a table row, not a runtime");
    assert.match(stt!.reason!, /no configured provider's key unlocks voice-stt/);

    // And every local runtime, not just that one — the same optimism covered all four.
    for (const id of LOCAL) {
      const status = statuses.find((s) => s.id === id);
      assert.notEqual(status?.validation, "untested", `${id} was never asked`);
      assert.ok(
        status!.probes.every((p) => !p.available),
        `${id} reported a capability its runtime just said it cannot serve`,
      );
    }
  });

  it("a runtime that is running keeps serving, and is not made to look like a key problem", async () => {
    const statuses = await statusesAfterStart(localValidators(() => ({ available: true })));
    const availability = deriveCapabilityAvailability(statuses);
    assert.equal(availability.find((a) => a.capability === "voice-stt")?.available, true);
    assert.deepEqual(availability.find((a) => a.capability === "voice-stt")?.via, ["whispercpp"]);
    for (const id of LOCAL) {
      assert.equal(statuses.find((s) => s.id === id)?.fault, null, `${id} answered, so nothing is at fault`);
    }
  });
});

describe("a runtime with no client says so in the runtime's terms (issue 462)", () => {
  it("names the runtime as absent rather than reporting a credential it does not have", async () => {
    // No validators at all: the shape of a build where the sidecar and the engine were never
    // wired, which is exactly how whisper.cpp shipped before it had a client.
    const service = new ProviderService(null, {}, null);
    await service.init();
    const status = await service.validate("whispercpp");
    assert.equal(status.validation, "invalid");
    assert.equal(status.probes.length, PROVIDERS.whispercpp.capabilities.length);
    assert.match(status.probes[0]!.reason!, /whisper\.cpp is not running on this machine/);
    // Not a key story: these providers have no key, and "invalid" against a credential that
    // does not exist sends whoever reads it looking for a box to paste something into.
    assert.doesNotMatch(status.probes[0]!.reason!, /key|credential|sidecar/i);
  });
});
