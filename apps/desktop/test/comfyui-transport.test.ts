import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { Agent } from "undici";
import { comfyUiLoopbackAddresses, createComfyUiFetch } from "../src/comfyui-transport.js";

describe("the ComfyUI HTTP transport", () => {
  it("closes every loopback response instead of pooling it across engine replacement", async () => {
    const ports: number[] = [];
    const connections: string[] = [];
    const server = createServer((request, response) => {
      ports.push(request.socket.remotePort!);
      connections.push(String(request.headers.connection));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const comfyFetch = createComfyUiFetch((url, init) => fetch(url, init));
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await comfyFetch(`http://localhost:${address.port}/system_stats`);
        assert.equal(response.status, 200);
        await response.text();
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    assert.deepEqual(connections, ["close", "close"]);
    assert.equal(new Set(ports).size, 2, "each probe must use a fresh TCP connection");
  });

  it("pins localhost to loopback instead of trusting host resolution", () => {
    assert.deepEqual(comfyUiLoopbackAddresses("LOCALHOST"), [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
    assert.deepEqual(comfyUiLoopbackAddresses("127.attacker.example"), []);
  });

  it("preserves caller options and leaves remote engines on the shared dispatcher", async () => {
    const calls: Array<{ url: string; headers: Headers; dispatcher: unknown }> = [];
    const dispatcher = new Agent({ pipelining: 0 });
    const comfyFetch = createComfyUiFetch(async (url, init) => {
      calls.push({
        url,
        headers: new Headers(init?.headers),
        dispatcher: (init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher,
      });
      return new Response("{}", { status: 200 });
    }, dispatcher);

    await comfyFetch("http://127.0.0.1:8188/system_stats", { headers: { accept: "application/json" } });
    await comfyFetch("http://localhost:8188/system_stats", { headers: { accept: "application/json" } });
    await comfyFetch("https://gpu.example:8188/system_stats", { headers: { accept: "application/json" } });

    assert.equal(calls[0]?.headers.get("accept"), "application/json");
    assert.equal(calls[0]?.dispatcher, dispatcher);
    assert.equal(calls[1]?.headers.get("accept"), "application/json");
    assert.equal(calls[1]?.dispatcher, dispatcher);
    assert.equal(calls[2]?.headers.get("accept"), "application/json");
    assert.equal(calls[2]?.dispatcher, undefined);
    await dispatcher.close();
  });
});
