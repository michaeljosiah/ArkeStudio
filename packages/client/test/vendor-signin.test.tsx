import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, VendorAuthStatus } from "@arke-studio/contracts";
import { SettingsSignInScreen } from "../src/screens/shell.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Settings · Sign-in (SPEC-030 §2.4): labels, states and refusals only, everything in the
 * harness's words, and the removal warning said before removal happens.
 */

const authWith = (patch: Partial<VendorAuthStatus>): ClientState => ({
  ...FIXTURE_STATE,
  app: {
    ...FIXTURE_STATE.app,
    vendorAuth: { ...FIXTURE_STATE.app.vendorAuth, ...patch },
  },
});

const render = () =>
  renderToString(
    <MemoryRouter>
      <SettingsSignInScreen />
    </MemoryRouter>,
  );

const OPENAI = FIXTURE_STATE.app.vendorAuth.vendors[0]!;

describe("Settings · Sign-in", () => {
  it("offers every method the harness reports, in the harness's words (R-7, R-9)", () => {
    __setStateForTest(FIXTURE_STATE);
    const html = render();
    assert.ok(html.includes("OpenAI"));
    assert.ok(html.includes("ChatGPT Pro/Plus (browser)"));
    assert.ok(html.includes("ChatGPT Pro/Plus (headless)"));
    assert.ok(html.includes("API key"));
    assert.ok(html.includes("not signed in"));
  });

  it("states its absence with the reason, and never renders a broken screen (R-12)", () => {
    __setStateForTest(
      authWith({
        available: false,
        reason: "this harness cannot sign in to a vendor from here",
        vendors: [],
      }),
    );
    const html = render();
    assert.ok(html.includes("unavailable"));
    assert.ok(html.includes("this harness cannot sign in to a vendor from here"));
    assert.ok(!html.includes("ChatGPT"));
  });

  it("a connected vendor reads connected, and a marked one asks for sign-in (R-10, R-13)", () => {
    __setStateForTest(
      authWith({
        vendors: [
          { ...OPENAI, connections: [{ kind: "stored", id: "cred_1", label: "default" }] },
          { id: "xai", name: "xAI", methods: OPENAI.methods, connections: [{ kind: "stored", id: "cred_2", label: "default" }], needsSignIn: true },
        ],
      }),
    );
    const html = render();
    assert.ok(html.includes("connected"));
    assert.ok(html.includes("sign-in needed"));
  });

  it("with both a connection and a Studio key, names the one in effect (R-11)", () => {
    __setStateForTest(
      authWith({
        vendors: [
          {
            ...OPENAI,
            connections: [
              { kind: "stored", id: "cred_1", label: "default" },
              { kind: "env", name: "OPENAI_API_KEY" },
            ],
          },
        ],
      }),
    );
    assert.ok(render().includes("uses this sign-in, not your key"));
  });

  it("a sign-in under way shows the harness's instructions verbatim — they carry the device code", () => {
    __setStateForTest(
      authWith({
        signIn: {
          vendor: "openai",
          method: "ChatGPT Pro/Plus (headless)",
          phase: "waiting",
          instructions: "Enter code: AAAA-BBBBB",
          codeEntry: false,
          detail: null,
        },
      }),
    );
    const html = render();
    assert.ok(html.includes("Enter code: AAAA-BBBBB"));
    assert.ok(html.includes("Stop waiting"));
  });

  it("a code-mode attempt shows a field to bring the code back", () => {
    __setStateForTest(
      authWith({
        signIn: {
          vendor: "openai",
          method: "Device",
          phase: "waiting",
          instructions: "Paste the code the vendor shows you.",
          codeEntry: true,
          detail: null,
        },
      }),
    );
    const html = render();
    assert.ok(html.includes("code from the vendor"));
    assert.ok(html.includes("Submit"));
  });

  it("a failed sign-in states the reason and offers a way out", () => {
    __setStateForTest(
      authWith({
        signIn: {
          vendor: "openai",
          method: "ChatGPT Pro/Plus (browser)",
          phase: "failed",
          instructions: null,
          codeEntry: false,
          detail: "the sign-in did not complete in time — the other methods still work",
        },
      }),
    );
    const html = render();
    assert.ok(html.includes("did not complete in time"));
    assert.ok(html.includes("Dismiss"));
  });

  it("the authoring label follows an agent's model override, not only the harness default", () => {
    const base = authWith({
      vendors: [
        { ...OPENAI, connections: [{ kind: "stored", id: "cred_1", label: "default" }] },
        { id: "xai", name: "xAI", methods: OPENAI.methods, connections: [{ kind: "stored", id: "cred_2", label: "default" }], needsSignIn: false },
      ],
    });
    __setStateForTest({
      ...base,
      app: {
        ...base.app,
        health: { ...base.app.health, harness: { status: "healthy" } },
        harnessModels: [{ id: "gpt", provider: "openai", isDefault: true }],
        agents: [
          {
            name: "scene-writer",
            description: "writes scenes",
            shippedBrief: "brief",
            brief: "brief",
            model: "xai/grok-code",
            edited: true,
          },
        ],
      },
    });
    const html = render();
    // Both providers can bill an authoring turn: the default's and the override's.
    const labels = html.split("used for authoring").length - 1;
    assert.equal(labels, 2);
  });

  it("the carry limitation is stated when personal harness state exists (R-4)", () => {
    __setStateForTest(
      authWith({
        carry: "unavailable",
        carryDetail: "sign-ins from your own installation stay there on this version — connect here separately",
      }),
    );
    assert.ok(render().includes("stay there on this version"));
  });

  it("a method with form fields renders nothing extra until it is opened", () => {
    // Copilot's device method carries a form; the row offers the method label alone.
    __setStateForTest(
      authWith({
        vendors: [
          {
            id: "github-copilot",
            name: "GitHub Copilot",
            methods: [
              {
                id: "device",
                kind: "oauth",
                label: "Login with GitHub Copilot",
                fields: [
                  {
                    key: "deploymentType",
                    title: "Select GitHub deployment type",
                    required: true,
                    placeholder: null,
                    options: [
                      { value: "github.com", label: "GitHub.com", description: "Public" },
                      { value: "enterprise", label: "GitHub Enterprise", description: null },
                    ],
                    whenEquals: [],
                  },
                ],
              },
            ],
            connections: [],
            needsSignIn: false,
          },
        ],
      }),
    );
    const html = render();
    assert.ok(html.includes("Login with GitHub Copilot"));
    assert.ok(!html.includes("Select GitHub deployment type"), "the form waits for the click");
  });
});
