import assert from "node:assert/strict";
import {it} from "node:test";
import {renderToString} from "react-dom/server";
import {reviewPrompt} from "@arke-studio/contracts";
import {PromptReviewDetails, ShotPromptProposalDiff} from "../src/components/prompt-review.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import type { ManifestModel } from "@arke-studio/contracts";

it("reviews a staged shot against its production's selection, including a newly added override", () => {
  const selected: ManifestModel={id:"selected-video",displayName:"Production model",provider:"fal",capability:"video",accepts:{referenceImages:1,startFrame:false,endFrame:false},limits:{},pricing:{kind:"unmetered"}};
  const supported: ManifestModel={...selected,id:"supported-video",displayName:"Other model",accepts:{referenceImages:10,startFrame:true,endFrame:true}};
  const snapshot=structuredClone(FIXTURE_STATE);
  snapshot.app.manifest!.models.push(selected,supported);
  snapshot.app.routing.defaults.video=supported.id;
  const production=snapshot.world!.productions[0]!;
  production.meta.models={video:selected.id};
  const targetPath=`productions/${production.meta.id}/scenes/sc_04.json`;
  const after="The first frame uses reference 2, with the final frame on the sea.";
  try {
    __setStateForTest(snapshot);
    let html=renderToString(<ShotPromptProposalDiff before={null} after={after} targetPath={targetPath}/>);
    assert.match(html,/Production model has no first-frame input/);
    assert.match(html,/Production model has no end-frame input/);
    assert.match(html,/accepts 1 image references/);
    production.meta.models.video=supported.id;
    __setStateForTest(snapshot);
    html=renderToString(<ShotPromptProposalDiff before="Before" after={after} targetPath={targetPath}/>);
    assert.doesNotMatch(html,/has no .*frame input|beyond the budget/);
  } finally {__setStateForTest(FIXTURE_STATE);}
});
it("shows model capability notices even when the prompt diff is empty and collapsed", async()=>{
  const review=await reviewPrompt("First frame", "First frame", [], "shot-prompt", {displayName:"Selected model",accepts:{referenceImages:0,startFrame:false,endFrame:false},limits:{}});
  const html=renderToString(<PromptReviewDetails review={review}/>);
  assert.match(html,/role="status">Selected model has no first-frame input/);
  assert.match(html,/No textual changes/);
});
it("names exact quotations and unverified additions without semantic claims",async()=>{
  const review=await reviewPrompt("A harbour","A neon harbour",[]);
  const html=renderToString(<PromptReviewDetails review={review}/>);
  assert.match(html,/unverified/);assert.match(html,/does not mean false/);assert.match(html,/UTF-8 bytes/);assert.match(html,/overflow-wrap:anywhere/);
  assert.doesNotMatch(html,/Cliche detected|Unsupported|token count/);
});

it("keeps a large rewrite collapsed without rendering token rows",async()=>{
  const review=await reviewPrompt("a ".repeat(200),"a extra ".repeat(200),[]);
  const html=renderToString(<PromptReviewDetails review={review}/>);
  assert.match(html,/<details><summary>Review changes/);
  assert.match(html.replaceAll("<!-- -->","").replace(/<[^>]*>/g,""),new RegExp(`${review.hunks.filter(h=>h.op==="add"&&h.support==="unverified").length} additions are unverified`));
  assert.doesNotMatch(html,/<ins>|<del>|Exact source:/);
});

it("counts every rendered unverified addition, including punctuation",async()=>{
  const review=await reviewPrompt("original",",",[]);
  const html=renderToString(<PromptReviewDetails review={review}/>).replaceAll("<!-- -->","").replace(/<[^>]*>/g,"");
  assert.match(html,/1 addition is unverified/);
});
