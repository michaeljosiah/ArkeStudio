import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  newId,
  type CandidateTombstone,
  type CandidateId,
  type ConversationId,
  type MessageId,
  type RunId,
  type TurnId,
  type WorldChatMessage,
} from "@arke-studio/contracts";
import {
  assembleContext,
  BOUNDS,
  shouldSummarise,
  type ContextAttachment,
} from "../../src/world-chat/context.js";
import {
  createRunScratch,
  removeRunScratch,
  runScratchDir,
  sweepRunScratch,
} from "../../src/world-chat/run-scratch.js";
import { mergeAttachmentRanges } from "../../src/world-chat/attachments.js";

/**
 * Bounded context and the per-run scratch (#70 §8.2, §8.5).
 *
 * The bound that matters most is the one that is not applied: a user's own message is never cut.
 */

const AT = "2026-08-06T10:00:00Z";

function message(role: "user" | "studio", text: string): WorldChatMessage {
  return {
    id: newId("msg") as MessageId,
    turnId: newId("turn") as TurnId,
    role,
    text,
    attachmentIds: [],
    createdAt: AT,
  };
}

/** Stable across calls: two baseInput() contexts must digest identically. */
const CURRENT_MESSAGE_ID = newId("msg") as MessageId;

/** An attachment as the runner hands it over: identity first, because evidence cites it. */
function attachment(over: Partial<ContextAttachment> = {}): ContextAttachment {
  return {
    id: newId("wca"),
    contentHash: `sha256:${"b".repeat(64)}`,
    fileName: "pasted-note.txt",
    kind: "document",
    readable: true,
    ...over,
  };
}

function baseInput() {
  return {
    candidates: [],
    messages: [] as WorldChatMessage[],
    tombstones: [] as CandidateTombstone[],
    currentUserMessage: "and the bells?",
    currentUserMessageId: CURRENT_MESSAGE_ID,
  };
}

describe("context assembly", () => {
  it("never truncates what the user just typed", () => {
    const long = "salt ".repeat(20_000);
    const context = assembleContext({ ...baseInput(), currentUserMessage: long });
    assert.equal(context.currentUserMessage, long, "cutting somebody's sentence to fit a budget is not an option");
    assert.equal(context.currentUserMessage.length, long.length);
  });

  it("holds every other section to its stated bound", () => {
    const context = assembleContext({
      ...baseInput(),
      summary: "s".repeat(BOUNDS.summary * 2),
      worldContext: "w".repeat(BOUNDS.worldContext * 2),
      messages: Array.from({ length: 40 }, (_, i) => message("user", `${i} `.repeat(2_000))),
    });

    assert.ok(context.summary.length <= BOUNDS.summary);
    assert.ok(context.worldContext.length <= BOUNDS.worldContext);
    assert.ok(context.recentTurns.length <= BOUNDS.recentTurns);
  });

  /**
   * Reported from the packaged build: a document was pasted, the chip appeared on the composer,
   * and the Studio answered "I can't see an attached document" — twice. It was telling the truth.
   * Nothing about the attachment ever reached the prompt, so the model had no way to know one
   * existed, and no amount of asking again would have changed that.
   */
  it("puts what was handed over in front of the model", () => {
    const context = assembleContext({
      ...baseInput(),
      attachments: [attachment({ text: "The drowned god sings." })],
      currentUserMessage: "The attached document, can you see it?",
    });
    assert.match(context.attachments, /pasted-note\.txt/, "it is named");
    assert.match(context.attachments, /The drowned god sings\./, "and its text is actually there");
  });

  /**
   * The same failure as the missing message ids, one field over: attachment evidence requires an
   * attachmentId and a contentHash, and neither appeared anywhere in the prompt. The model could
   * not even call get_attachment_text to find them out — that tool takes the id it has not got.
   * Every quotation of a handed-over document was therefore an invention the verifier rejected.
   */
  it("prints the identity attachment evidence has to cite", () => {
    const doc = attachment({ text: "The drowned god sings." });
    const context = assembleContext({ ...baseInput(), attachments: [doc] });
    assert.match(context.attachments, new RegExp(`attachmentId: ${doc.id}`));
    assert.match(context.attachments, new RegExp(`contentHash: ${doc.contentHash}`));
  });

  it("names an attachment it cannot read rather than staying silent about it", () => {
    const image = attachment({ fileName: "maren.png", kind: "image", readable: false });
    const context = assembleContext({ ...baseInput(), attachments: [image] });
    assert.match(context.attachments, /maren\.png/, "silence would make the model deny it exists");
    assert.match(context.attachments, /cannot be read/);
    assert.doesNotMatch(context.attachments, /do not guess[\s\S]*do not guess/, "said once");
    assert.match(
      context.attachments,
      new RegExp(`attachmentId: ${image.id}`),
      "an image cannot be quoted, but it can still be referred to by id",
    );
  });

  it("is empty when nothing was handed over, so the prompt gains no empty section", () => {
    assert.equal(assembleContext(baseInput()).attachments, "");
  });

  /**
   * The opposite of every other section: a document was handed over whole and starts at its
   * beginning, so keeping the tail would give the model the last page of something it never saw
   * the first page of.
   */
  it("keeps the beginning of a document it has to cut, not the end", () => {
    const body = `START-OF-DOCUMENT ${"x ".repeat(BOUNDS.attachments)} END-OF-DOCUMENT`;
    const context = assembleContext({
      ...baseInput(),
      attachments: [attachment({ fileName: "long.md", text: body })],
    });
    assert.ok(context.attachments.length <= BOUNDS.attachments + 200, "bounded");
    assert.match(context.attachments, /START-OF-DOCUMENT/);
    assert.doesNotMatch(context.attachments, /END-OF-DOCUMENT/);
    assert.ok(context.trimmed.includes("attachments"), "and it says it cut, rather than cutting quietly");
    assert.match(context.attachments, /get_attachment_text/, "pointing at how to read the rest");
  });

  /**
   * Spending the budget in document order loses the last document's heading first — its name,
   * id and hash — so the one the model is told least about is also the only one it cannot go
   * and read, because `get_attachment_text` needs the id that just fell off the end.
   */
  it("keeps every attachment's identity when several long documents are handed over", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      attachment({ fileName: `doc-${i}.txt`, text: "x".repeat(BOUNDS.attachments) }),
    );
    const context = assembleContext({ ...baseInput(), attachments: many });

    assert.ok(context.attachments.length <= BOUNDS.attachments, "still inside the bound");
    for (const doc of many) {
      assert.ok(context.attachments.includes(doc.fileName), `${doc.fileName} is named`);
      assert.ok(context.attachments.includes(doc.id), `${doc.fileName} keeps the id the tool needs`);
      assert.ok(context.attachments.includes(doc.contentHash), `${doc.fileName} keeps its hash`);
    }
    assert.ok(context.trimmed.includes("attachments"), "and it says it cut, rather than cutting quietly");
  });

  it("distinguishes two turns that differ only by what was attached", () => {
    const without = assembleContext(baseInput()).digest;
    const with_ = assembleContext({
      ...baseInput(),
      attachments: [attachment({ fileName: "a.txt", text: "something" })],
    }).digest;
    assert.notEqual(without, with_, "or a run record would claim they had the same context");
  });

  it("says which sections it had to trim, rather than trimming quietly", () => {
    const context = assembleContext({ ...baseInput(), summary: "s".repeat(BOUNDS.summary + 1) });
    assert.deepEqual(context.trimmed, ["summary"]);
  });

  it("keeps the most recent history when it has to choose", () => {
    const context = assembleContext({
      ...baseInput(),
      messages: [message("user", "the oldest thing said"), message("user", "the newest thing said")],
    });
    assert.match(context.recentTurns, /the newest thing said/);
  });

  /**
   * Message evidence requires a messageId, and the model can only cite what it is shown. The
   * first live turn failed on exactly this: the prompt rendered bare "User:" lines, so there was
   * no valid id anywhere in the model's world, and every citation of the conversation was an
   * invention the validator rejected.
   */
  it("renders every user message with the id evidence has to cite", () => {
    const said = message("user", "the tide answers the bells");
    const context = assembleContext({ ...baseInput(), messages: [said] });
    assert.ok(
      context.recentTurns.includes(`User [${said.id}]: the tide answers the bells`),
      "the id is beside the words, where a citation needs it",
    );
    assert.equal(context.currentUserMessageId, CURRENT_MESSAGE_ID);
  });

  /**
   * An id on the Studio's own reply is an invitation to cite it, and a proposition evidenced by
   * this app's earlier prose is a claim about a claim — an inference from two turns ago coming
   * back as a fact the user is told they asked for. The verifier refuses those; this keeps the
   * model from spending a turn writing one.
   */
  it("gives the Studio's own replies no id to cite", () => {
    const reply = message("studio", "the bells ring at slack water");
    const context = assembleContext({ ...baseInput(), messages: [reply] });
    assert.ok(context.recentTurns.includes("Studio: the bells ring at slack water"));
    assert.ok(!context.recentTurns.includes(reply.id), "nothing the Studio said is evidence");
  });

  /**
   * A group operation names a grp_... id and its expected revision, and an update restates the
   * whole group. Rendering only candidates meant the model could create a group and never touch
   * one again; rendering it without its rationale and membership was barely better, because an
   * update would then have to invent both — and an invented membership validates, silently
   * re-forming which propositions must land together.
   */
  it("shows live groups with everything an operation on one has to restate", () => {
    const group = {
      id: newId("grp"),
      conversationId: newId("cv"),
      revision: 3,
      title: "Maren's upbringing lands together",
      rationale: "One change, two propositions.",
      members: [
        { candidateId: newId("cand"), revision: 1 },
        { candidateId: newId("cand"), revision: 1 },
      ],
      atomic: true as const,
      status: "live" as const,
    };
    const context = assembleContext({ ...baseInput(), groups: [group] });
    assert.match(context.registry, new RegExp(`\\[${group.id} r3\\]`), "the id and revision to name");
    assert.match(context.registry, /rationale: One change, two propositions\./, "the rationale to restate");
    for (const member of group.members) {
      assert.ok(
        context.registry.includes(`${member.candidateId} r${member.revision}`),
        "and each member, so the grouping is not re-formed by guesswork",
      );
    }
  });

  it("says nothing about groups when there are none, rather than an empty heading", () => {
    assert.ok(!assembleContext(baseInput()).registry.includes("Groups:"));
  });

  it("carries retractions as keys, not as the text that was retracted", () => {
    const tombstone: CandidateTombstone = {
      candidateId: newId("cand") as CandidateId,
      revision: 1,
      structuralKey: "canon.create|new:the whale bone idea",
      payloadDigest: `sha256:${"a".repeat(64)}`,
      retractedByMessageId: newId("msg") as MessageId,
      at: AT,
    };
    const context = assembleContext({ ...baseInput(), tombstones: [tombstone] });

    assert.match(context.tombstones, /canon\.create/);
    assert.match(context.tombstones, /sha256:/);
    assert.ok(
      !context.tombstones.includes("statement"),
      "putting the withdrawn text back in front of the model every turn is the opposite of forgetting it",
    );
  });

  it("gives the same context the same digest, and a changed one a different digest", () => {
    const a = assembleContext(baseInput());
    const b = assembleContext(baseInput());
    const c = assembleContext({ ...baseInput(), currentUserMessage: "something else" });
    assert.equal(a.digest, b.digest);
    assert.notEqual(a.digest, c.digest);
  });

  it("summarises on turn count or on length, whichever comes first", () => {
    assert.equal(shouldSummarise({ turnCount: 8, recentTurnsLength: 10 }), true);
    assert.equal(shouldSummarise({ turnCount: 2, recentTurnsLength: BOUNDS.recentTurns }), true);
    assert.equal(shouldSummarise({ turnCount: 2, recentTurnsLength: 10 }), false);
  });
});

/**
 * Which passages of a document count as one (#70 §5.8, §13.2).
 *
 * The rule has to hold in both directions: windows the model read consecutively are one passage,
 * because a quotation may sit across their join; windows with a gap between them are not, because
 * joining them would manufacture text that appears nowhere in the file and call it evidence.
 */
describe("folding the passages a run read", () => {
  it("joins windows that abut", () => {
    assert.deepEqual(
      mergeAttachmentRanges([
        { offset: 0, text: "the bells " },
        { offset: 10, text: "were whale bone" },
      ]),
      ["the bells were whale bone"],
    );
  });

  it("joins windows that overlap, without repeating the overlap", () => {
    assert.deepEqual(
      mergeAttachmentRanges([
        { offset: 0, text: "the bells were" },
        { offset: 10, text: "were whale bone" },
      ]),
      ["the bells were whale bone"],
    );
  });

  it("keeps windows with a gap apart, so nothing is quotable across what was never read", () => {
    assert.deepEqual(
      mergeAttachmentRanges([
        { offset: 0, text: "the bells" },
        { offset: 500, text: "whale bone" },
      ]),
      ["the bells", "whale bone"],
    );
  });

  it("folds a window wholly inside another into nothing new", () => {
    assert.deepEqual(
      mergeAttachmentRanges([
        { offset: 0, text: "the bells were whale bone" },
        { offset: 4, text: "bells" },
      ]),
      ["the bells were whale bone"],
    );
  });

  it("does not depend on the order they were read in", () => {
    assert.deepEqual(
      mergeAttachmentRanges([
        { offset: 10, text: "were whale bone" },
        { offset: 0, text: "the bells " },
      ]),
      ["the bells were whale bone"],
    );
  });
});

describe("the per-run scratch directory", () => {
  async function appRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "arke-scratch-"));
  }

  it("writes session configuration outside the world", async () => {
    const root = await appRoot();
    const conversationId = newId("cv") as ConversationId;
    const runId = newId("run") as RunId;

    const dir = await createRunScratch({
      appRoot: root,
      conversationId,
      runId,
      config: { mcp: { arke: { url: "http://127.0.0.1:1/mcp/abc" } } },
    });

    assert.equal(dir, runScratchDir(root, conversationId, runId));
    const config = JSON.parse(await readFile(join(dir, "opencode.json"), "utf8"));
    assert.equal(config.mcp.arke.url, "http://127.0.0.1:1/mcp/abc");
    assert.deepEqual(await readdir(dir), ["opencode.json"], "and nothing else is in there");
  });

  it("removes one run without disturbing another", async () => {
    const root = await appRoot();
    const conversationId = newId("cv") as ConversationId;
    const keep = newId("run") as RunId;
    const drop = newId("run") as RunId;
    await createRunScratch({ appRoot: root, conversationId, runId: keep, config: {} });
    await createRunScratch({ appRoot: root, conversationId, runId: drop, config: {} });

    await removeRunScratch(root, conversationId, drop);

    const remaining = await readdir(join(root, "run", "world-chat", conversationId));
    assert.deepEqual(remaining, [keep]);
  });

  it("does not fail when the scratch is already gone", async () => {
    const root = await appRoot();
    const conversationId = newId("cv") as ConversationId;
    const runId = newId("run") as RunId;
    await removeRunScratch(root, conversationId, runId);
    await removeRunScratch(root, conversationId, runId);
  });

  it("sweeps what a crashed process left, and says what it swept", async () => {
    const root = await appRoot();
    const conversationId = newId("cv") as ConversationId;
    const runId = newId("run") as RunId;
    await createRunScratch({ appRoot: root, conversationId, runId, config: {} });

    const swept = await sweepRunScratch(root);
    assert.deepEqual(swept, [`${conversationId}/${runId}`]);
    assert.deepEqual(await readdir(join(root, "run", "world-chat")), []);
  });

  it("sweeps an app that has never run a conversation", async () => {
    assert.deepEqual(await sweepRunScratch(await appRoot()), []);
  });
});
