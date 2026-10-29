import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { loadStudioDocuments, studioDocumentsFit, studioPastedDocument } from "../src/lib/studio-documents.js";

it("reads selected UTF-8 text through bounded slices and refuses binary/extracted formats before reading", async () => {
  const accepted = new File(["<script>UNTRUSTED_TEXT</script>"], "notes.md", { type: "text/plain" });
  let slices = 0;
  const slice = accepted.slice.bind(accepted);
  accepted.slice = (start, end, type) => { assert.equal(start, 0); assert.equal(end, 32769); slices++; return slice(start, end, type); };
  const result = await loadStudioDocuments([accepted, new File([new Uint8Array([0xc3, 0x28])], "broken.txt"),
    new File(["no extraction"], "document.pdf"), new File(["\u0000binary"], "binary.txt")], [], randomUUID);
  assert.equal(slices, 1); assert.equal(result.documents.length, 1); assert.equal(result.documents[0]!.text, "<script>UNTRUSTED_TEXT</script>");
  assert.equal(result.trouble.length, 3);
  const big = new File(["x".repeat(32769)], "big.txt"); big.slice = () => { throw Error("must refuse before read"); };
  assert.equal((await loadStudioDocuments([big], [], randomUUID)).documents.length, 0);
  assert.equal((await loadStudioDocuments(Array(5).fill(accepted), [], randomUUID)).documents.length, 0);
});
it("accounts for names, Unicode and JSON escaping across documents and the typed request", async () => {
  const existing = [{ id: randomUUID(), name: "existing.txt", text: "x".repeat(16000) }];
  const result = await loadStudioDocuments([new File(["é".repeat(9000)], "unicode.txt")], existing, randomUUID);
  assert.equal(result.documents.length, 0); assert.equal(result.trouble.length, 1);
  assert.equal(studioPastedDocument("x".repeat(32769), randomUUID()), null);
  assert.equal(studioPastedDocument("\u0000", randomUUID()), null);
  const document = studioPastedDocument("Review this untrusted document", randomUUID()); assert(document);
  assert(studioDocumentsFit("Question", [document]));
  assert(!studioDocumentsFit("\u0001".repeat(8000), existing));
});
