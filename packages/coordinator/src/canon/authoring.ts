import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Proposal } from "@arke-studio/contracts";
import type { ProposalManager } from "../gate/proposals.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { MarkdownFile } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";

/**
 * Canon authoring flows over the gate (SPEC-006 §2.4, §2.8). Every path here stages or
 * commits through SPEC-004 — nothing special-cases the way into the world (R-3).
 */

export function entryContent(input: {
  id: string;
  type: string;
  title: string;
  status: "settled" | "open";
  statement: string;
  links?: string[];
}): string {
  const doc = MarkdownFile.create(
    {
      id: input.id,
      type: input.type,
      title: input.title,
      status: input.status,
      introducedAt: 0, // the committer stamps the real revision (SPEC-002)
      links: input.links ?? [],
    },
    input.statement.trim(),
  );
  return doc.serialize();
}

/** Stage a new settled entry: id reserved first so the file carries its real number (R-1). */
export async function stageCanonEntry(
  store: WorldStore,
  gate: ProposalManager,
  input: { entryType: string; title: string; statement: string },
): Promise<Proposal> {
  const [reserved] = await store.allocateCanonIds(1, "form");
  return gate.stage({
    kind: "new-canon",
    summary: `New ${input.entryType}: ${input.title}`,
    source: "form",
    preReservedCanonIds: [reserved!],
    targets: [
      {
        path: `canon/${reserved}.md`,
        content: entryContent({
          id: reserved!,
          type: input.entryType,
          title: input.title,
          status: "settled",
          statement: input.statement,
        }),
      },
    ],
  });
}

/** Stage an amendment: the live entry with its statement replaced (R-4). */
export async function stageCanonAmendment(
  store: WorldStore,
  gate: ProposalManager,
  input: { entryId: string; statement: string },
): Promise<Proposal> {
  const path = `canon/${input.entryId}.md`;
  const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  const content = amendCanonContent(live, input.statement);
  const doc = MarkdownFile.parse(content);
  return gate.stage({
    kind: "canon-edit",
    summary: `Amend ${input.entryId}: ${String(doc.data["title"] ?? "")}`,
    source: "form",
    targets: [{ path, content }],
  });
}

/**
 * Open a thread (R-13, R-14, D6): the id is allocated now and the entry lands immediately —
 * one gate-shaped commit — so the number is citable while the question is still open.
 */
export async function openThread(
  store: WorldStore,
  gate: ProposalManager,
  input: { title: string; question: string; candidates: string[] },
): Promise<{ entryId: string }> {
  const [entryId] = await store.allocateCanonIds(1, "ask");

  const body = [
    input.question.trim(),
    input.candidates.length > 0
      ? `\nConsidered when this was asked: ${input.candidates.join(", ")} — none of them decides it.`
      : "",
  ]
    .join("\n")
    .trim();

  const staged = await gate.stage({
    kind: "new-canon",
    summary: `Thread: ${input.title}`,
    source: "ask",
    preReservedCanonIds: [entryId!],
    targets: [
      {
        path: `canon/${entryId}.md`,
        content: entryContent({
          id: entryId!,
          type: "thread",
          title: input.title,
          status: "open",
          statement: body,
          links: input.candidates.filter((c) => c.startsWith("CANON-")),
        }),
      },
    ],
  });
  const outcome = await gate.accept(staged.id);
  if (outcome.status !== "accepted") {
    throw new Error(`opening the thread did not land: ${outcome.status}`);
  }
  return { entryId: entryId! };
}

/** Stage a thread's settlement (R-15): type resolves, status settles, the statement lands. */
export async function stageThreadSettlement(
  store: WorldStore,
  gate: ProposalManager,
  input: { entryId: string; resolvedType: string; statement: string },
): Promise<Proposal> {
  const path = `canon/${input.entryId}.md`;
  const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  const content = settleThreadContent(live, input.resolvedType, input.statement);
  const doc = MarkdownFile.parse(content);
  return gate.stage({
    kind: "canon-settle",
    summary: `Settle ${input.entryId}: ${String(doc.data["title"] ?? "")}`,
    source: "form",
    targets: [{ path, content }],
  });
}

/** Apply only the form-authored amendment to live or already-proposed canon bytes. */
export function amendCanonContent(content: string, statement: string): string {
  const doc = MarkdownFile.parse(content);
  doc.setBody(statement.trim());
  return doc.serialize();
}

/** Apply a direct settlement without disturbing any unread title, links, or other draft content. */
export function settleThreadContent(content: string, resolvedType: string, statement: string): string {
  const doc = MarkdownFile.parse(content);
  doc.setData({ type: resolvedType, status: "settled" });
  doc.setBody(statement.trim());
  return doc.serialize();
}
