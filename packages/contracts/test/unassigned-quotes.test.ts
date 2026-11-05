import assert from "node:assert/strict";
import { it } from "node:test";
import { castParagraphHashes, unassignedQuotes, type CastShape } from "../src/prose.js";

it("offers unassigned dialogue, replies, documents, anonymous speech and imitation as advisory choices", () => {
  const body = '“Stay,” Maren said.\n\n“No.”\n\nThe letter read: “Return by dawn.”\n\nThe masked guide said, “Follow me.”\n\nThe mimic radioed, “This is Maren.”';
  const record: CastShape = { paragraphs: castParagraphHashes(body), lines: [{ paragraph: 0, occurrence: 0, quote: "“Stay,”", speaker: "Maren", sheet: "maren-kest" }] };
  assert.deepEqual(unassignedQuotes(body, record).map(row => row.quote), ["“No.”", "“Return by dawn.”", "“Follow me.”", "“This is Maren.”"]);
  const reviewed = { ...record, pins: [{ paragraph: 2, occurrence: 0, quote: "“Return by dawn.”", narration: true as const }] };
  assert.deepEqual(unassignedQuotes(body, reviewed).map(row => row.paragraph), [1, 3, 4], "quoted documents can remain narration without changing their text");
  assert.deepEqual(unassignedQuotes(body, null), [], "an uncast chapter is not presented as an audited cast");
});

it("preserves repeated occurrences, surfaces ambiguous cast lines and honors exact narration pins", () => {
  const body = '“No.” “No.”';
  const record: CastShape = { paragraphs: castParagraphHashes(body), lines: [{ paragraph: 0, occurrence: 0, quote: "“No.”", speaker: "Maren" }] };
  assert.deepEqual(unassignedQuotes(body, record).map(row => row.occurrence), [0, 1]);
  assert.deepEqual(unassignedQuotes(body, { ...record, pins: [{ paragraph: 0, occurrence: 1, quote: "“No.”", narration: true }] }).map(row => row.occurrence), [0]);
  assert.equal(unassignedQuotes(body, { ...record, pins: [{ paragraph: 0, occurrence: 3, quote: "“No.”", narration: true }] }).length, 2, "a lost pin hides nothing");
});

it("reconciles moved narration choices and leaves edited paragraphs to Cast again", () => {
  const body = 'The letter says “Wait here.”';
  const record: CastShape = { paragraphs: castParagraphHashes(body), lines: [], pins: [{ paragraph: 0, occurrence: 0, quote: "“Wait here.”", narration: true }] };
  assert.deepEqual(unassignedQuotes('A new introduction.\n\n' + body, record), []);
  assert.deepEqual(unassignedQuotes('The letter says “Leave now.”', record), [], "the existing changed-paragraph cast workflow owns this unfinished paragraph");
  const partial = { paragraphs: castParagraphHashes(body), lines: [{ paragraph: 0, occurrence: 0, quote: "Wait", speaker: "Maren" }] };
  assert.deepEqual(unassignedQuotes(body, partial), [], "partly assigned quotes are left to the existing passage selector, not overwritten wholesale");
});
