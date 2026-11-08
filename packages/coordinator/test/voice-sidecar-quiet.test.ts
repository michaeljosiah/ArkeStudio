import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import type { DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../src/coordinator.js";
import type { ChangeLog } from "../src/change-log.js";
import { tempDir } from "./tmp.js";

/** The sidecar was polled every 20 s and its status journalled and broadcast each time (issue 2782). */
it("says the voice sidecar's status only when it changes", async () => {
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ provider: { listWorlds: async () => [], loadWorld: async () => { throw new Error("no world"); } },
    adapter: null, appVersion: "test", changeLogPath: join(await tempDir("arke-sidecar-"), "changes.jsonl"), observeEvent: (event) => events.push(event) });
  const host = coordinator as unknown as { publishSidecar(status: { state: "ready" | "unavailable"; detail: string }): void; changeLog: ChangeLog;
    serverApplication: { getInitialEvents(): DomainEvent[] } };
  try {
    host.publishSidecar({ state: "ready", detail: "Voxa is ready." });
    host.publishSidecar({ state: "ready", detail: "Voxa is ready." });
    host.publishSidecar({ state: "ready", detail: "Voxa is ready." });
    host.publishSidecar({ state: "unavailable", detail: "Voxa stopped." });
    assert.deepEqual(events.flatMap((event) => event.type === "voice.sidecar" ? [event.state] : []), ["ready", "unavailable"]);
    // A window that joins later is told the last status with its first events.
    const joined = host.serverApplication.getInitialEvents();
    assert.deepEqual(joined.flatMap((event) => event.type === "voice.sidecar" ? [event.state] : []), ["unavailable"]);
  } finally {
    await host.changeLog.drain();
  }
});
