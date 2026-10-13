import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { ConversationPresentationContext, useConversationNavigationGuard } from "../src/components/global-chat-context.js";
import { GlobalChatController } from "../src/lib/global-chat.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; dom.document.body.innerHTML = ""; });
for (const outcome of ["stay", "leave", "park"] as const) test(`a prepared Bench result respects a retained conversation after ${outcome}`, async () => {
  const container = dom.document.createElement("div") as unknown as HTMLElement; dom.document.body.append(container); root = createRoot(container);
  const owner = new GlobalChatController(); let finish!: () => void;
  const prepared = new Promise<void>(resolve => { finish = resolve; });
  function Consumer() {
    const guard = useConversationNavigationGuard(), location = useLocation(), navigate = useNavigate();
    return <><p data-path>{location.pathname}</p><button onClick={() => {
      const source = guard.path; void prepared.then(() => { if (guard.allows(source)) void navigate("/bench/prepared"); });
    }}>Prepare</button><button onClick={() => navigate("/bible")}>Leave</button></>;
  }
  const render = async (visible: boolean) => { await act(async () => root!.render(<MemoryRouter initialEntries={["/source"]}>
    <ConversationPresentationContext.Provider value={{ owner, key: "source", stopCapture: 0, inPanel: visible, hasHome: false, panelHost: null }}><Consumer /></ConversationPresentationContext.Provider>
  </MemoryRouter>)); };
  const click = async (label: string) => { await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === label)!.click()); };
  await render(true); await click("Prepare");
  if (outcome === "leave") await click("Leave");
  if (outcome === "park") await render(false);
  await act(async () => { finish(); await prepared; });
  assert.equal(container.querySelector('[data-path]')!.textContent, outcome === "stay" ? "/bench/prepared" : outcome === "leave" ? "/bible" : "/source");
});
