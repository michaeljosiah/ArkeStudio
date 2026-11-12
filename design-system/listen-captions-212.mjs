// Retain the approved caption layout without publishing the owner's manuscript or scene still.
import fs from "node:fs";
import { parseHTML } from "linkedom";
const here = new URL("./", import.meta.url);
const masterPath = new URL("Arke Studio.dc.html", here);
let master = fs.readFileSync(masterPath, "utf8");
const { document } = parseHTML(master);
const base = document.querySelectorAll("#t211 .sp211");
const css = fs.readFileSync(new URL("listen-slow-push-211.css", here), "utf8").replaceAll("sp211", "sc212") + `
.sc212 .follow{width:640px;max-width:calc(100% - 48px);font-size:var(--text-2xl);line-height:1.45;text-shadow:0 2px 5px #000,0 0 12px #000}
.sc212.phone .follow{width:auto;left:16px;right:16px;max-width:none;bottom:308px;font-size:var(--text-lg)}
`;
const frames = [
  { id: "212a", title: "Listen · short captions leave the picture visible", node: base[0], text: "Maren watched the boats beyond the breakwater. The harbour lamps slowly came on.", phone: false },
  { id: "212b", title: "Phone · the current phrase above the transport", node: base[1], text: "while the lamps slowly came on along the harbour wall", phone: true },
];
const rules = [
  "<b>1 · Approved, 2026-10-11.</b> The owner approved the in-conversation two-line caption proposal for issue 1711 before implementation. These public fictional specimens retain its width, readable type and placement; the owner's private scene and words are not published here. Existing controls and routes remain.",
  "<b>2 · Only the current phrase.</b> Text shows at most two lines, centred above the actual playback controls, at a maximum width of 640px. Use the 24px heading token on desktop and the 18px token on phone. The picture, title and transport retain their existing geometry. Do not show the following sentence, clip or ellipsize words, shrink the type, or require the listener to scroll a paragraph.",
  "<b>3 · Advance through all words.</b> Split long sentences and whole individually generated blocks into bounded phrases. Fit the current viewport and font, including enlarged text, and reflow at the current audio time after resize or font loading. An unbroken token can continue in another cue without inserting a space into its source. If the safe area holds one line, use one; when it holds none, hide the overlay until space is available rather than cover controls.",
  "<b>4 · The existing narration clock.</b> Use validated acoustic intervals supplied on the chapter clock when present; clear after a measured cue ends. Otherwise use the existing character-weighted sentence estimate, also for an individual take's whole-block entry. Never label interpolation measured or add current-word highlighting. Pause, seek and speed changes keep that same clock; no new narration or manuscript change is needed.",
  "<b>5 · Two homes and existing choices.</b> The shared module serves Listen and newly exported HTML players. Both mappers carry only coordinator-validated word intervals. Old package inputs remain readable with estimated timing. Text stays off by default and keeps its existing per-device preference. Gap notices remain separate from the current phrase and share its available space. MP4/sidecar cue sizes and export-preview font semantics remain unchanged; their existing word-clock basis is shared, while line breaks depend on the destination's frame and font.",
];
const drawings = frames.map((frame, index) => {
  const node = frame.node.cloneNode(true);
  node.className = node.className.replace("sp211", "sc212");
  node.querySelector(".follow").textContent = frame.text;
  return `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel"><a class="dv-oid" href="#${frame.id}">${frame.id}</a>${frame.title}</div><div class="dv-card" style="width:${frame.phone ? 390 : 1322}px;max-width:none">${index === 0 ? `<style>${css}</style>` : ""}${node.outerHTML}</div></div>`;
}).join("\n");
const turn = `<section class="dv-turn" id="t212"><div class="dv-thd"><a class="dv-tid" href="#t212">212</a><span class="dv-tname">Listen · two-line captions</span></div><p class="dv-next">Approved by the owner · 2026-10-11. Short, advancing phrases replace the unbounded passage overlay.</p><div class="dv-opts" style="margin-top:22px">${drawings}</div>${rules.map(rule => `<p class="dv-rule">${rule}</p>`).join("\n")}</section>\n`;
const old = master.indexOf('<section class="dv-turn" id="t212">');
if (old >= 0) { const end = master.indexOf('<section class="dv-turn"', old + 1); master = master.slice(0, old) + master.slice(end); }
const first = [...master.matchAll(/<section class="dv-turn" id="t(\d+)">/g)].find(match => Number(match[1]) > 0);
master = master.slice(0, first.index) + turn + master.slice(first.index);
fs.writeFileSync(masterPath, master);
const reviewPath = new URL("build-review.mjs", here);
let review = fs.readFileSync(reviewPath, "utf8").replace(/\n  \/\/ BEGIN TURN 212[\s\S]*?  \/\/ END TURN 212\n/, "\n");
review = review.replace("const SCREENS = [", 'const SCREENS = [\n  // BEGIN TURN 212\n' + frames.map(frame => `  { group: "Listen captions · approved", screen: ${JSON.stringify(frame.title)}, frame: "${frame.id}", route: "Audiobook / Listen", status: "drawn", checked: "2026-10-11", controls: ["Text"], notes: ["Owner-approved two-line caption layout for issue 1711; full words advance on the existing narration clock."] },`).join("\n") + "\n  // END TURN 212\n");
fs.writeFileSync(reviewPath, review);
console.log("Recorded approved two-line caption design, turn 212.");
