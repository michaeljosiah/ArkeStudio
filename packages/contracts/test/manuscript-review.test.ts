import assert from "node:assert/strict";
import { it } from "node:test";
import { ClientMessageSchema } from "../src/frames.js";
import { ManuscriptReviewSchema, ManuscriptReadingSchema, manuscriptReviewCoverage } from "../src/manuscript-review.js";
const target={worldId:"01J8F3K2QW9VZX4N7M0RTYB6HC",productionId:"book",requestId:"01K00000000000000000000001"};
it("bounds manuscript review requests and refuses unsafe targets or invalid editorial decisions",()=>{
  assert.equal(ClientMessageSchema.safeParse({...target,kind:"manuscript-review-start",brief:"Protect the ending"}).success,true);
  assert.equal(ClientMessageSchema.safeParse({...target,kind:"manuscript-review-start",brief:"x".repeat(6001)}).success,false);
  assert.equal(ClientMessageSchema.safeParse({...target,kind:"manuscript-review-read",productionId:"../other"}).success,false);
  assert.equal(ClientMessageSchema.safeParse({...target,kind:"manuscript-review-decide",reviewId:target.requestId,findingId:"one",decision:"accept-all"}).success,false);
});
it("counts a chapter complete only after every source segment completed and bounds reading outputs",()=>{
  const review=ManuscriptReviewSchema.parse({worldId:target.worldId,productionId:target.productionId,id:target.requestId,version:1,title:"Book",createdAt:"now",updatedAt:"now",brief:"",context:"",contextHash:"hash",snapshotHash:"hash",status:"partial",sources:[{id:"one",file:"one",title:"One",hash:"one",words:100}],tasks:[{id:"first",kind:"reading",chapterId:"one",state:"complete"},{id:"second",kind:"reading",chapterId:"one",state:"interrupted"}],findings:[]});
  assert.equal(manuscriptReviewCoverage(review).chapters,0);assert.equal(manuscriptReviewCoverage(review).stages,1);
  assert.equal(ManuscriptReadingSchema.safeParse({synopsis:"x".repeat(6000),editorial:"x".repeat(6000),strengths:"x".repeat(3000),continuity:"x".repeat(6000),findings:[]}).success,false);
});
