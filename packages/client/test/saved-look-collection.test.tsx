import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { CharacterLook, ClientMessage, ClientState } from "@arke-studio/contracts";
import { SavedLookCollection } from "../src/components/saved-look-collection.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1600, innerHeight: 1000 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) });
const AT = "2026-10-10T10:10:10.000Z";
const looks: CharacterLook[] = Array.from({ length: 16 }, (_, index) => ({ id: `coat-${String(index).padStart(6, "0")}`, name: `Coat ${index + 1}`, file: `takes/coat-${index}/full.png`, kind: "costume", prompt: `Hair first. Outfit ${index}: a charcoal coat and boots.`, acceptedAt: AT, mainFile: "head-front.png" }));
const state = (entries = looks): ClientState => ({ ...FIXTURE_STATE, world: { ...FIXTURE_STATE.world!, referenceKits: FIXTURE_STATE.world!.referenceKits.map(kit => kit.sheetId === "maren-kest" ? { ...kit, looks: entries } : kit) } });
const roots: Root[] = [];
const all = (selector: string) => [...dom.document.body.querySelectorAll(selector)] as HTMLElement[];
const options = () => all('[data-testid="saved-look-option"]');
const use = () => all('[data-testid="saved-look-use"]')[0] as HTMLButtonElement;
const props = (el: Element) => (el as unknown as Record<string, Record<string, (event: never) => void>>)[Object.keys(el).find(key => key.startsWith("__reactProps$"))!]!;
const press = async (el: Element | undefined) => { assert.ok(el); await act(async () => void el.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event)); };
const change = async (el: Element, value: string) => { await act(async () => props(el).onChange!({ target: { value } } as never)); };
async function mount(entries = looks, currentId: string | null = looks[0]!.id, connection: "open" | "closed" = "open") {
  const sent: ClientMessage[] = []; const chosen: Array<string | null> = []; let closed = 0;
  __setBridgeForTest({ send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as ArkeBridge);
  const container = dom.document.createElement("div"); dom.document.body.append(container); const root = createRoot(container); roots.push(root);
  await act(async () => {
    __setStateForTest(state(entries), { connection });
    root.render(<SavedLookCollection worldId={FIXTURE_WORLD_ID} productionId="saltlight" sheetId="maren-kest" name="Maren Kest" chapterOrder={7} currentId={currentId} onChoose={id => chosen.push(id)} onClose={() => { closed++; }} />);
  });
  return { sent, chosen, closed: () => closed, refresh: async (next: CharacterLook[], connection: "open" | "closed" = "open") => { await act(async () => __setStateForTest(state(next), { connection })); } };
}
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); dom.document.body.innerHTML = ""; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE); });

it("browses 16 saved looks with a single tab stop; keyboard preview changes nothing until Use", async () => {
  const m = await mount();
  assert.equal(options().length, 17);
  assert.equal(options().filter(option => option.tabIndex === 0).length, 1);
  await act(async () => props(all('[role="listbox"]')[0]!).onKeyDown!({ key: "End", preventDefault() {} } as never));
  assert.equal(options().at(-1)!.getAttribute("aria-selected"), "true");
  assert.equal(m.chosen.length, 0);
  assert.equal(m.sent.filter(message => message.kind !== "read-audiobook-looks").length, 0);
  await press(use()); assert.deepEqual(m.chosen, [looks.at(-1)!.id]);
});
it("searches full prompts, preserves the preview and row order across background arrivals, and clears no results", async () => {
  const m = await mount();
  const search = all('input[type="search"]')[0]!;
  await change(search, "Outfit 12:"); assert.equal(options().length, 1); assert.match(options()[0]!.textContent ?? "", /Coat 13/);
  assert.match(all('.fy-savedlook__selected h3')[0]!.textContent ?? "", /Coat 1$/);
  await change(search, "missing silver cape"); assert.equal(options().length, 0); assert.match(dom.document.body.textContent ?? "", /No looks found/);
  await press(all('button').find(button => button.textContent === "Clear search")); assert.equal(options().length, 17);
  await m.refresh([{ ...looks[0]!, id: "newest", name: "Newest coat", acceptedAt: "2026-10-11T10:10:10.000Z" }, ...looks]);
  assert.equal(options().at(-1)!.getAttribute("data-look"), "newest", "new arrivals append during the open chooser");
  assert.equal(options()[1]!.getAttribute("aria-selected"), "true");
});
it("keeps legacy names and missing images honest and refuses a removed selection", async () => {
  const legacy = looks.slice(0, 2).map(({ name: _name, ...look }) => look);
  const m = await mount(legacy);
  assert.match(options()[1]!.textContent ?? "", /Look · .*000000/);
  const preview = all('.fy-savedlook__preview img')[0]!;
  await act(async () => props(preview).onError!({} as never));
  assert.match(all('.fy-savedlook__preview')[0]!.textContent ?? "", /Preview unavailable/);
  await m.refresh(legacy.slice(1)); assert.equal(use().disabled, true); assert.match(dom.document.body.textContent ?? "", /no longer available/);
});
it("renames by metadata with an expected-name fence, preserving the selection through acknowledgement", async () => {
  const m = await mount();
  await press(all('[data-testid="saved-look-rename"]')[0]);
  await change(all('.fy-savedlook__rename input')[0]!, "Charcoal evening coat");
  await act(async () => props(all('form')[0]!).onSubmit!({ preventDefault() {} } as never));
  const message = m.sent.find(message => message.kind === "rename-character-look"); assert.ok(message && message.kind === "rename-character-look");
  assert.deepEqual([message.lookId, message.name, message.expectedName], [looks[0]!.id, "Charcoal evening coat", "Coat 1"]);
  assert.equal(use().disabled, true);
  await m.refresh(looks.map((look, i) => i === 0 ? { ...look, name: message.name } : look));
  await act(async () => __applyEventForTest({ at: AT, type: "reference.look-renamed", worldId: FIXTURE_WORLD_ID, sheetId: "maren-kest", lookId: message.lookId, requestId: message.requestId }));
  assert.equal(all('form').length, 0); assert.equal(use().disabled, false); assert.equal(options()[1]!.getAttribute("aria-selected"), "true"); assert.match(options()[1]!.textContent ?? "", /Charcoal evening coat/);
  assert.equal(m.chosen.length, 0);
});
it("retains a refused rename draft, clears a lost pending reply on disconnect, and disables writes offline", async () => {
  const m = await mount();
  await press(all('[data-testid="saved-look-rename"]')[0]); await change(all('.fy-savedlook__rename input')[0]!, "My coat");
  await act(async () => props(all('form')[0]!).onSubmit!({ preventDefault() {} } as never));
  const message = m.sent.find(message => message.kind === "rename-character-look"); assert.ok(message && message.kind === "rename-character-look");
  await act(async () => __applyEventForTest({ at: AT, type: "reference.look-renamed", worldId: FIXTURE_WORLD_ID, sheetId: "maren-kest", lookId: message.lookId, requestId: message.requestId, error: "This look was renamed elsewhere." }));
  assert.equal((all('.fy-savedlook__rename input')[0] as HTMLInputElement).value, "My coat"); assert.match(all('[role="alert"]')[0]!.textContent ?? "", /renamed elsewhere/);
  await act(async () => props(all('form')[0]!).onSubmit!({ preventDefault() {} } as never)); await m.refresh(looks, "closed");
  assert.match(all('[role="alert"]')[0]!.textContent ?? "", /Connection lost/); assert.equal((all('.fy-savedlook__rename input')[0] as HTMLInputElement).disabled, false); assert.equal(use().disabled, true);
});
