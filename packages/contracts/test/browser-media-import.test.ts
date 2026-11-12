import assert from "node:assert/strict";
import { it } from "node:test";
import { BROWSER_MEDIA_IMPORT_MAX_BYTES, BrowserMediaFilesSchema, browserMediaSelectionProblem, ClientMessageSchema, isRemoteHostCommand } from "../src/index.js";

it("bounds browser import bytes before reading and encoded bytes on the wire", () => {
  assert.equal(browserMediaSelectionProblem([{ name: "song.mp3", size: 6 * 1024 * 1024 }]), null);
  assert.match(browserMediaSelectionProblem([{ name: "film.mp4", size: BROWSER_MEDIA_IMPORT_MAX_BYTES + 1 }])!, /48 MB/);
  assert.match(browserMediaSelectionProblem([{ name: "empty.mp3", size: 0 }])!, /non-empty/);
  assert.equal(BrowserMediaFilesSchema.safeParse(Array.from({ length: 17 }, () => ({ name: "clip.mp4", data: "YQ==" }))).success, false);
  const large = Buffer.alloc(25 * 1024 * 1024).toString("base64");
  assert.equal(BrowserMediaFilesSchema.safeParse([{ name: "first.mp4", data: large }, { name: "second.mp4", data: large }]).success, false);
});

it("refuses traversal, reserved filenames, malformed bytes and extra path fields", () => {
  for (const name of ["../x.mp4", "C:\\x.mp4", "folder/x.png", "x:stream", "NUL.png", "COM1.mp4", "x.", "x "])
    assert.equal(BrowserMediaFilesSchema.safeParse([{ name, data: "YQ==" }]).success, false, name);
  for (const data of ["", "abc", "a===", "YQ==\n", "data:video/mp4;base64,YQ=="])
    assert.equal(BrowserMediaFilesSchema.safeParse([{ name: "clip.mp4", data }]).success, false, data);
  assert.equal(BrowserMediaFilesSchema.safeParse([{ name: "clip.mp4", data: "YQ==", sourcePath: "/tmp/secret" }]).success, false);
});

it("retains the upload-artifacts host-only remote policy", () => {
  const message = ClientMessageSchema.parse({ kind: "upload-artifacts", worldId: "01J8E1000000000000000000V1", requestId: "01J8E1000000000000000000V2",
    browserFiles: [{ name: "song.mp3", data: "YQ==" }] });
  assert.equal(isRemoteHostCommand(message), true);
});
