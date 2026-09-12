import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Prop, Sheet } from "@arke-studio/contracts";
import { mentionNames, scriptWords } from "../src/screens/scene-workspace/mentions.js";

const sheets = [{ id: "carl", name: "Carl" }, { id: "the-vigil", name: "The Vigil" }] as unknown as Sheet[];
const props = [{ id: "pr_1", name: "Carl", states: [] }, { id: "pr_2", name: "Polaroid", states: [] }] as unknown as Prop[];

describe("the script's words (issues 1103, 1114)", () => {
  it("reads a mention as the sheet's or the prop's name, keeps a slug nothing answers to, and lets the sheet keep a word a prop also claims", () => {
    const names = mentionNames(sheets, props);
    assert.equal(names.get("the-vigil"), "The Vigil");
    assert.equal(names.get("polaroid"), "Polaroid", "a prop is named by its own slug");
    assert.equal(names.get("carl"), "Carl", "the sheet's id is the slug itself; the prop only fills a slug no sheet has");
    const read = renderToStaticMarkup(<>{scriptWords("@carl lifts the @polaroid at @railway-hotel-lobby.", names, "read")}</>);
    assert.equal(read, '<span class="fy-mentionname" data-slug="carl">Carl</span> lifts the <span class="fy-mentionname" data-slug="polaroid">Polaroid</span> at <span class="fy-mentionname" data-slug="railway-hotel-lobby">railway-hotel-lobby</span>.');
  });

  it("written in, keeps every token on the line letter for letter, chipped as the bench chips a citation", () => {
    const names = mentionNames(sheets, props);
    const edit = renderToStaticMarkup(<>{scriptWords("(@carl) then @the-vigil", names, "edit")}</>);
    assert.equal(edit, '(<mark class="fy-bench__briefchip">@carl</mark>) then <mark class="fy-bench__briefchip">@the-vigil</mark>');
    assert.deepEqual(scriptWords("no mention", names, "edit"), ["no mention"]);
    assert.deepEqual(scriptWords("", names, "read"), []);
  });
});
