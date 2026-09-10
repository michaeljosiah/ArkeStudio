import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { parseHTML } from "linkedom";
import {
  activityJobLabels,
  computeNeedsYou,
  computeRunning,
  orderedShots,
  type ClientMessage,
  type ClientState,
  type FoundingBuildState,
  type Job,
  type LedgerEntry,
} from "@arke-studio/contracts";
import { ActivityRoute } from "../src/App.js";
import { AppChrome } from "../src/components/chrome.js";
import { ActivityPanel } from "../src/components/activity-panel.js";
import {
  __resetActivityPanelForTest,
  leaveProviderCalls,
  openActivityPanel,
  showActivityTab,
  type ActivityTab,
} from "../src/lib/activity-panel.js";
import { __setReleasesForTest } from "../src/lib/releases.js";
import type { ReleaseCard } from "../src/lib/release-notes.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * Activity as a panel (design turn 136; SPEC-014 R-20–R-27). The page's own tests moved here
 * with the page's rows: the compact actions and the two-press delete (issue 1010), the recovery
 * route under a failed job (issue 226), names that never borrow another world's entities
 * (issue 1005), spend under the panel's scope (issue 305 §8) and a failed ledger read said
 * plainly (SPEC-032 R-13). What is new is the panel itself: the tabs and where it opens, the
 * bell's two dots, the spend alert as a queue entry, the two remembered facts, and the release
 * cards the build carries.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Element: dom.Element,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const TODAY = `${new Date().toISOString().slice(0, 10)}T09:14:00Z`;
const YESTERDAY = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();

function job(overrides: Partial<Job>): Job {
  return {
    id: "jb_01J8E0000000000000000000L1",
    idempotencyKey: "01J8E1000000000000000000M1",
    worldId: FIXTURE_WORLD_ID,
    target: { kind: "character-look", id: "maren-kest/msm7pzlb/1" },
    capability: "image",
    provider: "openai",
    model: "gpt-image-2",
    params: {},
    estimatedMicroUsd: 150000,
    status: "failed",
    providerJobId: null,
    attempt: 1,
    error: "openai: image generation failed (HTTP 400)",
    createdAt: TODAY,
    updatedAt: TODAY,
    ...overrides,
  };
}

const card = (version: string, title: string, date: string, paragraphs = ["One paragraph."]): ReleaseCard => ({
  version,
  tag: `v${version}`,
  title,
  date,
  paragraphs,
  picture: null,
});

/** A world with nothing to decide: no proposals, no takes waiting, no jobs, no alert, no counts. */
function quiet(): ClientState {
  const base = structuredClone(FIXTURE_STATE);
  const world = base.world!;
  return {
    ...base,
    app: {
      ...base.app,
      jobs: [],
      queues: base.app.queues.map((queue) => ({ ...queue, paused: false, held: 0 })),
      spend: base.app.spend ? { ...base.app.spend, alerted: false } : null,
      builds: [],
    },
    worlds: base.worlds.map((summary) => ({ ...summary, attention: undefined })),
    world: {
      ...world,
      proposals: [],
      referenceTakes: [],
      externalEdits: [],
      artifacts: (world.artifacts ?? []).map((artifact) => ({ ...artifact, extraction: undefined })),
      productions: world.productions.map((production) => ({ ...production, takes: [] })),
    },
  };
}

function withState(state: ClientState): void {
  __setStateForTest(state);
  __resetActivityPanelForTest();
}

function render(state: ClientState, tab: ActivityTab): string {
  withState(state);
  openActivityPanel(tab);
  // Server rendering splits a sentence at every interpolation with a comment marker, and
  // escapes the apostrophe. Neither is on screen.
  return renderToString(
    <MemoryRouter>
      <ActivityPanel />
    </MemoryRouter>,
  )
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'");
}

function activityControl(html: string): string {
  const label = html.indexOf('aria-label="Activity"');
  assert.ok(label > 0, "the bell is drawn");
  return html.slice(html.lastIndexOf("<button", label), html.indexOf("</button>", label));
}

async function mounted(node: React.ReactNode, run: (container: HTMLElement) => Promise<void>): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(node));
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    __setBridgeForTest(null);
    __setStateForTest(FIXTURE_STATE);
    __setReleasesForTest(null);
    __resetActivityPanelForTest();
  }
}

function capture(): ClientMessage[] {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({
    appVersion: "test",
    platform: "test",
    connect() {},
    subscribe() {},
    send(json: string) {
      sent.push(JSON.parse(json));
    },
  });
  return sent;
}

describe("the panel and its tabs (design turn 136, R-20, R-21)", () => {
  it("orders the tabs What's new, Inbox, Spend, and counts on the labels", () => {
    const html = render(FIXTURE_STATE, "inbox");
    const tabs = [...parseHTML(html).document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent!.trim());
    assert.equal(tabs.length, 3);
    assert.match(tabs[0]!, /^What's new/);
    assert.match(tabs[1]!, /^Inbox · \d+$/, "the Inbox label carries the needs-you count");
    assert.equal(tabs[2], "Spend", "Spend carries no count");
    __setStateForTest(FIXTURE_STATE);
  });

  it("opens on Inbox while something needs you, and on What's new otherwise", async () => {
    assert.ok(computeNeedsYou(FIXTURE_STATE).length > 0, "the fixture has something waiting");
    withState(FIXTURE_STATE);
    await mounted(
      <MemoryRouter>
        <AppChrome />
        <ActivityPanel />
      </MemoryRouter>,
      async (container) => {
        const bell = container.querySelector<HTMLButtonElement>('button[aria-label="Activity"]')!;
        await act(async () => bell.click());
        assert.equal(container.querySelector(".fy-ap")?.getAttribute("data-tab"), "inbox");
        await act(async () => bell.click());
        assert.equal(container.querySelector(".fy-ap"), null, "the bell pressed again closes it");
      },
    );
    const nothing = quiet();
    assert.equal(computeNeedsYou(nothing).length, 0, "and this one has nothing waiting");
    withState(nothing);
    await mounted(
      <MemoryRouter>
        <AppChrome />
        <ActivityPanel />
      </MemoryRouter>,
      async (container) => {
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Activity"]')!.click());
        assert.equal(container.querySelector(".fy-ap")?.getAttribute("data-tab"), "new");
      },
    );
  });

  it("the retired route lands on Home with the panel open on the Inbox", async () => {
    withState(FIXTURE_STATE);
    await mounted(
      <MemoryRouter initialEntries={["/activity"]}>
        <Routes>
          <Route path="/activity" element={<ActivityRoute />} />
          <Route path="/worlds" element={<div data-testid="home" />} />
        </Routes>
        <ActivityPanel />
      </MemoryRouter>,
      async (container) => {
        assert.ok(container.querySelector('[data-testid="home"]'), "Home is behind it");
        assert.equal(container.querySelector(".fy-ap")?.getAttribute("data-tab"), "inbox");
      },
    );
  });

  it("closes on Escape", async () => {
    withState(FIXTURE_STATE);
    openActivityPanel("inbox");
    await mounted(
      <MemoryRouter>
        <ActivityPanel />
      </MemoryRouter>,
      async (container) => {
        assert.ok(container.querySelector(".fy-ap"));
        const escape = new dom.window.Event("keydown", { bubbles: true });
        Object.defineProperty(escape, "key", { value: "Escape" });
        await act(async () => window.dispatchEvent(escape));
        assert.equal(container.querySelector(".fy-ap"), null);
      },
    );
  });
});

describe("the bell's two dots (R-24)", () => {
  const chrome = () =>
    renderToString(
      <MemoryRouter>
        <AppChrome />
      </MemoryRouter>,
    );

  it("wears the warning dot while something needs you", () => {
    withState(FIXTURE_STATE);
    const control = activityControl(chrome());
    assert.ok(control.includes("fy-iconbtn__dot"), "lit");
    assert.equal(control.includes("fy-iconbtn__dot--new"), false, "warning, not news");
    assert.ok(control.includes("Activity — something needs you"));
  });

  it("wears the foreground dot for work that came back since the Inbox was last opened", () => {
    const state = quiet();
    state.app.jobs = [job({ status: "succeeded", error: null, updatedAt: TODAY })];
    state.app.activitySeen = { inboxSeenAt: null, whatsNewSeenVersion: null };
    withState(state);
    assert.ok(activityControl(chrome()).includes("fy-iconbtn__dot--new"), "never looked: any history is news");
    state.app.activitySeen = { inboxSeenAt: new Date(Date.parse(TODAY) + 60_000).toISOString(), whatsNewSeenVersion: null };
    withState(state);
    const seen = activityControl(chrome());
    assert.equal(seen.includes("fy-iconbtn__dot"), false, "looked after it came back: quiet");
    assert.ok(seen.includes('title="Activity"'));
  });

  it("wears the foreground dot for an update the updater has found (codex P2, PR 1087)", () => {
    const state = quiet();
    state.app.activitySeen = { inboxSeenAt: TODAY, whatsNewSeenVersion: "0.5.49" };
    state.app.update = { status: "available", targetVersion: "0.5.50", progressPercent: null, flow: null, detail: null, releaseName: null, releaseNotes: null };
    withState(state);
    assert.ok(activityControl(chrome()).includes("fy-iconbtn__dot--new"), "a release you do not have yet is unread");
    state.app.update = { ...state.app.update, status: "none", targetVersion: null };
    withState(state);
    assert.equal(activityControl(chrome()).includes("fy-iconbtn__dot"), false);
    __setStateForTest(FIXTURE_STATE);
  });

  it("wears the foreground dot for a release not yet read, and clears once it is", () => {
    __setReleasesForTest([card("0.5.47", "A world remembers why it was made", "2026-08-23")]);
    const state = quiet();
    state.app.activitySeen = { inboxSeenAt: TODAY, whatsNewSeenVersion: "0.5.41" };
    withState(state);
    const unread = activityControl(chrome());
    assert.ok(unread.includes("fy-iconbtn__dot--new"));
    assert.ok(unread.includes("Activity — something new"));
    state.app.activitySeen = { inboxSeenAt: TODAY, whatsNewSeenVersion: "0.5.47" };
    withState(state);
    assert.equal(activityControl(chrome()).includes("fy-iconbtn__dot"), false);
    __setReleasesForTest(null);
    __setStateForTest(FIXTURE_STATE);
  });
});

describe("the two remembered facts (R-25)", () => {
  it("opening the Inbox stamps the instant; reading What's new stamps the newest bundled version", async () => {
    __setReleasesForTest([card("0.5.47", "Newest", "2026-08-23"), card("0.5.41", "Older", "2026-08-22")]);
    withState(quiet());
    const sent = capture();
    openActivityPanel("inbox");
    await mounted(
      <MemoryRouter>
        <ActivityPanel />
      </MemoryRouter>,
      async () => {
        assert.ok(sent.some((m) => m.kind === "mark-inbox-seen"), "the Inbox was looked at");
        assert.equal(sent.some((m) => m.kind === "mark-whats-new-seen"), false, "What's new was not");
        await act(async () => showActivityTab("new"));
        assert.ok(sent.some((m) => m.kind === "mark-whats-new-seen" && m.version === "0.5.47"));
      },
    );
  });

  it("does not stamp a version already read", async () => {
    __setReleasesForTest([card("0.5.47", "Newest", "2026-08-23")]);
    const state = quiet();
    state.app.activitySeen = { inboxSeenAt: TODAY, whatsNewSeenVersion: "0.5.47" };
    withState(state);
    const sent = capture();
    openActivityPanel("new");
    await mounted(
      <MemoryRouter>
        <ActivityPanel />
      </MemoryRouter>,
      async () => {
        assert.equal(sent.some((m) => m.kind === "mark-whats-new-seen"), false);
      },
    );
  });
});

describe("What's new (R-26)", () => {
  it("lists the bundled cards newest first, with the waiting update on top and its own controls", () => {
    __setReleasesForTest([
      card("0.5.41", "The conversation is the workspace", "2026-08-22"),
      card("0.5.47", "A world remembers why it was made", "2026-08-23", ["First.", "Second.", "Third."]),
    ]);
    const state = quiet();
    state.app.update = {
      status: "available",
      targetVersion: "0.5.50",
      progressPercent: null,
      flow: null,
      detail: null,
      releaseName: "v0.5.50 — the cut hears itself",
      releaseNotes: "The Cut plays its own audio back.\n\nAnd more.",
    };
    const html = render(state, "new");
    const at = (needle: string) => {
      const index = html.indexOf(needle);
      assert.ok(index >= 0, needle);
      return index;
    };
    assert.ok(at("Available") < at("the cut hears itself"), "the update leads");
    assert.equal(html.includes("v0.5.50 · v0.5.50"), false, "the release name does not repeat the version");
    assert.ok(html.includes("The Cut plays its own audio back."));
    assert.ok(html.includes(">Download<"), "the update's own control is on its card");
    assert.ok(at("the cut hears itself") < at("A world remembers why it was made"), "then the newest card");
    assert.ok(at("A world remembers why it was made") < at("The conversation is the workspace"), "then the one before");
    assert.ok(html.includes("Read all · 2 more"), "a long card shows its first paragraph and counts the rest");
    assert.ok(html.includes("/releases/tag/v0.5.47"), "GitHub is the release page");
    __setReleasesForTest(null);
    __setStateForTest(FIXTURE_STATE);
  });

  it("carries no scope line — releases have no world", () => {
    __setReleasesForTest([card("0.5.47", "Newest", "2026-08-23")]);
    const html = render(FIXTURE_STATE, "new");
    assert.equal(html.includes("all worlds"), false);
    __setReleasesForTest(null);
    __setStateForTest(FIXTURE_STATE);
  });
});

describe("the spend alert is a queue entry (R-23)", () => {
  it("is an Inbox row whose one action opens Spend, and leaves when the status clears", async () => {
    const state = quiet();
    state.app.spend = {
      settings: { thresholdMicroUsd: 50_000_000, periodDays: 7 },
      rollingMicroUsd: 62_100_000,
      alerted: true,
      ledgerUnavailable: false,
    };
    const [entry] = computeNeedsYou(state);
    assert.equal(entry?.kind, "spend-over-threshold");
    assert.equal(entry?.urgency, 2, "beside blocked work, not above it");
    assert.deepEqual(entry?.actions, ["spend"]);
    const html = render(state, "inbox");
    assert.ok(html.includes("Over the spend alert"));
    assert.ok(html.includes("nothing is blocked"));
    withState(state);
    openActivityPanel("inbox");
    await mounted(
      <MemoryRouter>
        <ActivityPanel />
      </MemoryRouter>,
      async (container) => {
        const spend = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Spend");
        assert.ok(spend);
        await act(async () => spend.click());
        assert.equal(container.querySelector(".fy-ap")?.getAttribute("data-tab"), "spend");
      },
    );
    state.app.spend = { ...state.app.spend, alerted: false, rollingMicroUsd: 1_000_000 };
    assert.equal(computeNeedsYou(state).length, 0, "derived: it leaves with the status, never by dismissal");
    __setStateForTest(FIXTURE_STATE);
  });

  it("an off threshold never alerts", () => {
    const state = quiet();
    state.app.spend = { settings: { thresholdMicroUsd: 0, periodDays: 7 }, rollingMicroUsd: 99, alerted: true, ledgerUnavailable: false };
    assert.equal(computeNeedsYou(state).length, 0);
  });
});

describe("the Inbox's order and its history (R-22)", () => {
  it("groups finished work by day and keeps the settled line when nothing runs or waits", () => {
    const state = quiet();
    state.app.jobs = [
      job({ id: "jb_01J8E0000000000000000000L2", status: "succeeded", error: null, updatedAt: TODAY }),
      job({ id: "jb_01J8E0000000000000000000L3", status: "succeeded", error: null, updatedAt: YESTERDAY, createdAt: YESTERDAY }),
    ];
    const html = render(state, "inbox");
    assert.ok(html.includes("Nothing running, nothing waiting on you"));
    assert.ok(html.indexOf("today") < html.indexOf("yesterday"), "newest day first");
    assert.ok(html.includes("last 7 days"));
    __setStateForTest(FIXTURE_STATE);
  });

  it("puts Needs you before Running", () => {
    const state = structuredClone(FIXTURE_STATE);
    state.app.jobs = [job({ status: "running", error: null })];
    const html = render(state, "inbox");
    assert.ok(html.indexOf("Needs you") < html.indexOf("Running"), "opened to act, not to watch");
    __setStateForTest(FIXTURE_STATE);
  });
});

describe("the compact job actions and the two-press delete (issue 1010)", () => {
  it("keeps inspection and the two-step deletion behind the compact job actions", async () => {
    const done = job({ status: "succeeded", error: null, target: { kind: "character-look", id: "maren-kest/look/1" } });
    const running = job({ ...done, id: "jb_01J8E0000000000000000000L2", status: "running" });
    withState({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, jobs: [running, done] } });
    const sent = capture();
    openActivityPanel("inbox");
    await mounted(
      <MemoryRouter>
        <ActivityPanel />
      </MemoryRouter>,
      async (container) => {
        const button = (label: string) => {
          const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
            (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
          );
          assert.ok(found, label);
          return found;
        };
        const inspections = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Provider calls"]')];
        assert.equal(inspections().length, 2, "running and completed jobs offer the same action");
        await act(async () => inspections()[0]!.click());
        assert.ok(sent.some((m) => m.kind === "list-provider-calls" && m.jobId === running.id));
        assert.ok(container.querySelector(".fy-ap__back"), "the calls take the body's place, with the way back in the header");
        await act(async () => leaveProviderCalls());
        const inspect = inspections()[1]!;
        assert.equal(inspect.getAttribute("data-tip"), "Provider calls");
        assert.ok(inspect.closest(".fy-ap__row"));
        await act(async () => inspect.click());
        assert.ok(sent.some((m) => m.kind === "list-provider-calls" && m.jobId === done.id));
        await act(async () => leaveProviderCalls());
        await act(async () => button("Delete").click());
        assert.ok(!sent.some((m) => m.kind === "delete-job"), "the icon only opens confirmation");
        assert.match(container.textContent!, /ledger entry and anything it produced stay/);
        await act(async () => button("Keep").click());
        assert.ok(!sent.some((m) => m.kind === "delete-job"), "cancelling sends nothing");
        await act(async () => button("Delete").click());
        await act(async () => button("Delete").click());
        assert.equal(sent.filter((m) => m.kind === "delete-job" && m.jobId === done.id).length, 1);
      },
    );
  });
});

describe("a failed job's recovery route on the row (issue 226)", () => {
  const rows = (jobs: Job[]) => render({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, jobs } }, "inbox");

  it("names work and models consistently without borrowing another world's entities (issue 1005)", () => {
    const state = structuredClone(FIXTURE_STATE);
    const production = state.world!.productions[0]!;
    const model = state.app.manifest!.models[0]!;
    const sessionId = "sess_01J8F3K2QW9VZX4N7M0RTYB6HZ";
    state.world!.benchSessions.push({ id: sessionId, title: "A storm over the harbour", mode: "image", updatedAt: TODAY, takeCount: 1, runningCount: 1, failedCount: 0, waitingCount: 0 });
    const bench = job({ target: { kind: "bench-take", id: `${sessionId}/tk_opaque` }, provider: model.provider, model: model.id, status: "running", error: null });
    state.app.jobs = [bench];
    assert.match(computeRunning(state)[0]!.title, /A storm over the harbour/);
    // A job's row is the one whose diagnostic names it; the needs-you rows above carry none.
    const rowOf = (html: string, id: string) =>
      [...parseHTML(html).document.querySelectorAll(".fy-ap__row")].find((row) =>
        row.querySelector(".fy-ap__rowtitle")?.getAttribute("title")?.includes(id),
      )!;
    const runningTitle = rowOf(render(state, "inbox"), bench.id).querySelector(".fy-ap__rowtitle")!;
    assert.ok(runningTitle.getAttribute("title")!.includes(bench.target.id!));
    assert.ok(runningTitle.getAttribute("title")!.includes(`${model.provider}/${model.id}`));
    const master = job({ target: { kind: "master-look", id: FIXTURE_WORLD_ID }, provider: model.provider, model: model.id });
    state.app.jobs = [master];
    const text = rowOf(render(state, "inbox"), master.id).textContent!;
    assert.match(text, /Master look/);
    assert.ok(text.includes("The Undersong"), "the place rides on the row (R-19)");
    assert.ok(text.includes(model.displayName));
    assert.ok(!text.includes(FIXTURE_WORLD_ID));
    const shot = job({ productionId: production.meta.id, target: { kind: "shot", id: orderedShots(production.scenes[0]!)[0]!.id } });
    assert.ok(activityJobLabels(state, shot).place.includes(production.meta.title));
    assert.ok(activityJobLabels(state, shot).place.includes(state.world!.meta.name));
    const other = { ...shot, worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD" };
    assert.ok(!activityJobLabels(state, other).place.includes(production.meta.title));
    __setStateForTest(FIXTURE_STATE);
  });

  it("sends a failed character look to the looks screen, not to a production it does not have", () => {
    const html = rows([job({})]);
    assert.ok(html.includes("run it again from the looks screen"), "the row names where this one came from");
    assert.equal(html.includes("production's dispatch dialog"), false);
  });

  it("still sends production work to its production's dispatch dialog", () => {
    const html = rows([job({ productionId: "saltlight", target: { kind: "shot", id: "sh_12", coversShots: ["sh_12"] } })]);
    assert.ok(html.includes("run it again from its production's dispatch dialog"));
  });

  it("offers the destination as a control, so the row is not a dead end", () => {
    for (const [failed, label] of [
      [job({}), "Looks"],
      [job({ target: { kind: "main-photo-candidate", id: "maren-kest/g/2" } }), "Main photo"],
      [job({ target: { kind: "character-sheet", id: "maren-kest/g" } }), "Character sheet"],
    ] as const) {
      assert.ok(rows([failed]).includes(`>${label}</button>`), `${label} is a button on the row`);
    }
  });

  it("says nothing about where rather than naming somewhere wrong", () => {
    const html = rows([job({ target: { kind: "extraction", id: "af_1" } })]);
    assert.ok(html.includes("run it again from wherever you started it"));
    assert.equal(html.includes("dispatch dialog"), false);
  });

  it("leaves succeeded work alone — a retry line belongs to a failure", () => {
    assert.equal(rows([job({ status: "succeeded", error: null })]).includes("run it again"), false);
    __setStateForTest(FIXTURE_STATE);
  });
});

describe("spend obeys the panel's scope (issue 305 §8)", () => {
  const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const OTHER_WORLD_ID = "01J8E9000000000000000000W2";
  const GENESIS_ID = "gen-undersong";
  const OTHER_GENESIS_ID = "gen-elsewhere";
  const BUILD: FoundingBuildState = {
    buildId: "fb_01J8E0000000000000000000B1",
    worldId: FIXTURE_WORLD_ID,
    genesisId: GENESIS_ID,
    worldName: "The Undersong",
    status: "completed",
    stages: (["understanding", "shaping", "creating", "forging", "finalizing"] as const).map((id) => ({ id, label: id, state: "complete" as const })),
    progress: { terminal: 1, authorized: 1 },
    working: [],
    items: [],
    shortfall: null,
    noticeDismissed: true,
    capMicroUsd: 5_000_000,
    estimatedSpendMicroUsd: 1_000_000,
  };
  const entry = (overrides: Partial<LedgerEntry>): LedgerEntry => ({
    ts: RECENT,
    worldId: FIXTURE_WORLD_ID,
    jobId: "jb_01J8E0000000000000000000K1",
    provider: "fal",
    model: "seedance-2.0",
    outcome: "succeeded",
    estimatedMicroUsd: 250_000,
    actualMicroUsd: 250_000,
    actualSource: "provider-reported",
    ...overrides,
  });
  const spend = (ledger: LedgerEntry[], extra: Partial<ClientState["app"]> = { builds: [BUILD] }) =>
    render({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, ledger, ...extra } }, "spend");

  it("counts the active world's entries and leaves another world's money out of the total", () => {
    const html = spend([
      entry({ actualMicroUsd: 250_000 }),
      entry({ jobId: "jb_01J8E0000000000000000000K2", worldId: OTHER_WORLD_ID, provider: "openai", model: "gpt-image-2", actualMicroUsd: 4_000_000 }),
    ]);
    assert.ok(html.includes("$0.25"), "the total is this world's $0.25");
    assert.equal(html.includes("$4.25"), false);
    assert.equal(html.includes("openai"), false, "the other world's provider is not a bar on this world's spend");
  });

  it("counts a bench take, which is world-owned without belonging to a production", () => {
    assert.ok(spend([entry({ productionId: undefined, actualMicroUsd: 250_000 })]).includes("$0.25"));
  });

  it("shows nothing spent when this world's work is all in another world's ledger", () => {
    assert.ok(spend([entry({ worldId: OTHER_WORLD_ID, actualMicroUsd: 4_000_000 })]).includes("$0.00"));
  });

  it("counts the founding preview this world was made from, which the ledger holds under its genesis", () => {
    const html = spend([entry({ actualMicroUsd: 250_000 }), entry({ jobId: "jb_01J8E0000000000000000000K3", worldId: GENESIS_ID, actualMicroUsd: 1_000_000 })]);
    assert.ok(html.includes("$1.25"));
  });

  it("does not claim another world's founding preview", () => {
    assert.ok(spend([entry({ jobId: "jb_01J8E0000000000000000000K4", worldId: OTHER_GENESIS_ID, actualMicroUsd: 1_000_000 })]).includes("$0.00"));
  });

  it("keeps the founding preview through the world→genesis mapping once the build is forgotten (issue 531)", () => {
    const paid = entry({ jobId: "jb_01J8E0000000000000000000K3", worldId: GENESIS_ID, actualMicroUsd: 1_000_000 });
    assert.match(spend([paid], { builds: [], worldGenesis: { [FIXTURE_WORLD_ID]: GENESIS_ID } }), /\$1\.00/);
    const elsewhere = entry({ jobId: "jb_01J8E0000000000000000000K4", worldId: OTHER_GENESIS_ID, actualMicroUsd: 1_000_000 });
    assert.doesNotMatch(
      spend([elsewhere], { builds: [], worldGenesis: { [FIXTURE_WORLD_ID]: GENESIS_ID, [OTHER_WORLD_ID]: OTHER_GENESIS_ID } }),
      /\$1\.00/,
    );
    __setStateForTest(FIXTURE_STATE);
  });
});

describe("spend states a failed ledger read (SPEC-032 R-13)", () => {
  const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const entry = (): LedgerEntry => ({
    ts: RECENT,
    worldId: FIXTURE_WORLD_ID,
    jobId: "jb_01J8E0000000000000000000K1",
    provider: "fal",
    model: "seedance-2.0",
    outcome: "succeeded",
    estimatedMicroUsd: 250_000,
    actualMicroUsd: 250_000,
    actualSource: "provider-reported",
  });
  const unavailableSpend = (ledgerUnavailable: boolean) => ({
    settings: { thresholdMicroUsd: 50_000_000, periodDays: 7 },
    rollingMicroUsd: 0,
    alerted: false,
    ledgerUnavailable,
  });
  const spend = (over: Partial<ClientState["app"]>) => render({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, ...over } }, "spend");

  it("an unreadable ledger caveats the total and the alert row", () => {
    const html = spend({ ledger: [], ledgerUnavailable: true, spend: unavailableSpend(true) });
    assert.ok(html.includes("ledger could not be read"));
    assert.equal(html.includes("provider-reported"), false);
    assert.ok(html.includes("not evaluated"));
  });

  it("a merely empty ledger renders exactly as before — absence is not failure", () => {
    const html = spend({ ledger: [], ledgerUnavailable: false, spend: unavailableSpend(false) });
    assert.ok(html.includes("$0.00"));
    assert.equal(html.includes("ledger could not be read"), false);
    assert.equal(html.includes("not evaluated"), false);
    assert.ok(html.includes("Alert at"));
  });

  it("entries appended after a failed seed keep their figure, under the caveat", () => {
    const html = spend({ ledger: [entry()], ledgerUnavailable: true, spend: unavailableSpend(true) });
    assert.ok(html.includes("$0.25"));
    assert.ok(html.includes("ledger could not be read"));
  });

  it("an off threshold stays off", () => {
    const html = spend({ ledger: [], ledgerUnavailable: true, spend: { ...unavailableSpend(true), settings: { thresholdMicroUsd: 0, periodDays: 7 } } });
    assert.ok(html.includes("· off"));
    assert.equal(html.includes("not evaluated"), false);
  });

  it("states a fired alert even when a later read failed", () => {
    const html = spend({ ledger: [], ledgerUnavailable: true, spend: { ...unavailableSpend(true), rollingMicroUsd: 60_000_000, alerted: true } });
    assert.ok(html.includes("Over the threshold"));
    assert.equal(html.includes("not evaluated"), false);
    __setStateForTest(FIXTURE_STATE);
  });
});
