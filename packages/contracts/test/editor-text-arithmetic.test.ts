import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { paintText } from "../src/editor-text-painter.js";
import { PROOF_FRAME, proofFace, proofInk } from "./editor-text-fixture.js";

// The painter's arithmetic (SPEC-065 R-19). A golden picture is hashed on the machine that runs
// the test, so it cannot see a function whose answer differs from one machine to the next: a
// Math.pow in place of a multiplication gives the same hash here and a different picture
// somewhere else. So the rule is held two ways. The three sources that decide a pixel are read
// as text, which reaches every line whether a test draws through it or not; and a picture with
// every part in it is painted while everything outside the rule throws, which reaches whatever
// those lines call.

const ALLOWED = ["sqrt", "floor", "ceil", "round", "abs", "min", "max"];
const SOURCES = ["editor-text-layout.ts", "editor-text-raster.ts", "editor-text-painter.ts"];
/** The code alone. None of the three holds a string with a comment mark in it; the last test says so. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const read = (name: string): string => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

/** What `text` uses that R-19 leaves out, as the words found. */
function strays(text: string): string[] {
  const found: string[] = [];
  // Math by any road but a named member of the seven: a member outside them, an index, or the object handed on.
  for (const match of text.matchAll(/\bMath\b(?:\s*\.\s*(\w+))?/g)) if (!match[1] || !ALLOWED.includes(match[1])) found.push(match[0]);
  // What asks the machine: its locale, its clock, its chance, its environment.
  for (const match of text.matchAll(/toLocale\w*|\bIntl\b|\blocaleCompare\b|\bDate\b|\bperformance\b|\bprocess\b|\bnavigator\b|\bglobalThis\b|\brequire\b/g)) found.push(match[0]);
  // A power is the platform's pow. The sources multiply instead.
  if (text.includes("**")) found.push("**");
  return found;
}

test("the scan finds what the rule leaves out, and passes what it allows", () => {
  assert.deepEqual(strays("const d = Math.sqrt(a * a + b * b), e = Math.max(0, Math.min(1, Math.round(d)));"), []);
  assert.deepEqual(strays("Math.pow(squared, 0.5)"), ["Math.pow"]);
  assert.deepEqual(strays("Math.hypot(x, y) + Math . sin(t)"), ["Math.hypot", "Math . sin"]);
  assert.deepEqual(strays("const { pow } = Math; Math[name](2)"), ["Math", "Math"]);
  assert.deepEqual(strays("s ** 2"), ["**"]);
  assert.deepEqual(strays("line.toLocaleUpperCase()"), ["toLocaleUpperCase"]);
  assert.deepEqual(strays('line.toLocaleUpperCase("tr")'), ["toLocaleUpperCase"]);
  assert.deepEqual(strays("new Intl.Collator().compare(a, b); a.localeCompare(b); Date.now(); Math.random()"), ["Math.random", "Intl", "localeCompare", "Date"]);
  assert.deepEqual(strays("line.toUpperCase()"), []);
  // A comment may name what the code may not use.
  assert.deepEqual(strays(code("// Never toLocaleUpperCase\n/** Math.pow is not used. */ const a = 1; /* ** */")), []);
});

test("the sources that decide a pixel use + - * / and sqrt, floor, ceil, round, abs, min, max, and ask the machine nothing (SPEC-065 R-19)", () => {
  for (const name of SOURCES) {
    const source = read(name), text = code(source);
    assert.deepEqual(strays(text), [], name);
    // Nothing is drawn by a module this test does not read.
    const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]!);
    assert.ok(imports.length > 0, name);
    for (const from of imports) assert.ok(["./editor-text.js", ...SOURCES.map(other => `./${other.replace(/\.ts$/, ".js")}`)].includes(from), `${name} imports ${from}`);
    assert.ok(!/\bimport\s*\(/.test(text), name);
    // The scan reads code with its comments taken out, which is only sound while no string holds a comment mark.
    for (const match of source.matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) assert.ok(!/\/\/|\/\*/.test(match[0]), `${name}: ${match[0]}`);
  }
  // The record's module draws nothing, but the painter reads its types: it may bring in the schema library and nothing of the machine.
  assert.deepEqual(strays(code(read("editor-text.ts"))), []);
});

test("a picture with every part in it is painted without one call outside the rule", () => {
  const trap = (name: string) => () => { throw new Error(`${name} decides a pixel`); };
  const swapped: [object, string, PropertyDescriptor][] = [];
  const swap = (owner: object, name: string, label: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;
    swapped.push([owner, name, descriptor]);
    Object.defineProperty(owner, name, { ...descriptor, value: trap(label) });
  };
  const look = proofInk({
    size: 0.2, tracking: 0.05, leading: 1.1, capitals: true, align: "center", x: 0.5, y: 0.45, room: 0.6,
    fill: { kind: "gradient", stops: [{ at: 1, color: "#ff8040" }, { at: 0, color: "#ffffff" }, { at: 0.5, color: "#2040ff" }] },
    edge: { color: "#102030", width: 0.15 }, shadow: { color: "#000000", opacity: 0.7, blur: 0.8, dx: 0.1, dy: -0.15 },
    rule: { length: 0.5, weight: 0.05, gap: 0.3, soft: true }, backing: { kind: "shade", color: "#400000", opacity: 0.6 },
  });
  const face = proofFace().face, words = "av\nva", lifted = String.fromCodePoint(0x300);
  const plain = paintText(words, look, PROOF_FRAME, face);
  let trapped: ReturnType<typeof paintText>, boxed: ReturnType<typeof paintText>;
  try {
    for (const name of Object.getOwnPropertyNames(Math)) if (!ALLOWED.includes(name)) swap(Math, name, `Math.${name}`);
    for (const name of ["toLocaleUpperCase", "toLocaleLowerCase", "localeCompare"]) swap(String.prototype, name, name);
    for (const name of ["toLocaleString"]) for (const owner of [Number.prototype, Array.prototype, Object.prototype]) swap(owner, name, name);
    swap(Date, "now", "Date.now");
    trapped = paintText(words, look, PROOF_FRAME, face);
    boxed = paintText("qcop xw v" + lifted, { ...look, capitals: false, tracking: 0, fill: { kind: "solid", color: "#ffffff" }, backing: { kind: "box", color: "#400000", opacity: 0.6 } }, { width: 97, height: 61 }, face);
  } finally {
    for (const [owner, name, descriptor] of swapped) Object.defineProperty(owner, name, descriptor);
  }
  // The traps were set and are gone again.
  assert.ok(swapped.length > 20, `${swapped.length} traps`);
  assert.equal(Math.pow(2, 3), 8);
  assert.equal("i".toLocaleUpperCase("en"), "I");
  assert.ok(plain.ok && trapped.ok && boxed.ok);
  assert.deepEqual(trapped, plain);
  // Curves, a counter, contours that overlap, a lifted mark, both backings: something was drawn each time.
  assert.ok(trapped.rgba.some(value => value > 0) && boxed.rgba.some(value => value > 0));
});
