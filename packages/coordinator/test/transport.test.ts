import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import WebSocket from "ws";
import { FrameSchema, vendorAuthUnavailable, type ClientState, type Frame } from "@arke-studio/contracts";
import { Transport } from "../src/transport.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { tempDir } from "./tmp.js";

const STATE: ClientState = {
  app: {
    version: "0.0.0-test",
    health: {
      coordinator: { status: "healthy" },
      harness: { status: "unavailable", reason: "not configured" },
      voice: { status: "unavailable", reason: "not configured" },
    },
    jobs: [],
    builds: [],
    ledger: [],
    providers: [],
    providerTools: [],
    vendorAuth: vendorAuthUnavailable("not configured"),
    manifest: null,
    routing: { defaults: {}, faults: [] },
    models: { disabled: [] },
    presets: [],
    spend: null,
    backgroundNotifications: "issues-only",
    research: { web: false },
  narrator: null,
    appearance: { theme: "system" },
    runtime: null,
    harness: null,
    comfyui: null,
    voiceRuntime: null,
    drift: [],
    agents: [],
    harnessModels: [],
      harnessInfo: null,
    queues: [],
    setup: null,
    update: { status: "idle", targetVersion: null, progressPercent: null, flow: null, detail: null },
    env: null,
    sampleWorld: { available: false, installing: false, note: null },
  },
  worlds: [],
  world: null,
  worldChat: null,
  bench: null,
  authoringRuns: [],
};

const EVENT = {
  at: "2026-08-01T10:00:00Z",
  type: "health.changed",
  component: "voice",
  status: "starting",
} as const;

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

  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  async nextFrame(count = 1): Promise<void> {
    while (this.frames.length < count) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for a frame")), 5_000);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async closed(): Promise<number> {
    return new Promise((resolve) => this.socket.once("close", (code) => resolve(code)));
  }

  close(): void {
    this.socket.close();
  }
}

describe("Transport", () => {
  it("sends one snapshot then monotonically sequenced events (R-3)", async () => {
    const transport = new Transport({ getSnapshot: () => STATE });
    const port = await transport.start(0);
    try {
      const client = new TestClient(port);
      await client.open();
      client.send({ kind: "hello" });
      await client.nextFrame(1);

      transport.broadcast(EVENT);
      transport.broadcast({ ...EVENT, status: "healthy" });
      await client.nextFrame(3);

      assert.equal(client.frames[0]!.kind, "snapshot");
      assert.deepEqual(
        client.frames.map((f) => f.seq),
        [1, 2, 3],
      );
      assert.equal(client.frames[1]!.kind, "event");
      client.close();
    } finally {
      await transport.stop();
    }
  });

  it("answers a reconnect carrying lastSeq with a fresh snapshot, never a partial replay (D4)", async () => {
    const transport = new Transport({ getSnapshot: () => STATE });
    const port = await transport.start(0);
    try {
      const first = new TestClient(port);
      await first.open();
      first.send({ kind: "hello" });
      await first.nextFrame(1);
      transport.broadcast(EVENT);
      await first.nextFrame(2);
      first.close();

      const second = new TestClient(port);
      await second.open();
      second.send({ kind: "hello", lastSeq: 2 });
      await second.nextFrame(1);
      assert.equal(second.frames[0]!.kind, "snapshot");
      assert.equal(second.frames[0]!.seq, 1, "sequence is per connection");
      second.close();
    } finally {
      await transport.stop();
    }
  });

  it("replays held transient prompts immediately after the fresh snapshot", async () => {
    const pending = {
      at: "2026-08-01T10:00:00Z",
      type: "permission.pending" as const,
      permissionId: "p1",
      actionClass: "future-tool",
      description: "The agent wants to use a capability Studio does not recognise yet",
      rememberable: false,
    };
    const transport = new Transport({ getSnapshot: () => STATE, getInitialEvents: () => [pending] });
    const port = await transport.start(0);
    try {
      const client = new TestClient(port);
      await client.open();
      client.send({ kind: "hello" });
      await client.nextFrame(2);
      assert.equal(client.frames[0]!.kind, "snapshot");
      assert.deepEqual(client.frames[1], { kind: "event", seq: 2, event: pending });
      client.close();
    } finally {
      await transport.stop();
    }
  });

  it("replays held transient prompts after a broadcast snapshot too", async () => {
    const pending = {
      at: "2026-08-01T10:00:00Z",
      type: "permission.pending" as const,
      permissionId: "p1",
      actionClass: "future-tool",
      description: "The agent wants to use a capability Studio does not recognise yet",
      rememberable: false,
    };
    const transport = new Transport({ getSnapshot: () => STATE, getInitialEvents: () => [pending] });
    const port = await transport.start(0);
    try {
      const client = new TestClient(port);
      await client.open();
      client.send({ kind: "hello" });
      await client.nextFrame(2);
      transport.broadcastSnapshot();
      await client.nextFrame(4);
      assert.equal(client.frames[2]!.kind, "snapshot");
      assert.deepEqual(client.frames[3], { kind: "event", seq: 4, event: pending });
      client.close();
    } finally {
      await transport.stop();
    }
  });

  it("routes non-hello messages to the coordinator only after hello", async () => {
    const seen: unknown[] = [];
    const transport = new Transport({ getSnapshot: () => STATE, onMessage: (m) => seen.push(m) });
    const port = await transport.start(0);
    try {
      const client = new TestClient(port);
      await client.open();
      client.send({ kind: "hello" });
      await client.nextFrame(1);
      client.send({ kind: "open-world", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC" });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(seen.length, 1);

      const rude = new TestClient(port);
      await rude.open();
      rude.send({ kind: "open-world", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC" });
      assert.equal(await rude.closed(), 1002);
      client.close();
    } finally {
      await transport.stop();
    }
  });

  it("closes a connection that sends a malformed message rather than guessing", async () => {
    const transport = new Transport({ getSnapshot: () => STATE });
    const port = await transport.start(0);
    try {
      const client = new TestClient(port);
      await client.open();
      client.sendRaw("not json at all");
      assert.equal(await client.closed(), 1002);
    } finally {
      await transport.stop();
    }
  });

  it("drops a message this build's schema does not know, and keeps the session (review 2026-08-22)", async () => {
    // Valid JSON that fails the schema is version skew — a renderer one build ahead sends a
    // frame this coordinator has never heard of. Closing the socket for that made the whole app
    // read as disconnected on one keystroke; the message is dropped, said so, and life goes on.
    const dropped: string[] = [];
    const seen: unknown[] = [];
    const transport = new Transport({
      getSnapshot: () => STATE,
      onMessage: (m) => seen.push(m),
      log: (line) => dropped.push(line),
    });
    const port = await transport.start(0);
    try {
      const client = new TestClient(port);
      await client.open();
      client.send({ kind: "hello" });
      await client.nextFrame(1);

      client.send({ kind: "a-message-from-the-future", payload: { bold: true } });
      client.send({ kind: "open-world", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC" });
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(seen.length, 1, "the message after the unknown one still arrived");
      assert.equal(dropped.length, 1, "and the drop was said, not swallowed");

      transport.broadcast(EVENT);
      await client.nextFrame(2);
      assert.equal(client.frames[1]!.kind, "event", "the connection is still live both ways");
      client.close();
    } finally {
      await transport.stop();
    }
  });
});

/**
 * The read-only media route, end to end (issue 477).
 *
 * `parseByteRange` is unit-tested next door; what is proved here is the plumbing around it — that
 * a ranged request comes back 206 with a `Content-Range` a `<video>` can seek against, that an
 * artifact's markdown arrives with a text content type the viewer can read and its bytes intact,
 * and that the resolver's refusal is a 404 rather than anything the renderer could work around.
 */
describe("the media route", () => {
  const CLIP = Buffer.from("0123456789abcdefghij");
  // Blank lines, trailing space and a final newline: the parts a viewer would quietly eat.
  const NOTE = ["# Saltlight", "", "One night on the Vigil.   ", "", ""].join("\n");

  /** A transport serving one world's artifacts through the real resolver; base URL of that world. */
  async function serving(t: TestContext): Promise<string> {
    const root = await tempDir("arke-media-route-");
    await mkdir(join(root, "worlds", "the-undersong", "artifacts"), { recursive: true });
    await writeFile(join(root, "worlds", "the-undersong", "artifacts", "vigil.mp4"), CLIP);
    await writeFile(join(root, "worlds", "the-undersong", "artifacts", "treatment.md"), NOTE, "utf8");
    await writeFile(join(root, "worlds", "the-undersong", "artifacts", "treatment.md.json"), "{}", "utf8");
    const provider = new FsWorldProvider(root, { clock: () => "2026-08-26T10:00:00.000Z" });
    const transport = new Transport({
      getSnapshot: () => STATE,
      // The same one line the coordinator wires up, so the route under test is the real one.
      serveFile: async (urlPath) => {
        const match = /^\/media\/([^/]+)\/(.+)$/.exec(urlPath);
        return match ? await provider.serveMedia(match[1]!, match[2]!) : null;
      },
    });
    const port = await transport.start(0);
    t.after(async () => {
      await transport.stop();
      await provider.close();
    });
    return `http://127.0.0.1:${port}/media/the-undersong`;
  }

  it("sends the whole file when nothing was asked for, and says it takes ranges", async (t) => {
    const base = await serving(t);
    const res = await fetch(`${base}/artifacts/vigil.mp4`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("content-length"), String(CLIP.length));
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), CLIP.toString());
  });

  it("answers a range with 206 and the window it actually sent — what seeking runs on", async (t) => {
    const base = await serving(t);
    const res = await fetch(`${base}/artifacts/vigil.mp4`, { headers: { Range: "bytes=4-8" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 4-8/${CLIP.length}`);
    assert.equal(res.headers.get("content-length"), "5");
    assert.equal(await res.text(), "45678");

    // The suffix form a player sends looking for the trailing atoms — the one that reads backwards.
    const tail = await fetch(`${base}/artifacts/vigil.mp4`, { headers: { Range: "bytes=-4" } });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get("content-range"), `bytes 16-19/${CLIP.length}`);
    assert.equal(await tail.text(), "ghij");
  });

  it("refuses a window past the end with 416 rather than a short body", async (t) => {
    const base = await serving(t);
    const res = await fetch(`${base}/artifacts/vigil.mp4`, { headers: { Range: "bytes=900-999" } });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), `bytes */${CLIP.length}`);
  });

  it("serves an artifact's markdown as text, whitespace and line endings intact", async (t) => {
    const base = await serving(t);
    const res = await fetch(`${base}/artifacts/treatment.md`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(await res.text(), NOTE);
  });

  it("404s what the resolver refuses — the sidecar beside the file included", async (t) => {
    const base = await serving(t);
    for (const path of ["artifacts/treatment.md.json", "artifacts/../world.json", "artifacts/missing.mp4"]) {
      assert.equal((await fetch(`${base}/${path}`)).status, 404, `served ${path}`);
    }
  });
});
