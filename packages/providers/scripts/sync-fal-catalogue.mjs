/**
 * Regenerate the FAL half of the shipped manifest from fal's own catalogue.
 *
 *   node packages/providers/scripts/sync-fal-catalogue.mjs
 *
 * Why a script and not a hand-written table: the hand-written one was wrong. It called a model
 * "Seedance 2.0" while pointing at the v1 route, priced everything from memory, and listed
 * three models out of fourteen hundred. `https://fal.ai/api/models` is public and needs no key,
 * so the route ids and the prices can come from the place that charges them.
 *
 * What the API does NOT say is what a model accepts — reference images, start and end frames,
 * durations, resolutions. Those stay in CURATED below, written by hand, because guessing them
 * would put wrong promises in front of a dispatch. The script merges the two and refuses to
 * emit a model whose price it could not read: an unpriced model cannot be estimated, and
 * estimating before spending is the whole point of the manifest.
 */

const API = "https://fal.ai/api/models";

/**
 * The models we offer. Deliberately short — fourteen hundred routes is a search problem, not a
 * dropdown — and every line here is a decision about what the studio is for.
 */
const CURATED = {
  "fal-ai/flux-2-pro": {
    id: "flux-2-pro",
    capability: "image",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { resolutions: ["1MP", "2MP", "4MP"], aspects: ["16:9", "9:16", "1:1", "4:3"] },
  },
  "fal-ai/nano-banana-2": {
    id: "nano-banana-2",
    capability: "image",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { resolutions: ["1K", "2K", "4K"], aspects: ["16:9", "9:16", "1:1"] },
  },
  "fal-ai/nano-banana-pro": {
    id: "nano-banana-pro",
    capability: "image",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { resolutions: ["1K", "2K", "4K"], aspects: ["16:9", "9:16", "1:1"] },
  },
  "bytedance/seedance-2.0/text-to-video": {
    id: "seedance-2.0",
    capability: "video",
    accepts: { referenceImages: 0, startFrame: true, endFrame: true },
    limits: { maxDurationSec: 15, resolutions: ["720p", "1080p"], aspects: ["16:9", "9:16", "1:1"] },
  },
  "bytedance/seedance-2.0/fast/text-to-video": {
    id: "seedance-2.0-fast",
    capability: "video",
    accepts: { referenceImages: 0, startFrame: true, endFrame: true },
    limits: { maxDurationSec: 15, resolutions: ["720p", "1080p"], aspects: ["16:9", "9:16"] },
  },
  "fal-ai/veo3.1": {
    id: "veo-3.1",
    capability: "video",
    accepts: { referenceImages: 0, startFrame: true, endFrame: true },
    limits: { maxDurationSec: 8, resolutions: ["720p", "1080p"], aspects: ["16:9", "9:16"] },
  },
  "fal-ai/veo3.1/fast": {
    id: "veo-3.1-fast",
    capability: "video",
    accepts: { referenceImages: 0, startFrame: true, endFrame: false },
    limits: { maxDurationSec: 8, resolutions: ["720p"], aspects: ["16:9", "9:16"] },
  },
  "fal-ai/kling-video/v3/pro/text-to-video": {
    id: "kling-3-pro",
    capability: "video",
    accepts: { referenceImages: 0, startFrame: true, endFrame: true },
    limits: { maxDurationSec: 10, resolutions: ["1080p"], aspects: ["16:9", "9:16", "1:1"] },
  },
  "fal-ai/kling-video/v3/standard/text-to-video": {
    id: "kling-3-standard",
    capability: "video",
    accepts: { referenceImages: 0, startFrame: true, endFrame: false },
    limits: { maxDurationSec: 10, resolutions: ["720p"], aspects: ["16:9", "9:16"] },
  },
};

const money = String.raw`\*{0,2}\$([0-9]+(?:\.[0-9]+)?)\*{0,2}`;

/**
 * Read the price out of fal's own prose. Every pattern here was matched against a real string
 * from the API; anything that does not match returns null and the model is dropped rather than
 * guessed at.
 */
function pricingFrom(text) {
  const clean = (text ?? "").replace(/\s+/g, " ");
  const micro = (s) => Math.round(Number.parseFloat(s) * 1_000_000);

  // "For every second of 720p video ... **$0.3034/second** and for 1080p ... **$0.682/second**"
  const perSecondByRes = clean.match(new RegExp(`${money}\\s*/?\\s*second[\\s\\S]{0,80}?1080p[^$]{0,40}${money}`, "i"));
  if (perSecondByRes) {
    return {
      kind: "perSecond",
      microUsdPerSecond: micro(perSecondByRes[1]),
      byResolution: { "1080p": micro(perSecondByRes[2]) },
    };
  }
  if (/every second of/i.test(clean) || /per second/i.test(clean) || /\/second/i.test(clean)) {
    const first = clean.match(new RegExp(money));
    if (first) return { kind: "perSecond", microUsdPerSecond: micro(first[1]) };
  }
  // "**$0.03** for the first megapixel of output"
  const perMegapixel = clean.match(new RegExp(`${money}[^.]{0,30}megapixel`, "i"));
  if (perMegapixel) return { kind: "perMegapixel", microUsdPerMegapixel: micro(perMegapixel[1]) };
  // "Your request will cost **$0.08** per image."
  const perImage = clean.match(new RegExp(`${money}\\s*(?:per|/)\\s*image`, "i"));
  if (perImage) return { kind: "perImage", microUsdPerImage: micro(perImage[1]) };
  return null;
}

async function fetchCatalogue() {
  const items = [];
  let page = 1;
  for (;;) {
    const res = await fetch(`${API}?page=${page}&limit=100`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`fal catalogue: HTTP ${res.status} on page ${page}`);
    const body = await res.json();
    items.push(...(body.items ?? []));
    if (page >= (body.pages ?? 1)) return { items, total: body.total ?? items.length };
    page += 1;
  }
}

const { items, total } = await fetchCatalogue();
const byRoute = new Map(items.map((m) => [m.id, m]));
console.log(`[fal] ${total} models in the catalogue; ${Object.keys(CURATED).length} curated`);

const models = [];
const endpoints = {};
const skipped = [];
for (const [route, curated] of Object.entries(CURATED)) {
  const live = byRoute.get(route);
  if (!live) {
    skipped.push(`${route} — no longer in the catalogue`);
    continue;
  }
  const pricing = pricingFrom(live.pricingInfoOverride);
  if (!pricing) {
    skipped.push(`${route} — no price we could read from "${(live.pricingInfoOverride ?? "").slice(0, 60)}…"`);
    continue;
  }
  models.push({
    id: curated.id,
    provider: "fal",
    capability: curated.capability,
    displayName: live.title,
    accepts: curated.accepts,
    limits: curated.limits,
    pricing,
  });
  endpoints[curated.id] = route;
}

for (const line of skipped) console.warn(`[fal] skipped ${line}`);

const banner = `// Generated by packages/providers/scripts/sync-fal-catalogue.mjs — do not edit by hand.
// Route ids and prices come from https://fal.ai/api/models (public, no key). What a model
// accepts is curated in that script, because the API does not say.
// Catalogue size at generation: ${total} models. Regenerate when fal ships something worth having.
`;

const body = `${banner}
import type { ManifestModel } from "@arke-studio/contracts";

export const FAL_MODELS: readonly ManifestModel[] = ${JSON.stringify(models, null, 2)} as const;

/** Model id → fal route. Dispatch needs this; a model without one cannot be submitted. */
export const FAL_ENDPOINTS: Record<string, string> = ${JSON.stringify(endpoints, null, 2)};
`;

const out = new URL("../src/fal-catalogue.generated.ts", import.meta.url);
await (await import("node:fs/promises")).writeFile(out, body, "utf8");
console.log(`[fal] wrote ${models.length} models to src/fal-catalogue.generated.ts`);
