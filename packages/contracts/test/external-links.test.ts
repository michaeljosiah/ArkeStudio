import assert from "node:assert/strict";
import { it } from "node:test";
import { externalWebUrl } from "../src/external-links.js";

it("allows only absolute HTTP(S) links at the external shell boundary", () => {
  assert.equal(externalWebUrl("https://example.com/path?q=1#part"), "https://example.com/path?q=1#part");
  assert.equal(externalWebUrl("HTTP://EXAMPLE.COM"), "http://example.com/");
  for (const value of ["/tmp/file", "../file", "//example.com", "file:///C:/Windows/system.ini", "C:\\temp\\file", "javascript:alert(1)", "data:text/html,hello", "ms-settings:display", "mailto:a@example.com", "https://", ""]) {
    assert.equal(externalWebUrl(value), null, value);
  }
});
