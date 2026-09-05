import assert from "node:assert/strict";
import { it } from "node:test";
import { AudioEntrySchema, audioSourceOf, calculateDialogueTiming, DialogueTimingIntentSchema, dialogueTimingProblems, resolvedAuthoredDuration } from "../src/index.js";
const slot={shotId:"sh_a",startSec:2,endSec:6,source:"shot-duration" as const};
it("physical trim, lead-in and reaction handle retain full precision",()=>{
  const result=calculateDialogueTiming(slot,5,0.125,DialogueTimingIntentSchema.parse({sourceRange:{inSec:1,outSec:4.123},postHandle:{kind:"reaction",durationSec:0.5}}));
  assert.ok(result.ok); assert.equal(result.timing.spokenSec,3.123);assert.equal(result.timing.requiredMinimumSec,3.748);
  assert.equal(result.timing.speechStartSec,2.125);assert.equal(result.timing.deltaSec,0.2519999999999998);
  assert.equal(resolvedAuthoredDuration({}),4);assert.equal(resolvedAuthoredDuration({durationSec:2.123}),2.123);
  assert.equal(calculateDialogueTiming(slot,null,0).ok,false);assert.equal(calculateDialogueTiming(slot,2,-1).ok,false);
  assert.equal(calculateDialogueTiming(slot,2,0,DialogueTimingIntentSchema.parse({sourceRange:{inSec:0,outSec:3}})).ok,false);
});
it("overlap needs two positive mutually approved intervals and cannot exceed the timeline",()=>{
  const second={...slot,shotId:"sh_b",startSec:6,endSec:10};
  const a=calculateDialogueTiming(slot,5,0,DialogueTimingIntentSchema.parse({overflow:{mode:"overlap",withShotId:second.shotId}}));
  const b=calculateDialogueTiming(second,2,0,DialogueTimingIntentSchema.parse({overflow:{mode:"overlap",withShotId:slot.shotId}}));
  assert.ok(a.ok&&b.ok);assert.deepEqual(dialogueTimingProblems([a.timing,b.timing],[slot,second],10),[]);
  const one={...b.timing,intent:DialogueTimingIntentSchema.parse({})};
  assert.match(dialogueTimingProblems([a.timing,one],[slot,second],10).join(" "),/mutual/);
  assert.match(dialogueTimingProblems([a.timing,b.timing],[slot,second],6).join(" "),/exceeds the production/);
});
it("legacy sources remain readable while multiple source representations refuse",()=>{
  const old=AudioEntrySchema.parse({takeId:"tk_01ARZ3NDEKTSV4RRFFQ69G5FAV",offsetSec:0});
  assert.deepEqual(audioSourceOf(old),{kind:"take",takeId:old.takeId});assert.equal(old.source,undefined);
  assert.equal(AudioEntrySchema.safeParse({...old,source:{kind:"performance",performanceId:"pf_01ARZ3NDEKTSV4RRFFQ69G5FAV"}}).success,false);
});
