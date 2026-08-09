import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { AgentsPanel } from "../src/screens/agents.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const withAgents = () => ({
  ...FIXTURE_STATE,
  app: {
    ...FIXTURE_STATE.app,
    agents: [
      {
        name: "world-author",
        description: "Draft a new world from a name and a sentence",
        shippedBrief: "You draft the opening shape of a new world.",
        brief: "You draft the opening shape of a new world.",
        edited: false,
      },
      {
        name: "canon-author",
        description: "Draft canon entries and settle threads",
        shippedBrief: "You draft or amend canon entry files.",
        brief: "Write canon like a court reporter.",
        model: "github-copilot/claude-sonnet-4.6",
        edited: true,
      },
    ],
    harnessModels: [
      { id: "claude-sonnet-4.6", provider: "github-copilot", displayName: "Claude Sonnet 4.6" },
      { id: "gpt-5.6-sol", provider: "openai", displayName: "GPT-5.6 Sol" },
    ],
  },
});

const render = () =>
  renderToString(
    <MemoryRouter>
      <AgentsPanel />
    </MemoryRouter>,
  );

describe("the agents panel (behind Advanced on Who does what)", () => {
  it("lists each agent with what it is for, and groups models by provider", () => {
    __setStateForTest(withAgents());
    const html = render();
    assert.ok(html.includes("world-author"));
    assert.ok(html.includes("Draft canon entries and settle threads"));
    assert.ok(html.includes("github-copilot") && html.includes("openai"), "providers head their own group");
    assert.ok(html.includes("Claude Sonnet 4.6"));
  });

  it("says plainly when an agent is left to the harness, rather than showing a blank", () => {
    __setStateForTest(withAgents());
    const html = render();
    assert.ok(html.includes("whatever OpenCode is set to"));
  });

  it("marks an edited brief so the shipped one is never mistaken for it", () => {
    __setStateForTest(withAgents());
    const html = render();
    assert.ok(html.includes("Brief · edited"), "the edited agent says so");
  });

  it("offers no model list at all when the harness is not running, and says why", () => {
    const state = withAgents();
    __setStateForTest({ ...state, app: { ...state.app, harnessModels: [] } });
    const html = render();
    assert.ok(html.includes("ask the harness — it is not running"));
  });
});
