import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "../src/canonical-json.js";

test("the bytes are pinned: code-unit key order, integer-like keys as strings, arrays kept in order", () => {
  const value = { "é": 1, b: [3, { z: null, y: "q\"\n" }, [true]], B: -0, "10": 1e21, "9": NaN, _: { inner: undefined, kept: 0.5 }, a: undefined };
  assert.equal(canonicalJson(value), ["{",
    '"10":1e+21,"9":null,"B":0,"_":{"kept":0.5},"b":[3,{"y":"q\\"\\n","z":null},[true]],"é":1',
    "}"].join(""));
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson("x"), '"x"');
});

test("a value JSON cannot hold is refused, or written as null when asked", () => {
  for (const unsupported of [undefined, () => 1, Symbol("s"), [1, undefined], { f: () => 1 }]) {
    assert.throws(() => canonicalJson(unsupported), TypeError);
  }
  assert.equal(canonicalJson(undefined, { unsupported: "null" }), "null");
  assert.equal(canonicalJson([1, undefined, () => 1], { unsupported: "null" }), "[1,null,null]");
  assert.equal(canonicalJson({ f: () => 1, gone: undefined }, { unsupported: "null" }), '{"f":null}', "an undefined member is still dropped");
});

// The copies this replaced, kept here as they were, so that "byte-identical" is a test and not a claim.
const was = {
  /** contracts and coordinator `timeline.ts`, `dialogue-assessment.ts`, `editor-effect-requests.ts`, effect analysis. */
  sorted(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(was.sorted).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${was.sorted(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  },
  /** coordinator `arke-actions/digest.ts` and the client's history card. */
  stableJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(was.stableJson).join(",")}]`;
    return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${was.stableJson(v)}`).join(",")}}`;
  },
  /** coordinator `application/operations.ts`. */
  engine(value: unknown): string {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(was.engine).join(",")}]`;
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${was.engine(v)}`).join(",")}}`;
  },
};

/** Records as a schema leaves them: nested, keys in any order, optional members undefined. */
function corpus(count: number): unknown[] {
  let seed = 2824;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  const keys = ["a", "B", "_", "é", "10", "9", "0", "-1", "aa", "a b", "\u{1F600}", "z"];
  const leaf = (): unknown => [null, true, false, 0, -0, 1.5, -7, 1e21, NaN, "", "x", "q\"\\\n", " "][Math.floor(next() * 13)];
  const make = (depth: number): unknown => {
    const pick = next();
    if (depth > 3 || pick < 0.4) return leaf();
    if (pick < 0.65) return Array.from({ length: Math.floor(next() * 4) }, () => make(depth + 1));
    const record: Record<string, unknown> = {};
    for (const key of keys) if (next() < 0.35) record[key] = next() < 0.15 ? undefined : make(depth + 1);
    return record;
  };
  return Array.from({ length: count }, () => make(0));
}

test("it writes what every replaced copy wrote, on every value a schema can produce", () => {
  for (const value of corpus(2_000)) {
    const strict = canonicalJson(value), lenient = canonicalJson(value, { unsupported: "null" });
    assert.equal(strict, was.sorted(value));
    assert.equal(lenient, strict);
    assert.equal(lenient, was.stableJson(value));
    assert.equal(lenient, was.engine(value));
  }
  // Where an operation has no result, the engine hash and the action digest wrote null; they still do.
  assert.equal(canonicalJson(undefined, { unsupported: "null" }), was.engine(undefined));
  assert.equal(canonicalJson(undefined, { unsupported: "null" }), was.stableJson(undefined));
});
