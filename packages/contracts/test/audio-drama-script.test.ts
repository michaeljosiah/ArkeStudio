import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EpisodeScriptSchema, episodeScriptFile, episodeScriptProblems, estimateScriptSeconds, type EpisodeScriptBlock } from "../src/audio-drama.js";
import { ulid } from "../src/ids.js";

/** The episode script (SPEC-057 R-11..R-24, R-83): its blocks and the relations it keeps whole. */
const id = () => ulid();
const line = (speaker: string, words: string, extra: object = {}) => ({ id: id(), kind: "dialogue" as const, speaker, words, ...extra });

describe("an episode script (SPEC-057 R-83)", () => {
  it("holds every kind of block, each with its own id, and reads back exactly", () => {
    const blocks: EpisodeScriptBlock[] = [
      { id: id(), kind: "heading", place: "The bell tower", time: "Before dawn", heardAs: "narrated",
        source: { story: "low-water", chapter: "the-bell-tower", version: 14, paragraphs: [14, 15, 16, 17] } },
      { id: id(), kind: "ambience", heard: "Wind in the stairwell." },
      line("maren", "Bray. Bray, look — the stairs go all the way up.", { direction: "breathless, delighted", paragraphs: [14] }),
      line("bray", "I see them.", { channel: "off-mic" }),
      { id: id(), kind: "silence", seconds: 1.5 },
      { id: id(), kind: "sound", heard: "Far off, one deep stroke of the harbour bell.", purpose: "Sereth's signal", required: true },
      { id: id(), kind: "narration", words: "She climbed." },
      { id: id(), kind: "note", text: "Keep the bell distant." },
    ];
    const script = EpisodeScriptSchema.parse({ version: 1, episode: 1, title: "The tide turns", blocks });
    assert.deepEqual(script.blocks, blocks);
    assert.equal(episodeScriptFile(1), "episode-001.json");
    assert.equal(episodeScriptFile(12), "episode-012.json");
    assert.ok(episodeScriptFile(100) > episodeScriptFile(11), "three digits keep 100 after 11");
  });

  it("an interruption is a stored relation: a cut line needs the line that breaks in (R-18)", () => {
    const cut = line("maren", "Ilo's lantern is up here. He said it was", { cut: true });
    const breaksIn = line("bray", "Two. Climb.", { overlapsPrevious: true });
    assert.deepEqual(episodeScriptProblems([cut, breaksIn]), []);
    assert.match(episodeScriptProblems([cut, line("bray", "Two.")]).join(" "), /must be followed by the line that breaks in/);
    assert.match(episodeScriptProblems([{ id: id(), kind: "narration", words: "x" }, breaksIn]).join(" "), /must follow the line it breaks off/);
    assert.match(episodeScriptProblems([line("maren", "Not broken off."), breaksIn]).join(" "), /must follow the line it breaks off/,
      "both sides of the relation: the line above must be marked broken off");
    assert.throws(() => EpisodeScriptSchema.parse({ version: 1, episode: 1, blocks: [cut] }));
  });

  it("a bed stops before a block below it; a sound has no until; ids never repeat", () => {
    const later = line("maren", "Later.");
    const bed = { id: id(), kind: "music" as const, heard: "Low drone", until: later.id };
    assert.deepEqual(episodeScriptProblems([bed, line("bray", "Now."), later]), []);
    assert.match(episodeScriptProblems([later, bed]).join(" "), /stops before a block that is not below it/);
    assert.match(episodeScriptProblems([{ id: id(), kind: "sound", heard: "Click", until: later.id }, later]).join(" "), /a moment, not a bed/);
    const twice = line("maren", "Again.");
    assert.match(episodeScriptProblems([twice, twice]).join(" "), /appears twice/);
  });

  it("estimates listening time from spoken words, silences and sounds", () => {
    const seconds = estimateScriptSeconds([line("maren", Array(26).fill("word").join(" ")), { id: id(), kind: "silence", seconds: 3 }, { id: id(), kind: "sound", heard: "x" }]);
    assert.equal(seconds, 14);
  });
});
