import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { ulid, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../src/coordinator.js";
import type { WorldProvider } from "../src/world-provider.js";
import { tempDir } from "./tmp.js";

it("answers bible-helper-run with a correlated refusal instead of ignoring it", async () => {
  const events: DomainEvent[] = [];
  const provider: WorldProvider = {
    listWorlds: async () => [],
    loadWorld: async () => {
      throw new Error("no worlds in this harness");
    },
  };
  const root = await tempDir("bible-helper-refusal");
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "events.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
  });
  const send = (message: ClientMessage) =>
    (
      coordinator as unknown as {
        handleClientMessage(message: ClientMessage): Promise<void>;
      }
    ).handleClientMessage(message);
  const worldId = ulid();
  const requestId = ulid();

  await send({ kind: "bible-helper-run", worldId, requestId, helper: "rewrite", selection: "A bell." });

  const answer = events.find((event) => event.type === "bible.helper-answered");
  assert.ok(answer);
  assert.equal(answer.worldId, worldId);
  assert.equal(answer.requestId, requestId);
  assert.equal(answer.helper, "rewrite");
  assert.equal(answer.options, null);
  assert.match(answer.reason ?? "", /not available/i);
});
