import { z } from "zod";
import { FullSha256Schema } from "./audio.js";
import type { ManifestModel } from "./manifest.js";
import { multimediaCapacity } from "./reference-budget.js";

export const PROMPT_WARNING_SET_VERSION = 1;
export const PROMPT_WARNING_TERMS = ["neon", "cyberpunk", "epic", "anamorphic"] as const;
export const PromptLayerSchema = z.object({ text:z.string().min(1).max(20000),hash:FullSha256Schema,characters:z.number().int().positive(),utf8Bytes:z.number().int().positive() }).strict();
export const PromptSourceEvidenceSchema = z.object({kind:z.enum(["accepted-world","user-instruction"]),ref:z.string().min(1),sourceHash:FullSha256Schema,quote:z.string().min(1)}).strict();
const DeleteSchema=z.object({op:z.literal("delete"),text:z.string().min(1),beforeStart:z.number().int().nonnegative(),beforeEnd:z.number().int().positive()}).strict();
const AddSchema=z.object({op:z.literal("add"),text:z.string().min(1),afterStart:z.number().int().nonnegative(),afterEnd:z.number().int().positive(),support:z.enum(["exact-source","unverified"]),sources:z.array(PromptSourceEvidenceSchema),warnings:z.array(z.string())}).strict();
export const PromptDiffHunkSchema=z.discriminatedUnion("op",[DeleteSchema,AddSchema]).superRefine((h,ctx)=>{
  if(h.op==="delete"?h.beforeEnd-h.beforeStart!==h.text.length:h.afterEnd-h.afterStart!==h.text.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:"Hunk offsets must cover its exact UTF-16 text."});
  if(h.op==="add" && ((h.support==="exact-source")!==(h.sources.length>0)))ctx.addIssue({code:z.ZodIssueCode.custom,message:"Only exact-source additions carry evidence."});
});
export const PromptReviewSchema=z.object({schemaVersion:z.literal(1),workflow:z.enum(["world-key-art","shot-prompt"]),base:PromptLayerSchema,candidate:PromptLayerSchema,
  hunks:z.array(PromptDiffHunkSchema),characterDelta:z.number().int(),utf8ByteDelta:z.number().int(),warningSetVersion:z.literal(1),capabilityWarnings:z.array(z.string()).optional()}).strict();
export type PromptReview=z.infer<typeof PromptReviewSchema>;
export type PromptSourceSnapshot={kind:"accepted-world"|"user-instruction";ref:string;text:string};
export type PromptCapabilityModel = Pick<ManifestModel, "displayName" | "accepts" | "limits" | "unverified">;

/** Advisory wording checks, not a parser or a dispatch gate (SPEC-012 §2.8). */
export function promptCapabilityWarnings(text: string, model: PromptCapabilityModel): string[] {
  const warnings: string[] = [];
  const name = model.displayName;
  if (!model.accepts.startFrame && /\b(?:first|start|starting|opening)[ -]frame\b/i.test(text))
    warnings.push(`${name} has no first-frame input. Describe the opening as a request; it cannot lock an attached image to the start.`);
  if (!model.accepts.endFrame && /\b(?:last|end|ending|final)[ -]frame\b/i.test(text))
    warnings.push(`${name} has no end-frame input. Describe the ending as a request; it cannot lock an attached image to the end.`);
  const capacity = multimediaCapacity([], model);
  const counts = { image: 0, video: 0, audio: 0 };
  const numbers = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  const ordinals = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  const number = `(?:\\d+|${numbers.join("|")}|${ordinals.join("|")})`;
  const reference = "(?:(image|video|audio)\\s+references?|references?(?:\\s+(images?|videos?|audio))?|pictures?|images?)";
  const count = (raw: string, kind?: string) => {
    const value = /^\d/.test(raw) ? Number.parseInt(raw, 10) : Math.max(numbers.indexOf(raw), ordinals.indexOf(raw));
    const key = kind?.startsWith("video") ? "video" : kind === "audio" ? "audio" : "image";
    counts[key] = Math.max(counts[key], value);
  };
  for (const match of text.toLowerCase().matchAll(new RegExp(`\\b(${number})(?:st|nd|rd|th)?\\s+${reference}\\b`, "g"))) count(match[1]!, match[2] ?? match[3]);
  for (const match of text.toLowerCase().matchAll(new RegExp(`\\b${reference}\\s*#?\\s*(${number})(?:st|nd|rd|th)?\\b`, "g"))) count(match[3]!, match[1] ?? match[2]);
  const limits = {
    image: capacity.imageCeiling,
    video: capacity.videoCeilingSec > 0 ? model.accepts.referenceVideos : 0,
    audio: capacity.audioCeilingSec > 0 ? model.accepts.referenceAudio : 0,
  };
  for (const kind of ["image", "video", "audio"] as const) {
    const limit = limits[kind];
    if (limit !== undefined && counts[kind] > limit)
      warnings.push(`${name} accepts ${limit} ${kind} references; the prompt names reference ${counts[kind]}. References beyond the budget cannot be carried.`);
  }
  const combined = model.limits.maxCombinedReferences;
  if (combined !== undefined && counts.image + counts.video + counts.audio > combined)
    warnings.push(`${name} accepts at most ${combined} combined references across images, video and audio. The prompt names more than that budget.`);
  if (text.split(/[.!?;\n]/).some(clause => /\b(?:reference|picture|image)\b/i.test(clause) && /\b(?:at|after|from|until)\s+(?:\d+:\d+|\d+(?:\.\d+)?\s*(?:s\b|seconds?\b))/i.test(clause)))
    warnings.push(`${name} has no timed reference activation input. Carried references condition the generation; timestamped switches in prose cannot schedule when a reference takes over.`);
  return warnings;
}
export const PromptDispatchProvenanceSchema=z.object({schemaVersion:z.literal(1),workflow:z.enum(["world-key-art","shot-prompt"]),assembledHash:FullSha256Schema,candidateHash:FullSha256Schema.optional(),
  approvedHash:FullSha256Schema,approvedFrom:z.enum(["assembled","candidate","edited"]),warningSetVersion:z.literal(1),
  optimizer:z.object({kind:z.literal("harness"),purpose:z.string().min(1),agent:z.string().min(1)}).strict().optional(),
  adapter:z.object({provider:z.string().min(1),model:z.string().min(1),version:z.literal(1),creativePromptHash:FullSha256Schema,mechanicalSteps:z.array(z.string())}).strict()}).strict();
export function normalizePrompt(text:string):string{return text.replace(/\r\n?/g,"\n");}
export async function promptHash(text:string):Promise<string>{
  const digest=await globalThis.crypto.subtle.digest("SHA-256",new TextEncoder().encode(normalizePrompt(text)));
  return `sha256:${Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("")}`;
}
export async function promptLayer(raw:string):Promise<z.infer<typeof PromptLayerSchema>>{
  const text=normalizePrompt(raw);return PromptLayerSchema.parse({text,hash:await promptHash(text),characters:Array.from(text).length,utf8Bytes:new TextEncoder().encode(text).length});
}
type Token={text:string;start:number;end:number};
function tokens(text:string):Token[]{
  const result:Token[]=[];
  for(const match of text.matchAll(/\s+|[\p{L}\p{N}_'-]+|[^\s\p{L}\p{N}_'-]+/gu)){
    let start=match.index,part="";
    for(const character of match[0]){
      if(part.length+character.length>240){result.push({text:part,start,end:start+part.length});start+=part.length;part="";}
      part+=character;
    }
    if(part)result.push({text:part,start,end:start+part.length});
  }
  return result;
}
type Edit={op:"equal"|"add"|"delete";token:Token};
/** Myers shortest edit script, with a stable deletion-first tie and bounded work/memory. */
function edits(a:Token[],b:Token[]):Edit[]{
  let v=new Map<number,number>([[1,0]]);const trace:Map<number,number>[]=[];let work=0;
  for(let d=0;d<=a.length+b.length;d++){
    trace.push(new Map(v));
    for(let k=-d;k<=d;k+=2){
      if(++work>2000000)throw new Error("This rewrite exceeds the bounded prompt-review diff limit; shorten it before review.");
      let x=k===-d || (k!==d && (v.get(k-1)??-1)<(v.get(k+1)??-1)) ? v.get(k+1)??0 : (v.get(k-1)??0)+1;
      let y=x-k;
      while(x<a.length&&y<b.length&&a[x]!.text===b[y]!.text){x++;y++;}
      v.set(k,x);
      if(x>=a.length&&y>=b.length){
        const result:Edit[]=[];let bx=a.length,by=b.length;
        for(let depth=d;depth>=0;depth--){
          const previous=trace[depth]!,diagonal=bx-by;
          const pk=diagonal===-depth||(diagonal!==depth&&(previous.get(diagonal-1)??-1)<(previous.get(diagonal+1)??-1))?diagonal+1:diagonal-1;
          const px=previous.get(pk)??0,py=px-pk;
          while(bx>px&&by>py){result.push({op:"equal",token:a[--bx]!});by--;}
          if(depth===0)break;
          if(bx===px)result.push({op:"add",token:b[--by]!});else result.push({op:"delete",token:a[--bx]!});
        }
        return result.reverse();
      }
    }
  }
  return [];
}
const terms=(text:string)=>new Set(normalizePrompt(text).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_'-]+/gu)??[]);
export async function reviewPrompt(baseText:string,candidateText:string,sources:readonly PromptSourceSnapshot[],workflow:PromptReview["workflow"]="world-key-art",model?:PromptCapabilityModel):Promise<PromptReview>{
  const [base,candidate]=await Promise.all([promptLayer(baseText),promptLayer(candidateText)]);
  const verified=await Promise.all(sources.map(async s=>({...s,text:normalizePrompt(s.text),hash:await promptHash(s.text)})));
  const sourceTerms=new Set(verified.flatMap(s=>[...terms(s.text)]));
  // Keep a local rewrite together across up to three unchanged words, but stop at a
  // sentence boundary or a long passage. Evidence covers the complete displayed span.
  const regions:Array<{beforeStart:number;beforeEnd:number;afterStart:number;afterEnd:number;added:string;deleted:boolean}>=[];
  let before=0,after=0;
  for(const edit of edits(tokens(base.text),tokens(candidate.text))){
    const length=edit.token.text.length;
    if(edit.op==="equal"){before+=length;after+=length;continue;}
    let region=regions.at(-1);
    const gap=region?candidate.text.slice(region.afterEnd,after):"";
    if(!region || /[.!?;\n]/u.test(base.text.slice(region.beforeStart,before)+candidate.text.slice(region.afterStart,after)) || (gap.match(/[\p{L}\p{N}]+/gu)?.length??0)>3
      || Math.max(after+length-region.afterStart,before+length-region.beforeStart)>240){
      region={beforeStart:before,beforeEnd:before,afterStart:after,afterEnd:after,added:"",deleted:false};
      regions.push(region);
    }
    if(edit.op==="add"){after+=length;region.added+=edit.token.text+" ";}
    else {before+=length;region.deleted=true;}
    region.beforeEnd=before;region.afterEnd=after;
  }
  const groups:Array<{op:"add"|"delete";text:string;start:number;end:number;added:string}>=[];
  for(const [index,region] of regions.entries()){
    for(const op of ["delete","add"] as const){
      if(op==="add"?!region.added:!region.deleted)continue;
      const text=op==="add"?candidate.text:base.text;
      let start=op==="add"?region.afterStart:region.beforeStart,end=op==="add"?region.afterEnd:region.beforeEnd;
      const fragment=text.slice(start,end).trim();
      if(!/[.!?;\n]/u.test(text.slice(start,end)) && (Array.from(fragment).length<12 || (fragment.match(/[\p{L}\p{N}]+/gu)?.length??0)<2)){
        // A lone function word needs its neighbouring words to be readable. Do not steal
        // context from another change or cross a sentence to manufacture a quotation.
        const previous=regions[index-1],next=regions[index+1];
        const floor=previous?(op==="add"?previous.afterEnd:previous.beforeEnd):0;
        const ceiling=next?(op==="add"?next.afterStart:next.beforeStart):text.length;
        let words=0;
        for(const token of tokens(text.slice(floor,start)).reverse()){
          if(/[.!?;\n]/u.test(token.text)||words===2||end-(floor+token.start)>240)break;
          start=floor+token.start;if(/[\p{L}\p{N}]/u.test(token.text))words++;
        }
        words=0;const originalEnd=end;
        for(const token of tokens(text.slice(end,ceiling))){
          if(/[.!?;\n]/u.test(token.text)||words===2||originalEnd+token.end-start>240)break;
          end=originalEnd+token.end;if(/[\p{L}\p{N}]/u.test(token.text))words++;
        }
      }
      groups.push({op,text:text.slice(start,end),start,end,added:region.added});
    }
  }
  const hunks:PromptReview["hunks"]=groups.map(g=>{
    if(g.op==="delete")return {op:"delete",text:g.text,beforeStart:g.start,beforeEnd:g.end};
    const quote=g.text.trim(),characters=Array.from(quote);
    // Certify phrases, not punctuation or fragments of a longer word.
    const phrase=characters.length>=12&&(quote.match(/[\p{L}\p{N}]+/gu)?.length??0)>=2;
    const boundary=/[\p{L}\p{N}_'-]/u;
    const evidence=phrase?verified.filter(s=>{
      for(let at=s.text.indexOf(quote);at!==-1;at=s.text.indexOf(quote,at+1)){
        const before=Array.from(s.text.slice(Math.max(0,at-2),at)).at(-1)??"",after=Array.from(s.text.slice(at+quote.length,at+quote.length+2))[0]??"";
        if(!(boundary.test(characters[0]!)&&boundary.test(before))&&!(boundary.test(characters.at(-1)!)&&boundary.test(after)))return true;
      }
      return false;
    }).map(s=>({kind:s.kind,ref:s.ref,sourceHash:s.hash,quote})):[];
    const added=terms(g.added), warnings=PROMPT_WARNING_TERMS.filter(term=>added.has(term)&&!sourceTerms.has(term)).map(term=>`Added style term: "${term}"`);
    return {op:"add",text:g.text,afterStart:g.start,afterEnd:g.end,support:evidence.length?"exact-source":"unverified",sources:evidence,warnings};
  });
  return PromptReviewSchema.parse({schemaVersion:1,workflow,base,candidate,hunks,characterDelta:candidate.characters-base.characters,utf8ByteDelta:candidate.utf8Bytes-base.utf8Bytes,warningSetVersion:PROMPT_WARNING_SET_VERSION,...(model?{capabilityWarnings:promptCapabilityWarnings(candidate.text,model)}:{})});
}
