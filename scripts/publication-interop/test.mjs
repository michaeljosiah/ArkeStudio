import assert from "node:assert/strict";
import { test } from "node:test";
import { Manifest, GuidedNavigationDocument } from "@readium/shared";
import { captured, manifests, anchor } from "./generate.mjs";

test("the same captured order, identities and measured durations reach both audio manifests", () => {
  const { audio, w3c } = manifests([4.04898, 4.04898]);
  const parsed = Manifest.deserialize(audio).serialize();
  assert.equal(parsed.metadata.identifier, w3c.id);
  assert.deepEqual(parsed.readingOrder.map(item => [item.href, item.title, `PT${item.duration}S`]),
    w3c.readingOrder.map(item => [item.url, item.name, item.duration]));
  assert.equal(`PT${parsed.metadata.duration}S`, w3c.duration);
  assert.equal(parsed.metadata.title.und, w3c.name, "Readium normalizes a string title to a language map");
});

test("the Readium model preserves both captured text anchors and audio ranges", () => {
  const { guided, book } = manifests([4.05, 4.05]);
  assert.equal(Manifest.deserialize(book).metadata.effectiveLayout, "fixed");
  const roundtrip = GuidedNavigationDocument.deserialize(guided).serialize();
  assert.deepEqual(roundtrip, guided);
  assert.deepEqual(roundtrip.guided.map(item => item.audioref), ["chapter-1.mp3#t=0,2", "chapter-1.mp3#t=2,4"]);
  assert.equal(roundtrip.guided[1].textref, `page.xhtml#${anchor(captured.blocks[1].text)}`);
  assert.notEqual(anchor("Edited prose"), anchor(captured.blocks[1].text));
});

test("W3C manifests require an explicit adapter for this Readium SDK", () => {
  assert.equal(Manifest.deserialize(manifests([4, 4]).w3c), undefined);
});
