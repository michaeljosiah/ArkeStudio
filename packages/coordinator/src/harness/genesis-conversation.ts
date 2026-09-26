import { basename, dirname, join } from "node:path";
import { readFile, stat, rm } from "node:fs/promises";
import { CapabilitySchema, GenesisBlueprintSchema, newId, ulid, UlidSchema, type DomainEvent, type GenesisBlueprint, type WorldChatMessage } from "@arke-studio/contracts";
import { z } from "zod";
import { WorldChatStore, conversationDir } from "../world-chat/store.js";
import { foldBlueprint } from "./blueprint.js";
import { sandboxAttachments } from "../artifacts/genesis-attachments.js";
import { kindForFile } from "../artifacts/filing.js";
import { atomicWriteFile, serializeFileMutation } from "../world/atomic.js";

/** The harness owns workspace/, while application records remain outside its confinement. */
export function genesisControlDir(workspace: string): string {
  if (basename(workspace) !== "workspace") throw new Error("A founding workspace must have its own control directory.");
  return dirname(workspace);
}

const FrozenFoundingSchema = z.object({ blueprint: GenesisBlueprintSchema, models: z.record(CapabilitySchema, z.string()).optional() }).strict();
export async function frozenFoundingInput(dir: string) {
  return readFile(join(genesisControlDir(dir), "founding-input.json"), "utf8")
    .then(raw => FrozenFoundingSchema.parse(JSON.parse(raw)))
    .catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
}

export function reserveGenesisWorld(dir: string): Promise<string> {
  const path = join(genesisControlDir(dir), "creation.json");
  return serializeFileMutation(path, async () => {
    const existing = await readFile(path, "utf8").then(raw => UlidSchema.parse(JSON.parse(raw).worldId))
      .catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
    if (existing) return existing;
    const worldId = ulid();
    await atomicWriteFile(path, JSON.stringify({ worldId }) + "\n");
    return worldId;
  });
}

// Founding uses the ordinary conversation journal, so its messages remain readable by world
// chat after handoff. The sandbox owns only the proposed files, never a second permanent log.
const opening = new Map<string, Promise<WorldChatStore>>();
export function genesisConversation(dir: string): Promise<WorldChatStore> {
  const pending = opening.get(dir);
  if (pending) return pending;
  const work = (async () => {
    const log = new WorldChatStore(join(genesisControlDir(dir), ".conversation"));
    let meta = await log.readMeta();
    if (!meta) {
      const existing = await stat(log.metaPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (existing) throw new Error("The founding conversation identity is unreadable.");
      meta = await log.create(newId("cv"), new Date().toISOString());
    }
    await log.append({ type: "conversation.created", title: "Founding the world", entryContext: { kind: "world" } },
      { at: meta.createdAt, requestId: "founding-created" });
    return log;
  })();
  opening.set(dir, work);
  void work.finally(() => opening.delete(dir)).catch(() => {});
  return work;
}

export async function foundingMessages(dir: string): Promise<WorldChatMessage[]> {
  const log = await genesisConversation(dir);
  const { events, problems } = await log.read();
  if (problems.some(p => p.kind !== "torn-tail")) throw new Error("The founding conversation needs repair before it can continue.");
  return events.flatMap(({ event }) => event.type === "founding.message" ? [event.message] : []);
}

export async function recordFoundingMessage(dir: string, role: "user" | "studio", text: string): Promise<WorldChatMessage> {
  const log = await genesisConversation(dir);
  const message: WorldChatMessage = {
    id: newId("msg"), turnId: newId("turn"), role, text, attachmentIds: [], createdAt: new Date().toISOString(),
  };
  await log.append({ type: "founding.message", message }, { at: message.createdAt });
  return message;
}

export async function recordFoundingBlueprint(dir: string, blueprint: GenesisBlueprint): Promise<number> {
  const log = await genesisConversation(dir);
  return (await log.append({ type: "founding.blueprint", blueprint })).envelope.seq;
}

export async function loadGenesisConversation(dir: string, genesisId: string, running = false): Promise<Extract<DomainEvent, { type: "genesis.loaded" }>> {
  const messages = await foundingMessages(dir);
  const log = await genesisConversation(dir);
  const meta = (await log.readMeta())!;
  const { events } = await log.read();
  const revision = events.at(-1)?.seq ?? 0;
  const current = await foldBlueprint(dir);
  const latest = events.findLast(envelope => envelope.event.type === "founding.blueprint")?.event;
  const frozen = await frozenFoundingInput(dir);
  let blueprint = current;
  if (latest?.type === "founding.blueprint") {
    if (current.dropped.includes("draft.json")) {
      blueprint = { ...latest.blueprint, characters: current.characters, locations: current.locations, factions: current.factions, dropped: current.dropped };
    }
    for (const kind of ["characters", "locations", "factions"] as const) {
      const missing = latest.blueprint[kind].filter(entity => current.dropped.includes(`draft/${kind}/${entity.slug}.json`) || current.dropped.includes(`draft/${kind}`));
      blueprint = { ...blueprint, [kind]: [...blueprint[kind].filter(entity => !missing.some(old => old.slug === entity.slug)), ...missing] };
    }
  }
  if (frozen) blueprint = frozen.blueprint;
  const begun = await readFile(join(genesisControlDir(dir), "begun.json"), "utf8").then(raw => {
    const value = JSON.parse(raw) as { worldId?: unknown; form?: unknown };
    if (typeof value.worldId !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.worldId)) throw new Error("The founding handoff needs repair.");
    return { worldId: value.worldId, form: value.form === true };
  }).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
  const complete = begun?.form ? await stat(join(genesisControlDir(dir), "completed.json")).then(() => true)
    .catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return false; throw err; }) : false;
  return {
    type: "genesis.loaded", at: new Date().toISOString(), genesisId, conversationId: meta.id, revision,
    turns: messages.map(m => ({ id: m.id, role: m.role === "user" ? "user" : "gate", text: m.text, at: m.createdAt })),
    blueprint,
    attachments: (await sandboxAttachments(dir)).map(path => ({ name: basename(path), kind: kindForFile(path) })),
    status: running ? "running" : messages.at(-1)?.role === "user" ? "failed" : "completed",
    ...(!running && messages.at(-1)?.role === "user" ? { detail: "The previous reply did not finish. Your message and draft are saved; continue when ready." } : {}),
    ...(begun ? { worldId: begun.worldId } : {}),
    ...(frozen ? { founding: true, frozenModels: frozen.models ?? {} } : {}),
    ...(begun?.form ? { formHandoff: complete ? "completed" as const : "pending" as const } : {}),
  };
}

/** Replays join the same event IDs; a crash can leave a prefix, never a duplicate transcript. */
export async function carryGenesisConversation(dir: string, worldDir: string): Promise<void> {
  const source = await genesisConversation(dir);
  const meta = (await source.readMeta())!;
  const { events, problems } = await source.read();
  if (problems.length) throw new Error("The founding conversation needs repair before handoff.");
  const target = new WorldChatStore(conversationDir(worldDir, meta.id));
  const pointer = join(worldDir, "build", "conversation.json");
  const incomplete = join(target.dir, ".founding-incomplete");
  const completed = await readFile(pointer, "utf8").then(raw => JSON.parse(raw).conversationId === meta.id)
    .catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return false; throw err; });
  if (completed) { await rm(incomplete, { force: true }); return; }
  // A prefix is private until its final flushed event and handoff receipt exist.
  await atomicWriteFile(incomplete, "Founding conversation transfer in progress.\n");
  await target.create(meta.id, meta.createdAt);
  for (const envelope of events) {
    if (envelope.event.type !== "founding.message" && envelope.event.type !== "founding.voice-decision" && envelope.event.type !== "founding.image-decision" && envelope.event.type !== "founding.blueprint" && envelope.event.type !== "founding.decision" && envelope.event.type !== "conversation.created") {
      throw new Error("The founding sandbox contains an unsupported conversation event.");
    }
    await target.append(envelope.event, { at: envelope.at, requestId: `founding:${envelope.eventId}` });
  }
  // The pointer is written only after every append was flushed. Recovery can safely replay.
  await atomicWriteFile(pointer, JSON.stringify({ conversationId: meta.id }) + "\n");
  await rm(incomplete, { force: true });
}
