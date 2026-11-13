import assert from "node:assert/strict";
import { test } from "node:test";
import { compileAudiobookPerformance, groupedText, packTurns, groupReads, recogniseDirection, directionSchemaVersion, needsExpressiveDirection, type AudiobookBlock, type CadencePlan, type ManifestModel } from "../src/index.js";

const model: ManifestModel = { id: "gemini-3.8-flash-tts", provider: "google", capability: "voice-tts", displayName: "Gemini Flash",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: { maxSpeechUtf8Bytes: 7000, audioFormat: "wav" }, pricing: { kind: "perCharacter", microUsdPerCharacter: 1 },
  cadence: { deliveries: ["measured", "whispered"], speed: null, pause: "best-effort-audio-tag", breath: "best-effort-audio-tag", emphasis: "best-effort-capitalization", outputTimestamps: "none", phrase: "best-effort-instruction", tagSyntax: "angle", groupable: true,
    sounds: { snorts: "snort" }, deliveryMappings: { measured: { settings: {} }, whispered: { settings: {}, instruction: "Whispering." } } } };
const book = { reading: "performed" as const, notes: { Zeb: "dry British delivery", Jace: "calm stoic American delivery" } };
const reading = { book: "natural American narration" };
const block = (rows: AudiobookBlock["rows"]): AudiobookBlock => ({ key: "p0.0", paragraph: 0, text: rows!.map(r=>r.text).join(" "), rows });
const plan = (cues: CadencePlan["cues"]): CadencePlan => ({ schemaVersion: 1, sourceTextHash: `sha256:${"0".repeat(64)}`, speed: 1, cues });

test("Gemini styles dialogue and substantial narration separately in one request", () => {
  const input = block([{ text: '"Two metres left."', speaker: "Zeb" }, { text: "Zeb pointed at the slope without checking his GPS." }, { text: '"Bury it flat."', speaker: "Zeb" }]);
  const result = compileAudiobookPerformance(input, book, null, model, reading)!;
  assert.equal(result.parts.length, 1);
  assert.deepEqual(result.styledParts, [[
    { text: '"Two metres left."', instructions: "dry British delivery" },
    { text: "Zeb pointed at the slope without checking his GPS.", instructions: "Natural American narration." },
    { text: '"Bury it flat."', instructions: "dry British delivery" },
  ]]);
  assert.equal(result.parts[0], result.styledParts![0]!.map(t=>t.text).join("\n\n"));
  assert.equal(compileAudiobookPerformance(input, { ...book, reading: "narrator" }, null, model), null);
});

test("repeated words, local emotion and boundary cues preserve speaker and source anchors", () => {
  const input = block([{ text: '"Stay."', speaker: "Zeb" }, { text: "He waited." }, { text: '"Stay. Move."', speaker: "Jace" }]);
  const start = input.text.lastIndexOf("Stay.");
  const result = compileAudiobookPerformance(input, book, plan([
    { kind: "pause", at: 7, length: "short" },
    { kind: "breath", at: start-1, action: "inhale" },
    { kind: "delivery", span: { from: start, to: start+5, text: "Stay." }, delivery: "whispered" },
  ]), model, reading)!;
  const turns = result.styledParts!.flat();
  assert.equal(turns[0]!.instructions, "dry British delivery");
  assert.match(turns[0]!.text, /<short pause>/);
  assert.equal(turns[1]!.instructions, "Natural American narration.");
  const whisper = turns.find(t=>t.instructions?.includes("Whispering"))!;
  assert.equal(whisper.text, '<breath> "Stay.');
  assert.match(whisper.instructions!, /calm stoic American delivery/);
  assert.equal(turns.at(-1)!.instructions, "calm stoic American delivery");
  assert.equal(turns.map(t=>t.text).join(" ").match(/<breath>/g)?.length, 1);
  assert.deepEqual(result.held, []);
});

test("scoped and grouped reads retain identical style, including explicit narrator returns", () => {
  const inputs = [block([{ text: "Hold.", speaker: "Zeb" }]), { ...block([{ text: "He waited." }, { text: "Move.", speaker: "Jace" }]), key: "p1.0" }];
  const compiled = inputs.map(input=>compileAudiobookPerformance(input, book, null, model, reading)!);
  const blocks = compiled.map((c,i)=>({key: inputs[i]!.key,reader:"one-voice",parts:c.styledParts!.flat().map(t=>({text:t.text,style:t.instructions}))}));
  const packed = packTurns(blocks,"deltas");
  assert.deepEqual(packed.map(({keys: _keys,...turn})=>turn), compiled.flatMap(c=>c.styledParts!.flat()));
  assert.equal(groupReads(blocks).length,1);
  assert.match(groupedText(packed), /Hold\.\n\nHe waited\.\n\nMove\./);
});

test("oversized Unicode turns count style bytes and establish identity in every part", () => {
  const input = block([{text:"Écoutez. ".repeat(120).trim(),speaker:"Zeb"}]);
  const result=compileAudiobookPerformance(input,book,null,{...model,limits:{maxSpeechUtf8Bytes:210}},reading)!;
  assert.ok(result.parts.length>1);
  for(const turns of result.styledParts!){assert.ok(Buffer.byteLength(turns.map(t=>t.text).join("\n\n"))+Buffer.byteLength(turns.map(t=>t.instructions??"").join(" "))<=210);assert.ok(turns.every(t=>t.instructions==="dry British delivery"));}
  assert.equal(result.styledParts!.flat().map(t=>t.text).join(" "),input.text);
});

test("mismatched cast refuses; an unvoiced character returns to narration; legacy scaffolding is cleaned", () => {
  assert.throws(()=>compileAudiobookPerformance({...block([{text:"Old."}]),text:"New."},book,null,model),/cast it again/);
  const input=block([{text:"Hello.",speaker:"Unknown"}]);
  assert.equal(compileAudiobookPerformance(input,book,null,model,reading)!.styledParts![0]![0]!.instructions,"Natural American narration.");
  const legacy={...book,notes:{Unknown:"same narrator throughout, slight pitch lift, retain male timbre"}};
  assert.equal(compileAudiobookPerformance(input,legacy,null,model,reading)!.styledParts![0]![0]!.instructions,"slight pitch lift");
});

test("new vocal events require a newer reader while old expressive controls retain their boundary", () => {
  for(const tag of ["<grunt>","<heavy breath>","<snicker>","<whimper>"]){const parsed=recogniseDirection("Wait. "+tag+" Move.");assert.equal(parsed.text,"Wait. Move.");assert.ok(needsExpressiveDirection({cues:parsed.cues}));assert.equal(directionSchemaVersion({cues:parsed.cues}),82);}
  assert.equal(directionSchemaVersion({cues:[{kind:"sound",sound:"snorts",at:0}]}),78);
});

test("grouping respects the turn cap even for extremely short dialogue", () => {
  const blocks=Array.from({length:3},(_,i)=>({key:String(i),reader:"one",parts:Array.from({length:180},()=>({text:"Yes.",style:"calm"}))}));
  const groups=groupReads(blocks,"deltas",{inputTokens:100000,speechSeconds:10000});
  assert.equal(groups.length,2);assert.ok(groups.every(g=>g.turns.length<=400));
});


test("a word-only delivery selection keeps quote punctuation with its words", () => {
  const input=block([{text:'"Stay."',speaker:"Jace"}]);
  const result=compileAudiobookPerformance(input,book,plan([{kind:"delivery",span:{from:1,to:5,text:"Stay"},phrase:"firm"}]),model,reading)!;
  assert.equal(result.styledParts![0]!.length,1);
  assert.equal(result.styledParts![0]![0]!.text,input.text);
  assert.match(result.styledParts![0]![0]!.instructions!,/Firm/);
});
