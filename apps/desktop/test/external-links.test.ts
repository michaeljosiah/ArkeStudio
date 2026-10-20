import assert from "node:assert/strict";
import { it } from "node:test";
import { webWindowOpenHandler } from "../src/external-links.js";

it("denies every new renderer window and sends only web URLs to the OS shell", () => {
  const opened: string[] = [];
  const handle = webWindowOpenHandler(async url => { opened.push(url); });
  for (const url of ["file:///C:/Windows/system.ini", "file:///tmp/notice.txt", "ms-settings:display", "javascript:alert(1)", "/notice.txt", "../notice.txt"])
    assert.deepEqual(handle({ url }), { action: "deny" });
  assert.deepEqual(opened, []);
  assert.deepEqual(handle({ url: "https://example.com/charter" }), { action: "deny" });
  assert.deepEqual(opened, ["https://example.com/charter"]);
});
