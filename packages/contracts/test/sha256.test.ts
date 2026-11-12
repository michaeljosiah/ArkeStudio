import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256Hex } from "../src/sha256.js";

// The digest a kept text picture is named by (SPEC-065 R-20), held to node:crypto's. The client
// computes it in a browser and the coordinator in Node; one wrong bit and the Viewer asks for a
// picture the export never painted.

const utf8 = (text: string) => new TextEncoder().encode(text);
/** node:crypto's digest of the bytes `TextEncoder` gives the string. */
const node = (text: string) => createHash("sha256").update(utf8(text)).digest("hex");

test("the digest of the standard's own messages is the standard's", () => {
  // FIPS 180-4's examples, written out, so the test does not rest on node:crypto alone.
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("the plain digest is node:crypto's for every padding boundary and every kind of character", () => {
  // A block is 64 bytes and the padding needs nine: 55 bytes is the last length that fits one
  // block, 56 the first that spills, and the same again a block later. One byte to a character…
  const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000, 70_000];
  for (const length of lengths) assert.equal(sha256Hex("a".repeat(length)), node("a".repeat(length)), `${length} bytes`);
  // …then the same byte lengths reached in two, three and four bytes to a character, with the remainder in ASCII.
  for (const unit of ["é", "語", "😀"]) {
    const size = utf8(unit).length;
    for (const length of lengths) {
      const text = "a".repeat(length % size) + unit.repeat(Math.floor(length / size));
      assert.equal(utf8(text).length, length);
      assert.equal(sha256Hex(text), node(text), `${length} bytes of ${unit}`);
    }
  }
  // Over two million bytes, so the length written into the padding fills more than three of its bytes.
  const long = "The quick brown fox jumps over the lazy dog. Ọ̀rẹ́ mi, 語 😀\n".repeat(40_000);
  assert.ok(utf8(long).length > 2 ** 21);
  assert.equal(sha256Hex(long), node(long));

  for (const text of ["\n", "\r\n", "\u0000", "a\u0000b", "ß", "Ọ̀rẹ́", "é", "é", "語", "￿", "😀", "👩🏾‍🚀", "\u{10ffff}", '{"text":"q\\"\\n"}']) {
    assert.equal(sha256Hex(text), node(text), JSON.stringify(text));
    // Handing node:crypto the string must be the same as handing it the bytes.
    assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"), JSON.stringify(text));
  }

  // Three hundred strings from a fixed sequence: every length up to four blocks, every kind of
  // code unit, a surrogate with no partner among them.
  let seed = 0x2f6e2b1;
  const next = (below: number) => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0, Math.floor(seed / 0x10000) % below);
  const unit = (): string => {
    switch (next(6)) {
      case 0: return String.fromCharCode(0x20 + next(0x5f));
      case 1: return String.fromCharCode(0x80 + next(0x780));
      case 2: return String.fromCharCode(0x800 + next(0xd000));
      case 3: return String.fromCodePoint(0x10000 + next(0x8000) * 32 + next(32));
      case 4: return String.fromCharCode(0xd800 + next(0x800));
      default: return String.fromCharCode(next(0x20));
    }
  };
  for (let index = 0; index < 300; index++) {
    const text = Array.from({ length: next(260) }, unit).join("");
    assert.equal(sha256Hex(text), node(text), `string ${index}: ${JSON.stringify(text)}`);
    assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"), `string ${index}, as a string`);
  }
});

test("a surrogate with no partner is hashed as U+FFFD, the bytes TextEncoder gives", () => {
  // Decided, not left to chance: UTF-8 has no bytes for half a pair, `TextEncoder` writes EF BF BD
  // in its place, and so does node:crypto when it is handed the string.
  const replaced = createHash("sha256").update(Uint8Array.of(0xef, 0xbf, 0xbd)).digest("hex");
  for (const lone of ["\ud800", "\udbff", "\udc00", "\udfff"]) {
    assert.deepEqual([...utf8(lone)], [0xef, 0xbf, 0xbd]);
    assert.equal(sha256Hex(lone), replaced);
    assert.equal(sha256Hex(lone), createHash("sha256").update(lone).digest("hex"));
  }
  assert.equal(sha256Hex("\ud800"), sha256Hex("�"));
  // A pair the wrong way round is two of them, and a whole pair beside a half keeps its four bytes.
  assert.equal(sha256Hex("\ude00\ud83d"), sha256Hex("��"));
  assert.equal(sha256Hex("a\ud83d😀\ude00b"), node("a�😀�b"));
  // So two ill-formed strings can share a digest. JSON does not let them: it writes the half as an escape.
  assert.notEqual(sha256Hex(JSON.stringify("\ud800")), sha256Hex(JSON.stringify("�")));
  assert.notEqual(sha256Hex(JSON.stringify("\ud800")), sha256Hex(JSON.stringify("\ud801")));
});

test("the digest is sixty-four lower-case hex characters, leading zeros kept", () => {
  const digests = Array.from({ length: 200 }, (_, index) => sha256Hex(String(index)));
  for (const digest of digests) assert.match(digest, /^[0-9a-f]{64}$/);
  // The digest is eight words, each printed as eight characters. A word below 0x10000000 printed
  // bare would be seven, so the check above means something only if such a word is among them.
  assert.ok(digests.some(digest => digest.match(/.{8}/g)!.some(word => word.startsWith("0"))));
  assert.equal(new Set(digests).size, 200);
});
