import assert from "node:assert/strict";
import { it } from "node:test";
import { localModelPolicy } from "../../src/setup/catalogue.js";
import { PullProgress } from "../../src/setup/local-setup.js";

const UNCENSORED = "hf.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M";

it("the uncensored Gemma waits to be chosen, and carries its card's sampling; the stock one does neither (issue 1289)", () => {
  const policy = localModelPolicy(UNCENSORED);
  assert.equal(policy?.explicitChoiceOnly, true);
  assert.deepEqual(policy?.sampling, { temperature: 0.6, top_k: 64, top_p: 0.9, min_p: 0.05, repeat_penalty: 1.1 });
  assert.equal(policy?.displayName, "Gemma 4 · 12B Uncensored Balanced · HauhauCS");
  assert.equal(localModelPolicy(`ollama/${UNCENSORED}`)?.explicitChoiceOnly, true, "as the harness names it");
  assert.equal(localModelPolicy(UNCENSORED.toLowerCase())?.explicitChoiceOnly, true, "in whatever case it is listed");
  assert.equal(localModelPolicy("gemma4:12b"), undefined);
  assert.equal(localModelPolicy("someone-else:7b"), undefined);
});

it("reads ollama pull's own progress bars, off a terminal, into bytes and a rate", () => {
  const progress = new PullProgress();
  const redraw = (line: string) => `\u001b[?2026h\u001b[?25l\u001b[1G${line} \u001b[K\u001b[?25h\u001b[?2026l`;
  assert.equal(progress.read(redraw("pulling manifest ⠋")), false, "nothing to count yet");
  // Split mid-line, as pipe chunks are.
  const first = redraw("pulling 59656d7494d6:  45% ▕████      ▏ 3.3 GB/7.4 GB   30 MB/s   2m10s");
  assert.equal(progress.read(first.slice(0, 40)), false);
  assert.equal(progress.read(first.slice(40) + redraw("pulling 59656d7494d6:  46%")), true);
  assert.equal(progress.done, 3_300_000_000);
  assert.equal(progress.perSecond, 30_000_000);
  // Finished layers print their size alone, and several redraw together after a cursor-up.
  assert.equal(progress.read("\u001b[2A\u001b[1Gpulling 59656d7494d6: 100% ▕██████████▏ 7.4 GB\u001b[K\npulling f56e8459650d: 100% ▕██████████▏  159 B\u001b[K\n"), true);
  assert.equal(progress.done, 7_400_000_159);
  assert.equal(progress.read("verifying sha256 digest\nwriting manifest\nsuccess\n"), false, "the ending moves nothing");
});
