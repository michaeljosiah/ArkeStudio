import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, LedgerEntry } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { FreePlanStop } from "../src/components/free-plan-stop.js";
import { ReadAloudConfirmation } from "../src/components/read-aloud-confirmation.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A provider's Free plan (design turn 182): the Plan row on Google's and Mistral's panes, and
 * the two ways a free plan ends as a read says them. Labels only on screen.
 */

const plain = (html: string): string => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const pane = (provider: string) => {
  const html = renderToString(
    <MemoryRouter initialEntries={[`/settings/providers?provider=${provider}`]}>
      <App />
    </MemoryRouter>,
  );
  return html.slice(html.indexOf('data-testid="provider-pane"'));
};
const withPlans = (plans: Partial<ClientState["app"]["providerPlans"]>, ledger: LedgerEntry[] = []): ClientState => ({
  ...FIXTURE_STATE,
  app: {
    ...FIXTURE_STATE.app,
    providerPlans: { ...FIXTURE_STATE.app.providerPlans, ...plans },
    ledger,
    providers: [
      { id: "google", configured: true, validation: "valid", probes: [], fault: null, lastValidated: "2026-10-02T09:14:00.000Z" },
      { id: "mistral", configured: true, validation: "valid", probes: [], fault: null, lastValidated: "2026-10-02T09:14:00.000Z" },
    ],
  },
});

describe("the Plan row (design turn 182)", () => {
  it("is on Google's pane as Paid · Free, paid by default, with nothing under it", () => {
    __setStateForTest(withPlans({}));
    const html = pane("google");
    assert.match(html, /role="radiogroup" aria-label="Google plan"/);
    assert.match(html, /role="radio" aria-checked="true"[^>]*>Paid</);
    assert.match(html, /role="radio" aria-checked="false"[^>]*>Free</);
    assert.ok(!html.includes('data-testid="plan-under"'));
  });

  it("says under Free what it covers, leaves priced, how it ends and what Google may do", () => {
    __setStateForTest(withPlans({ google: "free" }));
    const text = plain(pane("google"));
    assert.match(text, /voices free · Gemini Flash TTS · Flash-Lite TTS/);
    assert.match(text, /voice design priced · daily limit · resets 00:00 PT/);
    assert.match(text, /may train Google models · billing linked = paid/);
  });

  it("shows a billed Free key as billed, with the author's way to say Free again", () => {
    __setStateForTest(withPlans({ google: "free", googleBilledAt: "2026-10-02T09:14:00.000Z" }));
    const html = pane("google");
    assert.match(plain(html), /key looks paid · reads priced/);
    assert.match(html, /Keep Free/);
    assert.match(html, /role="radio" aria-checked="true"[^>]*>Free</, "the switch stays where the author put it");
  });

  it("is on Mistral's pane as Paid · Free credit, with the month drawn against $10", () => {
    const draw = (ts: string, microUsd: number, characters: number): LedgerEntry => ({
      ts, worldId: "01K0000000000000000000000W", jobId: `jb_01K0000000000000000000${String(characters).padStart(4, "0")}`, provider: "mistral", model: "voxtral-mini-tts",
      outcome: "succeeded", estimatedMicroUsd: microUsd, actualMicroUsd: microUsd, actualSource: "free-credit",
      speechQuote: { model: "voxtral-mini-tts", provider: "mistral", quotedAt: ts, validUntil: null, tier: "standard", rateVersion: "character:16", unit: "character",
        quantities: { characters }, assumptions: [], expectedMicroUsd: microUsd, authorisedMicroUsd: microUsd, plan: "free-credit" },
    });
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1, 12).toISOString();
    __setStateForTest(withPlans({ mistral: "free-credit" }, [draw(thisMonth, 3_000_000, 200_000), draw(thisMonth, 420_000, 14_000)]));
    const text = plain(pane("mistral"));
    assert.match(text, /Paid Free credit/);
    assert.match(text, /\$10 a month · Voxtral reads drawn from it · estimate kept/);
    assert.match(text, /This month \$3\.42 of \$10 credit · 214k characters/);
  });

  it("is absent from a provider without a free tier", () => {
    __setStateForTest(withPlans({}));
    assert.ok(!pane("fal").includes('aria-label="Plan"'));
    assert.ok(!pane("fal").includes("plan</"));
  });
});

describe("the two ways a free plan ends, on the read", () => {
  it("says the day's limit with when it resets, and offers the shipped narrator", () => {
    const text = plain(renderToString(<FreePlanStop error="Google free limit reached" onDefaultNarrator={() => {}} />));
    assert.match(text, /Google free limit reached · resets 00:00 PT · \d+ h \d+ m|Google free limit reached · resets 00:00 PT · \d+ m/);
    assert.match(text, /Read with George/);
  });

  // 2026-10-02: Google's refusal said "retry in 45m28s" at 23:14 UTC — 17:00 Pacific, not midnight.
  it("says the limit and the reset Google named, when it named them", () => {
    const reset = new Date(Date.now() + 45 * 60_000).toISOString();
    const text = plain(renderToString(<FreePlanStop error={`Google free limit reached · 10 a day · resets ${reset}`} onDefaultNarrator={() => {}} />));
    assert.match(text, /Google free limit reached · 10 a day · resets \d\d:\d\d PT · 4[56] m/);
    assert.ok(!text.includes(reset), "the instant is read, never shown");
  });

  it("asks before a read the free day cannot cover, in reads rather than a price", () => {
    __setStateForTest(withPlans({ google: "free" }));
    const text = plain(renderToString(
      <ReadAloudConfirmation inline title="Maren Kest" onConfirm={() => {}} onCancel={() => {}} result={{
        at: "2026-10-02T23:14:00.000Z", type: "voice.audio", requestId: "01J8F3K2QW9VZX4N7M0RTYB6R1", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", sheetVersion: 1, purpose: "prose",
        provider: "google", model: "gemini-3.8-flash-tts", voiceId: "Kore", format: "wav", status: "confirmation-required", file: null, cached: false,
        characterCount: 48_000, estimatedMicroUsd: 0, confirmationToken: "token", freePlan: { requests: 122, allowed: 10, left: 10 },
      }} />,
    ));
    assert.match(text, /122 reads · free plan allows 10 a day/);
    assert.match(text, /Read 10 now/);
    assert.ok(!text.includes("Confirm 48"), "no price to confirm");
  });

  it("says a billed read and offers to turn the plan off — never turning it off itself", () => {
    const text = plain(renderToString(<FreePlanStop error="Google billed this read · key looks paid" />));
    assert.match(text, /Google billed this read · key looks paid/);
    assert.match(text, /Turn off Free plan/);
  });

  it("says nothing for any other failure", () => {
    assert.equal(renderToString(<FreePlanStop error="Voice synthesis failed. Open Activity for details." />), "");
  });
});
