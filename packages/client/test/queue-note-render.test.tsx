import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { Note } from "../src/components/queue-toaster.js";
import type { QueueNote } from "../src/components/queue-note.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The notification's rendered shape against design turn 79: two lines, a third only for a reason,
 * one action and one dismiss. The CSS that gives these classes their bands lives in toast.css and
 * is asserted separately by the token tests.
 */

const base: QueueNote = {
  id: "queue:01J8F3K2QW9VZX4N7M0RTYB6HC",
  tone: "queued",
  title: "Scene 11, 4 shots",
  meta: "Seedance 2.0 · ~$5.46 · 4 queued",
  action: { label: "Activity", to: "/activity" },
};

const html = (note: QueueNote) =>
  renderToString(<Note note={note} onAct={() => {}} onDismiss={() => {}} />);

describe("the queue notification renders", () => {
  it("says the work in two lines and offers one way on", () => {
    const out = html(base);
    assert.match(out, /class="fy-note fy-note--queued"/);
    assert.match(out, /class="fy-note__title">Scene 11, 4 shots</);
    assert.match(out, /class="fy-note__meta">Seedance 2\.0 · ~\$5\.46 · 4 queued</);
    // No third band without a reason, and exactly one action beside the dismiss.
    assert.doesNotMatch(out, /fy-note__reason/);
    assert.equal(out.match(/class="ui-btn/g)?.length, 1);
    assert.equal(out.match(/fy-note__close/g)?.length, 1);
  });

  it("carries a refusal's reason as its own band", () => {
    const out = html({
      ...base,
      tone: "refused",
      title: "Nothing was queued",
      meta: "nothing spent",
      reason: "FAL rejected the key (HTTP 401). 4 shots held.",
      action: { label: "Providers", to: "/settings/providers" },
    });
    assert.match(out, /class="fy-note fy-note--refused"/);
    assert.match(out, /class="fy-note__reason">FAL rejected the key \(HTTP 401\)\. 4 shots held\.</);
    assert.match(out, /Providers</);
  });

  it("drops the action entirely when there is nowhere to go", () => {
    const out = html({ ...base, tone: "refused", action: undefined, reason: "The file is 8.4 MB; the ceiling is 6 MB." });
    assert.doesNotMatch(out, /class="ui-btn/);
    // The dismiss survives — it is how the notification is closed, not an action on the work.
    assert.match(out, /fy-note__close/);
  });

  it("pulses the dot only while something is running", () => {
    assert.doesNotMatch(html(base), /fy-note__dot--live/);
    assert.match(html({ ...base, live: true }), /fy-note__dot--live/);
  });

  it("shows the picture that came back, and keeps the dot when the world is not open", () => {
    const thumb = { worldId: FIXTURE_STATE.world!.meta.worldId, path: "references/maren-kest/sheet.png" };
    __setStateForTest(FIXTURE_STATE);
    const shown = html({ ...base, tone: "back", thumb });
    assert.match(shown, /class="fy-note__thumb"/);
    assert.doesNotMatch(shown, /fy-note__dot/);

    // A job from a world this session has not opened has no slug to build a URL from, so the
    // notification keeps the dot rather than pointing at a path that would 404.
    const elsewhere = html({ ...base, tone: "back", thumb: { ...thumb, worldId: "01J0000000000000000000000X" } });
    assert.doesNotMatch(elsewhere, /fy-note__thumb/);
    assert.match(elsewhere, /class="fy-note__dot"/);
  });
});
