import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ReviewAnswerSchema, type HarnessAdapter, type MessagePart, type ReviewAnswer, type ReviewTask } from "@arke-studio/contracts";
import { createPreparedSession, sessionTurnTimeoutMs, type SessionInput } from "./session-files.js";
import { extractJson } from "../canon/ask.js";
import { imageRendition, IMAGE_RUN_ENCODED_BYTES, type ImageRenditionMaker } from "../world-chat/image-rendition.js";

export interface ReviewTaskInput {
  specialist: "script" | "visual";
  prompt: string;
  images: Array<{ block: string; bytes: Uint8Array; extension: string }>;
}
export type ReviewTaskRunner = (input: ReviewTaskInput, signal: AbortSignal,
  receipt: (value: Pick<ReviewTask, "sessionId" | "model" | "provider" | "disclosure">) => Promise<void>) => Promise<ReviewAnswer>;

/** Named, bounded sessions are launched here; no model receives a general-purpose spawn tool. */
export function makeReviewTaskRunner(deps: {
  adapter: HarnessAdapter; sessionInput: SessionInput; scratch: string; maker?: ImageRenditionMaker;
  cloudAllowed(provider: string): Promise<boolean>;
}): ReviewTaskRunner {
  return async (input, signal, receipt) => {
    signal.throwIfAborted();
    const agent = input.specialist === "script" ? "chapter-script-reviewer" : "chapter-visual-reviewer";
    const dir = join(deps.scratch, `chapter-review-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    // Review only the pinned snapshot: never inherit the selected world's memory, tools or authoring skill.
    const isolated = Promise.resolve(deps.sessionInput({ agent })).then(configured => ({ ...configured, agent, skillFamily: "chapter-review", skillModelId: undefined,
      worldQueryUrl: undefined, memoryDir: undefined, authorNotesFile: undefined, researchWeb: false }));
    const session = await createPreparedSession(deps.adapter, dir, isolated,
      { purpose: "ask", agent }, undefined, signal);
    const parts: MessagePart[] = [{ type: "text", text: input.prompt }];
    let provider: string | undefined, disclosure: string | undefined, cloudProvider: string | undefined;
    if (input.images.length) {
      if (deps.adapter.imageInput !== true || deps.adapter.imageInputForSession?.(session.sessionId) !== true)
        throw new Error("The selected visual reviewer cannot inspect images. No image content was sent.");
      const destination = deps.adapter.imageDestinationForSession?.(session.sessionId);
      provider = destination?.provider;
      if (!destination || !provider) throw new Error("The image inspection destination is unknown; no images were sent.");
      if (!destination.local) cloudProvider = provider;
      if (!destination.local && !await deps.cloudAllowed(provider)) throw new Error(`Cloud image inspection is disabled for ${provider}.`);
      disclosure = destination.local ? "Image inspection runs locally." : `Chapter text and selected image renditions are sent to ${provider} for this review.`;
      let encoded = 0;
      for (const image of input.images) {
        const rendered = await imageRendition(image.bytes, image.extension, deps.maker, signal);
        encoded += 4 * Math.ceil(rendered.data.length / 3);
        if (encoded > IMAGE_RUN_ENCODED_BYTES) throw new Error("This visual task exceeds the image inspection byte budget.");
        parts.push({ type: "text", text: `Image block ${image.block}:` },
          { type: "image", mimeType: "image/png", data: Buffer.from(rendered.data).toString("base64") });
      }
    }
    // Durably record the destination before dispatch. This is not a completed inspection receipt.
    await receipt({ sessionId: session.sessionId, ...(session.model ? { model: session.model } : {}),
      ...(provider ? { provider } : {}), ...(disclosure ? { disclosure } : {}) });
    signal.throwIfAborted();
    // Decoding and the durable receipt can take time; recheck immediately before dispatch.
    if (cloudProvider && !await deps.cloudAllowed(cloudProvider)) throw new Error(`Cloud image inspection is disabled for ${cloudProvider}.`);
    signal.throwIfAborted();
    const listen = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
      void deps.adapter.interrupt?.(session.sessionId).catch(() => {});
      listen.abort();
    };
    const completed = (async () => {
      for await (const event of deps.adapter.streamEvents(listen.signal)) {
        if (!("sessionId" in event) || event.sessionId !== session.sessionId) continue;
        if (event.type === "message.completed") return event.text ?? "";
        if (event.type === "session.error") throw new Error(event.message);
      }
      throw new Error("The review session ended without a completed answer.");
    })();
    void completed.catch(() => {});
    let stop!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      stop = () => { interrupt(); reject(new Error("Review cancelled.")); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { interrupt(); reject(new Error("Review task timed out. It was not retried.")); }, sessionTurnTimeoutMs(session.model, 180_000));
    });
    try {
      const answer = await Promise.race([(async () => {
        await deps.adapter.dispatchAsync({ sessionId: session.sessionId, parts });
        return completed;
      })(), cancelled, timeout]);
      signal.throwIfAborted();
      return ReviewAnswerSchema.parse(extractJson(answer));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      listen.abort();
      if (interrupted) await deps.adapter.interrupt?.(session.sessionId).catch(() => {});
    }
  };
}
