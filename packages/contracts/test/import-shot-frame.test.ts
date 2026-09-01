import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientMessageSchema } from "../src/frames.js";
import { DomainEventSchema } from "../src/events.js";

const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC";
const REQUEST = "01J8E1000000000000000000V1";

describe("import-shot-frame contracts", () => {
  it("admits only a correlated shot identity, never a renderer filesystem path", () => {
    const command = {
      kind: "import-shot-frame",
      worldId: WORLD,
      productionId: "saltlight",
      shotId: "sh_12",
      requestId: REQUEST,
    } as const;

    assert.deepEqual(ClientMessageSchema.parse(command), command);
    const { requestId: _requestId, ...uncorrelated } = command;
    assert.throws(() => ClientMessageSchema.parse(uncorrelated));
    assert.throws(() => ClientMessageSchema.parse({ ...command, sourcePath: "C:/private/frame.png" }));
    assert.throws(() => ClientMessageSchema.parse({ ...command, shotId: "scene-12" }));
  });

  it("uses the existing correlated queue result without a new response event", () => {
    assert.doesNotThrow(() =>
      DomainEventSchema.parse({
        at: "2026-08-31T12:00:00.000Z",
        type: "queue.enqueue-result",
        requestId: REQUEST,
        command: "import-shot-frame",
        disposition: "not-queued",
        requestedCount: 0,
        acceptedJobIds: [],
        failures: [],
      }),
    );
  });
});
