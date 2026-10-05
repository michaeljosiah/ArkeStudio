import {
  MAIN_PHOTO_LOOK,
  PICTURE_PROMPT_MAX,
  pictureAspect,
  pictureQuote,
  sheetReferencePicture,
  type AudiobookPicture,
  type ChapterAudiobook,
  type ManifestModel,
  type PictureSuggestion,
  type PictureWho,
  type WorldBundle,
} from "@arke-studio/contracts";

/**
 * A picture already on its block, read back as 193's card (design turn 194, rule 12; 194a, 194g):
 * the card a suggestion draws, drawn from what the picture kept rather than from a fresh draft. The
 * Bench's sidecar holds the prompt it was sent, the model and the pictures that rode; the record's
 * stamp holds who was in it and which of each look's images rode; the shot (frame, who was not in
 * frame, the checks) is kept from design turn 194g on. What none of them kept is left out, never
 * reconstructed: a picture made before the shot was kept has no Frame and no checks.
 *
 * Null for a picture Arke did not make — one chosen from the world, an upload, a cast picture, a
 * scene's frame — and for one whose model the manifest no longer lists, since then nothing can say
 * what Make again would cost.
 */
export function madePicture(
  world: Pick<WorldBundle, "artifacts" | "sheets" | "referenceKits">,
  models: readonly ManifestModel[] | undefined,
  entry: AudiobookPicture,
  look: ChapterAudiobook["look"] | null | undefined,
  block: string,
): PictureSuggestion | null {
  const artifact = world.artifacts.find((candidate) => `artifacts/${candidate.file}` === entry.file);
  const generation = artifact?.generation;
  if (generation === undefined || generation.source !== "bench") return null;
  const prompt = madePrompt(generation.brief).slice(0, PICTURE_PROMPT_MAX);
  if (prompt === "") return null;
  const model = models?.find((candidate) => candidate.provider === generation.provider && candidate.id === generation.model);
  if (model === undefined) return null;

  const sheetOf = (key: string) => look?.characters[key]?.sheet ?? key;
  const who: PictureWho[] = [];
  const seen = new Set<string>();
  const add = (sheetId: string, reference: string | null, carried: boolean) => {
    const sheet = world.sheets.find((candidate) => candidate.id === sheetId);
    const place = sheet?.type === "location";
    // A character is named by the key the chapter's people carry (the stamp's), so Make again asks for the same people.
    const key = place ? sheetId : (entry.look?.who.find((candidate) => sheetOf(candidate) === sheetId) ?? sheetId);
    if (seen.has(key)) return;
    seen.add(key);
    const pick = place ? undefined : entry.look?.looks?.[key];
    who.push({
      key,
      name: sheet?.name ?? key,
      ...(sheet !== undefined ? { sheet: sheet.id } : {}),
      kind: place ? "place" : "character",
      reference,
      carried,
      // The main photo chosen for this picture alone rode as the main photo does: no look (design turn 193d, R-146).
      ...(pick !== undefined && pick.lookId !== MAIN_PHOTO_LOOK ? { look: { lookId: pick.lookId, view: pick.view } } : {}),
      ...(pick?.only === true ? { only: true as const } : {}),
    });
  };
  // What rode, as the Bench sent it: each picture under `references/<sheet>/`.
  const rode = generation.references.flatMap((token) => {
    if (token.source.source !== "world-file") return [];
    const path = token.source.path;
    const sheetId = token.sheetId ?? (path.startsWith("references/") ? path.split("/")[1] : undefined);
    return sheetId === undefined ? [] : [{ sheetId, path }];
  });
  const rodeOf = (sheetId: string) => rode.find((entry) => entry.sheetId === sheetId);
  // The people first, in the stamp's order: one who did not ride is still in frame, dashed (no
  // picture) or over the model's limit (a picture that was left behind).
  for (const key of entry.look?.who ?? []) {
    const sheetId = sheetOf(key);
    const riding = rodeOf(sheetId);
    if (riding !== undefined) add(sheetId, riding.path, true);
    else add(sheetId, sheetReferencePicture(world, sheetId), false);
  }
  for (const riding of rode) if (world.sheets.find((sheet) => sheet.id === riding.sheetId)?.type !== "location") add(riding.sheetId, riding.path, true);
  for (const riding of rode) if (world.sheets.find((sheet) => sheet.id === riding.sheetId)?.type === "location") add(riding.sheetId, riding.path, true);

  const asked = generation.params.kind === "image" ? generation.params.aspect : undefined;
  const aspect = asked !== undefined && asked !== "" ? asked : pictureAspect(model);
  return {
    block,
    prompt,
    who,
    lines: [],
    model: {
      provider: model.provider,
      id: model.id,
      name: model.displayName,
      references: model.accepts.referenceImages,
      ...(model.pricing.kind === "included-plan" ? { plan: "included-plan" as const } : {}),
    },
    ...(aspect !== undefined ? { aspect } : {}),
    // What Make again costs, from the figures the suggestion priced it with.
    estimatedMicroUsd: pictureQuote(model, who.filter((entry) => entry.carried).length, aspect),
    ...(entry.look !== undefined ? { look: entry.look } : {}),
    ...(entry.shot !== undefined ? { shot: entry.shot } : {}),
  };
}

/**
 * The prompt a made picture was asked with. A picture made from a block's card went to the Bench
 * as the prompt, then the app's own closing lines (`pictureBench`: who is in which picture, the
 * light, no text), each a paragraph; the card shows the prompt alone. A brief the author wrote at
 * the Bench has none of those lines and is the prompt whole.
 */
export function madePrompt(brief: string): string {
  const whole = brief.trim();
  if (!whole.endsWith("No text in the picture.")) return whole;
  return (whole.split("\n\n")[0] ?? "").trim();
}

/** The one plain word for where a picture Arke did not make came from: an upload, or chosen from what the world holds. */
export function chosenFrom(world: Pick<WorldBundle, "artifacts">, file: string): "uploaded" | "chosen" {
  const artifact = world.artifacts.find((candidate) => `artifacts/${candidate.file}` === file);
  return artifact?.origin.by === "user" ? "uploaded" : "chosen";
}
