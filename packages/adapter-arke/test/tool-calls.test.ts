import test from "node:test";
import assert from "node:assert/strict";
import { recoverToolCall } from "../src/tool-calls.js";

const known = new Set(["read", "list", "search", "write", "edit", "world_search_canon"]);

test("a whole reply that is a call, in the shapes local models write, is read as that call", () => {
  const call = { function: { name: "write", arguments: { path: "a.md", content: "x" } } };
  assert.deepEqual(recoverToolCall('{"name":"write","arguments":{"path":"a.md","content":"x"}}', known), { call });
  assert.deepEqual(recoverToolCall('```json\n{"name":"write","parameters":{"path":"a.md","content":"x"}}\n```', known), { call });
  assert.deepEqual(recoverToolCall('<tool_call>\n{"name":"write","arguments":"{\\"path\\":\\"a.md\\",\\"content\\":\\"x\\"}"}\n</tool_call>', known), { call });
  assert.deepEqual(recoverToolCall('{"function":{"name":"write","arguments":{"path":"a.md","content":"x"}}}', known), { call });
  assert.deepEqual(recoverToolCall('  {"name":"list"}  ', known), { call: { function: { name: "list", arguments: {} } } });
});

test("prose, a call inside prose, and a structured reply are replies, not calls", () => {
  assert.equal(recoverToolCall("The harbour town is Saltlight.", known), null);
  assert.equal(recoverToolCall('I will call {"name":"write","arguments":{}} now.', known), null);
  assert.equal(recoverToolCall('{"reply":"Saltlight it is.","name":"Saltlight"}', known), null, "a field called name is not a tool");
  assert.equal(recoverToolCall('{"title":"The bells"}', known), null);
  assert.equal(recoverToolCall('{"reply": "unterminated', known), null, "broken JSON that names no tool is not ours to judge");
});

test("a call that cannot be read is reported as unreadable, never mended", () => {
  assert.deepEqual(recoverToolCall("<tool_call>{name: write}</tool_call>", known), { unreadable: "the text inside <tool_call> is not valid JSON" });
  assert.deepEqual(recoverToolCall('{"name":"write","arguments":"{path: a.md"}', known), { unreadable: "the arguments for write are not valid JSON" });
  assert.deepEqual(recoverToolCall('{"name":"edit","arguments":[1,2]}', known), { unreadable: "the arguments for edit must be a JSON object" });
  assert.deepEqual(recoverToolCall('<tool_call>{"arguments":{}}</tool_call>', known), { unreadable: "the call does not name a tool" });
});

test("a tagged call to a tool that is not offered is still a call, so the confinement can refuse it", () => {
  assert.deepEqual(recoverToolCall('<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>', known),
    { call: { function: { name: "bash", arguments: { command: "ls" } } } });
});

test("a fenced or bare call to a known tool that is not valid JSON is unreadable, not a reply", () => {
  assert.deepEqual(recoverToolCall('```json\n{"name":"write","arguments":{"path":"a.md","content":"x",}}\n```', known), { unreadable: "the call to write is not valid JSON" });
  assert.deepEqual(recoverToolCall('{"name": "edit", "arguments": {"path": "a.md"', known), null, "not a whole object, so not a call at all");
  assert.deepEqual(recoverToolCall('{"name": "edit", "arguments": {path: "a.md"}}', known), { unreadable: "the call to edit is not valid JSON" });
  assert.equal(recoverToolCall('```json\n{"reply": "Saltlight",}\n```', known), null, "a botched structured reply names no tool");
  assert.equal(recoverToolCall('```json\n{"name": "Saltlight",}\n```', known), null, "nor does one with a name that is not a tool");
});
