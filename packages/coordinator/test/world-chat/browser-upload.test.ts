import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { ClientMessageSchema, newId, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { WorldChatAttachmentStore } from "../../src/world-chat/attachments.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

it("device bytes enter the private conversation store and cannot choose a host path",async()=>{
  const {root,worldDir}=await makeTempRoot(),provider=new FsWorldProvider(root),conversationId=newId("cv"),events:DomainEvent[]=[];
  await provider.loadWorld(WORLD_ID);
  const log=new WorldChatStore(conversationDir(worldDir,conversationId));await log.create(conversationId,new Date().toISOString());
  const coordinator=new Coordinator({provider,adapter:null,changeLogPath:join(root,"changes.jsonl"),appVersion:"test",observeEvent:event=>events.push(event)});
  const send=(message:ClientMessage)=>(coordinator as unknown as {handleClientMessage(message:ClientMessage):Promise<void>}).handleClientMessage(message);
  const upload={kind:"world-chat-upload" as const,worldId:WORLD_ID,conversationId,requestId:"browser-upload",name:"../../notes.txt",data:Buffer.from("The harbour remembers.").toString("base64")};
  try {
    await send(ClientMessageSchema.parse(upload));
    const created=(await log.read()).events.map(row=>row.event).find(event=>event.type==='attachment.created');assert.ok(created?.type==='attachment.created');
    assert.equal(created.attachment.fileName,"notes.txt");
    assert.ok(events.some(event=>event.type==="world-chat.upload-result" && event.requestId==="browser-upload" && !event.reason));
    assert.equal(Buffer.from(await new WorldChatAttachmentStore(worldDir).readBytes(created.attachment)).toString(),"The harbour remembers.");
    await send(ClientMessageSchema.parse({...upload,name:"binary.txt",data:Buffer.from([0,0,1,2]).toString("base64")}));
    assert.ok(events.some(event=>event.type==='world-chat.attachment-refused' && event.name==='binary.txt'));
    assert.ok(events.some(event=>event.type==="world-chat.upload-result" && event.reason));
    assert.equal((await log.read()).events.filter(row=>row.event.type==='attachment.created').length,1);
    await send({...upload,worldId:"01ARZ3NDEKTSV4RRFFQ69G5FAV"});
    assert.equal((await log.read()).events.filter(row=>row.event.type==='attachment.created').length,1);
  } finally { await provider.close(); }
});
