import assert from "node:assert/strict";
import { it } from "node:test";
import { ClientMessageSchema, DomainEventSchema } from "../src/index.js";
import { isRemoteHostCommand } from "../src/remote-command-access.js";

const request = { kind: "import-character-look", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", requestId: "01J8E1000000000000000000K1", sheetId: "bray-half-hitch", name: "Ward visit", lookKind: "costume", files: [{ name: "look.png", data: "aW1hZ2U=" }] };
it("accepts one browser-carried image without host filesystem access", () => {
  const parsed = ClientMessageSchema.parse(request);
  assert.equal(isRemoteHostCommand(parsed), false);
  assert.throws(() => ClientMessageSchema.parse({ ...request, sourcePaths: ["C:/private.png"] }));
  assert.throws(() => ClientMessageSchema.parse({ ...request, files: [] }));
  assert.throws(() => ClientMessageSchema.parse({ ...request, files: [...request.files, ...request.files] }));
});
it("requires bounded authored look details and a safe image filename", () => {
  for (const change of [{ name: " " }, { name: "x".repeat(61) }, { lookKind: "view" }, { files: [{name:"../private.png",data:"aW1hZ2U="}] }])
    assert.throws(() => ClientMessageSchema.parse({ ...request, ...change }));
});
it("correlates a landed look to its originating request", () => {
  const result = { type: "character-look.imported", at: "2026-10-20T06:00:00Z", worldId: request.worldId, sheetId: request.sheetId, requestId: request.requestId, status: "landed", takeId: "tk_01J8E0000000000000000000J1" };
  assert.doesNotThrow(() => DomainEventSchema.parse(result));
  assert.throws(() => DomainEventSchema.parse({ ...result, requestId: undefined }));
});
