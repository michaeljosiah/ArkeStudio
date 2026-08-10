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
import { lookContentHash } from "../../src/world-chat/look.js";
import { evaluateReadiness } from "../../src/world-chat/readiness.js";
import { recordResolution } from "../../src/world-chat/resolution.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { wrapUp, WrapUpError } from "../../src/world-chat/wrapup.js";
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

/** The `wrapup.failed` this conversation recorded, if it recorded one. */
async function failureIn(log: WorldChatStore) {
  const { events } = await log.read();
  return events
    .map((e) => e.event)
    .find((e): e is Extract<typeof e, { type: "wrapup.failed" }> => e.type === "wrapup.failed");
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

  /*
   * The roll-back that could not roll everything back.
   *
   * `gate.discard` can refuse — a file held open, a directory that will not go — and swallowing
   * that left a proposal on the approvals screen for a conversation whose propositions were all
   * still live, under a refusal that said nothing had been created. The intent closes either way,
   * so startup recovery, which reconciles by open intent, would never look again: nothing in the
   * world or the log knew the thing was there.
   */
  it("names the proposals a failed roll-back could not take back", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const seq = await withCandidates(w.log, [
      candidate({ title: "A rule that stages first" }),
      candidate({ title: "A rule that never gets that far" }),
    ]);

    const realStage = w.gate.stage.bind(w.gate);
    let staged = 0;
    w.gate.stage = async (input) => {
      staged += 1;
      if (staged === 2) throw new Error("the disk went away");
      return realStage(input);
    };
    w.gate.discard = async () => {
      throw new Error("and it is still away");
    };

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-stuck",
          expectedConversationSeq: seq,
          now: NOW,
        }),
      (err: unknown) =>
        err instanceof WrapUpError && err.reason === "leftovers" && /could not be taken back/.test(err.message),
    );

    const left = await w.ours();
    assert.equal(left.length, 1, "the proposal that would not go is still on the approvals screen");
    const failed = await failureIn(w.log);
    assert.deepEqual(
      failed?.leftovers?.map((one) => one.proposalId),
      [left[0]!.id],
      "and the log names it, because after the intent closes nothing else remembers",
    );
    assert.deepEqual(
      failed?.leftovers?.[0]?.candidateIds,
      [left[0]!.worldChatOrigins?.[0]?.candidateId],
      "with the propositions it was made from, which its manifest may not outlive",
    );
  });

  /*
   * A discard that threw is not proof the proposal survived. It removes the directory and then
   * writes the world's change journal, so a failure in the second half leaves nothing on the
   * approvals screen — and an id recorded for it would name a proposal that does not exist, which
   * the guard would then refuse every later wrap-up over, for good.
   */
  it("records nothing for a discard that failed after the proposal had already gone", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const seq = await withCandidates(w.log, [
      candidate({ title: "A rule that stages first" }),
      candidate({ title: "A rule that never gets that far" }),
    ]);

    const realStage = w.gate.stage.bind(w.gate);
    let staged = 0;
    w.gate.stage = async (input) => {
      staged += 1;
      if (staged === 2) throw new Error("the disk went away");
      return realStage(input);
    };
    // Removes the proposal and then fails, exactly as a failing journal append would.
    const realDiscard = w.gate.discard.bind(w.gate);
    w.gate.discard = async (id) => {
      await realDiscard(id);
      throw new Error("the journal would not take it");
    };

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-half-gone",
          expectedConversationSeq: seq,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason !== "leftovers",
    );

    assert.deepEqual(await w.ours(), [], "the proposal did go, whatever the discard then said");
    assert.equal(
      (await failureIn(w.log))?.leftovers,
      undefined,
      "so nothing is named, and the next wrap-up is not refused over a proposal that is not there",
    );
  });

  it("refuses to go again while a proposal it could not take back is still waiting", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    await withCandidates(w.log, [candidate(), candidate({ title: "A second one" })]);

    const realStage = w.gate.stage.bind(w.gate);
    let staged = 0;
    w.gate.stage = async (input) => {
      staged += 1;
      if (staged === 2) throw new Error("the disk went away");
      return realStage(input);
    };
    const stuck = w.gate.discard.bind(w.gate);
    w.gate.discard = async () => {
      throw new Error("and it is still away");
    };

    const attempt = async (requestId: string) => {
      const { events } = await w.log.read();
      return wrapUp({
        store: w.store,
        gate: w.gate,
        conversationId: w.conversationId,
        requestId,
        expectedConversationSeq: events[events.length - 1]!.seq,
        now: NOW,
      });
    };

    await assert.rejects(() => attempt("req-first"), (err: unknown) => err instanceof WrapUpError);
    await assert.rejects(
      () => attempt("req-second"),
      (err: unknown) => err instanceof WrapUpError && err.reason === "leftovers",
      "going again would stage a second proposal for propositions that already have one",
    );

    // Discarded on the approvals screen, as the refusal says to do: the way out is not a restart.
    w.gate.discard = stuck;
    const waiting = await w.ours();
    for (const proposal of waiting) await w.gate.discard(proposal.id);

    /*
     * Still refused, on the gap the gate cannot see. Deciding a proposal removes it and records
     * that against the conversation afterwards, so between the two the gate says gone while every
     * candidate still reads live — and a wrap-up that went ahead there would propose again what
     * had just been decided.
     */
    await assert.rejects(
      () => attempt("req-in-the-gap"),
      (err: unknown) => err instanceof WrapUpError && err.reason === "leftovers",
    );

    for (const proposal of waiting) {
      await recordResolution(w.store, proposal, "discarded", NOW);
    }
    w.gate.stage = realStage;
    const done = await attempt("req-third");
    assert.equal(
      done.proposalIds.length,
      1,
      "the conversation carries again, less the proposition discarded along with the leftover",
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
   * The version did not move and the look did.
   *
   * A world with no art-direction file still has one, derived from its name, tone, genre and
   * logline — and that derivation is always v1. Edit the world's tone and the description every
   * image is generated from is rewritten while the number sits exactly where it was, so a draft
   * pinned to the number alone passed as current and replaced words it had never been shown.
   */
  it("holds back a look whose description was rewritten under the same version", () => {
    const shown = "Painterly and hand-animated, with visible brushwork.";
    const pinned = candidate({
      classification: "art-direction.change",
      title: "The world takes a painterly look",
      draft: { description: "Painterly and hand-animated." },
      checks: {
        ...candidate().checks,
        required: [],
        completed: [],
        basedOnArtDirectionVersion: 1,
        basedOnArtDirectionLook: lookContentHash(shown),
      },
    } as Partial<WorldChangeCandidate>);

    const rewritten = {
      canon: [],
      sheets: [],
      proposals: [],
      artDirection: { version: 1, description: "Saltlight should feel wry and salt-bleached." },
    } as never;
    assert.equal(evaluateReadiness([pinned], rewritten).notCarried[0]!.reason, "look-moved");

    const unchanged = {
      canon: [],
      sheets: [],
      proposals: [],
      artDirection: { version: 1, description: shown },
    } as never;
    assert.equal(
      evaluateReadiness([pinned], unchanged).carried.length,
      1,
      "word for word what it was shown is not a look that moved",
    );
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
