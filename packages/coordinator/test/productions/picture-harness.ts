import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ClientMessage, DomainEvent, ManifestModel } from "@arke-studio/contracts";
import { BenchStore, sessionDir } from "../../src/bench/store.js";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { LookDeriver } from "../../src/productions/audiobook-look.js";
import type { IllustrateDeriver } from "../../src/productions/audiobook-illustrate.js";
import type { PictureDeriver, PictureDeriverInput } from "../../src/productions/audiobook-picture-suggest.js";
import { pngBytes } from "../queue/fake-provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * The harness the pictures-proposed-by-Arke tests share (design turn 191): a real Coordinator over
 * a copy of the fixture world, the writing service stood in for by its seams, and the job queue
 * stood in for by one that lands a picture the way a finished job lands a Bench take — the
 * session log says the take completed — or fails it, or never lands it.
 */
export const CLOCK = "2026-10-03T09:00:00.000Z";
export const LEDGER = "the-ledger-of-nights";
export const CHAPTER = "04-her-own-hand";
export const IMAGE: ManifestModel = {
  id: "stair-image",
  provider: "fal",
  capability: "image",
  displayName: "Stair Image",
  accepts: { referenceImages: 2, startFrame: false, endFrame: false },
  limits: { aspects: ["16:9", "1:1"], maxPromptChars: 4000 },
  pricing: { kind: "perImage", microUsdPerImage: 40_000, microUsdPerReferenceImage: 5_000 },
};

/** What a job does when the queue is asked for it: land its picture, fail, or hang until cancelled. */
export type Landing = "land" | "fail" | "hold";

export interface Harness {
  worldDir: string;
  events: DomainEvent[];
  send: (message: ClientMessage) => Promise<void>;
  schemaVersion: () => number;
  seen: PictureDeriverInput[];
  enqueued: Array<{ params: Record<string, unknown>; estimatedMicroUsd: number; at: number }>;
  cancelled: string[];
  /** The most jobs that were ever in flight at once: a run made one at a time never holds two. */
  concurrent: () => number;
  store: () => ReturnType<NonNullable<FsWorldProvider["openStore"]>>;
}

export interface HarnessOptions {
  picture?: PictureDeriver;
  look?: LookDeriver;
  illustrate?: IllustrateDeriver;
  model?: ManifestModel | null;
  /** All jobs land, or this says what the nth job (from 0) does. */
  land?: boolean | "fail" | ((n: number) => Landing);
  /** What a failed job says, as the provider would. */
  failure?: string;
  prepare?: (worldDir: string) => Promise<void>;
}

export async function withHarness(run: (h: Harness) => Promise<void>, options: HarnessOptions = {}): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
  await options.prepare?.(worldDir);
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const seen: PictureDeriverInput[] = [];
  const enqueued: Harness["enqueued"] = [];
  const cancelled: string[] = [];
  let inFlight = 0;
  let widest = 0;
  const models = options.model === null ? [] : [options.model ?? IMAGE];
  const behaviour = (n: number): Landing => (typeof options.land === "function" ? options.land(n) : options.land === false ? "hold" : options.land === "fail" ? "fail" : "land");
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-10-03", models },
    observeEvent: (event) => events.push(event),
    pictureDeriver:
      options.picture ??
      (async (input) => {
        seen.push(input);
        return { prompt: "Maren on the rail with Bray beside her, telling a story to fill the quiet; grey dawn.", who: ["maren-kest", "bray-half-hitch", "nobody"], place: null };
      }),
    lookDeriver:
      options.look ??
      (async () => ({ place: { text: "The rail desk at dawn, grey light." }, characters: [{ who: "maren-kest", text: "Oilskin coat, dark with salt." }, { who: "bray-half-hitch", text: "Three belts, a wet cap." }] })),
    ...(options.illustrate !== undefined ? { illustrateDeriver: options.illustrate } : {}),
  });
  (coordinator as unknown as { jobQueue: unknown }).jobQueue = {
    enqueue: async (input: { target: { id: string }; landing: { dir: string }; params: Record<string, unknown>; estimatedMicroUsd: number }) => {
      const n = enqueued.length;
      enqueued.push({ params: input.params, estimatedMicroUsd: input.estimatedMicroUsd, at: Date.now() });
      const what = behaviour(n);
      const id = `jb_01J${String(n).padStart(23, "0")}`;
      const [sessionId, takeId] = input.target.id.split("/") as [string, string];
      const bench = new BenchStore(sessionDir(worldDir, sessionId as never));
      if (what === "hold") return { id };
      inFlight += 1;
      widest = Math.max(widest, inFlight);
      // A job takes a moment, as a real one does: a run that started the next while this was in
      // flight would show here as two at once.
      await new Promise((resolve) => setTimeout(resolve, 15));
      try {
        if (what === "fail") {
          await bench.append({ type: "take-status", takeId: takeId as never, status: "failed", error: options.failure ?? "the provider refused the prompt" }, { at: CLOCK });
          return { id };
        }
        await mkdir(join(worldDir, input.landing.dir), { recursive: true });
        const bytes = pngBytes();
        await writeFile(join(worldDir, input.landing.dir, "made.png"), bytes);
        await bench.append(
          { type: "take-completed", takeId: takeId as never, media: { file: "made.png", hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }, cost: { estimatedMicroUsd: input.estimatedMicroUsd, actualMicroUsd: input.estimatedMicroUsd }, completedAt: CLOCK },
          { at: CLOCK },
        );
        return { id };
      } finally {
        inFlight -= 1;
      }
    },
    cancel: async (jobId: string) => void cancelled.push(jobId),
  };
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ worldDir, events, send, seen, enqueued, cancelled, concurrent: () => widest, schemaVersion: () => provider.openStore!()!.getBundle().meta.schemaVersion, store: () => provider.openStore!() });
  } finally {
    await provider.close();
  }
}

export { WORLD_ID };
