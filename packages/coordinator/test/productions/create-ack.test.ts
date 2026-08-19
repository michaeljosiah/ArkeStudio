import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { ulid } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The correlated, idempotent creation acknowledgement (issue #384): success only after the
 * commit is durable and carrying the actual slug; redelivery returns the same slug instead of
 * a second production; concurrent distinct requests get distinct productions; failure names
 * itself and creates nothing.
 */

const CLOCK = "2026-08-19T12:00:00.000Z";

type CreateResult = Extract<DomainEvent, { type: "production.create-result" }>;

async function harness(root?: string, worldDir?: string) {
  const made = root && worldDir ? { root, worldDir } : await makeTempRoot();
  const provider = new FsWorldProvider(made.root, { clock: () => CLOCK });
  closeOnCleanup(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(made.root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
  });
  const send = (msg: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
  const results = () => events.filter((e): e is CreateResult => e.type === "production.create-result");
  return { ...made, provider, events, send, results };
}

function createMsg(requestId: string, title = "Inkbound"): ClientMessage {
  return { kind: "create-production", worldId: WORLD_ID, requestId, title, medium: "video" } as ClientMessage;
}

describe("create-production acknowledgement (issue 384)", () => {
  it("acknowledges with the actual slug only after the production is durable", async () => {
    const h = await harness();
    const requestId = ulid();
    await h.send(createMsg(requestId));
    const [result] = h.results();
    assert.ok(result, "one correlated result");
    assert.equal(result.requestId, requestId);
    assert.equal(result.disposition, "created");
    assert.equal(result.slug, "inkbound");
    const dirs = await readdir(join(h.worldDir, "productions"));
    assert.ok(dirs.includes("inkbound"), "the acknowledged production exists on disk");
  });

  it("redelivery of one request id creates exactly one production and returns the same slug", async () => {
    const h = await harness();
    const requestId = ulid();
    await h.send(createMsg(requestId));
    await h.send(createMsg(requestId));
    const results = h.results();
    assert.equal(results.length, 2, "each delivery is answered");
    assert.deepEqual(
      results.map((r) => [r.disposition, r.slug]),
      [
        ["created", "inkbound"],
        ["created", "inkbound"],
      ],
      "the same slug both times",
    );
    const dirs = (await readdir(join(h.worldDir, "productions"))).filter((d) => d.startsWith("inkbound"));
    assert.deepEqual(dirs, ["inkbound"], "no inkbound-2");
  });

  it("survives a restart: the redelivered request finds the commit that served it", async () => {
    const first = await harness();
    const requestId = ulid();
    await first.send(createMsg(requestId));
    // A fresh provider and coordinator over the same root — the in-memory guard is gone and
    // only the change log remembers. The first is closed the way a real restart closes it.
    await first.provider.close();
    const second = await harness(first.root, first.worldDir);
    await second.send(createMsg(requestId));
    const [replay] = second.results();
    assert.ok(replay, "the redelivery is answered after restart");
    assert.equal(replay.disposition, "created");
    assert.equal(replay.slug, "inkbound");
    const dirs = (await readdir(join(first.worldDir, "productions"))).filter((d) => d.startsWith("inkbound"));
    assert.deepEqual(dirs, ["inkbound"], "still exactly one production");
  });

  it("concurrent creates with distinct request ids receive unique slugs", async () => {
    const h = await harness();
    const a = ulid();
    const b = ulid();
    await Promise.all([h.send(createMsg(a)), h.send(createMsg(b))]);
    const results = h.results();
    assert.equal(results.length, 2);
    assert.ok(
      results.every((r) => r.disposition === "created"),
      "both succeed",
    );
    const slugs = results.map((r) => r.slug).sort();
    assert.deepEqual(slugs, ["inkbound", "inkbound-2"], "unique slugs, no silent overwrite");
  });

  it("failure names its reason, and no speculative production appears", async () => {
    const h = await harness();
    // A file the bundle does not know about, exactly where the create wants to write: the
    // commit refuses as stale (never merged), and retries cannot invent a way around it.
    await mkdir(join(h.worldDir, "productions", "inkbound"), { recursive: true });
    await writeFile(join(h.worldDir, "productions", "inkbound", "production.json"), "{}", "utf8");
    const requestId = ulid();
    await h.send(createMsg(requestId));
    const [result] = h.results();
    assert.ok(result, "the failure is answered, not swallowed");
    assert.equal(result.disposition, "failed");
    assert.ok(result.reason && result.reason.length > 0, "the reason is named");
    assert.equal(result.slug, undefined, "no slug is promised");
  });
});
