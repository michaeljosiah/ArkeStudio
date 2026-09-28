import assert from "node:assert/strict";
import { it } from "node:test";
import { BROWSER_ATTACHMENT_MAX_BYTES, ClientMessageSchema } from "../src/index.js";
const upload = { kind:"world-chat-upload",worldId:"01ARZ3NDEKTSV4RRFFQ69G5FAV",conversationId:"cv_01ARZ3NDEKTSV4RRFFQ69G5FAV",name:"notes.txt",data:Buffer.from("The harbour remembers.").toString("base64") };
it("browser attachments are bounded bytes and never accept host paths",()=>{
  assert.ok(ClientMessageSchema.safeParse(upload).success);
  for(const fields of [{sourcePath:"C:/private.txt"},{data:""},{data:"bad!"},{data:"a"},{name:"a".repeat(256)}])assert.equal(ClientMessageSchema.safeParse({...upload,...fields}).success,false);
  assert.ok(ClientMessageSchema.safeParse({...upload,data:Buffer.alloc(BROWSER_ATTACHMENT_MAX_BYTES).toString("base64")}).success);
  assert.equal(ClientMessageSchema.safeParse({...upload,data:Buffer.alloc(BROWSER_ATTACHMENT_MAX_BYTES+1).toString("base64")}).success,false);
});
