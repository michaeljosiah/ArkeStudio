import { imageConstraintSuffix, type WorldBundle } from "@arke-studio/contracts";
import { normalizePrompt, promptHash, reviewPrompt, PromptDispatchProvenanceSchema, type PromptSourceSnapshot, type ManifestModel } from "@arke-studio/contracts";
import { randomUUID } from "node:crypto";

export function keyArtCreativeBody(composed:string):string {
  return normalizePrompt(composed).replace(/ No text, no logos(?:, no character portraits)?\.$/,"");
}
export type KeyArtPromptContext={worldId:string;model:Pick<ManifestModel,"id"|"provider">;base:string;fixed:string;sources:PromptSourceSnapshot[];references:unknown};
type Session=KeyArtPromptContext&{id:string;createdAt:number;candidate?:string;contextHash:string};
/** Unapproved creative work lives only in this coordinator session and never becomes world canon. */
export class KeyArtPromptReviews {
  private sessions=new Map<string,Session>();
  private async fingerprint(context:KeyArtPromptContext){return promptHash(JSON.stringify([context.worldId,context.model,context.base,context.fixed,context.sources,context.references]));}
  async begin(context:KeyArtPromptContext){
    for(const [world,s]of this.sessions)if(Date.now()-s.createdAt>3600000)this.sessions.delete(world);
    if(this.sessions.size>=32)this.sessions.delete(this.sessions.keys().next().value!);
    const session:Session={...context,id:randomUUID(),createdAt:Date.now(),contextHash:""};
    this.sessions.set(context.worldId,session);session.contextHash=await this.fingerprint(context);return session;
  }
  cancel(worldId:string){this.sessions.delete(worldId);}
  clear(){this.sessions.clear();}
  async candidate(worldId:string,id:string,text:string|null){
    const session=this.sessions.get(worldId);if(!session||session.id!==id)return null;
    if(text?.trim()&&normalizePrompt(text)!==session.base)session.candidate=normalizePrompt(text);
    return session;
  }
  async approve(context:KeyArtPromptContext,reviewId:string|undefined,body:string|undefined){
    const session=reviewId?this.sessions.get(context.worldId):undefined;
    if(reviewId&&(!session||session.id!==reviewId||Date.now()-session.createdAt>3600000||session.contextHash!==await this.fingerprint(context)))throw new Error("The key-art prompt, sources, references or model changed. Prepare and review the current plan again.");
    const approved=normalizePrompt(body??context.base);
    if(!approved.trim())throw new Error("Write a nonempty creative prompt before generation.");
    const review=await reviewPrompt(context.base,approved,context.sources);
    const approvedFrom=approved===context.base?"assembled":session?.candidate===approved?"candidate":"edited";
    const finalPrompt=`${approved}${context.fixed}`;
    const provenance=PromptDispatchProvenanceSchema.parse({schemaVersion:1,workflow:"world-key-art",assembledHash:review.base.hash,
      ...(session?.candidate?{candidateHash:await promptHash(session.candidate),optimizer:{kind:"harness",purpose:"art-prompt",agent:"art-director"}}:{}),
      approvedHash:review.candidate.hash,approvedFrom,warningSetVersion:1,
      adapter:{provider:context.model.provider,model:context.model.id,version:1,creativePromptHash:await promptHash(finalPrompt),mechanicalSteps:["append application-owned image constraints"]}});
    return {prompt:finalPrompt,provenance,review};
  }
}

export function keyArtReviewContext(bundle:WorldBundle,model:ManifestModel,base:string,references:unknown,hasCast:boolean,briefText?:string):KeyArtPromptContext {
  const sources:PromptSourceSnapshot[]=[];
  const add=(ref:string,text:string|undefined,kind:PromptSourceSnapshot["kind"]="accepted-world")=>{if(text?.trim())sources.push({kind,ref,text});};
  add("world/name",bundle.meta.name);add("world/logline",bundle.meta.logline);add("world/tone",bundle.meta.tone);add("world/genre",bundle.meta.genre);
  add("art-direction",bundle.artDirection.description);
  if(bundle.bible.present)add("bible",bundle.bible.text);
  for(const canon of bundle.canon.filter(c=>c.status!=="open").slice(0,6))add(`canon/${canon.id}`,canon.title);
  for(const sheet of bundle.sheets.filter(s=>s.type==="character"||s.type==="location"))add(`sheet/${sheet.id}`,JSON.stringify(sheet));
  add("key-art/brief",briefText,"user-instruction");
  return {worldId:bundle.meta.worldId,model,base:keyArtCreativeBody(base),sources,references,
    fixed:` No text, no logos${hasCast?"":", no character portraits"}.${imageConstraintSuffix(bundle.artDirection)}`};
}
