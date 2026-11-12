import { createHash } from "node:crypto";
import { describeCoordinatorError } from "../errors/user-message.js";
import type { IllustrateDeriver, IllustrateDeriverInput, RawIllustration } from "./audiobook-illustrate.js";

const SECTION_CHARS = 12_000;
type Block = IllustrateDeriverInput["blocks"][number];

/** Keep sentence identities and their chapter clock while bounding each planning turn. */
function sections(input: IllustrateDeriverInput): Block[][] {
  const result: Block[][] = [];
  let current: Block[] = [], size = 0;
  for (const block of input.blocks) {
    for (const sentence of block.sentences ?? [{ id: `${block.key}#0`, at: block.at, text: block.text }]) {
      if (size && size + sentence.text.length > SECTION_CHARS) { result.push(current); current = []; size = 0; }
      const last = current.at(-1);
      if (last?.key === block.key) current[current.length - 1] = { ...last, text: `${last.text} ${sentence.text}`, sentences: [...last.sentences!, sentence] };
      else current.push({ ...block, at: sentence.at, text: sentence.text, sentences: [sentence] });
      size += sentence.text.length;
    }
  }
  if (current.length) result.push(current);
  return result;
}

/** Like held illustration proposals, completed sections live in this app session until decided. */
export class IllustrationPlanning {
  private readonly held = new Map<string, { fingerprint: string; parts: RawIllustration[] }>();

  discard(key: string): void { this.held.delete(key); }

  async derive(key: string, input: IllustrateDeriverInput, deriver: IllustrateDeriver, signal?: AbortSignal): Promise<RawIllustration> {
    const batches = sections(input);
    if (batches.length <= 1) return deriver(input, signal);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    let plan = this.held.get(key);
    if (plan?.fingerprint !== fingerprint) {
      plan = { fingerprint, parts: [] };
      this.held.delete(key);
      // Retain a bounded set of interrupted chapters, never a growing history of their prose.
      if (this.held.size >= 32) this.held.delete(this.held.keys().next().value!);
      this.held.set(key, plan);
    }
    for (let n = plan.parts.length; n < batches.length; n++) {
      signal?.throwIfAborted();
      const blocks = batches[n]!;
      try {
        // Covered sections may use no slots; thinPictures applies the chapter cap after planning.
        const part = await deriver({ ...input, blocks, section: { number: n + 1, total: batches.length } }, signal);
        signal?.throwIfAborted();
        const names = new Set(blocks.flatMap(block => block.sentences!.map(sentence => sentence.id)));
        plan.parts.push({ pictures: part.pictures.filter(picture => names.has(picture.at ?? `${picture.block}#0`)).slice(0, input.cap),
          ...(part.summary ? { summary: part.summary.slice(0, 600) } : {}) });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`Section ${n + 1} of ${batches.length}: ${describeCoordinatorError(error)}. ${plan.parts.length} completed sections kept in this session; Continue planning retries this section.`);
      }
    }
    return { pictures: plan.parts.flatMap(part => part.pictures), summary: plan.parts.map(part => part.summary ?? "").filter(Boolean).join(" ") };
  }
}
