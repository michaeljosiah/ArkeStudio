import { mkdir, rm } from "node:fs/promises";
import { createPreparedSession, type SessionInput } from "../harness/session-files.js";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HarnessAdapter, WorldMeta } from "@arke-studio/contracts";
import { extractJson } from "../canon/ask.js";
import { bibleExcerpt } from "./key-art-references.js";
import { toExtendedLength } from "../world/paths.js";

/**
 * The art director: one harness turn that turns what a world *is* into a prompt an image model
 * can use.
 *
 * Concatenating the logline and posting it at an image model is a weak prompt — the logline is
 * written for a reader ("a drowned god still sings") and an image model wants a subject, a
 * light, a lens and a material. A writing model is good at that translation, and we already
 * have one running.
 *
 * It is a suggestion, never a gate: if the harness is down, slow, or answers with something
 * that is not a prompt, the caller falls back to the plain assembly and the picture is still
 * made. Nothing here is allowed to be the reason a button does nothing.
 */

/**
 * Measured, not guessed. The first real run answered in 93 seconds and I had given up at 45,
 * so the plain assembly went to the image model while a perfectly good prompt was still being
 * written. Extraction allows 120s for the same kind of turn; this matches it.
 */
const WALL_CLOCK_MS = 120_000;

/**
 * What the art director is told. Only what the world itself says — no invented context. The
 * bible, the cast in frame and the key-art brief joined once a founding conversation left
 * them (SPEC-031 R-58): a picture assembled from a logline and two adjectives is a picture
 * of a genre, and the world just spent a conversation becoming specific.
 */
export function worldBrief(
  meta: WorldMeta,
  canonLines: readonly string[],
  extras: { bible?: string; cast?: readonly string[]; keyArtBrief?: string } = {},
): string {
  const bible = extras.bible !== undefined ? bibleExcerpt(extras.bible, 600) : "";
  const lines = [
    `World: ${meta.name}`,
    meta.logline?.trim() ? `Logline: ${meta.logline.trim()}` : "",
    meta.tone?.trim() ? `Tone: ${meta.tone.trim()}` : "",
    meta.genre?.trim() ? `Genre: ${meta.genre.trim()}` : "",
    bible !== "" ? `The story's argument: ${bible}` : "",
    (extras.cast?.length ?? 0) > 0
      ? `In frame, identities supplied as reference images: ${extras.cast!.join(", ")}`
      : "",
    extras.keyArtBrief?.trim() ? `The image the author asked for: ${extras.keyArtBrief.trim()}` : "",
    canonLines.length > 0 ? `Established, and binding:\n${canonLines.map((l) => `- ${l}`).join("\n")}` : "",
  ];
  return lines.filter((l) => l.length > 0).join("\n");
}

export function makeArtDirector(
  adapter: HarnessAdapter,
  sessionInput: SessionInput,
  scratchRoot: string,
  options: {
    /** Which roster agent answers. The default is the key-art writer this file was born for. */
    agent?: "art-director" | "prompt-enhancer" | "lyricist" | "conversation-namer";
    /**
     * The JSON key the answer arrives under. Every agent here replies with one string in one
     * object; they disagree only about what to call it, and a lyricist answering {"prompt":…}
     * would be describing a song rather than writing one.
     */
    answerKey?: "prompt" | "lyrics" | "title";
    /** The longest answer accepted. Key art allows a complete single-image prompt; the enhancer's
        ceiling is the chosen model's own published cap, so a long valid rewrite is never
        thrown away as "no answer". */
    maxChars?: number;
    /**
     * How long to wait. The default is the measured one below, which is right for a turn whose
     * answer is the thing the person pressed a button for. A caller whose answer is a nicety —
     * a conversation's name, written while the real turn runs — waits a fraction of it, because
     * nothing is improved by holding a list refresh open for two minutes to relabel one row.
     */
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): (brief: string) => Promise<string | null> {
  const key = options.answerKey ?? "prompt";
  const PromptSchema = z.object({ [key]: z.string().min(1).max(options.maxChars ?? 6000) });
  return async (brief) => {
    const root=resolve(scratchRoot), sandbox=join(root,`art-${randomUUID()}`);
    let created=false, deadline:ReturnType<typeof setTimeout>|undefined;
    const abort=new AbortController();
    const cancelled=()=>abort.abort(options.signal?.reason);
    options.signal?.addEventListener("abort",cancelled,{once:true});
    try {
      options.signal?.throwIfAborted();
      await mkdir(toExtendedLength(root),{recursive:true});
      await mkdir(toExtendedLength(sandbox));created=true;
      const session=await createPreparedSession(adapter,sandbox,sessionInput({}),{purpose:"art-prompt",agent:options.agent??"art-director"});
      options.signal?.throwIfAborted();
      let finalText="";
      const collected=(async()=>{
        for await(const event of adapter.streamEvents(abort.signal)) {
          if (!("sessionId" in event)||event.sessionId!==session.sessionId)continue;
          if(event.type==="message.completed"){finalText=event.text??"";return;}
          if(event.type==="session.error")throw new Error("The drafting harness reported a failure.");
        }
        abort.signal.throwIfAborted();
      })();
      // Attach rejection handling before dispatch, whose receipt can itself be delayed.
      const outcome=collected.then(()=>({ok:true as const}),()=>({ok:false as const}));
      const stopped=new Promise<never>((_,reject)=>{
        abort.signal.addEventListener("abort",()=>reject(new Error("Prompt drafting stopped.")),{once:true});
        deadline=setTimeout(()=>abort.abort(),options.timeoutMs??WALL_CLOCK_MS);
      });
      const work=(async()=>{
        await adapter.dispatchAsync({sessionId:session.sessionId,parts:[{type:"text",text:brief}]});
        return outcome;
      })();
      const result=await Promise.race([work,stopped]);
      if(!result.ok)return null;
      try {const parsed=PromptSchema.safeParse(extractJson(finalText));return parsed.success?String(parsed.data[key]).trim():null;} catch{return null;}
    } finally {
      clearTimeout(deadline);abort.abort();options.signal?.removeEventListener("abort",cancelled);
      // Only this invocation's UUID directory is ours. Never sweep the shared scratch root.
      const child=relative(root,resolve(sandbox));
      if(created&&!isAbsolute(child)&&!child.startsWith("..")&&/^art-[0-9a-f-]+$/.test(child))await rm(toExtendedLength(sandbox),{recursive:true,force:true}).catch(()=>{});
    }
  };
}
