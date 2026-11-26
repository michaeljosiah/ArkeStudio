import assert from "node:assert/strict";
import { it } from "node:test";
import { AGENT_MEDIA_TOOL_CATALOG } from "../../src/world-chat/media-tool-catalog.js";

/**
 * What the measurement tools tell Arke about their own limits (design turn 286). Tested on 0.5.127:
 * asked whether ten shots were ready, Arke judged the cuts from the contact sheet's middle frames,
 * and called three slow, dark shots stills because the export review gave them no motion figures.
 */
const describe = (name: string) => AGENT_MEDIA_TOOL_CATALOG.find((tool) => tool.name === name)!.description;

it("the contact sheet says a middle frame shows no cut, and how to see the cuts", () => {
  assert.match(describe("cut_contact_sheet"), /A middle frame shows no cut: to see the cuts, ask again with seams true/);
  assert.match(describe("cut_contact_sheet"), /One page is one image of the budget however many cuts it holds/);
  const inputs = AGENT_MEDIA_TOOL_CATALOG.find((tool) => tool.name === "cut_contact_sheet")!.inputSchema.properties as Record<string, unknown>;
  assert.deepEqual(inputs["seams"], { type: "boolean", default: false });
});

/*
 * On 2026-11-26 a scene was cut outside the Studio and its clips sat on the shelf. Both tools read
 * any film, but said to name an export, so Arke looked at eight frames of a three-shot clip
 * instead and placed a cut 1.1 s from where it was.
 */
it("the sheet and the review say they read any film, not only an export", () => {
  for (const name of ["cut_contact_sheet", "review_export"]) assert.match(describe(name), /Name any film: a finished export by its id \(from list_exports\), a take, or a video on the shelf/, name);
});

it("the export review says a shot with no motion figures is not proof of a still", () => {
  assert.match(describe("review_export"), /not proof of a still: look before saying a shot does not move/);
});
