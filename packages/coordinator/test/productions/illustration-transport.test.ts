import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { FrameSchema, type ArtifactSidecar, type DomainEvent } from "@arke-studio/contracts";
import { Transport } from "../../src/transport.js";
import { CHAPTER, LEDGER, WORLD_ID, withHarness } from "./picture-harness.js";

it("ten illustrated pictures in a 4,800-artifact world do not replay held proposals or overload a slow window", { timeout: 90_000 }, async () => {
  const token = "a".repeat(64), logs: string[] = [], writes: Array<() => void> = [];
  let transport!: Transport, replays = 0, snapshots = 0, largest = 0;
  const artifacts: ArtifactSidecar[] = Array.from({ length: 4800 }, (_, n) => ({ id: `ar_${String(n).padStart(26, "0")}`,
    kind: "image", file: `picture-${n}.png`, hash: `sha256:${"a".repeat(64)}`, links: [], created: "2026-11-01T00:00:00Z",
    origin: { by: "system", producedBy: "synthetic provenance ".repeat(150) } }));
  const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0,
    send(text: string, done: () => void) {
      const frame = FrameSchema.parse(JSON.parse(text));
      if (frame.kind === "snapshot") { snapshots++; largest = Math.max(largest, Buffer.byteLength(text)); }
      writes.push(done);
    }, close() { socket.readyState = 2; }, terminate() {},
  });
  const drain = () => { while (writes.length) writes.shift()!(); };
  try {
    await withHarness(async ({ events, send, enqueued }) => {
      await transport.start();
      (transport as unknown as { accept(socket: unknown, origin: undefined): void }).accept(socket, undefined);
      socket.emit("message", Buffer.from(JSON.stringify({ kind: "hello", token })));
      drain();
      // Keep one write in flight while the actual illustration workflow files ten pictures.
      transport.broadcast({ at: "2026-11-01T00:00:00Z", type: "health.changed", component: "voice", status: "starting" });
      await send({ kind: "illustrate-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER });
      const answer = events.filter((event): event is Extract<DomainEvent, { type: "illustration.finished" }> => event.type === "illustration.finished").at(-1);
      assert.equal(answer?.outcome, "proposed");
      const proposal = answer!.proposal!;
      assert.equal(proposal.rows.length, 10);
      await send({ kind: "accept-illustration", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER,
        proposalId: proposal.proposalId, blocks: proposal.rows.map(row => row.block),
        confirmedMicroUsd: proposal.rows.reduce((sum, row) => sum + row.estimatedMicroUsd, 0) });
      assert.equal(enqueued.length, 10);
      assert(events.some(event => event.type === "illustration.progress" && event.progress.state === "done" && event.progress.made.length === 10));
      await new Promise(resolve => setTimeout(resolve, 300));
      drain();
      assert.equal(socket.readyState, 1, logs.join("\n"));
      assert(!logs.some(line => line.includes("outbound queue limit")));
      assert.equal(replays, 1, "only hello reads the held startup events");
      assert(snapshots >= 2);
      assert(largest > 13_000_000, `large-world snapshot was ${largest} bytes`);
    }, {
      transport(application) {
        transport = new Transport({ auth: { token, allowedOrigins: [] }, log: line => logs.push(line),
          getSnapshot() { const state = application.getSnapshot(); return state.world ? { ...state, world: { ...state.world, artifacts } } : state; },
          getInitialEvents() {
            replays++;
            // Match a large book with held proposals in 26 chapters, without paid model work.
            return (application.getInitialEvents?.() ?? []).flatMap<DomainEvent>(event => event.type === "illustration.finished"
              ? Array.from({ length: 26 }, (_, n) => ({ ...event, chapterId: `chapter-${n}` })) : [event]);
          },
        });
        return transport;
      },
      async prepare(worldDir) {
        const file = join(worldDir, "productions", LEDGER, "chapters", `${CHAPTER}.md`);
        const paragraphs = Array.from({ length: 10 }, (_, n) => `Maren counts tide ${n}. ${"She checks the ledger by the water. ".repeat(30)}`);
        await writeFile(file, `${await readFile(file, "utf8")}\n\n${paragraphs.join("\n\n")}\n`);
      },
      illustrate: async input => ({ summary: "Ten moments by the water.", pictures: input.blocks.filter(block => block.text.startsWith("Maren counts tide"))
        .map((block, n) => ({ block: block.key, title: `Tide ${n}`, prompt: "Maren checks the ledger beside the water.", who: ["maren-kest"], place: null })) }),
    });
  } finally { await transport?.stop(); }
});
