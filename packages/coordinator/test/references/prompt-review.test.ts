import assert from "node:assert/strict";
import { it } from "node:test";
import { KeyArtPromptReviews, keyArtCreativeBody, type KeyArtPromptContext } from "../../src/references/prompt-review.js";
import { promptHash } from "@arke-studio/contracts";
const context:KeyArtPromptContext={worldId:"world",model:{id:"model",provider:"fal"},base:"A quiet harbour.",fixed:" No text, no logos.",sources:[{kind:"accepted-world",ref:"world/tone",text:"quiet"}],references:[]};
it("draft review is session-only and approval freezes exact body plus fixed constraints",async()=>{
  const reviews=new KeyArtPromptReviews(),session=await reviews.begin(context);
  await reviews.candidate(context.worldId,session.id,"A neon harbour.");
  const approved=await reviews.approve(context,session.id,"A neon harbour.");
  assert.equal(approved.prompt,"A neon harbour. No text, no logos.");assert.equal(approved.provenance.approvedFrom,"candidate");
  assert.equal(approved.provenance.adapter.creativePromptHash,await promptHash(approved.prompt));
  const base=await reviews.approve(context,session.id,context.base);assert.equal(base.provenance.approvedFrom,"assembled");
  const edited=await reviews.approve(context,session.id,"My edited harbour. ");assert.equal(edited.provenance.approvedFrom,"edited");assert.match(edited.prompt,/harbour\.  No text/);
  await assert.rejects(reviews.approve({...context,base:"Changed world"},session.id,context.base),/changed/);
  await assert.rejects(reviews.approve({...context,references:["new image"]},session.id,context.base),/changed/);
  reviews.cancel(context.worldId);await assert.rejects(reviews.approve(context,session.id,context.base),/changed/);
  assert.equal((await new KeyArtPromptReviews().approve(context,undefined,undefined)).prompt,"A quiet harbour. No text, no logos.","legacy dispatch uses assembled text without hidden drafting");
  assert.equal(keyArtCreativeBody("A place. No text, no logos, no character portraits."),"A place.");
});
