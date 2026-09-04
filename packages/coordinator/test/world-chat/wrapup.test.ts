import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ART_DIRECTION_PATH,
  newId,
  type CandidateGroup,
  type CandidateId,
  type ConversationId,
  type MessageId,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { lookContentHash } from "../../src/world-chat/look.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { recoverWrapUps } from "../../src/world-chat/wrapup-recovery.js";
import { evaluateReadiness } from "../../src/world-chat/readiness.js";
import { recordResolution } from "../../src/world-chat/resolution.js";
import { materialiseDuplicateChoice } from "../../src/world-chat/materialise.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { rejectPoint, returnToRail, savePoint, wrapUp, WrapUpError } from "../../src/world-chat/wrapup.js";
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
  groups: CandidateGroup[] = [],
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
      groups,
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

  it("composes a relationship onto a sheet created in the same atomic group", async () => {
    const w = await world();
    const groupId = newId("grp");
    const created = candidate({
      conversationId: w.conversationId,
      groupId,
      classification: "sheet.create",
      title: "Maren Kest",
      checks: {
        state: "complete",
        basedOnCanonRevision: 42,
        required: ["sheet-search", "canon-search"],
        completed: ["sheet-search", "canon-search"],
        consulted: [],
        likelyDuplicates: [],
        possibleAmendments: [],
        contradictionCandidates: [],
        explanation: "No overlap was found.",
      },
      draft: {
        type: "character",
        name: "Maren Kest",
        canonRules: [],
        links: [],
        sections: [{ heading: "Essence", body: "A keeper of drowned bells." }],
      },
    } as Partial<WorldChangeCandidate>);
    const relationship = candidate({
      conversationId: w.conversationId,
      groupId,
      classification: "relationship.change",
      title: "Maren trusts Bray",
      checks: {
        state: "complete",
        basedOnCanonRevision: 42,
        required: ["target-read", "related-read"],
        completed: ["target-read", "related-read"],
        consulted: [],
        likelyDuplicates: [],
        possibleAmendments: [],
        contradictionCandidates: [],
        explanation: "Both ends were checked.",
      },
      draft: {
        from: { kind: "pending-entity", ref: { candidateId: created.id, revision: created.revision } },
        to: { kind: "sheet", sheetId: "bray-half-hitch" },
        linkAction: "add",
        proseEdits: [{
          sheet: { kind: "pending-entity", ref: { candidateId: created.id, revision: created.revision } },
          sectionHeading: "Relationships",
          body: "Maren trusts Bray with the western bell.",
          reason: "The relationship was settled in conversation.",
        }],
      },
    } as Partial<WorldChangeCandidate>);
    const group: CandidateGroup = {
      id: groupId,
      conversationId: w.conversationId,
      revision: 1,
      title: "Maren and Bray",
      rationale: "The relationship depends on Maren existing.",
      members: [created, relationship].map((item) => ({ candidateId: item.id, revision: item.revision })),
      atomic: true,
      status: "live",
    };
    const seq = await withCandidates(w.log, [relationship, created], [group]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-related-create",
      expectedConversationSeq: seq,
      now: NOW,
    });

    assert.equal(result.proposalIds.length, 1);
    const proposal = await w.gate.readManifest(result.proposalIds[0]!);
    assert.equal(proposal.targets.length, 1, "the composed sheet is one atomic target");
    const content = await readFile(join(w.dir, ".proposals", proposal.id, proposal.targets[0]!.path), "utf8");
    assert.match(content, /bray-half-hitch/);
    assert.match(content, /Maren trusts Bray with the western bell\./);
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
        medium: "image",
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

  /*
   * The same filesystem trouble that makes a discard fail is what would make reading `.proposals`
   * fail. `listOpen` answers that with an empty list — the same answer it gives when nothing is
   * staged — so verifying through it would report every proposal gone at the moment they are
   * certainly not, and the leftovers would go unrecorded.
   */
  it("records the leftovers when it cannot tell whether they are still there", async () => {
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
    // The disk is unreadable in both directions, which is the point: an unanswerable question is
    // not a "no".
    w.gate.isStaged = async () => {
      throw new Error("cannot read .proposals either");
    };

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-cannot-tell",
          expectedConversationSeq: seq,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "leftovers",
    );

    const named = (await failureIn(w.log))?.leftovers ?? [];
    assert.equal(named.length, 1, "recorded rather than assumed gone, so recovery still comes back for it");
    assert.deepEqual(named.map((one) => one.proposalId), (await w.ours()).map((p) => p.id));
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
   * A role that is a sentence.
   *
   * `CHARACTER_ROLE_MAX` used to be enforced only by the accept gate, which is the last step there
   * is: the point was materialised, staged, marked `proposed` — off the rail, with nothing left to
   * correct it from — and only then refused, leaving a proposal on the Cast and approvals screens
   * that nobody could ever accept. Held back here it stays in the conversation, which is where a
   * shorter role can be asked for.
   */
  function newCharacter(role: string) {
    return candidate({
      classification: "sheet.create",
      title: "Corvin joins the cast",
      draft: {
        type: "character",
        name: "Corvin Sabato",
        role,
        canonRules: [],
        links: [],
        sections: [{ heading: "Essence", body: "An ancient Watcher." }],
      },
    } as Partial<WorldChangeCandidate>);
  }

  it("holds back a new character whose role is longer than a role may be", () => {
    const long = "Founder and High Regent of the Blackfeather Covenant; Severed political leader";
    const { carried, notCarried } = evaluateReadiness([newCharacter(long)], bundle);
    assert.deepEqual(carried, [], "nothing is staged, so nothing can be left standing");
    assert.equal(notCarried[0]!.reason, "role-too-long");
  });

  it("carries one whose role is a label", () => {
    const { carried, notCarried } = evaluateReadiness([newCharacter("Blackfeather founder")], bundle);
    assert.equal(carried.length, 1);
    assert.deepEqual(notCarried, []);
  });

  /*
   * The bound belongs to characters, exactly as the gate applies it. `checkAuthoredBounds` measures
   * `characters/` and nothing else, so refusing a long role on a location here would hold back what
   * the gate would have written without complaint.
   */
  it("leaves a location's role alone, because the gate never measures one", () => {
    const long = "A drowned harbour that keeps its bells above the waterline year round";
    const place = candidate({
      classification: "sheet.create",
      title: "The harbour joins the world",
      draft: {
        type: "location",
        name: "Slackwater",
        role: long,
        canonRules: [],
        links: [],
        // "Look", not "Essence": Essence is a character's section, and a location's prose has
        // nowhere to put it. The fixture said Essence while nothing checked, which is the same
        // slip the drafting guide's own example was making.
        sections: [{ heading: "Look", body: "Bells above the water." }],
      },
    } as Partial<WorldChangeCandidate>);
    assert.equal(evaluateReadiness([place], bundle).carried.length, 1);
  });

  /*
   * The edit path too, now that an edit can actually set a role. It could not before — materialise
   * dropped the field — so the bound only had to cover creates; a fix in one place without the
   * other would have reopened exactly this bug through the other door.
   */
  it("holds back an edit that would set a role longer than a role may be", () => {
    const edit = candidate({
      classification: "sheet.edit",
      title: "Corvin's role is spelled out",
      target: { kind: "sheet", sheetKind: "character", sheetId: "corvin-sabato" },
      draft: { role: "Founder and High Regent of the Blackfeather Covenant, and much else besides" },
    } as Partial<WorldChangeCandidate>);
    const world = { canon: [], sheets: [{ id: "corvin-sabato" }], proposals: [] } as never;
    assert.equal(evaluateReadiness([edit], world).notCarried[0]?.reason, "role-too-long");
  });

  it("lets an edit that clears the role through, because null is not a long string", () => {
    const edit = candidate({
      classification: "sheet.edit",
      title: "Corvin loses his title",
      target: { kind: "sheet", sheetKind: "character", sheetId: "corvin-sabato" },
      draft: { role: null },
    } as Partial<WorldChangeCandidate>);
    const world = { canon: [], sheets: [{ id: "corvin-sabato" }], proposals: [] } as never;
    assert.equal(evaluateReadiness([edit], world).carried.length, 1);
  });

  it("holds back only the long one, leaving what was said beside it to carry", () => {
    const long = "Founder and High Regent of the Blackfeather Covenant; Severed political leader";
    const { carried, notCarried } = evaluateReadiness([newCharacter(long), candidate()], bundle);
    assert.equal(carried.length, 1, "the sibling is unaffected — this is not all-or-nothing");
    assert.equal(notCarried.length, 1);
  });

  /*
   * The two shapes of an edit that reports success and writes nothing.
   *
   * Driven 2026-08-23 on `king-s-daughter`: a proposition claiming two new facts about a
   * character was accepted, versioned v1 -> v2, given a history snapshot and a commit line, and
   * the sheet afterwards was byte-identical to v1. `sheetBody` writes the shape's headings and
   * only those, so a section under any other one is set on a map and never read — and the file
   * still differs in bytes, because `updated` is stamped with today, so the gate's byte
   * comparison called it a change.
   *
   * Held back here, where the point stays on the rail and naming a real heading is the repair.
   */
  const withSheet = {
    canon: [],
    proposals: [],
    sheets: [
      {
        id: "adaeze-working-name",
        type: "character",
        name: "Adaeze",
        sections: [
          { heading: "Essence", body: "She keeps the count her aunt taught her." },
          { heading: "Appearance", body: "Small hands, always moving." },
        ],
      },
    ],
  } as never;

  function sheetEdit(sections: Array<{ heading: string; body: string }>) {
    return candidate({
      classification: "sheet.edit",
      title: "Adaeze counts with her aunt's own gesture",
      target: { kind: "sheet", sheetKind: "character", sheetId: "adaeze-working-name" },
      draft: { sections },
    } as Partial<WorldChangeCandidate>);
  }

  it("holds back an edit written under a heading the sheet does not have", () => {
    const edit = sheetEdit([{ heading: "Habits", body: "Thumb against forefinger, four times." }]);
    const { carried, notCarried } = evaluateReadiness([edit], withSheet);
    assert.deepEqual(carried, [], "nothing of it would reach the page, so nothing is staged");
    assert.equal(notCarried[0]!.reason, "unknown-section");
  });

  /*
   * One real heading and one invented one is the same silence in a smaller place: the good
   * section would land, the other would vanish, and the proposition would be reported as written.
   */
  it("holds back an edit that names one real heading and one invented one", () => {
    const edit = sheetEdit([
      { heading: "Essence", body: "She counts before she speaks." },
      { heading: "Habits", body: "Thumb against forefinger, four times." },
    ]);
    assert.equal(evaluateReadiness([edit], withSheet).notCarried[0]?.reason, "unknown-section");
  });

  it("carries an edit written under a heading the sheet has", () => {
    const edit = sheetEdit([{ heading: "Essence", body: "She counts with her aunt's own gesture." }]);
    const { carried, notCarried } = evaluateReadiness([edit], withSheet);
    assert.equal(carried.length, 1);
    assert.deepEqual(notCarried, []);
  });

  it("holds back an edit that restates what the sheet already says", () => {
    const edit = sheetEdit([{ heading: "Essence", body: "She keeps the count her aunt taught her." }]);
    const { carried, notCarried } = evaluateReadiness([edit], withSheet);
    assert.deepEqual(carried, [], "an accept that changes nothing must not be offered as one");
    assert.equal(notCarried[0]!.reason, "changes-nothing");
  });

  it("counts whitespace alone as no change, because the written file would be identical", () => {
    const edit = sheetEdit([{ heading: "Essence", body: "  She keeps the count her aunt taught her.\n" }]);
    assert.equal(evaluateReadiness([edit], withSheet).notCarried[0]?.reason, "changes-nothing");
  });

  /*
   * The same drop reached by asking for a relationship instead of an edit. Materialise writes a
   * prose edit's section exactly as it writes a sheet edit's, so fixing one door and not the
   * other would leave the bug in the building.
   */
  it("holds back a relationship whose prose edit names a heading the sheet does not have", () => {
    const tie = candidate({
      classification: "relationship.change",
      title: "Adaeze and her aunt share the count",
      draft: {
        from: { kind: "sheet", sheetId: "adaeze-working-name" },
        to: { kind: "sheet", sheetId: "adaeze-working-name" },
        linkAction: "unchanged",
        proseEdits: [
          {
            sheet: { kind: "sheet", sheetId: "adaeze-working-name" },
            sectionHeading: "History",
            body: "Her aunt taught her the count.",
            reason: "Said outright.",
          },
        ],
      },
    } as Partial<WorldChangeCandidate>);
    assert.equal(evaluateReadiness([tie], withSheet).notCarried[0]?.reason, "unknown-section");
  });

  it("carries a relationship whose prose edit names a heading the sheet has", () => {
    const tie = candidate({
      classification: "relationship.change",
      title: "Adaeze and her aunt share the count",
      draft: {
        from: { kind: "sheet", sheetId: "adaeze-working-name" },
        to: { kind: "sheet", sheetId: "adaeze-working-name" },
        linkAction: "unchanged",
        proseEdits: [
          {
            sheet: { kind: "sheet", sheetId: "adaeze-working-name" },
            sectionHeading: "Relationships",
            body: "Her aunt taught her the count.",
            reason: "Said outright.",
          },
        ],
      },
    } as Partial<WorldChangeCandidate>);
    assert.equal(evaluateReadiness([tie], withSheet).carried.length, 1);
  });

  it("carries an edit that changes a field without touching a section", () => {
    const edit = candidate({
      classification: "sheet.edit",
      title: "Adaeze gets a role",
      target: { kind: "sheet", sheetKind: "character", sheetId: "adaeze-working-name" },
      draft: { role: "The counter" },
    } as Partial<WorldChangeCandidate>);
    assert.equal(evaluateReadiness([edit], withSheet).carried.length, 1);
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
    const entryId = w.store.getBundle().canon[0]!.id;
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
        likelyDuplicates: [{ kind: "canon", entryId }],
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
    assert.deepEqual(
      asking.options.map((option) => option.optionId),
      ["create", `amend:${entryId}`],
      "only a canonical reference the rematerializer supports is offered as an amendment",
    );
  });

  it("does not offer a Canon amendment to a similar sheet", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const looksLikeASheet = candidate({
      checks: {
        ...candidate().checks,
        likelyDuplicates: [{ kind: "sheet", sheetKind: "character", sheetId: "maren-kest" }],
      },
    } as Partial<WorldChangeCandidate>);
    const seq = await withCandidates(w.log, [looksLikeASheet]);
    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-sheet-match",
      expectedConversationSeq: seq,
      now: NOW,
    });
    assert.deepEqual(result.openChoices, []);
  });

  it("rematerialises the same questioned payload as create or canonical amend", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const entryId = w.store.getBundle().canon[0]!.id;
    const questioned = candidate({
      checks: {
        ...candidate().checks,
        likelyDuplicates: [{ kind: "canon", entryId }],
      },
    } as Partial<WorldChangeCandidate>);

    const created = materialiseDuplicateChoice(questioned, "create", "CANON-999", w.store.getBundle(), AT);
    assert.equal(created.action, "create");
    assert.equal(created.targets[0]!.path, "canon/CANON-999.md");

    const amended = materialiseDuplicateChoice(
      questioned,
      `amend:${entryId}`,
      "CANON-999",
      w.store.getBundle(),
      AT,
    );
    assert.equal(amended.action, "amend");
    assert.equal(amended.targets[0]!.path, `canon/${entryId}.md`);
    assert.match(amended.targets[0]!.content, /The bells may pass sideways\./);
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
          writeThrough: async () => "the world moved underneath it",
        }),
      (err: unknown) =>
        err instanceof WrapUpError &&
        // The gate's reason reaches the person, rather than a count they cannot act on.
        err.message.includes("the world moved underneath it"),
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

/** The two states recovery has to tell apart when a wrap-up died with nothing left open. */
describe("recovering an accept all that wrote and then died", () => {
  it("closes a conversation whose changes had already landed", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    await withCandidates(w.log, [candidate()]);
    /*
     * The shape a crash leaves after the last accept: the intent is open, no proposal is left to
     * find because acceptance removed it, and the log records that it landed. Read as "nothing was
     * created", this closed nothing and left a conversation no later Accept all could finish.
     */
    await w.log.append(
      { type: "wrapup.intent-recorded", requestId: "wrote-then-died", expectedConversationSeq: 2, plannedProposalIds: [] },
      { at: AT },
    );
    await w.log.append(
      { type: "proposal.resolved", proposalId: newId("pr") as never, outcome: "accepted", candidateIds: [] },
      { at: AT },
    );

    const { repaired } = await recoverWrapUps(w.store, w.gate, NOW);
    const mine = repaired.find((r) => r.conversationId === w.conversationId);
    assert.equal(mine?.outcome, "completed", "what was written is what happened");

    const { events } = await w.log.read();
    const view = foldConversation((await w.log.readMeta())!.id, AT, events).view;
    assert.equal(view.status, "closed");
  });

  it("still reports one that created nothing as failed, leaving it open", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    await withCandidates(w.log, [candidate()]);
    await w.log.append(
      { type: "wrapup.intent-recorded", requestId: "died-early", expectedConversationSeq: 2, plannedProposalIds: [] },
      { at: AT },
    );

    const { repaired } = await recoverWrapUps(w.store, w.gate, NOW);
    assert.equal(repaired.find((r) => r.conversationId === w.conversationId)?.outcome, "failed");
    const { events } = await w.log.read();
    const view = foldConversation((await w.log.readMeta())!.id, AT, events).view;
    assert.equal(view.status, "open", "nothing was written, so there is still everything to decide");
  });
});

/**
 * A save is a thing the conversation knows it is doing.
 *
 * It was built without a durable record, on the reasoning that it stages at most a group and a
 * crash leaves what a waiting proposal already is. That covered the proposal and nothing around
 * it: while a save is in flight nothing else could see it, so a conversation could be deleted out
 * from under one, and a proposal a save left waiting was counted nowhere.
 */
describe("a save the conversation can see", () => {
  it("blocks deletion while it is writing, and stops blocking when it is done", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const point = candidate();
    await withCandidates(w.log, [point]);

    const before = foldConversation((await w.log.readMeta())!.id, AT, (await w.log.read()).events).view;
    assert.equal(before.deletionBlock, null, "nothing is happening yet");

    await w.log.append(
      { type: "save.intent-recorded", requestId: "mid-save", candidateIds: [point.id] },
      { at: AT },
    );
    const during = foldConversation((await w.log.readMeta())!.id, AT, (await w.log.read()).events).view;
    assert.equal(
      during.deletionBlock,
      "wrap-up-in-flight",
      "a conversation being written from cannot be deleted under the write",
    );

    await w.log.append({ type: "save.settled", requestId: "mid-save", proposalIds: [] }, { at: AT });
    const after = foldConversation((await w.log.readMeta())!.id, AT, (await w.log.read()).events).view;
    assert.equal(after.deletionBlock, null);
  });

  it("counts a proposal a save left waiting, so the conversation cannot be deleted from under it", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const point = candidate();
    await withCandidates(w.log, [point]);

    const result = await savePoint({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "save-waiting",
      candidateId: point.id,
      expectedCandidateRevision: point.revision,
      now: NOW,
    });

    const view = foldConversation((await w.log.readMeta())!.id, AT, (await w.log.read()).events).view;
    assert.deepEqual(
      view.proposalIds,
      result.proposalIds,
      "a save announces its proposal on the status change, since it has no completion event",
    );
    assert.equal(
      view.deletionBlock,
      "unresolved-proposals",
      "and the proposal keeps the conversation alive, because send-back has nowhere else to go",
    );
  });

  /*
   * What a save does when the gate will not write what it staged.
   *
   * It used to do nothing at all: the proposal stayed, and the proposition stayed `proposed`. So a
   * character the gate refused — over a role a hundred characters past its limit — left the rail
   * for good and reappeared on the Cast screen as a draft that could never be accepted, with the
   * conversation offering no way back to it. Taken back instead, exactly as Accept all does.
   */
  it("takes back a proposal the gate would not write, and puts the point back on the rail", async () => {
    const w = await world();
    closeOnCleanup(() => w.store.close());
    const point = candidate();
    await withCandidates(w.log, [point]);

    const result = await savePoint({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "save-refused",
      candidateId: point.id,
      expectedCandidateRevision: point.revision,
      now: NOW,
    });
    const proposalId = result.proposalIds[0]!;
    const staged = await w.gate.readManifest(proposalId);

    await returnToRail(w.log, w.gate, staged, NOW);

    assert.equal(
      (await w.ours()).some((p) => p.id === proposalId),
      false,
      "the proposal is gone, so the same change is not offered twice",
    );
    const view = foldConversation((await w.log.readMeta())!.id, AT, (await w.log.read()).events).view;
    assert.equal(
      view.candidates.find((c) => c.id === point.id)?.status,
      "live",
      "and the point is back on the rail, where it can be corrected",
    );
    assert.deepEqual(view.proposalIds, [], "nothing is still counted as waiting");
    assert.equal(
      view.deletionBlock,
      null,
      "so the conversation is not held open for ever by a proposal that no longer exists",
    );
  });
});
