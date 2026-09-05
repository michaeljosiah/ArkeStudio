import assert from "node:assert/strict";
import {it} from "node:test";
import {renderToString} from "react-dom/server";
import {reviewPrompt} from "@arke-studio/contracts";
import {PromptReviewDetails} from "../src/components/prompt-review.js";
it("names exact quotations and unverified additions without semantic claims",async()=>{
  const review=await reviewPrompt("A harbour","A neon harbour",[]);
  const html=renderToString(<PromptReviewDetails review={review}/>);
  assert.match(html,/unverified/);assert.match(html,/does not mean false/);assert.match(html,/UTF-8 bytes/);assert.match(html,/overflow-wrap:anywhere/);
  assert.doesNotMatch(html,/Cliche detected|Unsupported|token count/);
});
