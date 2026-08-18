import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import WebSocket from "ws";
import { agentForPurpose, buildSessionConfig } from "@arke-studio/adapter-opencode";
import { FrameSchema, type Frame, type HarnessAdapter, type HarnessEvent } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../src/coordinator.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "./world/helpers.js";

/**
 * A run in flight has to survive a reload (issue 239).
 *
 * `authoring` is folded from events on the client, so reloading mid-draft came back with an empty
 * map for a proposal an agent was still writing into. Two things followed: no surface could tell
 * "still being written" from "finished", and Accept and Discard were offered over the working
 * directory — accepting could commit half a sheet, discarding could delete it under the agent.
 *
 * The wall clock allows a turn fifteen minutes, so the window outlives several reloads.
 */

const MAREN = "characters/maren-kest.md";

/**
 * An adapter whose turn never ends, so the run is still live when the assertions run.
 *
 * Events are kept and replayed to a stream that attaches late. Dropping them instead loses an
 * interrupt sent before the run subscribes, and a run that never ends is one `stop()` waits
 * fifteen minutes for — which turns any failure in here into a hang rather than a red test.
 */
function neverendingAdapter(): HarnessAdapter {
  const subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
  const backlog: HarnessEvent[] = [];
  const push = (event: HarnessEvent) => {
    backlog.push(event);
    for (const sub of subscribers) {
      sub.queue.push(event);
      sub.wake?.();
      sub.wake = null;
    }
  };
  return {
    id: "stuck",
    capabilities: () => new Set(),
    readiness: () => ({ ready: true }),
    async createSession() {
      return { sessionId: "ses_stuck" };
    },
    async sendMessage(input) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async dispatchAsync(input) {
      push({ type: "message.delta", sessionId: input.sessionId, text: "thinking…" });
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async interrupt(id: string) {
      push({ type: "session.ended", sessionId: id, reason: "cancelled", detail: "interrupted" });
    },
    streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
      const sub: { queue: HarnessEvent[]; wake: (() => void) | null } = { queue: [...backlog], wake: null };
      subscribers.add(sub);
      return {
        [Symbol.asyncIterator]() {
          return (async function* () {
            try {
              while (!signal?.aborted) {
                const next = sub.queue.shift();
                if (next) {
                  yield next;
                  continue;
                }
                await new Promise<void>((resolve) => {
                  signal?.addEventListener("abort", () => resolve(), { once: true });
                  sub.wake = resolve;
                });
              }
            } finally {
              subscribers.delete(sub);
            }
          })();
        },
      };
    },
  } as HarnessAdapter;
}

class TestClient {
  private socket: WebSocket;
  readonly frames: Frame[] = [];
  private waiters: Array<() => void> = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket.on("message", (data) => {
      this.frames.push(FrameSchema.parse(JSON.parse(String(data))));
      for (const w of this.waiters.splice(0)) w();
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
  }

  send(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }

  /**
   * Resolves on the first frame at or after `from` that matches, or throws — a hang is the
   * failure under test. `from` matters here because the same kind of frame is awaited more than
   * once, and an earlier one would answer the later wait immediately.
   */
  async until(match: (frame: Frame) => boolean, label: string, from = 0): Promise<Frame> {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const hit = this.frames.slice(from).find(match);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** The most recent snapshot this client has been sent. */
  lastSnapshot(): Extract<Frame, { kind: "snapshot" }> {
    const snapshots = this.frames.filter((f) => f.kind === "snapshot");
    const last = snapshots[snapshots.length - 1];
    assert.ok(last?.kind === "snapshot", "a snapshot had arrived");
    return last;
  }

  close(): void {
    this.socket.close();
  }
}

describe("a proposal being written into, seen from a client that reloaded (issue 239)", () => {
  it("carries the live run in the snapshot, and refuses to settle the proposal under it", async () => {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: () => "2026-08-10T12:00:00.000Z" });
    await provider.loadWorld(WORLD_ID);
    const coordinator = new Coordinator({
      provider,
      adapter: neverendingAdapter(),
      authoring: { buildConfig: buildSessionConfig, agentForPurpose },
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      manifest: SHIPPED_MANIFEST,
    });
    const { port } = await coordinator.start(0);
    const drafter = new TestClient(port);
    let reloaded: TestClient | null = null;
    let proposalId: string | null = null;
    await drafter.open();
    try {
      drafter.send({ kind: "hello", lastSeq: 0 });
      await drafter.until((f) => f.kind === "snapshot", "the opening snapshot");
      drafter.send({
        kind: "draft-with-studio",
        worldId: WORLD_ID,
        path: MAREN,
        summary: "revise appearance",
        instruction: "make her hands say more",
      });

      // The run registers before this is emitted, so from here on it is genuinely in flight.
      const started = await drafter.until(
        (f) => f.kind === "event" && f.event.type === "authoring.status" && f.event.status === "running",
        "the run starting",
      );
      assert.equal(started.kind, "event");
      if (started.kind !== "event" || started.event.type !== "authoring.status") return;
      proposalId = started.event.proposalId;

      // The reload: a client that was not here when the run started, and so has seen no
      // authoring event at all. Everything it knows arrives in the snapshot.
      reloaded = new TestClient(port);
      await reloaded.open();
      reloaded.send({ kind: "hello", lastSeq: 0 });
      await reloaded.until((f) => f.kind === "snapshot", "the reloaded client's snapshot");
      assert.deepEqual(
        reloaded.lastSnapshot().state.authoringRuns,
        [proposalId],
        "the snapshot says which proposal is being written into",
      );

      // And the coordinator refuses to settle it, whatever a client believes. Accept first.
      const beforeAccept = reloaded.frames.length;
      reloaded.send({ kind: "proposal-accept", worldId: WORLD_ID, proposalId });
      const blockedAccept = await reloaded.until(
        (f) => f.kind === "event" && f.event.type === "proposal.blocked" && f.event.proposalId === proposalId,
        "the refusal to accept",
      );
      assert.equal(blockedAccept.kind, "event");
      if (blockedAccept.kind !== "event" || blockedAccept.event.type !== "proposal.blocked") return;
      assert.equal(blockedAccept.event.reason, "drafting");
      assert.match(blockedAccept.event.detail ?? "", /still writing/);

      // A reason alone would leave the client believing it can try again — only a stale view of
      // the run got it here. The refusal is followed by a snapshot it did not ask for, carrying
      // the run it did not know about (review of PR 371).
      const corrected = await reloaded.until(
        (f) => f.kind === "snapshot",
        "a snapshot correcting the client that was refused",
        beforeAccept,
      );
      assert.equal(corrected.kind, "snapshot");
      if (corrected.kind !== "snapshot") return;
      assert.deepEqual(corrected.state.authoringRuns, [proposalId], "and it names the live run");

      // Then discard, which would have taken the working directory out from under the agent.
      const beforeDiscard = reloaded.frames.length;
      reloaded.send({ kind: "proposal-discard", worldId: WORLD_ID, proposalId });
      const blockedDiscard = await reloaded.until(
        (f) => f.kind === "event" && f.event.type === "proposal.blocked",
        "the refusal to discard",
        beforeDiscard,
      );
      assert.equal(blockedDiscard.kind, "event");
      if (blockedDiscard.kind !== "event" || blockedDiscard.event.type !== "proposal.blocked") return;
      assert.equal(blockedDiscard.event.reason, "drafting");

      // Settling is not the only way to write into a proposal. An in-place field edit goes into
      // the same files, and its revision check cannot see the agent, which does not write
      // through the journal — so it is refused on the same grounds (review of PR 371).
      const beforeEdit = reloaded.frames.length;
      reloaded.send({
        kind: "proposal-update-field",
        worldId: WORLD_ID,
        requestId: "01J8E10000000000000000ED11",
        proposalId,
        path: MAREN,
        field: "appearance",
        value: "typed while the agent was writing",
        expectedDraftRevision: 1,
      });
      const blockedEdit = await reloaded.until(
        (f) => f.kind === "event" && f.event.type === "proposal.blocked",
        "the refusal to edit a field",
        beforeEdit,
      );
      assert.equal(blockedEdit.kind, "event");
      if (blockedEdit.kind !== "event" || blockedEdit.event.type !== "proposal.blocked") return;
      assert.equal(blockedEdit.event.reason, "drafting");

      // Nothing settled: the proposal is still staged, and still being written into.
      const beforeHello = reloaded.frames.length;
      reloaded.send({ kind: "hello", lastSeq: 0 });
      const after = await reloaded.until(
        (f) => f.kind === "snapshot",
        "a snapshot after the refusals",
        beforeHello,
      );
      assert.equal(after.kind, "snapshot");
      if (after.kind !== "snapshot") return;
      assert.ok(
        after.state.world?.proposals.some((p) => p.proposal.id === proposalId),
        "the proposal survived both",
      );
      assert.deepEqual(after.state.authoringRuns, [proposalId], "and the run is still going");

      // Cancelling is the way through — and then the snapshot stops claiming a live run.
      reloaded.send({ kind: "authoring-cancel", worldId: WORLD_ID, proposalId });
      await reloaded.until(
        (f) => f.kind === "event" && f.event.type === "authoring.status" && f.event.status === "cancelled",
        "the cancellation",
      );
      const beforeLast = reloaded.frames.length;
      reloaded.send({ kind: "hello", lastSeq: 0 });
      await reloaded.until(
        (f) => f.kind === "snapshot" && f.state.authoringRuns.length === 0,
        "a snapshot with no live run",
        beforeLast,
      );
      // Stopped here, so the cleanup below has nothing left to stop.
      proposalId = null;
    } finally {
      // The adapter's turn never ends by itself and `stop()` waits on background work, so a run
      // left going outlasts the test: a failed assertion would hang the runner instead of
      // failing it, and the reason would scroll past a long time before the timeout.
      if (proposalId !== null) {
        drafter.send({ kind: "authoring-cancel", worldId: WORLD_ID, proposalId });
        await drafter
          .until(
            (f) => f.kind === "event" && f.event.type === "authoring.status" && f.event.status === "cancelled",
            "the run stopping",
          )
          .catch(() => {});
      }
      drafter.close();
      reloaded?.close();
      await coordinator.stop();
    }
  });
});
