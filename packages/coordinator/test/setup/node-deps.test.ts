import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { nodeSetupDeps } from "../../src/setup/node-deps.js";

describe("setup's Node HTTP dependency", () => {
  it("sends a real byte range and publishes the response's resume evidence", async () => {
    const encodings: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      encodings.push(request.headers["accept-encoding"]);
      if (request.headers.range === "bytes=5-") {
        assert.equal(request.headers["if-range"], '"weights-v1"');
        response.writeHead(206, {
          "Accept-Ranges": "bytes",
          "Content-Range": "bytes 5-9/10",
          "Content-Length": "5",
          ETag: '"weights-v1"',
        });
        response.end("56789");
        return;
      }
      response.writeHead(200, { "Content-Length": "10" });
      response.end("0123456789");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const deps = nodeSetupDeps();
      const ranged = await deps.fetchStream(
        `http://127.0.0.1:${address.port}/weights`,
        new AbortController().signal,
        5,
        '"weights-v1"',
      );
      const chunks: Uint8Array[] = [];
      for await (const chunk of ranged.body) chunks.push(chunk);
      assert.equal(ranged.status, 206);
      assert.equal(ranged.acceptRanges, true);
      assert.equal(ranged.contentRangeStart, 5);
      assert.equal(ranged.contentRangeEnd, 9);
      assert.equal(ranged.contentRangeTotal, 10);
      assert.equal(ranged.validator, '"weights-v1"');
      assert.match(encodings[0] ?? "", /identity/);
      assert.equal(Buffer.concat(chunks).toString(), "56789");

      const whole = await deps.fetchStream(
        `http://127.0.0.1:${address.port}/weights`,
        new AbortController().signal,
        null,
      );
      assert.equal(whole.status, 200);
      assert.equal(whole.acceptRanges, false);
      for await (const _chunk of whole.body) {
        // Drain the response so the local server can close cleanly.
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
