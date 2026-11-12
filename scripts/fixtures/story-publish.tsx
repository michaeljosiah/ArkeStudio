
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { StoryPublishSheet } from "./src/components/story-publish";
import { __setBridgeForTest, __setStateForTest, __applyEventForTest } from "./src/lib/store";
import { FIXTURE_STATE } from "./test/fixture-state";
import "./src/theme/tokens/colors.css";
import "./src/theme/tokens/typography.css";
import "./src/theme/tokens/spacing.css";
import "./src/theme/tokens/effects.css";
import "./src/theme/globals.css";
import "./src/components/ui.css";
import "./src/components/layout.css";
import "./src/screens/fidelity.css";
import "./src/screens/bible-canon.css";
import "./src/components/story-publish.css";
const production = { ...FIXTURE_STATE.world.productions[0], meta: { ...FIXTURE_STATE.world.productions[0].meta, title: "Saltlight" }, chapters: [{ id: "neap", file: "01-neap", order: 1, title: "Neap", status: "draft", version: 1, words: 1840 }] };
const settings = { title: "Saltlight", author: "M. Josiah", language: "en-GB", label: "For friends", description: "A private story", cover: null, chapterIds: ["neap"], outputs: ["epub", "m4b"], avoidEmDashes: true };
const finding = { id: "a".repeat(64), chapterId: "neap", chapterTitle: "Neap", chapterFile: "01-neap", baseHash: "hash", paragraph: 0, start: 0, end: 39, before: "Maren turned—she knew that voice.", suggestion: "Maren turned. She knew that voice.", reason: "Review the sentence break.", narration: ["p0.0"], kept: false };
const edition = { id: "11111111-1111-4111-8111-111111111111", worldId: FIXTURE_STATE.world.meta.worldId, productionId: production.meta.id, createdAt: "2026-10-13T12:00:00Z", settings, fingerprint: "c".repeat(64), status: "preview", phase: "Preview ready", files: ["epub", "m4b"].map(format => ({ format, name: "story." + format, bytes: 123456, sha256: "d".repeat(64) })) };
window.mockEdition = edition;
__setBridgeForTest({ connect() {}, subscribe() {}, send(json) {
 const message = JSON.parse(json);
 if (message.kind === "list-story-publications") return;
 if (message.kind !== "publish-story") return;
 const result = message.input.action === "list" ? { settings, editions: [] } :
 message.input.action === "review" ? { review: { settings, fingerprint: "c".repeat(64), chapters: [{ id: "neap", title: "Neap", words: 1840, audioProblems: [] }], blockers: [], warnings: [], findings: [finding] } } :
 message.input.action === "preview" ? { edition } :
 message.input.action === "preview-page" ? { preview: { html: "<html><body><h1>Neap</h1><p>Maren turned. She knew that voice.</p></body></html>", chapter: 0, count: 1 } } :
 message.input.action === "decide" ? { review: { settings, fingerprint: "c".repeat(64), chapters: [{ id: "neap", title: "Neap", words: 1840, audioProblems: [] }], blockers: [], warnings: [], findings: [{ ...finding, kept: true }] } } :
 message.input.action === "create" ? { edition: { ...edition, status: "ready", phase: "Files ready" } } : {};
 setTimeout(() => __applyEventForTest({ at: "2026-10-13T12:00:00Z", type: "story.published", requestId: message.requestId, worldId: message.worldId, productionId: message.productionId, result }), 10);
}});
__setStateForTest(FIXTURE_STATE, { connection: "open" });
const root = createRoot(document.getElementById("root"));
window.mountPublish = async () => { root.render(<MemoryRouter><StoryPublishSheet key={Math.random()} worldId={edition.worldId} production={production} onClose={() => {}} /></MemoryRouter>); await new Promise(resolve => setTimeout(resolve, 100)); };
window.pressPublish = async label => { const button = [...document.querySelectorAll("button")].find(button => button.textContent === label); if (!button || button.disabled) throw new Error("Unavailable: " + label); button.click(); await new Promise(resolve => setTimeout(resolve, 100)); };
window.checkPublish = () => {
 const dialog = document.querySelector("dialog[open]"); if (!dialog) throw new Error("Publish dialog is not open");
 const content = dialog.querySelector(".fy-publish");
 if (content.scrollWidth > content.clientWidth + 2) throw new Error("Publish content overflows");
 for (const button of dialog.querySelectorAll("button")) { const box = button.getBoundingClientRect(); if (box.width && box.height < 43) throw new Error("Small action: " + button.textContent); }
 return { width: innerWidth, height: innerHeight, contentWidth: content.clientWidth, step: dialog.querySelector("h3")?.textContent };
};
