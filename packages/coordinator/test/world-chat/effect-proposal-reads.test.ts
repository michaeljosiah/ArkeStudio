import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultEffectClip } from "@arke-studio/contracts";
import { boundedEffectReadRows, effectReadRows } from "../../src/world-chat/effect-proposal-reads.js";
import { productionReadFence } from "../../src/world-chat/production-reads.js";

test("complete effect reads expose every curve point and cue with a freshness fence", () => {
  const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", seed: 1, startFrame: 0, durationFrames: 2400 });
  effect.intensityCurve.points = Array.from({ length: 2000 }, (_, index) => ({ id: `ep_${index}`, offsetFrames: index, value: .5, interpolation: "linear" as const }));
  effect.cueOverrides = [{ id: "ec_opening", kind: "accent", frame: 0, strength: .5, durationFrames: 4 }];
  const rows = effectReadRows("timeline", effect), values = rows.map(row => row.value as { kind: string; point?: unknown; cue?: unknown });
  assert.equal(values.filter(row => row.kind === "effect-point").length, 2000);
  assert.deepEqual(values.find(row => row.kind === "effect-cue")?.cue, effect.cueOverrides[0]);
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
  const before = productionReadFence(rows);
  effect.intensityCurve.points[1999]!.value = .75;
  assert.notEqual(productionReadFence(effectReadRows("timeline", effect)), before, "the final point participates in the read receipt");
});

test("large retained decisions paginate losslessly instead of hiding trailing identities", () => {
  const value = { kind: "effect-human-decision", ids: Array.from({ length: 4000 }, (_, index) => `human:${index}:🌌`) };
  const rows = boundedEffectReadRows([{ key: "decision", value }]);
  assert.ok(rows.length > 1);
  const fragments = rows.map(row => row.value as { recordKey: string; index: number; count: number; jsonText: string });
  assert.ok(fragments.every((part, index) => part.index === index && part.count === rows.length && part.jsonText.length <= 2048));
  assert.deepEqual(JSON.parse(fragments.map(part => part.jsonText).join("")), value);
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
});
