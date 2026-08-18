import type { BenchMode, BenchParams, ManifestModel } from "@arke-studio/contracts";

/** What a composer is set to within one mode: which model, and the controls under it. */
export interface ModeSetup {
  provider: string;
  model: string;
  params: BenchParams;
}

/**
 * What the composer becomes when the mode changes.
 *
 * The rule is that a glance at the other mode costs nothing. Switching used to reset the model
 * and every parameter to that mode's defaults in both directions, so a video setup — the model,
 * its length, whether it makes sound — was destroyed by one press of *Image* and not restored by
 * pressing *Video* again. The round trip looked free and was not, and nothing said so.
 *
 * A remembered model that is no longer usable is dropped rather than restored: a key withdrawn
 * or a row disabled between one press and the next would otherwise put a selection in the
 * composer that the dispatch is bound to refuse.
 */
export function setupForMode(
  mode: BenchMode,
  remembered: ModeSetup | undefined,
  usable: readonly ManifestModel[],
): ModeSetup {
  const stillUsable =
    remembered !== undefined &&
    usable.some((m) => m.id === remembered.model && m.provider === remembered.provider);
  if (remembered !== undefined && stillUsable) return remembered;
  const first = usable[0];
  return {
    provider: first?.provider ?? "",
    model: first?.id ?? "",
    params:
      mode === "image"
        ? { kind: "image", count: 1 }
        : mode === "video"
          ? { kind: "video" }
          : mode === "voice"
            ? { kind: "voice", count: 1 }
            : // A song starts with no words. The lyrics box is empty and dispatch refuses until
              // it is not — either the author writes them or the helper drafts them.
              { kind: "music", count: 1, lyrics: "" },
  };
}
