import {
  BROWSER_ATTACHMENT_MAX_BYTES, type ModelChoices, type ClientState, type SizeTier,
} from "@arke-studio/contracts";
import { isRemoteSession } from "../remote-session.js";
import type { AttachTarget } from "../../arke-bridge.js";
import { bridge, send, useStoreSelector } from "./core.js";
import type { StoreState } from "./state.js";
import { browserUploadResults, queueRequest } from "./events.js";

export function openWorld(worldId: string): void {
  send({ kind: "open-world", worldId });
}

export function createWorld(input: {
  name: string;
  logline?: string;
  tone?: string;
  genre?: string;
  /** The look chosen at genesis, recorded as world look v1. Absent when it was deferred. */
  artDirection?: string;
  /** The through-line the conversation wrote, born as bible v1. Absent when it wrote none. */
  bible?: string;
  /** Begun from a conversation: its attachments are filed into the world as it opens. */
  genesisId?: string;
  /** The genesis card's models (design turn 153), written into the new world. */
  models?: ModelChoices;
}): void {
  send({ kind: "create-world", ...input });
}

/** Ask the host to open its picker and file whatever is chosen. No path passes through here. */
export function attachFiles(worldId: string, links?: string[], production?: string | null): void {
  send({
    kind: "attach-files",
    worldId,
    ...(links !== undefined ? { links } : {}),
    ...(production !== undefined ? { production } : {}),
  });
}

/**
 * Can this session take a dropped or pasted file? Only the desktop host can — it is the one
 * that can turn a File into somewhere on disk. A browser session says nothing and offers
 * nothing, rather than showing a drop target that would quietly do nothing.
 */
export function hostCanAttach(): boolean {
  return typeof bridge?.attachDropped === "function" && typeof bridge?.attachBytes === "function";
}

/** Conversations accept device bytes through the paired browser's authenticated connection. */
export function canAttachConversationFiles(): boolean { return isRemoteSession() || hostCanAttach(); }

/** An extension for bytes that arrived with none — from what the clipboard said they are. */
const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/pdf": "pdf",
};

function nameFor(file: File): string {
  if (file.name) return file.name;
  return `pasted.${EXT_BY_TYPE[file.type] ?? "bin"}`;
}

/**
 * File what was dropped or pasted. Those with a path behind them go by path; the rest — a
 * clipboard screenshot, a drag out of a web page — are handed over as bytes. Resolves with a
 * reason when something could not be taken, so the composer can say so on the chip rather
 * than swallowing it.
 */
export async function attachHostFiles(
  target: AttachTarget,
  files: readonly File[],
): Promise<ReadonlyArray<{ name: string; reason: string }>> {
  if (isRemoteSession()) {
    const trouble: Array<{ name: string; reason: string }> = [];
    for (const file of files) {
      const name = nameFor(file);
      if (target.kind !== "world-chat-attach") { trouble.push({ name, reason: "Attach this file in a conversation." }); continue; }
      if (file.size === 0 || file.size > BROWSER_ATTACHMENT_MAX_BYTES || name.length > 255) {
        trouble.push({ name, reason: "Choose a non-empty file up to 16 MB with a shorter name." }); continue;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const chunks: string[] = [];
        for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
        const requestId = crypto.randomUUID();
        const reason = await new Promise<string | undefined>(resolve => {
          const finish = (reason?: string) => { clearTimeout(timeout); browserUploadResults.delete(requestId); resolve(reason); };
          const timeout = setTimeout(() => finish("The upload was not confirmed. Check the connection before trying again."), 60_000);
          browserUploadResults.set(requestId, finish);
          if (!send({ kind: "world-chat-upload", requestId, worldId: target.worldId, conversationId: target.conversationId, name, data: btoa(chunks.join("")) }))
            finish("The studio is disconnected. Attach the file again when it reconnects.");
        });
        if (reason) trouble.push({ name, reason });
      } catch { trouble.push({ name, reason: "It could not be read." }); }
    }
    return trouble;
  }
  const host = bridge;
  if (!host?.attachDropped || !host.attachBytes) {
    return files.map((f) => ({ name: nameFor(f), reason: "attaching needs the desktop app" }));
  }
  const trouble: Array<{ name: string; reason: string }> = [];
  let unresolved: number[] = [];
  try {
    unresolved = host.attachDropped(target, files).unresolved;
  } catch {
    unresolved = files.map((_, i) => i);
  }
  for (const index of unresolved) {
    const file = files[index];
    if (!file) continue;
    try {
      const outcome = await host.attachBytes(target, nameFor(file), new Uint8Array(await file.arrayBuffer()));
      if (!outcome.ok) trouble.push({ name: nameFor(file), reason: outcome.reason });
    } catch {
      trouble.push({ name: nameFor(file), reason: "it could not be read" });
    }
  }
  return trouble;
}

/** A paste too long to be a message becomes a note in the world instead of filling the box. */
export async function attachHostText(
  target: AttachTarget,
  text: string,
  name: string,
): Promise<ReadonlyArray<{ name: string; reason: string }>> {
  if (isRemoteSession()) return attachHostFiles(target, [new File([text], name, { type: "text/plain" })]);
  const host = bridge;
  if (!host?.attachBytes) return [{ name, reason: "attaching needs the desktop app" }];
  try {
    const outcome = await host.attachBytes(target, name, new TextEncoder().encode(text));
    return outcome.ok ? [] : [{ name, reason: outcome.reason }];
  } catch {
    return [{ name, reason: "it could not be written" }];
  }
}

/** Ask the host's picker for files to hand to a conversation that has no world yet. */
export function genesisAttachFiles(genesisId: string): void {
  send({ kind: "genesis-attach-files", genesisId });
}

/**
 * The world's key image, from its own name, logline and tone. An ordinary image job: estimated
 * before it runs, in the ledger, cancellable from Activity like anything else that spends.
 *
 * A prompt is sent only when the author changed one (design 64). Sending the box's contents
 * unconditionally would look identical from here and mean something different at the other end:
 * the coordinator reads a present prompt as "the author has decided", and would then skip the
 * art-director rewrite for every generation whose box was merely opened and closed.
 */
export function generateWorldImage(worldId: string, opts: { modelId?: string; prompt?: string; promptReviewId?:string; count?:number } = {}): void {
  send({
    kind: "generate-world-image",
    worldId,
    requestId: queueRequest("generate-world-image"),
    ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
    ...(opts.promptReviewId?{promptReviewId:opts.promptReviewId}:{}),
    ...(opts.count!==undefined?{count:opts.count}:{}),
  });
}

/**
 * Or bring your own: the host opens the picker, and the renderer never sees the bytes. The file
 * chosen becomes the world's key art — a picture picked by name is a decision, not an offer, and
 * landing it as one more candidate to be asked about read as the button doing nothing.
 */
export function uploadWorldImage(worldId: string): void {
  send({ kind: "upload-world-image", worldId, requestId: queueRequest("upload-world-image") });
}

/** Keep one of the candidates. `file` names which, world-relative — absent means the only one. */
export function keepWorldImage(worldId: string, file?: string): void {
  send({ kind: "use-world-image", worldId, ...(file !== undefined ? { file } : {}) });
}

export function discardWorldImage(worldId: string): void {
  send({ kind: "discard-world-image", worldId });
}

/**
 * The world look as a picture. The prompt defaults to the look's own description, so the image
 * and the words it illustrates are written from the same sentence — and can be replaced for one
 * generation from the dialog, where the words are still the author's rather than a model's.
 */
export function generateMasterLook(
  worldId: string,
  options: {
    modelId?: string | undefined;
    prompt?: string | undefined;
    tier?: SizeTier | undefined;
    aspect?: string | undefined;
    /** How many previews to make, 1-4. Absent is one. */
    count?: number | undefined;
  } = {},
): void {
  send({
    kind: "generate-master-look",
    worldId,
    requestId: queueRequest("generate-master-look"),
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(options.tier !== undefined ? { tier: options.tier } : {}),
    ...(options.aspect !== undefined ? { aspect: options.aspect } : {}),
    ...(options.count !== undefined ? { count: options.count } : {}),
  });
}

/** Or bring your own: the host opens the picker, and the renderer never touches the bytes. */
export function uploadMasterLook(worldId: string): void {
  send({ kind: "upload-master-look", worldId, requestId: queueRequest("upload-master-look") });
}

/**
 * Stage an image for a generation to look at (design 67). Same picker, same one-way street: the
 * renderer asks, and learns from the snapshot that a reference is now attached.
 */
export function pickStagedReference(worldId: string, key: string, source?: string | { slug: string; path: string }): void {
  send({
    kind: "pick-staged-reference",
    ...(typeof source === "string" ? { worldFile: source } : source ? { image: source } : {}),
    worldId,
    key,
    requestId: queueRequest("pick-staged-reference"),
  });
}

/** Take it away again — that generation is made from words alone. */
export function clearStagedReference(worldId: string, key: string): void {
  send({ kind: "clear-staged-reference", worldId, key });
}

/** Accepting is a look change: the image lands as the next version's master look. */
export function keepMasterLook(worldId: string, file?: string): void {
  send({ kind: "use-master-look", worldId, ...(file !== undefined ? { file } : {}) });
}

export function discardMasterLook(worldId: string): void {
  send({ kind: "discard-master-look", worldId });
}

/** Move a world out of the library. The folder survives in archive/ — this is not a delete. */
export function archiveWorld(worldId: string): void {
  send({ kind: "archive-world", worldId });
}

export function useArchiveNote(): StoreState["archiveNote"] {
  return useStoreSelector(store => store.archiveNote);
}

/** Copy the sample world this build carries into the library (SPEC-016 R-6). */
export function installSampleWorld(): void {
  send({ kind: "install-sample-world" });
}

export function cancelSampleWorldDownload(): void { send({ kind: "cancel-sample-world-download" }); }
export function discardSampleWorldDownload(): void { send({ kind: "discard-sample-world-download" }); }
export function refreshSampleWorldDownload(): void { send({ kind: "refresh-sample-world-download" }); }

/**
 * Whether there is a sample world to install, and how the last attempt went. Read off the
 * snapshot rather than folded from events: the answer is settled at start-up, so a Settings
 * pane opened much later still gets it.
 */
export function useSampleWorld(): ClientState["app"]["sampleWorld"] | null {
  return useStoreSelector(store => store.state?.app.sampleWorld ?? null);
}

export function reconcileExternalEdit(worldId: string, path: string): void {
  send({ kind: "reconcile-external-edit", worldId, path });
}
