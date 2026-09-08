import assert from "node:assert/strict";
import {it} from "node:test";
import {renderToString} from "react-dom/server";
import {reviewPrompt} from "@arke-studio/contracts";
import {PromptReviewDetails} from "../src/components/prompt-review.js";
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
