import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ART_DIRECTION_PATH,
  newId,
  type CandidateId,
  type ConversationId,
  type MessageId,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { evaluateReadiness } from "../../src/world-chat/readiness.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { rejectPoint, savePoint, wrapUp, WrapUpError } from "../../src/world-chat/wrapup.js";
import { WorldStore } from "../../src/world/store.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";

/**
 * Turning a conversation into proposals (#70 §11.3).
 *
 * The tests worth their place are the refusals. Wrap-up is the moment a conversation stops being
 * talk, so what it declines to carry — and what it leaves untouched when it cannot finish — is
 * the whole promise that talking changes nothing until you say so.
 */

const AT = "2026-08-06T10:00:00Z";
const NOW = () => AT;

function candidate(over: Partial<WorldChangeCandidate> = {}): WorldChangeCandidate {
  return {
    id: newId("cand") as CandidateId,
    conversationId: newId("cv") as ConversationId,
    revision: 1,
    status: "live",
    settledness: "settled",
    classification: "canon.create",
    subject: { kind: "new", label: "The bells" },
    title: "Bells may pass sideways",
    rationale: "They said so.",
    sourceMessageIds: [],
    evidence: [
      {
        kind: "message",
        messageId: newId("msg") as MessageId,
        quote: "the bells pass sideways",
        start: 0,
        end: 23,
        purpose: "intent",
      },
    ],
    checks: {
      state: "complete",
      basedOnCanonRevision: 42,
      required: ["canon-search"],
      completed: ["canon-search"],
      consulted: [],
      likelyDuplicates: [],
      possibleAmendments: [],
      contradictionCandidates: [],
      explanation: "Nothing in the world looks like this already.",
    },
    createdAt: AT,
    updatedAt: AT,
    draft: { type: "lore", title: "The bells", statement: "The bells may pass sideways.", links: [] },
    ...over,
  } as WorldChangeCandidate;
}

async function world() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir);
  const gate = new ProposalManager(store);
  const conversationId = newId("cv") as ConversationId;
  /** The fixture world already ships a staged proposal, so only ours are interesting. */
  const ours = async () => (await gate.listOpen()).filter((p) => p.kind === "worldbuilding");
  const log = new WorldChatStore(conversationDir(dir, conversationId));
  await log.create(conversationId, AT);
  await log.append(
    { type: "conversation.created", title: "the bells", entryContext: { kind: "world" } },
    { at: AT },
  );
  return { dir, store, gate, conversationId, log, ours };
}

/** Put a completed turn carrying these propositions into the log. */
async function withCandidates(
  log: WorldChatStore,
  candidates: WorldChangeCandidate[],
): Promise<number> {
  const turnId = newId("turn");
  await log.append(
    {
      type: "turn.completed",
      message: {
        id: newId("msg") as MessageId,
        turnId,
        role: "studio",
        text: "Noted.",
        attachmentIds: [],
        createdAt: AT,
      },
      run: {
        id: newId("run"),
        turnId,
        basedOnConversationSeq: 1,
        status: "completed",
        adapter: "fake",
        harnessCleanup: "not-required",
        contextDigest: `sha256:${"a".repeat(64)}`,
        startedAt: AT,
        endedAt: AT,
      },
      receipts: [],
      candidates,
      groups: [],
      tombstones: [],
    },
    { at: AT },
  );
  // The number the panel is given, and so the number the client hands back — the last sequence,
  // not how many lines it took to reach it.
  const { events } = await log.read();
  return events[events.length - 1]!.seq;
}

function failsToMaterialise(): WorldChangeCandidate {
  return candidate({
    classification: "relationship.change",
    title: "Bray and somebody who is not here",
    draft: {
      from: { kind: "sheet", sheetId: "bray-half-hitch" },
      to: { kind: "sheet", sheetId: "nobody-at-all" },
      linkAction: "add",
      proseEdits: [
        {
          sheet: { kind: "sheet", sheetId: "nobody-at-all" },
          sectionHeading: "Relationships",
          body: "They have never met.",
          reason: "",
        },
      ],
    },
  } as Partial<WorldChangeCandidate>);
}

describe("what a conversation carries", () => {
  it("makes a proposal from a settled proposition", async () => {
    const w = await world();
    const seq = await withCandidates(w.log, [candidate()]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-1",
      expectedConversationSeq: seq,
      now: NOW,
    });

    assert.equal(result.proposalIds.length, 1);
    const staged = await w.ours();
    assert.equal(staged.length, 1);
    assert.equal(staged[0]!.kind, "worldbuilding");
    assert.match(staged[0]!.source, /^world-chat:cv_/);
    assert.equal(
      staged[0]!.worldChatOrigins?.[0]?.requestId,
      "req-1",
      "the proposal records which conversation and request produced it",
    );
    await w.store.close();
  });

  it("names what did not carry, rather than counting it", async () => {
    const w = await world();
    const maybe = candidate({ settledness: "tentative", title: "Whether the bells are whale bone" });
    const seq = await withCandidates(w.log, [candidate(), maybe]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-2",
      expectedConversationSeq: seq,
      now: NOW,
    });

    assert.equal(result.proposalIds.length, 1);
    assert.deepEqual(result.notCarried, [
      {
        candidateId: maybe.id,
        summary: "Whether the bells are whale bone",
        reason: "tentative",
      },
    ]);
    await w.store.close();
  });

  it("keeps a media idea out of the proposals and says it kept it", async () => {
    const w = await world();
    const idea = candidate({
      classification: "media.image-opportunity",
      title: "A picture of the lock",
      draft: {
        target: { kind: "world" },
        purpose: "world-key-art",
        brief: "The lock at slack water.",
        reason: "",
        dependencies: [],
      },
    } as Partial<WorldChangeCandidate>);
    const seq = await withCandidates(w.log, [candidate(), idea]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-3",
      expectedConversationSeq: seq,
      now: NOW,
    });

    assert.deepEqual(result.mediaIdeaIds, [idea.id], "the idea is retained, not lost and not proposed");
    assert.equal(result.proposalIds.length, 1);
    await w.store.close();
  });

  it("carries an open question as an open thread", async () => {
    const w = await world();
    const thread = candidate({
      classification: "canon.thread",
      settledness: "unresolved",
      title: "Who objects when the bells pass sideways?",
      draft: { title: "Objections", question: "Who objects?", consideredEntryIds: [] },
    } as Partial<WorldChangeCandidate>);
    const seq = await withCandidates(w.log, [thread]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-4",
      expectedConversationSeq: seq,
      now: NOW,
    });

    assert.equal(result.threadProposalIds.length, 1, "a question becomes a thread, through the gate");
    const staged = await w.ours();
    const content = await readFile(
      join(w.dir, ".proposals", staged[0]!.id, "canon", `${staged[0]!.reservedCanonIds[0]}.md`),
      "utf8",
    );
    assert.match(content, /status: open/, "and it is open, because it asserts nothing");
    await w.store.close();
  });

  /*
   * The world's look, changed by talking about it.
   *
   * Before this classification existed the nearest thing was canon.create, so "make it painterly"
   * became a Canon entry titled "Visual art direction" — accepted, applied, and read by nothing
   * that generates an image. The world looked exactly as it had. That is the failure worth a test:
   * not that a proposal appears, but that it writes the record generation actually reads.
   */
  it("changes the world look rather than writing a note about it", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const before = w.store.getBundle().artDirection;
    const seq = await withCandidates(w.log, [
      candidate({
        classification: "art-direction.change",
        title: "The world takes a painterly, hand-animated look",
        draft: { description: "Painterly and hand-animated: visible brushwork, dramatic key light." },
      } as Partial<WorldChangeCandidate>),
    ]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-look",
      expectedConversationSeq: seq,
      now: NOW,
    });

    assert.equal(result.proposalIds.length, 1);
    const staged = (await w.gate.listOpen()).find((p) => p.id === result.proposalIds[0]);
    assert.ok(staged);
    assert.equal(
      staged.kind,
      "art-direction",
      "the kind is what the gate computes the look's ripple from — staged as worldbuilding it would arrive as an unexplained file change",
    );
    assert.deepEqual(
      staged.targets.map((t) => t.path),
      ["art-direction/art-direction.json"],
      "and it writes the record every generation reads, not a canon entry about it",
    );

    const written = JSON.parse(
      await readFile(join(w.dir, ".proposals", staged.id, "art-direction/art-direction.json"), "utf8"),
    ) as { version: number; description: string; masterLook?: string; history: Array<{ version: number }> };
    assert.equal(written.version, before.version + 1);
    assert.match(written.description, /painterly/i);
    assert.equal(
      written.masterLook,
      undefined,
      "an image of the look being replaced is not an illustration of the one replacing it",
    );
    assert.ok(
      written.history.some((h) => h.version === before.version),
      "the look it replaces stays in history, because accepted takes are still pinned to it",
    );
  });
});

describe("what wrap-up refuses", () => {
  it("refuses when nothing is settled enough", async () => {
    const w = await world();
    const seq = await withCandidates(w.log, [candidate({ settledness: "tentative" })]);

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-5",
          expectedConversationSeq: seq,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "nothing-to-carry",
    );
    assert.deepEqual(await w.ours(), [], "and stages nothing");
    await w.store.close();
  });

  it("still wraps up a log an older race left with a repeated sequence number", async () => {
    const w = await world();
    // Closed by the sweep rather than at the end of the test: an open store holds the event loop,
    // so an assertion failing before the close hangs the file instead of reporting.
    closeOnCleanup(() => w.store.close());
    const seq = await withCandidates(w.log, [candidate()]);

    /*
     * Appends were once serialised per store instance rather than per conversation, so two that
     * overlapped read the same tail and wrote the same number. The damage outlives the race: from
     * then on the file holds one more record than its highest sequence, forever. Wrap-up compared
     * the count against the sequence the panel was shown, so every attempt on such a conversation
     * came back stale — a button that did nothing, with the reason only in a log file.
     *
     * Copied into a second conversation because this log was written by something else: appending
     * over the top of one this process has already written is a foreign write, and rightly caught.
     */
    const lines = (await readFile(w.log.eventsPath, "utf8")).split("\n").filter(Boolean);
    const damaged = lines.map((line) => JSON.parse(line) as { seq: number });
    damaged[damaged.length - 1]!.seq = damaged[damaged.length - 2]!.seq;

    const twin = newId("cv") as ConversationId;
    const twinLog = new WorldChatStore(conversationDir(w.dir, twin));
    await twinLog.create(twin, AT);
    await writeFile(twinLog.eventsPath, damaged.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const { events } = await twinLog.read();
    const lastSeq = events[events.length - 1]!.seq;
    assert.equal(lastSeq, seq - 1, "the repeat costs the log a number it never gets back");
    assert.equal(events.length, lastSeq + 1, "one more record than the highest sequence — the real shape");

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: twin,
      requestId: "req-repeated-seq",
      // What the panel showed, which is the last sequence and not the number of records.
      expectedConversationSeq: lastSeq,
      now: NOW,
    });

    assert.equal(result.proposalIds.length, 1);
  });

  /*
   * The second press, after a wrap-up that died between staging its proposals and recording how
   * it ended. Its propositions are still `live` — their status events are only appended once every
   * proposal is durable — so a second run would carry them again and stage a duplicate set beside
   * the ones already on disk.
   */
  it("refuses a second wrap-up while one is still unaccounted for", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    await withCandidates(w.log, [candidate()]);
    await w.log.append(
      {
        type: "wrapup.intent-recorded",
        requestId: "req-died",
        expectedConversationSeq: 2,
        plannedProposalIds: [],
      },
      { at: AT },
    );

    const { events } = await w.log.read();
    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-second",
          expectedConversationSeq: events[events.length - 1]!.seq,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "in-flight",
    );
    assert.equal((await w.ours()).length, 0, "and stages nothing while it refuses");
  });

  /*
   * Two frames arriving together. The durable guard cannot catch this on its own: an intent is
   * only appended once the pre-flight has passed, so both reads see a log with nothing in the way
   * and both would go on to stage a set of proposals for the same propositions.
   */
  it("stages one set of proposals when two wrap-ups arrive at once", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const seq = await withCandidates(w.log, [candidate()]);

    const both = await Promise.allSettled(
      ["req-a", "req-b"].map((requestId) =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId,
          expectedConversationSeq: seq,
          now: NOW,
        }),
      ),
    );

    assert.equal(both.filter((r) => r.status === "fulfilled").length, 1, "exactly one of them ran");
    const refused = both.find((r) => r.status === "rejected");
    assert.ok(refused?.status === "rejected" && refused.reason instanceof WrapUpError);
    assert.equal((await w.ours()).length, 1, "and one set of proposals exists, not two");
  });

  /*
   * The look moving between readiness and the base that staging captures.
   *
   * Readiness cannot close that window on its own — there are awaited writes and an id allocation
   * after it — so the check is repeated once the captured base is known. What matters as much as
   * the refusal is what it leaves: nothing staged, and no open intent, or the conversation would
   * refuse every later wrap-up as in-flight until the studio restarted.
   */
  it("leaves nothing staged and nothing in flight when the look moves mid-wrap-up", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const seq = await withCandidates(w.log, [
      candidate({
        classification: "art-direction.change",
        title: "The world takes a painterly look",
        draft: { description: "Painterly and hand-animated." },
        checks: { ...candidate().checks, required: [], completed: [], basedOnArtDirectionVersion: 3 },
      } as Partial<WorldChangeCandidate>),
      candidate({ title: "A rule that would have carried" }),
    ]);

    // The look moves after readiness has run: the bundle reports a version the draft never saw.
    const realBundle = w.store.getBundle.bind(w.store);
    let readinessDone = false;
    w.store.getBundle = () => {
      const bundle = realBundle();
      if (!readinessDone) {
        readinessDone = true;
        return bundle;
      }
      return { ...bundle, artDirection: { ...bundle.artDirection, version: 99 } };
    };

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-look-moved",
          expectedConversationSeq: seq,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "stale",
    );

    assert.deepEqual(await w.ours(), [], "the rule staged beside it went too — all or nothing");
    const { events } = await w.log.read();
    const last = events.map((e) => e.event.type);
    assert.ok(last.includes("wrapup.failed"), "the intent is closed, so the next wrap-up is not refused as in-flight");
  });

  /*
   * Staging itself can refuse — the world-look singleton does, when another conversation gets
   * there first — and it refuses between two of the loop's calls. What matters is that a wrap-up
   * stopped half way leaves nothing: no proposals on the approvals screen with no account of
   * themselves, and no open intent, which the in-flight guard would read as a reason to refuse
   * every later wrap-up on this conversation until the studio restarted.
   */
  it("rolls the whole set back when staging refuses part way", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const seq = await withCandidates(w.log, [
      candidate({ title: "An ordinary rule that stages first" }),
      candidate({
        classification: "art-direction.change",
        title: "The world takes a painterly look",
        draft: { description: "Painterly and hand-animated." },
        checks: { ...candidate().checks, required: [], completed: [] },
      } as Partial<WorldChangeCandidate>),
    ]);

    // Somebody else's look proposal appears between the two stage calls.
    const realStage = w.gate.stage.bind(w.gate);
    let staged = 0;
    w.gate.stage = async (input) => {
      staged += 1;
      if (staged === 2) await realStage({ kind: "art-direction", summary: "theirs", source: "elsewhere", targets: [{ path: ART_DIRECTION_PATH, content: "{}" }] }).catch(() => undefined);
      return realStage(input);
    };

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-lost-the-slot",
          expectedConversationSeq: seq,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError,
    );

    assert.deepEqual(await w.ours(), [], "the rule staged before it went too — all or nothing");
    const { events } = await w.log.read();
    assert.ok(
      events.some((e) => e.event.type === "wrapup.failed"),
      "and the intent is closed, so the next wrap-up is not refused as in-flight",
    );
  });

  it("refuses a conversation that moved on while it was being read", async () => {
    const w = await world();
    const seq = await withCandidates(w.log, [candidate()]);

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-6",
          expectedConversationSeq: seq - 1,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "stale",
    );
    await w.store.close();
  });

  it("leaves no proposal behind when a change cannot be written", async () => {
    const w = await world();
    // Passes readiness — a relationship change has no `target` field for readiness to check —
    // and fails at materialisation, which is the path this test is about.
    const seq = await withCandidates(w.log, [candidate(), failsToMaterialise()]);

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-7",
          expectedConversationSeq: seq,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError,
    );

    assert.deepEqual(
      await w.ours(),
      [],
      "a proposal nobody can accept is worse than no proposal",
    );
    await w.store.close();
  });

  it("records the failure on the conversation and leaves it open", async () => {
    const w = await world();
    const seq = await withCandidates(w.log, [candidate(), failsToMaterialise()]);

    await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-8",
      expectedConversationSeq: seq,
      now: NOW,
    }).catch(() => {});

    const { events } = await w.log.read();
    assert.ok(events.some((e) => e.event.type === "wrapup.failed"), "the attempt is recorded");
    assert.ok(
      !events.some((e) => e.event.type === "wrapup.completed"),
      "and the conversation is not closed — there is no half-closed state",
    );
    await w.store.close();
  });
});

describe("readiness on its own", () => {
  const bundle = { canon: [], sheets: [] } as never;

  it("holds back a proposition with no intent evidence", () => {
    const bare = candidate({ evidence: [] });
    const { carried, notCarried } = evaluateReadiness([bare], bundle);
    assert.deepEqual(carried, []);
    assert.equal(notCarried[0]!.reason, "invalid");
  });

  /*
   * A look drafted against a look that has since changed.
   *
   * This classification carries the whole description, so writing it now would replace whatever
   * was decided in between with words chosen before it existed — and nothing downstream would
   * catch it, because the proposal is staged against whatever is current at that moment. Held
   * back rather than dropped: it stays in the conversation to be asked for again.
   */
  function lookChange(basedOn: number) {
    return candidate({
      classification: "art-direction.change",
      title: "The world takes a painterly look",
      draft: { description: "Painterly and hand-animated." },
      checks: { ...candidate().checks, required: [], completed: [], basedOnArtDirectionVersion: basedOn },
    } as Partial<WorldChangeCandidate>);
  }

  it("holds back a look written against a look that has since changed", () => {
    const world = { canon: [], sheets: [], proposals: [], artDirection: { version: 5 } } as never;
    const { carried, notCarried } = evaluateReadiness([lookChange(4)], world);
    assert.deepEqual(carried, []);
    assert.equal(notCarried[0]!.reason, "look-moved");
  });

  it("carries one written against the look that is still current", () => {
    const world = { canon: [], sheets: [], proposals: [], artDirection: { version: 5 } } as never;
    const { carried, notCarried } = evaluateReadiness([lookChange(5)], world);
    assert.equal(carried.length, 1);
    assert.deepEqual(notCarried, []);
  });

  /*
   * There is one world look, and the screen that reviews a proposed one finds it by kind rather
   * than by id — so a second would be reviewed, accepted or discarded in place of the first.
   */
  it("holds back a second look change from the same wrap-up", () => {
    const world = { canon: [], sheets: [], proposals: [], artDirection: { version: 5 } } as never;
    const { carried, notCarried } = evaluateReadiness([lookChange(5), lookChange(5)], world);
    assert.equal(carried.length, 1, "the staged set cannot see itself, so this pass has to");
    assert.equal(notCarried[0]!.reason, "look-already-proposed");
  });

  it("holds back a second look change while one is already waiting", () => {
    const world = {
      canon: [],
      sheets: [],
      proposals: [{ proposal: { kind: "art-direction" } }],
      artDirection: { version: 5 },
    } as never;
    const { carried, notCarried } = evaluateReadiness([lookChange(5)], world);
    assert.deepEqual(carried, []);
    assert.equal(notCarried[0]!.reason, "look-already-proposed");
  });

  it("holds back an undecided proposition", () => {
    const undecided = candidate({
      classification: "undecided",
      draft: { question: "which?", plausibleActions: [], possibleTargets: [] },
    } as Partial<WorldChangeCandidate>);
    assert.equal(evaluateReadiness([undecided], bundle).notCarried[0]!.reason, "undecided");
  });

  it("ignores propositions that are not live", () => {
    const withdrawn = candidate({ status: "withdrawn" });
    const { carried, notCarried } = evaluateReadiness([withdrawn], bundle);
    assert.deepEqual(carried, []);
    assert.deepEqual(notCarried, [], "a retracted idea is history, not something that failed to carry");
  });

  it("lets a partial check through only when the user has overridden it", () => {
    const partial = candidate();
    partial.checks = { ...partial.checks, state: "partial" };
    assert.equal(evaluateReadiness([partial], bundle).notCarried[0]!.reason, "invalid");

    const overridden = candidate();
    overridden.checks = {
      ...overridden.checks,
      state: "partial",
      userOverride: { at: AT, reason: "create-anyway" },
    };
    assert.equal(evaluateReadiness([overridden], bundle).carried.length, 1);
  });
});

/**
 * Writing one point from the rail (#70, revised).
 *
 * The design this replaces decided twice, and both decisions were about everything at once: a
 * conversation produced a dozen points of which two were wrong, and the only way to say so was to
 * carry all twelve to another screen and reject two there. These are about the difference — one
 * point, written where it is shown, with the conversation still open afterwards.
 */
describe("saving one point", () => {
  it("writes only the point it was asked for, and leaves the rest live", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const wanted = candidate({ title: "Bells may pass sideways" });
    const other = candidate({ title: "A separate rule nobody asked to save" });
    await withCandidates(w.log, [wanted, other]);

    const result = await savePoint({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "save-1",
      candidateId: wanted.id,
      expectedCandidateRevision: wanted.revision,
      now: NOW,
    });

    assert.deepEqual(result.candidateIds, [wanted.id]);
    assert.equal(result.proposalIds.length, 1);
    assert.equal((await w.ours()).length, 1, "the other point was not written");

    const { events } = await w.log.read();
    const moved = events.flatMap((e) =>
      e.event.type === "candidate.status-changed" ? [e.event.candidateId] : [],
    );
    assert.deepEqual(moved, [wanted.id], "and only the saved one left the rail");
    assert.ok(
      !events.some((e) => e.event.type === "wrapup.completed"),
      "the conversation stays open — only Accept all closes it",
    );
  });

  /*
   * A point is corrected by talking, and a correction is a new revision of the same proposition.
   * Saving whatever is current would write the correction the person has not read yet.
   */
  it("refuses a point that changed since the rail showed it", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const point = candidate();
    await withCandidates(w.log, [point]);

    await assert.rejects(
      () =>
        savePoint({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "save-stale",
          candidateId: point.id,
          expectedCandidateRevision: point.revision + 1,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "stale",
    );
    assert.deepEqual(await w.ours(), [], "and nothing was written");
  });

  it("says why a point that is not settled enough cannot be written", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const maybe = candidate({ settledness: "tentative", title: "Whether the bells are whale bone" });
    await withCandidates(w.log, [maybe]);

    await assert.rejects(
      () =>
        savePoint({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "save-tentative",
          candidateId: maybe.id,
          expectedCandidateRevision: maybe.revision,
          now: NOW,
        }),
      (err: unknown) =>
        err instanceof WrapUpError && err.reason === "nothing-to-carry" && /still a maybe/.test(err.message),
    );
  });
});

/**
 * Accept all writes what is left and closes the conversation.
 *
 * The coordinator's handler does the accepting, so what wrapUp itself has to guarantee is the
 * part that makes accepting possible and honest: every proposition that carried became a
 * proposal, each says which one, and a proposal carrying an open choice is marked as asking a
 * question — because that is the one a press must not answer on somebody's behalf.
 */
describe("what accept all leaves behind", () => {
  it("marks a proposal that asks a question, so a press cannot answer it", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    /*
     * A canon.create that looks like something already in the world. The gate attaches the
     * duplicate-or-amend question to that proposal and no other, which is what lets the rest be
     * written while this one waits.
     */
    const looksFamiliar = candidate({
      title: "Bray Half-Hitch keeps the lock",
      draft: { type: "lore", title: "Bray Half-Hitch", statement: "He keeps the lock.", links: [] },
      checks: {
        ...candidate().checks,
        likelyDuplicates: [{ kind: "sheet", sheetKind: "character", sheetId: "bray-half-hitch" }],
      },
    } as Partial<WorldChangeCandidate>);
    const seq = await withCandidates(w.log, [candidate(), looksFamiliar]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-accept-all",
      expectedConversationSeq: seq,
      now: NOW,
    });

    assert.equal(result.proposalIds.length, 2);
    assert.equal(result.openChoices.length, 1, "one of them is asking, and names which");
    const asking = result.openChoices[0]!;
    assert.match(asking.question, /new rule, or a change/);
    assert.ok(
      result.proposalIds.includes(asking.proposalId),
      "the question travels with its own proposal, so the others stay acceptable",
    );
  });
});

/**
 * An atomic group, through a path that writes as soon as it is asked to.
 *
 * "These land together or not at all" was true of staging and only of staging: as one proposal
 * per member, accepting them is one gate call each, so the first changes the targets the second
 * was based on and the second comes back stale — half a group written, which is the single
 * outcome the group exists to prevent.
 */
describe("a group is one change", () => {
  /** Two propositions that must land together, and the group that says so. */
  async function withGroup(log: WorldChatStore, members: WorldChangeCandidate[]) {
    const groupId = newId("grp");
    const grouped = members.map((m) => ({ ...m, groupId }) as WorldChangeCandidate);
    const turnId = newId("turn");
    await log.append(
      {
        type: "turn.completed",
        message: { id: newId("msg") as MessageId, turnId, role: "studio", text: "Noted.", attachmentIds: [], createdAt: AT },
        run: {
          id: newId("run"),
          turnId,
          basedOnConversationSeq: 1,
          status: "completed",
          adapter: "fake",
          harnessCleanup: "not-required",
          contextDigest: `sha256:${"a".repeat(64)}`,
          startedAt: AT,
          endedAt: AT,
        },
        receipts: [],
        candidates: grouped,
        groups: [
          {
            id: groupId,
            conversationId: grouped[0]!.conversationId,
            revision: 1,
            title: "These two go together",
            rationale: "One refers to the other.",
            members: grouped.map((m) => ({ candidateId: m.id, revision: m.revision })),
            atomic: true,
            status: "live",
          },
        ],
        tombstones: [],
      } as never,
      { at: AT },
    );
    return { groupId, grouped };
  }

  it("stages a group as one proposal, so accepting it is one commit", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const { grouped } = await withGroup(w.log, [candidate({ title: "First half" }), candidate({ title: "Second half" })]);

    const result = await savePoint({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "save-group",
      candidateId: grouped[0]!.id,
      expectedCandidateRevision: grouped[0]!.revision,
      expectedGroupRevisions: grouped.map((c) => ({ candidateId: c.id, revision: c.revision })),
      now: NOW,
    });

    assert.equal(result.proposalIds.length, 1, "one proposal, not one per member");
    assert.equal(result.candidateIds.length, 2, "and it carries both");
    const staged = (await w.ours()).find((p) => p.id === result.proposalIds[0]);
    assert.equal(staged?.worldChatOrigins?.length, 2, "each proposition says it became this one");
  });

  it("refuses when a member changed behind a rail that still shows the old one", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const { grouped } = await withGroup(w.log, [candidate({ title: "First half" }), candidate({ title: "Second half" })]);

    await assert.rejects(
      () =>
        savePoint({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "save-group-stale",
          candidateId: grouped[0]!.id,
          expectedCandidateRevision: grouped[0]!.revision,
          // The rail saw the sibling a revision ago — it was corrected in another window since.
          expectedGroupRevisions: [
            { candidateId: grouped[0]!.id, revision: grouped[0]!.revision },
            { candidateId: grouped[1]!.id, revision: grouped[1]!.revision + 1 },
          ],
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "stale",
    );
    assert.deepEqual(await w.ours(), [], "and nothing was written");
  });
});

describe("what a point save will not write from", () => {
  it("refuses while a wrap-up that never finished is still open", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const point = candidate();
    await withCandidates(w.log, [point]);
    await w.log.append(
      { type: "wrapup.intent-recorded", requestId: "died", expectedConversationSeq: 2, plannedProposalIds: [] },
      { at: AT },
    );

    await assert.rejects(
      () =>
        savePoint({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "save-after-crash",
          candidateId: point.id,
          expectedCandidateRevision: point.revision,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "in-flight",
    );
  });

  it("refuses in an archived conversation, which keeps its live points", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const point = candidate();
    await withCandidates(w.log, [point]);
    await w.log.append({ type: "conversation.archived" }, { at: AT });

    await assert.rejects(
      () =>
        savePoint({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "save-archived",
          candidateId: point.id,
          expectedCandidateRevision: point.revision,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && /archived/.test(err.message),
    );
    assert.deepEqual(await w.ours(), [], "an archived conversation writes nothing");
  });
});

/**
 * What deciding immediately does to the states either side of it.
 *
 * Each of these is a window that only exists because the decision writes at once: between staging
 * and the status that takes a point off the rail, between one accept and the next, and between a
 * save reading the conversation and a reject writing to it.
 */
describe("the windows either side of a decision", () => {
  it("refuses a save for a point a proposal already holds", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const point = candidate();
    await withCandidates(w.log, [point]);

    /*
     * The crash window, made directly: a proposal staged and durable while the point still reads
     * live, because the status that would take it off the rail never landed. In the ordinary case
     * that status is what refuses a second press; this is the case where it is not there, and
     * pressing again would allocate a second Canon id and leave two entries for one sentence.
     */
    await w.gate.stage({
      kind: "worldbuilding",
      summary: point.title,
      source: `world-chat:${w.conversationId}`,
      targets: [{ path: "canon/CANON-001.md" }],
      worldChatOrigins: [
        {
          requestId: "died-mid-save",
          conversationId: w.conversationId,
          candidateId: point.id,
          candidateRevision: point.revision,
          targetPaths: ["canon/CANON-001.md"],
          fields: ["statement"],
        },
      ],
    });

    await assert.rejects(
      () =>
        savePoint({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "save-again",
          candidateId: point.id,
          expectedCandidateRevision: point.revision,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "in-flight",
    );
    assert.equal((await w.ours()).length, 1, "one proposal, not two");
  });

  it("puts points back on the rail when accept all could not write them", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const seq = await withCandidates(w.log, [candidate()]);

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "accept-all-fails",
          expectedConversationSeq: seq,
          now: NOW,
          // Nothing lands, as a stale or unconfirmed accept would answer.
          writeThrough: async () => false,
        }),
      (err: unknown) => err instanceof WrapUpError,
    );

    const { events } = await w.log.read();
    const view = foldConversation((await w.log.readMeta())!.id, AT, events).view;
    assert.equal(view.status, "open", "the conversation is not closed over work it did not write");
    assert.equal(view.candidates.filter((c) => c.status === "live").length, 1, "and the point is decidable again");
    assert.deepEqual(await w.ours(), [], "with no proposal left offering the same change twice");
  });

  it("refuses a reject whose revision is not the one the rail showed", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const point = candidate();
    await withCandidates(w.log, [point]);

    await assert.rejects(
      () =>
        rejectPoint({
          store: w.store,
          conversationId: w.conversationId,
          candidateId: point.id,
          expectedCandidateRevision: point.revision + 1,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "stale",
    );

    const { events } = await w.log.read();
    assert.ok(
      !events.some((e) => e.event.type === "candidate.status-changed"),
      "the corrected point was left alone rather than discarded in its place",
    );
  });
});
