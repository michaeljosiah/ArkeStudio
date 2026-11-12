import type { EffectClip } from "./editor-effects.js";
/** Optional extensions have semantic defaults without rewriting legacy authored records. */
const defaults: Readonly<Record<string, unknown>> = {
  "appearance.texture": .75, "appearance.softness": .55, "appearance.depth": .6, "appearance.blendMode": "normal",
  "motion.airflow": .5, "motion.particleDeflections": true, "motion.boundary": "soft-bounce",
};
export function effectAuthoredValue(effect: EffectClip, path: string): unknown {
  const value = path.split(".").reduce<unknown>((owner, key) => owner && typeof owner === "object" ? (owner as Record<string, unknown>)[key] : undefined, effect);
  return value === undefined ? defaults[path] : value;
}
