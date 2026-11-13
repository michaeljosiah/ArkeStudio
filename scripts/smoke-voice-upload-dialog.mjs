// The real cast read and a nested shared sheet, with synthetic consent replies and no provider calls.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { buildClientPage, clientStyles, servePage } from "./lib/client-page.mjs";
import { openChrome, until } from "./lib/chrome.mjs";

const output = resolve("output/voice-upload-dialog-native-283");
await mkdir(output, { recursive: true });
await buildClientPage(output, `${await clientStyles()}
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router";
import {App} from "./App.js";
import {PageSheet} from "./components/page-sheet.js";
import {RemoteVoiceUploadConfirmation} from "./components/remote-voice-upload-confirmation.js";
import {FIXTURE_STATE} from "../test/fixture-state.js";
import {FIXTURE_WORLD_ID} from "./screens/registry.js";
import {__applyEventForTest,__setBridgeForTest,__setStateForTest,__connectionStatusForTest} from "./lib/store.js";
let root;
window.sent=[];
const bridge={appVersion:"smoke",platform:"test",connect(){},subscribe(){return()=>{};},send(raw){window.sent.push(JSON.parse(raw));},coordinatorHttpBase:()=>location.origin};
window.arke=bridge;
function Nested(){const [open,setOpen]=useState(false),[ask,setAsk]=useState(false);return <><button id="outer" onClick={()=>setOpen(true)}>Open reading sheet</button><PageSheet open={open} onClose={()=>setOpen(false)} title="Reading" preserveReturnFocus><button id="inner" onClick={()=>setAsk(true)}>Read aloud</button>{ask&&<RemoteVoiceUploadConfirmation destinationLabel={"voice-box.example:8188/"+"long-destination-".repeat(12)} destinationNotice={"A long destination notice. ".repeat(60)} onCancel={()=>{window.cancelled++;setAsk(false)}} onConfirm={()=>{window.confirmed++;setAsk(false)}}/>}</PageSheet></>}
window.mount=(nested=false)=>{root?.unmount();window.sent=[];window.cancelled=0;window.confirmed=0;__setBridgeForTest(bridge);__setStateForTest(FIXTURE_STATE);__connectionStatusForTest("open");root=createRoot(document.getElementById("root"));root.render(nested?<Nested/>:<MemoryRouter initialEntries={["/w/"+FIXTURE_WORLD_ID+"/cast/maren-kest"]}><App/></MemoryRouter>)};
window.askUpload=()=>{const request=window.sent.filter(m=>m.kind==="read-sheet-section").at(-1);if(!request)throw new Error("No read");__applyEventForTest({type:"voice.upload-confirmation-required",at:"2026-11-13T12:00:00Z",worldId:FIXTURE_WORLD_ID,requestId:request.requestId,command:request.kind,destinationLabel:"Mistral · Harbour glass",confirmationToken:"synthetic-consent-token",destinationNotice:"The recording is sent with each read and not kept by Arke on the service."})};
window.mount();
`);
const server = await servePage(output);
const browser = await openChrome();
const { cdp, evaluate: js } = browser;
const dialog = '[data-testid="remote-voice-upload-confirmation"]';
const wait = expression => until(() => js(expression));
const press = async (key, code, modifiers = 0) => {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, modifiers });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code, modifiers });
};
const focusText = () => js("document.activeElement.textContent.trim()");
const click = selector => js(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});button.focus();button.click()})()`);
const exists = `!!document.querySelector('${dialog}')`;
const results = [];
try {
  await cdp("Page.navigate", { url: server.origin });
  await wait("!!window.mount");
  for (const [name, width, height] of [["phone",390,844],["desktop",1360,820],["short",900,400]]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const dark of [false, true]) {
      await js(`document.documentElement.classList.toggle("dark",${dark});window.mount()`);
      for (const action of ["escape", "backdrop", "cancel", "confirm"]) {
        await wait('!!document.querySelector(\'button[aria-label="Read aloud"]\')');
        await click('button[aria-label="Read aloud"]');
        await wait('window.sent.some(m=>m.kind==="read-sheet-section")');
        await js("window.askUpload()");
        await wait(`${exists} && document.activeElement.textContent.trim()==="Not now"`);
        if (action === "escape") await browser.screenshot(join(output,`${name}-${dark ? "dark" : "light"}-cast.png`));
        assert.ok(await js(`document.querySelector('${dialog}').closest('.fy-editordialog').parentElement===document.body`));
        await press("Tab",9,8);
        assert.equal(await focusText(), "Send recording");
        await press("Tab",9);
        assert.equal(await focusText(), "Not now");
        const before = await js('window.sent.filter(m=>m.kind==="read-sheet-section").length');
        if (action === "escape") await press("Escape",27);
        else if (action === "backdrop") await js(`document.querySelector('${dialog}').closest('.fy-editordialog').click()`);
        else await click(`${dialog} button:${action === "cancel" ? "first" : "last"}-child`);
        await wait(`!(${exists})`);
        const after = await js('window.sent.filter(m=>m.kind==="read-sheet-section")');
        assert.equal(after.length, before + (action === "confirm" ? 1 : 0));
        if (action === "confirm") {
          assert.equal(after.at(-1).voiceUploadConfirmedFor,"synthetic-consent-token");
          assert.equal(after.at(-1).requestId,after.at(-2).requestId);
          assert.equal(after.at(-1).confirmationToken,undefined);
        } else {
          assert.equal(await js('document.activeElement.getAttribute("aria-label")'),"Read aloud","cancellation returns to the recreated read control");
        }
        results.push({name,dark,action,pass:true});
      }
      await js("window.mount(true)");
      await wait('!!document.querySelector("#outer")');
      await click("#outer");
      await wait('!!document.querySelector("dialog[open]")');
      await click("#inner");
      await wait(`${exists} && document.activeElement.textContent.trim()==="Not now"`);
      assert.equal(await js('!!document.querySelector("dialog[open]")'),false,"underlying modal gives way");
      const geometry = await js(`(()=>{const p=document.querySelector('.fy-voice-upload'),c=document.querySelector('.fy-voice-upload__body'),r=p.getBoundingClientRect(),actions=[...p.querySelectorAll('button')].map(b=>b.getBoundingClientRect());return {within:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,horizontal:c.scrollWidth>c.clientWidth,scrollable:c.scrollHeight>c.clientHeight,startsAtTop:c.scrollTop===0,actionsVisible:actions.every(b=>b.top>=r.top&&b.bottom<=r.bottom)}})()`);
      assert.ok(geometry.within && !geometry.horizontal,JSON.stringify(geometry));
      assert.ok(geometry.startsAtTop && geometry.actionsVisible,"read the notice from its beginning with both actions visible");
      if (name === "short") assert.ok(geometry.scrollable,"a long notice scrolls in a short window");
      await js(`document.querySelector('${dialog} button:last-child').focus()`);
      await press("Tab",9);
      assert.equal(await focusText(),"Not now");
      await browser.screenshot(join(output,`${name}-${dark ? "dark" : "light"}.png`));
      await press("Escape",27);
      await wait('!!document.querySelector("dialog[open]")');
      assert.equal(await js("document.activeElement.id"),"inner","focus returns into the restored parent sheet");
      assert.equal(await js("window.cancelled"),1);
      await press("Escape",27);
      await wait('!document.querySelector("dialog[open]")');
      assert.equal(await js("document.activeElement.id"),"outer");
      results.push({name,dark,nested:true,...geometry,pass:true});
    }
  }
  await writeFile(join(output,"results.json"),JSON.stringify(results,null,2));
  console.log(`${results.length} voice-upload browser checks passed.`);
} finally { await browser.close(); await server.close(); }
