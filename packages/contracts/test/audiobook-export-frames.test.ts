import assert from "node:assert/strict";
import { it } from "node:test";
import { ClientMessageSchema } from "../src/frames.js";

it("opens only the exact exported player or an existing video filename", () => {
  const command = { kind: "open-exports-folder", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", dir: "audiobook-ledger-ab_test" };
  for (const file of ["player.html", "chapter-01.mp4"]) assert.ok(ClientMessageSchema.safeParse({ ...command, file }).success);
  for (const file of ["other.html", "player.html.exe", "../player.html", "C:\\player.html", "https://example.test/player.html"]) assert.equal(ClientMessageSchema.safeParse({ ...command, file }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ ...command, dir: "../other", file: "player.html" }).success, false);
});
