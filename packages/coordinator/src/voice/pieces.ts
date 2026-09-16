import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job, ManifestModel, VoiceAudioFormat } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { joinSpeech, splitForSpeech } from "./service.js";

/**
 * A read over the reader's cap is made in pieces rather than refused (issue 1208).
 *
 * Every hosted reader takes so much text a request — 1,000 characters on Breeze, 2,000 on
 * Voxtral and Fish — and the read paths handed a block over whole, so a sheet section of 1,487
 * characters read fine on one narrator and came back from the next as a provider refusal, after
 * the price had been confirmed. The audiobook already splits a block on its row's cap and joins
 * the parts; this is the same split and the same join for the section and page reads, with the
 * bookkeeping a read needs that a run does not: the pieces go through the queue as jobs of their
 * own and land in whatever order the vendor finishes them, so something has to know which block
 * each belongs to, hand a single block's pieces on as they land, and join a page's before the
 * block is announced.
 */

/**
 * What the reader is sent for one block: the block whole when it fits the row's cap, else in
 * pieces at sentence ends. flac has no join and a page announces a block once, whole, so a flac
 * reader's block goes as it always did rather than in pieces it could never become one file from
 * — the audiobook flags the same block for the same reason.
 */
export function piecesFor(text: string, model: Pick<ManifestModel, "limits">, format: VoiceAudioFormat): string[] {
  const cap = model.limits.maxPromptChars;
  if (cap === undefined || text.length <= cap || format === "flac") return [text];
  return splitForSpeech(text, cap);
}

/** What a piece's job carries to find its block again, frozen into its params beside `part`/`parts`. */
export function pieceParams(blockIndex: number, piece: number, pieces: number): { blockIndex: number; piece: number; pieces: number } {
  return { blockIndex, piece, pieces };
}

/** Which piece of which block a job is, or null for a job that was never a piece. */
export function pieceOf(job: Pick<Job, "params">): { blockIndex: number; piece: number; pieces: number } | null {
  const { blockIndex, piece, pieces } = job.params;
  return typeof blockIndex === "number" && typeof piece === "number" && typeof pieces === "number" ? { blockIndex, piece, pieces } : null;
}

/** The jobs the queue gave a batch of inputs, grouped by block and ordered by piece, for `PieceReads.queued`. */
export function pieceJobs(inputs: readonly Pick<Job, "params">[], jobIds: readonly string[]): Map<number, string[]> {
  const byBlock = new Map<number, string[]>();
  for (const [at, input] of inputs.entries()) {
    const piece = pieceOf(input);
    const jobId = jobIds[at];
    if (piece === null || jobId === undefined) continue;
    const ids = byBlock.get(piece.blockIndex) ?? [];
    ids[piece.piece] = jobId;
    byBlock.set(piece.blockIndex, ids);
  }
  return byBlock;
}

interface Block {
  /** The whole block's cache file, where the joined read lands so the next read is a hit (SPEC-011 R-10). */
  file: string;
  format: VoiceAudioFormat;
  /** A page's block is announced once it is whole; a single block's pieces are heard as they land. */
  page: boolean;
  /** The prose's count, as the block's event states it — never the sum of the vendor's. */
  characters: number;
  /** Every piece's job once the queue has named them, so a block that cannot be made whole stops paying for the rest. */
  jobIds: readonly string[];
  /** Failed before the queue named its jobs: kept only so `queued` can cancel them, and never announced or joined. */
  failed: boolean;
  landed: (string | undefined)[];
  estimatedMicroUsd: number;
}

export type PieceSettled =
  /** No block is waiting on this piece: the read was stopped, its block already failed, or it was queued by an earlier process. */
  | { kind: "orphan" }
  | { kind: "landed"; page: boolean }
  | { kind: "whole"; page: boolean; file: string; characters: number; estimatedMicroUsd: number }
  | { kind: "unjoined"; page: boolean; error: string };

/**
 * The blocks being made in pieces, by request and block. Held in memory only: a read is asked
 * for by an open screen and answered by events, so a piece that lands after a restart has no
 * screen to reach and is left in the cache it landed in.
 *
 * A block is registered before its jobs are queued and told their ids after, because a piece
 * can land before the batch call returns — a fake reader in a test does, and a piece nothing
 * is waiting for is an orphan. A piece can fail in that window too (codex on PR 1210), when
 * its block has no siblings to name: the block is kept, marked failed, and `queued` answers
 * with its jobs for cancelling once the queue has named them.
 */
export class PieceReads {
  private readonly blocks = new Map<string, Block>();

  register(input: { requestId: string; blockIndex: number; pieces: number; file: string; format: VoiceAudioFormat; page: boolean; characters: number }): void {
    const { requestId, blockIndex, pieces, ...block } = input;
    this.blocks.set(key(requestId, blockIndex), { ...block, jobIds: [], failed: false, landed: Array.from({ length: pieces }, () => undefined), estimatedMicroUsd: 0 });
  }

  /**
   * The queue named the jobs: each block learns its pieces' ids, in piece order. A block that
   * failed before this is let go, and its jobs are the answer — the ones still to be cancelled
   * rather than paid for (the failed piece's own is among them; cancelling a job that has
   * ended is nothing).
   */
  queued(requestId: string, jobs: ReadonlyMap<number, readonly string[]>): string[] {
    const cancel: string[] = [];
    for (const [blockIndex, jobIds] of jobs) {
      const id = key(requestId, blockIndex);
      const block = this.blocks.get(id);
      if (block === undefined) continue;
      if (block.failed) {
        this.blocks.delete(id);
        cancel.push(...jobIds);
      } else block.jobIds = jobIds;
    }
    return cancel;
  }

  /** Stopped: nothing that lands for the request is announced or joined. */
  drop(requestId: string): void {
    for (const id of this.blocks.keys()) if (id.startsWith(`${requestId}\n`)) this.blocks.delete(id);
  }

  /**
   * A piece's job failed or was cancelled. The block cannot be made whole, so its other pieces
   * are not worth paying for: the answer names them for cancelling. Null once the block is
   * gone — the siblings we cancelled come back through here too, and are not news.
   */
  failed(job: Job): { page: boolean; cancel: string[] } | null {
    const piece = pieceOf(job);
    const requestId = job.params["requestId"];
    if (piece === null || typeof requestId !== "string") return null;
    const id = key(requestId, piece.blockIndex);
    const block = this.blocks.get(id);
    if (block === undefined || block.failed) return null;
    if (block.jobIds.length === 0) {
      // Before the queue has named the jobs: the failure is news, the siblings are `queued`'s.
      block.failed = true;
      return { page: block.page, cancel: [] };
    }
    this.blocks.delete(id);
    return { page: block.page, cancel: block.jobIds.filter((candidate) => candidate !== job.id) };
  }

  /**
   * A piece's job landed. On the last piece the block is joined under its whole cache file —
   * the read is heard from the pieces, but the next read of the same words is a hit, and a
   * page's block is announced from it.
   */
  async landed(job: Job, store: WorldStore): Promise<PieceSettled> {
    const piece = pieceOf(job);
    const requestId = job.params["requestId"];
    const file = job.landedFiles?.[0];
    if (piece === null || typeof requestId !== "string" || file === undefined) return { kind: "orphan" };
    const id = key(requestId, piece.blockIndex);
    const block = this.blocks.get(id);
    if (block === undefined || block.failed) return { kind: "orphan" };
    block.landed[piece.piece] = file;
    block.estimatedMicroUsd += job.estimatedMicroUsd;
    if (block.landed.filter((landed) => landed !== undefined).length < piece.pieces) return { kind: "landed", page: block.page };
    this.blocks.delete(id);
    try {
      const bytes = await Promise.all(
        block.landed.map(async (rel) => new Uint8Array(await readFile(toExtendedLength(join(store.dir, fromPortable(rel!)))))),
      );
      const joined = joinSpeech(bytes, block.format);
      await store.gateOp(async () => {
        await atomicWriteFile(join(store.dir, fromPortable(block.file)), joined);
      });
      return { kind: "whole", page: block.page, file: block.file, characters: block.characters, estimatedMicroUsd: block.estimatedMicroUsd };
    } catch (error) {
      return { kind: "unjoined", page: block.page, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

const key = (requestId: string, blockIndex: number) => `${requestId}\n${blockIndex}`;
