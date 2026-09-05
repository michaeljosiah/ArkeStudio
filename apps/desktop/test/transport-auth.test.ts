import assert from "node:assert/strict";
import { it } from "node:test";
import { authenticatedMediaHeaders, desktopTransportOrigins } from "../src/transport-auth.js";

it("authenticates this window's world and genesis media without putting the token in URLs", () => {
  const session = { port: 43210, token: "a".repeat(64) };
  for (const prefix of ["media/world", "genesis-media/draft"]) {
    const request = { url: `http://127.0.0.1:43210/${prefix}/clip.mp4`, webContentsId: 7, requestHeaders: { Range: "bytes=4-8" } };
    assert.deepEqual(authenticatedMediaHeaders(request, session, 7), { Range: "bytes=4-8", Authorization: `Bearer ${session.token}` });
    assert.equal(request.url.includes(session.token), false);
    assert.deepEqual(request.requestHeaders, { Range: "bytes=4-8" });
    assert.deepEqual(authenticatedMediaHeaders(request, session, 8), request.requestHeaders);
    assert.deepEqual(authenticatedMediaHeaders(request, null, 7), request.requestHeaders);
  }
});

it("never carries the session header to another host, port or route on redirect", () => {
  const session = { port: 43210, token: "a".repeat(64) };
  for (const url of ["https://example.com/media/a", "http://127.0.0.1:43211/media/a", "http://127.0.0.1:43210/other"]) {
    assert.deepEqual(authenticatedMediaHeaders({ url, webContentsId: 7, requestHeaders: { authorization: `Bearer ${session.token}` } }, session, 7), {});
  }
});

it("uses Electron's actual file WebSocket and fetch origins, or only the configured dev origin", () => {
  assert.deepEqual(desktopTransportOrigins(), ["file://", "null"]);
  assert.deepEqual(desktopTransportOrigins("http://localhost:5199/studio"), ["http://localhost:5199"]);
});
