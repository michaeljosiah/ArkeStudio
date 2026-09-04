import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ConversationActionTombstoneSchema,
  type ConversationActionCard,
  type ConversationActionTombstone,
} from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";
import { foldConversation } from "../world-chat/fold.js";
import { WorldChatStore } from "../world-chat/store.js";
import { toExtendedLength } from "../world/paths.js";

const TOMBSTONES_FILE = join(".history", "conversation-actions.jsonl");
const writers = new Map<string, WriteQueue>();

function pathFor(worldPath: string): string {
  return join(worldPath, TOMBSTONES_FILE);
}

function writerFor(path: string): WriteQueue {
  const existing = writers.get(path);
  if (existing) return existing;
  const writer = new WriteQueue();
  writers.set(path, writer);
  return writer;
}

function tombstoneFor(action: ConversationActionCard): ConversationActionTombstone | null {
  if (!["completed", "failed", "cancelled", "denied", "stale", "superseded"].includes(action.status)) {
    return null;
  }
  return ConversationActionTombstoneSchema.parse({
    actionId: action.actionId,
    actorId: action.actorId,
    actionKind: action.actionKind,
    status: action.status,
    ...(action.decision
      ? { decision: action.decision.decision, decidedAt: action.decision.decidedAt }
      : {}),
    authority: action.authority,
    payloadDigest: action.payloadDigest,
    previewDigest: action.previewDigest,
    ...(action.receipt
      ? {
          receipt: {
            kind: action.receipt.kind,
            id: action.receipt.id,
            ...(action.receipt.digest ? { digest: action.receipt.digest } : {}),
          },
        }
      : {}),
  });
}

async function repairTornTail(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(path), "utf8");
  } catch {
    return;
  }
  if (raw.length === 0 || raw.endsWith("\n")) return;
  const cut = raw.lastIndexOf("\n");
  const repaired = cut === -1 ? "" : raw.slice(0, cut + 1);
  const temporary = `${path}.repair-${process.pid}`;
  await writeFile(toExtendedLength(temporary), repaired, "utf8");
  await rename(toExtendedLength(temporary), toExtendedLength(path));
}

export async function readConversationActionTombstones(
  worldPath: string,
): Promise<ConversationActionTombstone[]> {
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(pathFor(worldPath)), "utf8");
  } catch {
    return [];
  }
  const tombstones: ConversationActionTombstone[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = ConversationActionTombstoneSchema.safeParse(JSON.parse(line));
      if (parsed.success) tombstones.push(parsed.data);
    } catch {
      /* One damaged audit line cannot hide the valid records around it. */
    }
  }
  return tombstones;
}

export async function appendConversationActionTombstones(
  worldPath: string,
  actions: readonly ConversationActionCard[],
): Promise<void> {
  const tombstones = actions.flatMap((action) => {
    const tombstone = tombstoneFor(action);
    return tombstone ? [tombstone] : [];
  });
  if (tombstones.length === 0) return;
  const path = pathFor(worldPath);
  await writerFor(path).enqueue(async () => {
    await repairTornTail(path);
    const existing = new Set((await readConversationActionTombstones(worldPath)).map((one) => one.actionId));
    const added = tombstones.filter((one) => !existing.has(one.actionId));
    if (added.length === 0) return;
    await mkdir(toExtendedLength(dirname(path)), { recursive: true });
    const handle = await open(toExtendedLength(path), "a");
    try {
      await handle.appendFile(added.map((one) => `${JSON.stringify(one)}\n`).join(""), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

/** Recover the minimum audit before reclaiming a conversation directory renamed by Delete. */
export async function preserveConversationActionTombstones(
  worldPath: string,
  deletedConversationDir: string,
): Promise<void> {
  const store = new WorldChatStore(deletedConversationDir);
  const meta = await store.readMeta();
  if (!meta) return;
  const actions = foldConversation(meta.id, meta.createdAt, (await store.read()).events).view.actions;
  await appendConversationActionTombstones(worldPath, actions);
}
