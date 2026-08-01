import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deliveryParams,
  extractVoiceAttributes,
  previewLineFor,
  rankVoices,
  type ProductionBundle,
  type Sheet,
  type VoiceCandidate,
} from "@arke-studio/contracts";
import { KOKORO_PRESETS, localCandidates, sidecarState, VoxaClient } from "../src/index.js";

const SHEET = {
  id: "maren-kest",
  type: "character",
  name: "Maren Kest",
  version: 4,
  status: "locked",
  canonRules: [],
  links: [],
  created: "2026-05-02",
  updated: "2026-07-14",
  sections: [
    { heading: "Essence", body: "Tide-caller. She hears the verse under the harbour" },
    { heading: "Voice · written", body: "Low and even. Speaks to the water before she speaks to people." },
  ],
} as unknown as Sheet;

describe("matching (R-7, R-8, D5, D6, §3.2)", () => {
  it("extracts attributes from a written description, deterministically", () => {
    const written = "Low and even. Speaks to the water before she speaks to people.";
    const a = extractVoiceAttributes(written);
    const b = extractVoiceAttributes(written);
    assert.deepEqual(a, b);
    assert.ok(a.includes("low"));
    assert.ok(a.includes("even"));
    assert.ok(a.includes("water"));
    assert.ok(!a.includes("the"), "stopwords never become attributes");
  });

  it("ranks by overlap, shows the matched attributes, and stays stable across runs", () => {
    const candidates: VoiceCandidate[] = [
      { provider: "elevenlabs", voiceId: "v1", label: "Harbour", attributes: ["low", "even", "coastal"], local: false, canClone: true },
      { provider: "elevenlabs", voiceId: "v2", label: "Bright", attributes: ["bright", "quick"], local: false, canClone: true },
      { provider: "kokoro", voiceId: "af_bella", label: "Bella", attributes: ["low", "warm"], local: true, canClone: false },
    ];
    const extracted = extractVoiceAttributes("Low and even, a coastal calm.");
    const first = rankVoices(extracted, candidates);
    const second = rankVoices(extracted, [...candidates].reverse());
    assert.deepEqual(
      first.map((r) => r.candidate.voiceId),
      second.map((r) => r.candidate.voiceId),
      "input order never changes the ranking",
    );
    assert.equal(first[0]!.candidate.voiceId, "v1");
    assert.deepEqual(first[0]!.matched.sort(), ["coastal", "even", "low"]);
    // The score is the stated overlap definition — matched ÷ extracted — nothing else (R-8).
    assert.equal(first[0]!.overlap, first[0]!.matched.length / extracted.length);
  });

  it("a candidate with no metadata ranks last rather than erroring (§3.2)", () => {
    const ranked = rankVoices(
      ["low"],
      [
        { provider: "x", voiceId: "bare", label: "Bare", attributes: [], local: false, canClone: false },
        { provider: "x", voiceId: "low", label: "Low", attributes: ["low"], local: false, canClone: false },
      ],
    );
    assert.equal(ranked[ranked.length - 1]!.candidate.voiceId, "bare");
    assert.equal(ranked[ranked.length - 1]!.overlap, 0);
  });
});

describe("preview lines (R-9, D7, §3.2)", () => {
  const productionWithLine = {
    scenes: [
      {
        shots: [
          { audio: { kind: "vo", speaker: "maren-kest", line: "the verse, under the water" } },
          { audio: { kind: "vo", speaker: "bray-half-hitch", line: "not my knot" } },
        ],
      },
    ],
  } as unknown as ProductionBundle;

  it("prefers the character's own line", () => {
    const line = previewLineFor(SHEET, [productionWithLine]);
    assert.deepEqual(line, { text: "the verse, under the water", source: "own-line" });
  });

  it("drafts from the sheet for a character with no dialogue", () => {
    const line = previewLineFor(SHEET, []);
    assert.equal(line.source, "drafted");
    assert.match(line.text, /Tide-caller/);
  });

  it("uses the stock sentence only when nothing else exists", () => {
    const bare = { ...SHEET, sections: [] } as unknown as Sheet;
    const line = previewLineFor(bare, []);
    assert.equal(line.source, "stock");
  });
});

describe("delivery (R-15, D9, §3.2)", () => {
  it("maps deliveries per provider and reports what cannot be expressed", () => {
    const eleven = deliveryParams("elevenlabs", "breaking");
    assert.ok(eleven.ok && eleven.params["stability"] !== undefined);
    const kokoroPace = deliveryParams("kokoro", "urgent");
    assert.ok(kokoroPace.ok && kokoroPace.params["speed"] !== undefined);
    const kokoroNo = deliveryParams("kokoro", "breaking");
    assert.ok(!kokoroNo.ok && /cannot express "breaking"/.test(kokoroNo.reason), "stated, never silently ignored");
    const unknown = deliveryParams("higgsfield", "cold");
    assert.ok(!unknown.ok && /no declared delivery mapping/.test(unknown.reason));
  });
});

describe("the sidecar client and its four states (R-4, §2.10)", () => {
  it("every request goes to loopback and nowhere else (R-17 instrumentation)", async () => {
    const urls: string[] = [];
    const client = new VoxaClient(async (url) => {
      urls.push(url);
      if (url.endsWith("/stt")) return new Response(JSON.stringify({ text: "hello harbour" }), { status: 200 });
      if (url.endsWith("/tts")) return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 });
      if (url.endsWith("/voices")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }, "http://127.0.0.1:5901");
    await client.health();
    await client.listVoices();
    await client.synthesize({ voiceId: "af_bella", text: "hi" });
    const text = await client.transcribe(new Uint8Array([1, 2]), "audio/webm");
    assert.equal(text, "hello harbour");
    assert.ok(urls.every((u) => u.startsWith("http://127.0.0.1:5901/")), "audio never leaves the machine");
  });

  it("maps health to the four degradation states with real copy", () => {
    assert.equal(sidecarState(null).state, "not-started");
    assert.match(sidecarState(null).detail, /cloud voice still works/);
    const downloading = sidecarState({ ok: false, downloading: { model: "kokoro-int8", receivedMb: 40, totalMb: 92 } });
    assert.equal(downloading.state, "downloading");
    assert.match(downloading.detail, /40 of 92 MB/);
    const broken = sidecarState({ ok: false, unavailableReason: "kokoro weights failed verification" });
    assert.equal(broken.state, "unavailable");
    assert.equal(sidecarState({ ok: true, version: "1.4.0" }).state, "ready");
  });

  it("the local catalogue is presets, uniformly shaped, never cloneable (R-6, D4)", () => {
    const candidates = localCandidates(KOKORO_PRESETS);
    assert.ok(candidates.length >= 6);
    for (const c of candidates) {
      assert.equal(c.local, true);
      assert.equal(c.canClone, false, "local means presets, cloud means cloning");
      assert.ok(c.attributes.length > 0, "attributes exist for honest matching");
    }
  });
});
