import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CanonEntrySchema,
  SHEET_SHAPES,
  SheetSchema,
  sheetDir,
  type ConversationActionPrepareIntent,
  type Proposal,
  type Sheet,
  type SheetKind,
  type WorldChatArtDirectionAction,
  type WorldChatCanonAction,
  type WorldChatSheetAction,
} from "@arke-studio/contracts";
import type { ProposalManager } from "../gate/proposals.js";
import { buildSheetContent, editSheetContent } from "../sheets/authoring.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { uniqueSlug } from "../world/slug.js";
import { MarkdownFile } from "../world/text-files.js";
import type { WorldStatePrecondition, WorldStore } from "../world/store.js";
import { entryContent, settleThreadContent } from "../canon/authoring.js";

const sourceFor = (actionId: string): string => `world-chat-action:${actionId}`;

function attendedBy(intent: Pick<ConversationActionPrepareIntent, "actionId" | "conversationId">) {
  return {
    origin: {
      surface: "world-chat",
      gesture: "conversation-action",
      conversationId: intent.conversationId,
    },
    decision: {
      mode: "attended" as const,
      owner: { kind: "world-chat" as const, conversationId: intent.conversationId },
    },
  };
}

function sheetPath(kind: SheetKind, id: string): string {
  return `${sheetDir(kind)}/${id}.md`;
}

async function readLive(store: WorldStore, path: string): Promise<string> {
  const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8").catch(() => null);
  if (raw === null) throw new Error(`${path} does not exist`);
  return raw;
}

function requireCanonLinks(store: WorldStore, links: readonly string[]): void {
  const bundle = store.getBundle();
  for (const link of links) {
    const exists = link.startsWith("CANON-")
      ? bundle.canon.some((entry) => entry.id === link)
      : bundle.sheets.some((sheet) => sheet.id === link);
    if (!exists) throw new Error(`${link} is not in this world`);
  }
}

function requireCanonIds(store: WorldStore, ids: readonly string[]): void {
  const canon = new Set(store.getBundle().canon.map((entry) => entry.id));
  const missing = ids.find((id) => !canon.has(id));
  if (missing) throw new Error(`${missing} is not in this world`);
}

function requireSheetIds(store: WorldStore, ids: readonly string[]): void {
  const sheets = new Set(store.getBundle().sheets.map((sheet) => sheet.id));
  const missing = ids.find((id) => !sheets.has(id));
  if (missing) throw new Error(`${missing} is not in this world`);
}

function requireSheet(store: WorldStore, kind: SheetKind, id: string): Sheet {
  const sheet = store.getBundle().sheets.find((candidate) => candidate.id === id);
  if (!sheet || sheet.type !== kind) throw new Error(`${kind} ${id} is not in this world`);
  return sheet;
}

function assertSheetFields(kind: SheetKind, input: { role?: unknown; billing?: unknown; region?: unknown }): void {
  if (kind !== "character" && (input.role !== undefined || input.billing !== undefined)) {
    throw new Error(`role and billing belong only to character sheets`);
  }
  if (kind !== "location" && input.region !== undefined) throw new Error(`region belongs only to location sheets`);
}

function assertSections(kind: SheetKind, sections: readonly { heading: string }[]): void {
  const allowed = new Set(SHEET_SHAPES[kind].sections.map((section) => section.heading));
  const invalid = sections.find((section) => !allowed.has(section.heading));
  if (invalid) throw new Error(`${invalid.heading} is not a ${kind} sheet section`);
}

/** Materialise one typed Canon operation into the existing proposal authority. */
export async function stageWorldChatCanonAction(
  store: WorldStore,
  gate: ProposalManager,
  intent: Pick<ConversationActionPrepareIntent, "actionId" | "conversationId">,
  action: WorldChatCanonAction,
  precondition?: WorldStatePrecondition,
): Promise<Proposal> {
  const change = action.action.change;
  const source = sourceFor(intent.actionId);
  if (change.operation === "create" || change.operation === "open-thread") {
    const [entryId] = await store.allocateCanonIds(1, source, precondition);
    if (!entryId) throw new Error("a Canon id could not be reserved");
    const links = change.operation === "create" ? change.links : change.consideredEntryIds;
    requireCanonLinks(store, links);
    const content = entryContent({
      id: entryId,
      type: change.operation === "create" ? change.entryType : "thread",
      title: change.title,
      status: change.operation === "create" ? "settled" : "open",
      statement: change.operation === "create"
        ? change.statement
        : threadBody(change.question, change.consideredEntryIds),
      links: [...links],
    });
    return gate.stage(
      {
        kind: "new-canon",
        summary: change.operation === "create" ? `New ${change.entryType}: ${change.title}` : `Thread: ${change.title}`,
        source,
        ...attendedBy(intent),
        preReservedCanonIds: [entryId],
        targets: [{ path: `canon/${entryId}.md`, content }],
      },
      precondition,
    );
  }

  const path = `canon/${change.entryId}.md`;
  const live = await readLive(store, path);
  const doc = MarkdownFile.parse(live);
  const parsed = CanonEntrySchema.parse({ ...doc.data, body: doc.body.trim() });
  if (parsed.retired) throw new Error(`${change.entryId} is retired`);
  let summary: string;
  if (change.operation === "amend") {
    if (change.changes.links) requireCanonLinks(store, change.changes.links);
    doc.setData({
      ...(change.changes.entryType !== undefined ? { type: change.changes.entryType } : {}),
      ...(change.changes.title !== undefined ? { title: change.changes.title } : {}),
      ...(change.changes.links !== undefined ? { links: change.changes.links } : {}),
    });
    if (change.changes.statement !== undefined) doc.setBody(change.changes.statement);
    summary = `Amend ${change.entryId}: ${change.changes.title ?? parsed.title}`;
  } else if (change.operation === "settle-thread") {
    if (parsed.status !== "open" || parsed.type !== "thread") throw new Error(`${change.entryId} is not an open thread`);
    const settled = MarkdownFile.parse(settleThreadContent(live, change.resolvedType, change.statement));
    doc.data = settled.data;
    doc.setBody(settled.body);
    summary = `Settle ${change.entryId}: ${parsed.title}`;
  } else if (change.operation === "set-status") {
    doc.setData(change.change.status === "open"
      ? { type: "thread", status: "open" }
      : { type: change.change.resolvedType, status: "settled" });
    summary = `${change.change.status === "open" ? "Reopen" : "Settle"} ${change.entryId}: ${parsed.title}`;
  } else {
    if (parsed.status !== "open" || parsed.type !== "thread") throw new Error(`${change.entryId} is not an open thread`);
    requireCanonIds(store, change.consideredEntryIds);
    doc.setData({ links: change.consideredEntryIds });
    doc.setBody(threadBody(threadQuestion(parsed.body), change.consideredEntryIds));
    summary = `Update considered entries for ${change.entryId}: ${parsed.title}`;
  }
  return gate.stage(
    {
      kind: change.operation === "settle-thread" ? "canon-settle" : "canon-edit",
      summary,
      source,
      ...attendedBy(intent),
      targets: [{ path, content: doc.serialize() }],
    },
    precondition,
  );
}

const CONSIDERED_MARKER = /\n*Considered when this was asked: [^\n]* — none of them decides it\.\s*$/;

function threadQuestion(body: string): string {
  return body.replace(CONSIDERED_MARKER, "").trim();
}

function threadBody(question: string, considered: readonly string[]): string {
  return [
    question.trim(),
    considered.length > 0
      ? `\nConsidered when this was asked: ${considered.join(", ")} — none of them decides it.`
      : "",
  ].join("\n").trim();
}

function proposedSheetContent(store: WorldStore, sheet: Sheet, changes: {
  name?: string;
  role?: string | null;
  billing?: string | null;
  region?: string | null;
  canonRules?: readonly string[];
  links?: readonly string[];
  sections?: readonly { heading: string; body: string }[];
}): string {
  assertSheetFields(sheet.type, changes);
  assertSections(sheet.type, changes.sections ?? []);
  if (changes.canonRules) requireCanonIds(store, changes.canonRules);
  if (changes.links) requireSheetIds(store, changes.links);
  const sections = Object.fromEntries(sheet.sections.map((section) => [section.heading, section.body]));
  for (const section of changes.sections ?? []) sections[section.heading] = section.body;
  return editSheetContent({
    sheet,
    sections,
    ...(changes.name !== undefined ? { name: changes.name } : {}),
    ...(changes.role !== undefined ? { role: changes.role } : {}),
    ...(changes.billing !== undefined ? { billing: changes.billing } : {}),
    ...(changes.region !== undefined ? { region: changes.region } : {}),
    ...(changes.canonRules !== undefined ? { canonRules: changes.canonRules } : {}),
    ...(changes.links !== undefined ? { links: changes.links.filter((id) => id !== sheet.id) } : {}),
    date: store.now().slice(0, 10),
  });
}

/** Materialise one typed sheet or relationship operation into the existing proposal authority. */
export async function stageWorldChatSheetAction(
  store: WorldStore,
  gate: ProposalManager,
  intent: Pick<ConversationActionPrepareIntent, "actionId" | "conversationId">,
  action: WorldChatSheetAction,
  precondition?: WorldStatePrecondition,
): Promise<Proposal> {
  const change = action.action.change;
  const source = sourceFor(intent.actionId);
  if (change.operation === "create") {
    assertSheetFields(change.sheetType, change);
    assertSections(change.sheetType, change.sections);
    requireCanonIds(store, change.canonRules);
    requireSheetIds(store, change.links);
    const slug = uniqueSlug(change.name, change.sheetType, store.getBundle().sheets.map((sheet) => sheet.id));
    const content = buildSheetContent({
      id: slug,
      type: change.sheetType,
      name: change.name,
      status: "sketch",
      sections: Object.fromEntries(change.sections.map((section) => [section.heading, section.body])),
      canonRules: change.canonRules,
      links: change.links.filter((id) => id !== slug),
      ...(change.productionId !== undefined ? { production: change.productionId } : {}),
      extra: {
        ...(change.role !== undefined ? { role: change.role } : {}),
        ...(change.billing !== undefined ? { billing: change.billing } : {}),
        ...(change.region !== undefined ? { region: change.region } : {}),
      },
      date: store.now().slice(0, 10),
    });
    SheetSchema.parse({ ...MarkdownFile.parse(content).data, sections: MarkdownFile.parse(content).sections() });
    return gate.stage(
      {
        kind: "new-sheet",
        summary: `New ${change.sheetType}: ${change.name}`,
        source,
        ...attendedBy(intent),
        targets: [{ path: sheetPath(change.sheetType, slug), content }],
        ...(change.productionId !== undefined ? { production: change.productionId } : {}),
      },
      precondition,
    );
  }

  if (change.operation === "duplicate") {
    const sheet = requireSheet(store, change.sheetType, change.sheetId);
    if (sheet.retired) throw new Error(`${sheet.name} is retired`);
    const live = await readLive(store, sheetPath(sheet.type, sheet.id));
    const copy = MarkdownFile.parse(live);
    const slug = uniqueSlug(change.newName, sheet.type, store.getBundle().sheets.map((candidate) => candidate.id));
    copy.setData({
      id: slug,
      name: change.newName,
      version: 1,
      status: "sketch",
      origin: { sheet: sheet.id, version: sheet.version },
      created: store.now().slice(0, 10),
      updated: store.now().slice(0, 10),
    });
    return gate.stage(
      {
        kind: "new-sheet",
        summary: `Duplicate ${sheet.name} as ${change.newName} (from v${sheet.version})`,
        source,
        ...attendedBy(intent),
        targets: [{ path: sheetPath(sheet.type, slug), content: copy.serialize() }],
        ...(sheet.production ? { production: sheet.production } : {}),
      },
      precondition,
    );
  }

  if (change.operation === "relationship") {
    const edits = new Map<string, { sheet: Sheet; changes: Parameters<typeof proposedSheetContent>[2] }>();
    const from = requireSheet(store, change.from.sheetType, change.from.sheetId);
    if (change.to.kind === "sheet" && change.to.sheetId === from.id) {
      throw new Error("a sheet cannot relate to itself");
    }
    const fromLinks = new Set(from.links);
    const fromCanon = new Set(from.canonRules);
    if (change.to.kind === "sheet") {
      requireSheetIds(store, [change.to.sheetId]);
      if (change.linkAction === "add" && change.to.sheetId !== from.id) fromLinks.add(change.to.sheetId);
      else fromLinks.delete(change.to.sheetId);
    } else {
      requireCanonIds(store, [change.to.entryId]);
      if (change.linkAction === "add") fromCanon.add(change.to.entryId);
      else fromCanon.delete(change.to.entryId);
    }
    edits.set(from.id, { sheet: from, changes: { links: [...fromLinks], canonRules: [...fromCanon] } });
    for (const prose of change.proseEdits) {
      const sheet = requireSheet(store, prose.sheetType, prose.sheetId);
      const held = edits.get(sheet.id) ?? { sheet, changes: {} };
      held.changes = {
        ...held.changes,
        sections: [...(held.changes.sections ?? []), { heading: prose.sectionHeading, body: prose.body }],
      };
      edits.set(sheet.id, held);
    }
    const targets = [...edits.values()].map(({ sheet, changes }) => ({
      path: sheetPath(sheet.type, sheet.id),
      content: proposedSheetContent(store, sheet, changes),
    }));
    return gate.stage(
      {
        kind: "sheet-edit",
        summary: `${change.linkAction === "add" ? "Add" : "Remove"} relationship from ${from.name}`,
        source,
        ...attendedBy(intent),
        targets,
      },
      precondition,
    );
  }

  const sheet = requireSheet(store, change.sheetType, change.sheetId);
  if (sheet.retired) throw new Error(`${sheet.name} is retired`);
  let content: string;
  let summary: string;
  if (change.operation === "edit") {
    content = proposedSheetContent(store, sheet, change.changes);
    summary = `Edit ${sheet.name}`;
  } else if (change.operation === "rename") {
    content = proposedSheetContent(store, sheet, { name: change.name });
    summary = `Rename ${sheet.name} to ${change.name} — the id and every citation stay`;
  } else if (change.operation === "set-status") {
    const doc = MarkdownFile.parse(await readLive(store, sheetPath(sheet.type, sheet.id)));
    doc.setData({ status: change.status });
    content = doc.serialize();
    summary = `${change.status === "locked" ? "Lock" : "Unlock"} ${sheet.name}`;
  } else {
    if (!sheet.production) throw new Error(`${sheet.name} already belongs to the world`);
    const doc = MarkdownFile.parse(await readLive(store, sheetPath(sheet.type, sheet.id)));
    const next = { ...doc.data };
    delete next["production"];
    doc.data = next;
    doc.setData({});
    content = doc.serialize();
    summary = `Promote ${sheet.name} out of ${sheet.production} and into the world`;
  }
  return gate.stage(
    {
      kind: "sheet-edit",
      summary,
      source,
      ...attendedBy(intent),
      targets: [{ path: sheetPath(sheet.type, sheet.id), content }],
    },
    precondition,
  );
}

export async function stageWorldChatArtDirectionAction(
  store: WorldStore,
  gate: ProposalManager,
  intent: Pick<ConversationActionPrepareIntent, "actionId" | "conversationId">,
  action: WorldChatArtDirectionAction,
  precondition?: WorldStatePrecondition,
): Promise<Proposal> {
  const current = store.getBundle().artDirection;
  const changes = action.action.changes;
  return gate.stageArtDirectionChange(
    changes.description ?? current.description,
    changes.masterLook === "clear" ? null : current.masterLook,
    {
      ...(changes.audio !== undefined ? { audio: changes.audio } : {}),
      ...(changes.failureModes !== undefined ? { failureModes: changes.failureModes } : {}),
      ...(changes.keyArtIntent !== undefined ? { keyArtIntent: changes.keyArtIntent } : {}),
    },
    {
      source: sourceFor(intent.actionId),
      precondition,
      ...attendedBy(intent),
    },
  );
}
