import assert from "node:assert/strict";
import { it } from "node:test";
import { AGENT_MEDIA_TOOL_CATALOG } from "../../src/world-chat/media-tool-catalog.js";

/**
 * What the measurement tools tell Arke about their own limits (design turn 286). Tested on 0.5.127:
 * asked whether ten shots were ready, Arke judged the cuts from the contact sheet's middle frames,
 * and called three slow, dark shots stills because the export review gave them no motion figures.
 */
const describe = (name: string) => AGENT_MEDIA_TOOL_CATALOG.find((tool) => tool.name === name)!.description;

it("the contact sheet says a middle frame shows no cut", () => {
  assert.match(describe("cut_contact_sheet"), /A middle frame shows no cut: to judge whether a cut matches, sample_video either side of it/);
});

it("the export review says a shot with no motion figures is not proof of a still", () => {
  assert.match(describe("review_export"), /not proof of a still: look before saying a shot does not move/);
});
