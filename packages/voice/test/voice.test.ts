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
import {
  compatibleSidecarHealth,
  KOKORO_PRESETS,
  localCandidates,
  sidecarState,
  VoxaCancelledError,
  VoxaClient,
  VoxaTimeoutError,
} from "../src/index.js";

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
      { provider: "elevenlabs", model: "eleven-v2", voiceId: "v1", label: "Harbour", attributes: ["low", "even", "coastal"], local: false, canClone: true },
      { provider: "elevenlabs", model: "eleven-v3", voiceId: "v2", label: "Bright", attributes: ["bright", "quick"], local: false, canClone: true },
      { provider: "kokoro", model: "kokoro-82m", voiceId: "af_bella", label: "Bella", attributes: ["low", "warm"], local: true, canClone: false },
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
        { provider: "x", model: "x-v1", voiceId: "bare", label: "Bare", attributes: [], local: false, canClone: false },
        { provider: "x", model: "x-v2", voiceId: "low", label: "Low", attributes: ["low"], local: false, canClone: false },
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
        id: "sc_01",
        shots: [
          { id: "sh_1", audio: { kind: "vo", speaker: "maren-kest", line: "the verse, under the water" } },
          { id: "sh_2", audio: { kind: "vo", speaker: "bray-half-hitch", line: "not my knot" } },
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
      return new Response(JSON.stringify({
        ok: true,
        version: "0.8.0",
        protocolVersion: 1,
        architecture: "x64",
        engines: ["kokoro", "whisper"],
        engineStatus: { kokoro: { ready: true }, whisper: { ready: true } },
      }), { status: 200 });
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
    const base = { version: "0.8.0", protocolVersion: 1 as const, architecture: "x64" as const, engines: ["kokoro", "whisper"] as const, engineStatus: { kokoro: { ready: true }, whisper: { ready: true } } };
    const downloading = sidecarState({
      ...base,
      ok: false,
      engineStatus: { kokoro: { ready: false }, whisper: { ready: false } },
      downloading: { model: "kokoro-int8", receivedMb: 40, totalMb: 92 },
    });
    assert.equal(downloading.state, "downloading");
    assert.match(downloading.detail, /40 of 92 MB/);
    const broken = sidecarState({
      ...base,
      ok: false,
      engineStatus: { kokoro: { ready: false }, whisper: { ready: false } },
      unavailableReason: "kokoro weights failed verification",
    });
    assert.equal(broken.state, "unavailable");
    assert.equal(sidecarState({ ...base, ok: true }).state, "ready");
    assert.equal(
      sidecarState({
        ...base,
        ok: false,
        engineStatus: { kokoro: { ready: false, reason: "Kokoro failed" }, whisper: { ready: true } },
      }).state,
      "ready",
      "one ready engine keeps the protocol host usable for that capability",
    );
    assert.equal(compatibleSidecarHealth({ ...base, ok: true, engines: [...base.engines] }, "x64"), true);
    assert.equal(
      compatibleSidecarHealth({ ...base, ok: false, engines: [...base.engines] }, "x64"),
      true,
      "compatibility is not aggregate engine readiness",
    );
    assert.equal(compatibleSidecarHealth({ ...base, ok: true, engines: [...base.engines] }, "arm64"), false);
  });

  it("bounds every hung operation with a typed operation timeout", async () => {
    const requestSignals: AbortSignal[] = [];
    const client = new VoxaClient(
      async (_url, init) => {
        if (init?.signal) requestSignals.push(init.signal);
        return new Promise<Response>(() => {});
      },
      "http://127.0.0.1:5901",
      { timeouts: { health: 10, voices: 10, tts: 10, stt: 10 } },
    );

    const operations = [
      { operation: "health", invoke: () => client.health() },
      { operation: "voices", invoke: () => client.listVoices() },
      { operation: "tts", invoke: () => client.synthesize({ voiceId: "af_bella", text: "hello" }) },
      { operation: "stt", invoke: () => client.transcribe(new Uint8Array([1]), "audio/webm") },
    ] as const;
    for (const operation of operations) {
      await assert.rejects(
        operation.invoke,
        (error) =>
          error instanceof VoxaTimeoutError &&
          error.operation === operation.operation &&
          error.timeoutMs === 10,
      );
    }
    assert.equal(requestSignals.length, operations.length);
    assert.ok(requestSignals.every((signal) => signal.aborted), "every underlying fetch is aborted too");
  });

  it("reports the configured TTS timeout after time spent waiting in the synthesis lane", async () => {
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const client = new VoxaClient(
      async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 });
        }
        return new Promise<Response>(() => {});
      },
      "http://127.0.0.1:5901",
      { timeouts: { tts: 60 } },
    );
    const first = client.synthesize({ voiceId: "af_bella", text: "one" });
    const second = client.synthesize({ voiceId: "af_bella", text: "two" });
    while (releaseFirst === undefined) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await first;
    await assert.rejects(
      second,
      (error) => error instanceof VoxaTimeoutError && error.timeoutMs === 60 && /60 ms/.test(error.message),
    );
  });

  it("accepts caller cancellation and reports it distinctly from timeout", async () => {
    const control = new AbortController();
    const client = new VoxaClient(
      async () => new Promise<Response>(() => {}),
      "http://127.0.0.1:5901",
      { timeouts: { voices: 1_000 } },
    );
    const pending = client.listVoices({ signal: control.signal });
    control.abort();
    await assert.rejects(
      pending,
      (error) => error instanceof VoxaCancelledError && error.operation === "voices",
    );
  });

  it("serializes all synthesis through one client-wide lane", async () => {
    let active = 0;
    let peak = 0;
    const client = new VoxaClient(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 });
      },
      "http://127.0.0.1:5901",
      { timeouts: { tts: 1_000 } },
    );

    await Promise.all([
      client.synthesize({ voiceId: "af_bella", text: "one" }),
      client.synthesize({ voiceId: "af_bella", text: "two" }),
      client.synthesize({ voiceId: "af_bella", text: "three" }),
    ]);
    assert.equal(peak, 1);
  });

  it("cancels active and queued synthesis before a runtime restart", async () => {
    const client = new VoxaClient(
      async () => new Promise<Response>(() => {}),
      "http://127.0.0.1:5901",
      { timeouts: { tts: 1_000 } },
    );
    const first = client.synthesize({ voiceId: "af_bella", text: "one" }).catch((error: unknown) => error);
    const second = client.synthesize({ voiceId: "af_bella", text: "two" }).catch((error: unknown) => error);
    client.cancelPending();

    assert.ok((await first) instanceof VoxaCancelledError);
    assert.ok((await second) instanceof VoxaCancelledError);
  });

  it("keeps the synthesis lane usable after restart cancellation", async () => {
    let calls = 0;
    const client = new VoxaClient(
      async () => {
        calls += 1;
        if (calls === 1) return new Promise<Response>(() => {});
        return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 });
      },
      "http://127.0.0.1:5901",
      { timeouts: { tts: 1_000 } },
    );
    const interrupted = client.synthesize({ voiceId: "af_bella", text: "old process" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    client.cancelPending();
    await assert.rejects(interrupted, VoxaCancelledError);
    const afterRestart = await client.synthesize({ voiceId: "af_bella", text: "new process" });
    assert.equal(Buffer.from(afterRestart).toString("ascii"), "RIFF");
  });

  it("the Kokoro catalogue is presets, uniformly shaped, never cloneable (R-6, D4)", () => {
    const candidates = localCandidates(KOKORO_PRESETS);
    assert.ok(candidates.length >= 6);
    for (const c of candidates) {
      assert.equal(c.local, true);
      assert.equal(c.canClone, false, "Kokoro presets are never cloneable");
      assert.ok(c.attributes.length > 0, "attributes exist for honest matching");
    }
  });
});
