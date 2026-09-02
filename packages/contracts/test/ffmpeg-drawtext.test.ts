import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ffmpegDrawtextText } from "../src/ffmpeg-filter.js";

/**
 * A burned-in cue keeps its punctuation (round three of PR 696). The text sits inside single
 * quotes in the filter graph, so the graph parser hands the option parser the bare run: a
 * backslash and a colon are escaped once for that second pass, and a quote closes the run,
 * escapes itself outside it, and reopens it. Nothing authored is replaced.
 */
describe("drawtext text escaping", () => {
  it("escapes the option parser's specials and leaves the rest alone", () => {
    assert.equal(ffmpegDrawtextText("Don't stop, now: ok [1]; fine"), "Don'\\\\\\''t stop, now\\: ok [1]; fine");
    assert.equal(ffmpegDrawtextText("a\\b"), "a\\\\b");
    assert.equal(ffmpegDrawtextText("plain words"), "plain words");
  });

  it("unescapes back to the cue through both layers", () => {
    // The graph parser: a quoted run is verbatim; outside it `\x` is `x`. Then the option parser
    // reads the bare value with the same backslash rule. Modelled here so the escape is checked
    // against the parsing it targets rather than against itself.
    const graphLayer = (quoted: string): string => {
      let out = "";
      let i = 0;
      while (i < quoted.length) {
        const c = quoted[i]!;
        if (c === "\\" && i + 1 < quoted.length) {
          out += quoted[i + 1];
          i += 2;
        } else if (c === "'") {
          const end = quoted.indexOf("'", i + 1);
          out += quoted.slice(i + 1, end);
          i = end + 1;
        } else {
          out += c;
          i += 1;
        }
      }
      return out;
    };
    const optionLayer = (bare: string): string => bare.replace(/\\(.)/g, "$1");
    for (const cue of ["Don't stop, now: ok [1]; fine", "C:\\path\\to", "it's 'quoted'", "50% off, really?"]) {
      assert.equal(optionLayer(graphLayer(`'${ffmpegDrawtextText(cue)}'`)), cue);
    }
  });
});
