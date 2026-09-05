import { z } from "zod";
import { FullSha256Schema } from "./audio.js";

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
  hunks:z.array(PromptDiffHunkSchema),characterDelta:z.number().int(),utf8ByteDelta:z.number().int(),warningSetVersion:z.literal(1)}).strict();
export type PromptReview=z.infer<typeof PromptReviewSchema>;
export type PromptSourceSnapshot={kind:"accepted-world"|"user-instruction";ref:string;text:string};
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
function tokens(text:string):Token[]{return Array.from(text.matchAll(/\s+|[\p{L}\p{N}_'-]+|[^\s\p{L}\p{N}_'-]+/gu),m=>({text:m[0],start:m.index,end:m.index+m[0].length}));}
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
export async function reviewPrompt(baseText:string,candidateText:string,sources:readonly PromptSourceSnapshot[],workflow:PromptReview["workflow"]="world-key-art"):Promise<PromptReview>{
  const [base,candidate]=await Promise.all([promptLayer(baseText),promptLayer(candidateText)]);
  const verified=await Promise.all(sources.map(async s=>({...s,text:normalizePrompt(s.text),hash:await promptHash(s.text)})));
  const sourceTerms=new Set(verified.flatMap(s=>[...terms(s.text)]));
  const groups:Array<{op:"add"|"delete";text:string;start:number;end:number}>=[];let adjacent=false;
  for(const edit of edits(tokens(base.text),tokens(candidate.text))){
    if(edit.op==="equal"){adjacent=false;continue;}
    const previous=groups.at(-1),t=edit.token;
    if(adjacent&&previous?.op===edit.op&&previous.end===t.start){previous.text+=t.text;previous.end=t.end;}
    else groups.push({op:edit.op,text:t.text,start:t.start,end:t.end});adjacent=true;
  }
  const hunks:PromptReview["hunks"]=groups.map(g=>{
    if(g.op==="delete")return {op:"delete",text:g.text,beforeStart:g.start,beforeEnd:g.end};
    const quote=g.text.trim(), evidence=quote?verified.filter(s=>s.text.includes(quote)).map(s=>({kind:s.kind,ref:s.ref,sourceHash:s.hash,quote})):[];
    const added=terms(g.text), warnings=PROMPT_WARNING_TERMS.filter(term=>added.has(term)&&!sourceTerms.has(term)).map(term=>`Added style term: "${term}"`);
    return {op:"add",text:g.text,afterStart:g.start,afterEnd:g.end,support:evidence.length?"exact-source":"unverified",sources:evidence,warnings};
  });
  return PromptReviewSchema.parse({schemaVersion:1,workflow,base,candidate,hunks,characterDelta:candidate.characters-base.characters,utf8ByteDelta:candidate.utf8Bytes-base.utf8Bytes,warningSetVersion:PROMPT_WARNING_SET_VERSION});
}
