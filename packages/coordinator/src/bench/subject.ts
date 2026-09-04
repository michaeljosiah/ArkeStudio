import {
  DEFAULT_SHOT_SEC,
  admitReference,
  attachmentFor,
  assembleBoardPrompt,
  bindReferences,
  boardPromptFor,
  benchSubjectTitle,
  benchTokenFor,
  designatedVoiceSample,
  effectiveFraming,
  resolvedShotStaging,
  hasOwnFrame,
  mappedReferenceKinds,
  modelForCapability,
  orderedShots,
  packBoards,
  packShotsFor,
  productionAspect,
  productionStyleFor,
  promptFor,
  resolveCast,
  stagingMoveWord,
  stagePlayblastIsStale,
  stagingPromptClause,
  supportsMode,
  type AppSettings,
  type BenchComposer,
  type BenchReferenceToken,
  type BenchSession,
  type BenchSubject,
  type ManifestModel,
  type ModelManifest,
  type ProductionBundle,
  type ReferenceKind,
  type SceneRecord,
  type Shot,
  type ShotStaging,
  type WorldBundle,
} from "@arke-studio/contracts";

export interface PreparedBenchSubject {
  subject: BenchSubject;
  title: string;
  composer: BenchComposer;
  references: BenchReferenceToken[];
}

export interface SubjectSourceReader {
  read(path: string): Promise<{ hash: string } | { refused: string }>;
  durationSec(path: string): Promise<number | null>;
}

export type PrepareBenchSubjectResult =
  | { ok: true; prefill: PreparedBenchSubject }
  | { ok: false; reason: string };

/** The production route seeds the Bench picker; a disabled or stranded choice is not substituted. */
export function subjectModelFor(
  production: ProductionBundle,
  capability: "image" | "video",
  settings: AppSettings | null,
  manifest: ModelManifest | null,
): ManifestModel | null {
  if (manifest === null) return null;
  const chosen = production.meta.models?.[capability];
  const model = chosen
    ? manifest.models.find((candidate) => candidate.id === chosen && candidate.capability === capability) ?? null
    : modelForCapability(manifest, settings?.routing, capability);
  return model !== null && !settings?.models.disabled.includes(model.id) ? model : null;
}

/** Board identity follows the production's known route cap even when that route is stranded. */
function subjectPackingModelFor(
  production: ProductionBundle,
  settings: AppSettings | null,
  manifest: ModelManifest | null,
): ManifestModel | null {
  const chosen = production.meta.models?.video;
  return chosen === undefined
    ? subjectModelFor(production, "video", settings, manifest)
    : manifest?.models.find((candidate) => candidate.id === chosen && candidate.capability === "video") ?? null;
}

function episodeFor(production: ProductionBundle, sceneId: string): BenchSubject["episode"] {
  const episode = production.episodes.find((candidate) => candidate.scenes.includes(sceneId as never));
  return episode
    ? { id: episode.id, order: episode.order, title: episode.title }
    : undefined;
}

function subjectContext(production: ProductionBundle, scene: SceneRecord) {
  const episode = episodeFor(production, scene.id);
  return {
    productionId: production.meta.id,
    productionTitle: production.meta.title,
    ...(episode !== undefined ? { episode } : {}),
    sceneId: scene.id,
    sceneNumber: scene.number,
    sceneTitle: scene.title,
  };
}

function sheetOrder(shots: readonly Shot[], world: WorldBundle) {
  const found = new Map<string, ReturnType<typeof resolveCast>["cast"][number]>();
  for (const shot of shots) {
    for (const entry of resolveCast(shot.description, world.sheets).cast) {
      if (!found.has(entry.sheet.id)) found.set(entry.sheet.id, entry);
    }
  }
  return [...found.values()];
}

function assembledPromptSheetVersions(
  shots: readonly Shot[],
  scene: SceneRecord,
  world: WorldBundle,
): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const { sheet } of sheetOrder(shots, world)) versions[sheet.id] = sheet.version;
  const location = scene.inherits?.location === undefined
    ? undefined
    : world.sheets.find((sheet) => sheet.id === scene.inherits?.location);
  if (location !== undefined) versions[location.id] = location.version;
  return versions;
}

async function sourceToken(
  path: string,
  kind: ReferenceKind,
  token: string,
  reader: SubjectSourceReader,
  extra: Omit<BenchReferenceToken, "token" | "kind" | "source">,
): Promise<BenchReferenceToken | null> {
  const read = await reader.read(path);
  if ("refused" in read) return null;
  return {
    token,
    kind,
    source: { source: "world-file", path, hash: read.hash as never },
    ...extra,
  };
}

async function sheetTokens(
  shots: readonly Shot[],
  world: WorldBundle,
  production: ProductionBundle,
  scene: SceneRecord,
  reader: SubjectSourceReader,
  startAt = 1,
): Promise<BenchReferenceToken[]> {
  const references: BenchReferenceToken[] = [];
  let image = startAt;
  const ordered = sheetOrder(shots, world);
  const decisions = ordered.map(({ sheet }) =>
    attachmentFor(
      world.referenceKits.find((candidate) => candidate.sheetId === sheet.id) ?? null,
      sheet,
      "primary",
      { productionId: production.meta.id, sceneId: scene.id },
    ),
  );
  for (const bound of bindReferences(decisions, world.sheets)) {
    const sheet = world.sheets.find((candidate) => candidate.id === bound.sheetId)!;
    const entry = await sourceToken(
      bound.file,
      "image",
      benchTokenFor("image", image),
      reader,
      {
        label: `${sheet.name} · v${sheet.version}`,
        detail: `@${sheet.id} · ${bound.rolePhrase}`,
        sheetId: sheet.id,
        sheetVersion: sheet.version,
        ride: "when-supported",
        productionBinding: {
          subject: bound.subject,
          rolePhrase: bound.rolePhrase,
          mode: bound.mode,
        },
        subjectRole: "reference",
      },
    );
    if (entry !== null) {
      references.push(entry);
      image += 1;
    }
  }
  return references;
}

async function voiceTokens(
  shots: readonly Shot[],
  world: WorldBundle,
  reader: SubjectSourceReader,
): Promise<BenchReferenceToken[]> {
  const speakers: string[] = [];
  for (const shot of shots) {
    const speaker = shot.audio?.speaker;
    if (speaker !== undefined && !speakers.includes(speaker)) speakers.push(speaker);
  }
  const references: BenchReferenceToken[] = [];
  for (const speaker of speakers) {
    const sheet = world.sheets.find((candidate) => candidate.id === speaker);
    const kit = world.referenceKits.find((candidate) => candidate.sheetId === speaker) ?? null;
    const sample = designatedVoiceSample(kit);
    if (sheet === undefined || sample === null) continue;
    const durationSec = await reader.durationSec(sample.file);
    const entry = await sourceToken(
      sample.file,
      "audio",
      benchTokenFor("audio", references.length + 1),
      reader,
      {
        label: `voice sample · @${speaker}`,
        detail: durationSec === null ? sheet.name : `${sheet.name} · ${durationSec.toFixed(1)}s`,
        sheetId: sheet.id,
        sheetVersion: sheet.version,
        ...(durationSec !== null ? { durationSec } : {}),
        ride: "when-supported",
        subjectRole: "audio",
      },
    );
    if (entry !== null) references.push(entry);
  }
  return references;
}

/**
 * The filed playblast as a reference tile: the artifact the Stage exported, named for what it
 * is. `when-supported`, because no route today maps a video reference — the tile stays visible
 * and says it is not riding, while the beats in the brief carry the move regardless.
 */
function playblastToken(
  staging: ShotStaging,
  scene: SceneRecord,
  world: WorldBundle,
  shown: { durationSec: number; aspect: string; lens: string | undefined },
): BenchReferenceToken | null {
  const pinned = staging.playblast;
  if (pinned === undefined) return null;
  const artifact = world.artifacts.find((candidate) => candidate.id === pinned.artifactId);
  if (artifact === undefined || artifact.kind !== "video") return null;
  const resolved = resolvedShotStaging(scene, staging);
  // The recording baked in a staging, a length, an aspect and a lens; any of them moving on
  // makes it a file of a shot that no longer exists this way, and the tile says so.
  const moved = stagePlayblastIsStale(scene, staging, shown);
  const stale = moved ? " · stale" : "";
  return {
    token: benchTokenFor("video", 1),
    kind: "video",
    source: { source: "artifact", artifactId: artifact.id, hash: artifact.hash },
    label: `Staging · Playblast v${pinned.version}`,
    detail: `${staging.keys.length} keys · ${stagingMoveWord(staging.keys, resolved.cast, staging.rig)}${stale}`,
    ...(artifact.mediaInfo !== undefined ? { durationSec: artifact.mediaInfo.durationSec } : {}),
    ride: "when-supported",
    subjectRole: "reference",
  };
}

function stageOpeningFrameToken(
  staging: ShotStaging,
  scene: SceneRecord,
  world: WorldBundle,
  shown: { durationSec: number; aspect: string; lens: string | undefined },
  index: number,
): BenchReferenceToken | null {
  const pinned = staging.playblast;
  if (pinned?.openingFrameArtifactId === undefined) return null;
  const moved = stagePlayblastIsStale(scene, staging, shown);
  if (moved) return null;
  const artifact = world.artifacts.find((candidate) => candidate.id === pinned.openingFrameArtifactId);
  if (artifact === undefined || artifact.kind !== "image") return null;
  return {
    token: benchTokenFor("image", index),
    kind: "image",
    source: { source: "artifact", artifactId: artifact.id, hash: artifact.hash },
    label: `Staging · opening frame v${pinned.version}`,
    detail: `${staging.keys.length} keys · ${stagingMoveWord(staging.keys, resolvedShotStaging(scene, staging).cast, staging.rig)}`,
    ride: "when-supported",
    subjectRole: "board-frame",
  };
}

function admittedTokens(references: readonly BenchReferenceToken[], model: ManifestModel | null): string[] {
  if (model === null) return [];
  const mapped = new Set(mappedReferenceKinds(model.provider));
  const carried: Array<{ kind: ReferenceKind; durationSec: number | null }> = [];
  const admitted: string[] = [];
  for (const reference of references) {
    if (!mapped.has(reference.kind)) continue;
    const item = { kind: reference.kind, durationSec: reference.kind === "image" ? 0 : (reference.durationSec ?? null) };
    const verdict = admitReference(item, carried, model);
    if (!verdict.ok) continue;
    carried.push(item);
    admitted.push(reference.token);
  }
  return admitted;
}

/** Re-evaluate which current subject references ride when its chosen route changes. */
export function subjectReferenceRouting(
  references: readonly BenchReferenceToken[],
  subject: BenchSubject,
  model: ManifestModel | null,
): Pick<BenchComposer, "activeTokens" | "keyframeTokens"> {
  if (model === null) return { activeTokens: [], keyframeTokens: [] };
  const frames = references.filter((reference) => reference.subjectRole === "board-frame");
  const ordinary = references.filter((reference) => reference.subjectRole !== "board-frame");
  if (
    subject.kind === "shot" &&
    model.capability === "video" &&
    frames.length === 1 &&
    supportsMode(model, "first-frame")
  ) {
    return { activeTokens: [], keyframeTokens: [frames[0]!.token] };
  }
  // A complete frame sequence is structural guidance, not a bag of optional references. Keep it
  // intact in the keyframe lane even when this model cannot carry it, so dispatch refuses by name
  // instead of silently truncating it or spending on a less faithful ordinary-reference route.
  if (subject.kind === "board" && frames.length === subject.members.length) {
    return { activeTokens: [], keyframeTokens: frames.map((reference) => reference.token) };
  }
  return {
    activeTokens: admittedTokens([...ordinary, ...frames], model),
    keyframeTokens: [],
  };
}

/** Re-route production-owned references while preserving every user-owned lane exactly. */
export function subjectSessionReferenceRouting(
  session: BenchSession,
  model: ManifestModel | null,
): Pick<BenchComposer, "activeTokens" | "keyframeTokens"> | undefined {
  if (session.subject === undefined) return undefined;
  const subjectTokens = new Set(session.subjectTokens);
  const references = session.subjectTokens.flatMap((token) => {
    const reference = session.tokenRegistry.find((candidate) => candidate.token === token);
    return reference === undefined ? [] : [reference];
  });
  const routed = subjectReferenceRouting(references, session.subject, model);
  const mergeLane = (current: readonly string[], subjectLane: readonly string[]): string[] => {
    const routedTokens = new Set(subjectLane);
    const merged = current.filter((token) => !subjectTokens.has(token) || routedTokens.has(token));
    for (const token of subjectLane) {
      if (!merged.includes(token)) merged.push(token);
    }
    return merged;
  };
  return {
    activeTokens: mergeLane(session.composer.activeTokens, routed.activeTokens),
    keyframeTokens: mergeLane(session.composer.keyframeTokens, routed.keyframeTokens),
  };
}

function boardFor(
  production: ProductionBundle,
  scene: SceneRecord,
  world: WorldBundle,
  packing: { maxDurationSec?: number; maxMembers?: number } | null,
  memberShotIds: readonly string[],
) {
  const shots = orderedShots(scene);
  const packed = packBoards(
    packShotsFor({
      scene,
      shots,
      selections: production.selections,
      takes: production.takes,
      castOf: (shot) =>
        resolveCast(shot.description, world.sheets).cast
          .filter((entry) => entry.sheet.type === "character")
          .map((entry) => entry.sheet.id),
      defaultDurationSec: DEFAULT_SHOT_SEC,
    }),
    packing?.maxDurationSec ?? 10,
    new Set(scene.boards?.splits ?? []),
    new Set(scene.boards?.merges ?? []),
    (shotId) => subjectShotHasFrame(production, world, shotId),
    packing?.maxMembers,
  );
  if (!packed.ok) return null;
  return packed.boards.find((candidate) => candidate.memberShotIds.join("\n") === memberShotIds.join("\n")) ?? null;
}

function subjectShotHasFrame(production: ProductionBundle, world: WorldBundle, shotId: string): boolean {
  if (hasOwnFrame(production.selections[shotId], world.artifacts)) return true;
  const accepted = production.selections[shotId]?.acceptedTakeId;
  const take = accepted === undefined
    ? undefined
    : production.takes.find((candidate) => candidate.id === accepted);
  return take?.kind === "frame" || take?.kind === "still";
}

/** The bands still derive this exact board under the constraints that opened the session. */
export function boardSubjectIsCurrent(world: WorldBundle, subject: Extract<BenchSubject, { kind: "board" }>): boolean {
  const production = world.productions.find((candidate) => candidate.meta.id === subject.productionId);
  const scene = production?.scenes.find((candidate) => candidate.id === subject.sceneId);
  return production !== undefined && scene !== undefined &&
    boardFor(production, scene, world, subject.packing, subject.members.map((member) => member.shotId)) !== null;
}

/** Resolve an identity-only handoff against the current world and prepare one atomic Bench prefill. */
export async function prepareBenchSubject(
  world: WorldBundle,
  input: {
    productionId: string;
    sceneId: string;
    subject: { kind: "shot"; shotId: string } | { kind: "board"; memberShotIds: string[] };
    /** A shot opens in image mode unless the Stage asks for the clip (SPEC-036 R-23). */
    mode?: "image" | "video";
    settings: AppSettings | null;
    manifest: ModelManifest | null;
    sources: SubjectSourceReader;
  },
): Promise<PrepareBenchSubjectResult> {
  const production = world.productions.find((candidate) => candidate.meta.id === input.productionId);
  if (production === undefined) return { ok: false, reason: "That production is no longer in this world." };
  const scene = production.scenes.find((candidate) => candidate.id === input.sceneId);
  if (scene === undefined) return { ok: false, reason: "That scene is no longer in this production." };
  const shots = orderedShots(scene);
  const aspect = productionAspect(production.meta);
  const style = productionStyleFor(production.meta, world.artDirection.description);

  if (input.subject.kind === "shot") {
    const shotId = input.subject.shotId;
    const shot = shots.find((candidate) => candidate.id === shotId);
    if (shot === undefined) return { ok: false, reason: "That shot is no longer in this scene." };
    const mode = input.mode ?? "image";
    const model = subjectModelFor(production, mode, input.settings, input.manifest);
    const references = await sheetTokens([shot], world, production, scene, input.sources);
    const staging = mode === "video" ? shot.staging : undefined;
    const shown = {
      durationSec: shot.durationSec ?? DEFAULT_SHOT_SEC,
      aspect,
      lens: effectiveFraming(scene, shot).lens,
    };
    const openingFrame = staging === undefined
      ? null
      : stageOpeningFrameToken(staging, scene, world, shown, references.length + 1);
    const selection = production.selections[shot.id];
    const frameArtifactId = selection?.startFrameArtifactId;
    const frameArtifact = frameArtifactId === undefined || frameArtifactId === null
      ? undefined
      : world.artifacts.find((candidate) => candidate.id === frameArtifactId);
    if (openingFrame !== null) {
      references.push(openingFrame);
    } else if (hasOwnFrame(selection, world.artifacts) && frameArtifact?.kind === "image") {
      references.push({
        token: benchTokenFor("image", references.length + 1),
        kind: "image",
        source: { source: "artifact", artifactId: frameArtifact.id, hash: frameArtifact.hash },
        label: `Shot ${shot.number} · storyboard frame`,
        detail: "the storyboard frame for this shot",
        ride: "when-supported",
        subjectRole: "board-frame",
      });
    }
    // The clip is where the move matters: its exact opening view can ride every image-capable
    // route, the playblast rides where video is carried, and the beats ride in the words everywhere.
    const playblast = staging === undefined
      ? null
      : playblastToken(staging, scene, world, shown);
    if (playblast !== null) references.push(playblast);
    const nameOf = (sheetId: string) => world.sheets.find((sheet) => sheet.id === sheetId)?.name ?? sheetId;
    const prompt = promptFor(world.meta, world.sheets, scene, shot, style, undefined, mode).text;
    const brief = staging === undefined
      ? prompt
      : `${prompt}\n\n${stagingPromptClause(resolvedShotStaging(scene, staging), nameOf, shown.durationSec)}`;
    const promptSheetVersions = shot.promptOverride === undefined
      ? assembledPromptSheetVersions([shot], scene, world)
      : { ...shot.promptOverride.sheetVersions };
    const subject: BenchSubject = {
      kind: "shot",
      ...subjectContext(production, scene),
      promptSheetVersions,
      shotId: shot.id,
      shotNumber: shot.number,
      shotTitle: shot.title,
      durationSec: shot.durationSec ?? DEFAULT_SHOT_SEC,
      aspect,
    };
    const routing = subjectReferenceRouting(references, subject, model);
    return {
      ok: true,
      prefill: {
        subject,
        title: benchSubjectTitle(subject),
        references,
        composer: {
          mode,
          provider: model?.provider ?? "",
          model: model?.id ?? "",
          params:
            mode === "video"
              ? { kind: "video", aspect, durationSec: shot.durationSec ?? DEFAULT_SHOT_SEC, sound: true }
              : { kind: "image", aspect, count: 1 },
          brief,
          ...routing,
        },
      },
    };
  }

  const model = subjectModelFor(production, "video", input.settings, input.manifest);
  const packingModel = subjectPackingModelFor(production, input.settings, input.manifest);
  const packing = {
    maxDurationSec: packingModel?.limits.maxDurationSec ?? 10,
    ...(packingModel?.limits.storyboardPanels !== undefined
      ? { maxMembers: packingModel.limits.storyboardPanels }
      : {}),
  };
  const board = boardFor(
    production,
    scene,
    world,
    packing,
    input.subject.memberShotIds,
  );
  if (board === null) return { ok: false, reason: "That board no longer matches the current scene." };
  const members = board.memberShotIds.map((id) => shots.find((candidate) => candidate.id === id)!);
  const sheets = await sheetTokens(members, world, production, scene, input.sources);
  const frames: BenchReferenceToken[] = [];
  let nextImage = sheets.length + 1;
  for (const shot of members) {
    const selection = production.selections[shot.id];
    const artifactId = selection?.startFrameArtifactId;
    const artifact = artifactId ? world.artifacts.find((candidate) => candidate.id === artifactId) : undefined;
    if (artifact?.kind === "image") {
      frames.push({
        token: benchTokenFor("image", nextImage++),
        kind: "image",
        source: { source: "artifact", artifactId: artifact.id, hash: artifact.hash },
        label: `Shot ${shot.number} · accepted frame`,
        detail: "visual keyframe",
        ride: "when-supported",
        subjectRole: "board-frame",
      });
      continue;
    }
    const accepted = selection?.acceptedTakeId;
    const legacy = accepted === undefined
      ? undefined
      : production.takes.find(
          (candidate) =>
            candidate.id === accepted &&
            (candidate.kind === "frame" || candidate.kind === "still") &&
            candidate.media !== undefined,
        );
    if (legacy?.media === undefined) continue;
    const path = `productions/${production.meta.id}/takes/${legacy.id}/${legacy.media}`;
    const read = await input.sources.read(path);
    if ("refused" in read) continue;
    frames.push({
      token: benchTokenFor("image", nextImage++),
      kind: "image",
      source: { source: "world-file", path, hash: read.hash },
      label: `Shot ${shot.number} · accepted frame`,
      detail: "visual keyframe",
      ride: "when-supported",
      subjectRole: "board-frame",
    });
  }
  const voices = await voiceTokens(members, world, input.sources);
  const ordinary = [...sheets, ...voices];
  const authoredPrompt = boardPromptFor(scene, board.memberShotIds);
  const subject: BenchSubject = {
    kind: "board",
    ...subjectContext(production, scene),
    promptSheetVersions: authoredPrompt === null ? assembledPromptSheetVersions(members, scene, world) : {},
    letter: board.letter,
    durationSec: board.durationSec,
    aspect,
    packing,
    members: members.map((shot) => ({
      shotId: shot.id,
      number: shot.number,
      title: shot.title,
      durationSec: shot.durationSec ?? DEFAULT_SHOT_SEC,
    })),
  };
  const routing = subjectReferenceRouting([...ordinary, ...frames], subject, model);
  return {
    ok: true,
    prefill: {
      subject,
      title: benchSubjectTitle(subject),
      references: [...ordinary, ...frames],
      composer: {
        mode: "video",
        provider: model?.provider ?? "",
        model: model?.id ?? "",
          params: {
            kind: "video",
            aspect,
            durationSec: board.durationSec,
            sound: true,
          },
        brief:
          authoredPrompt ??
          assembleBoardPrompt({
            world: world.meta,
            sheets: world.sheets,
            scene,
            shots: members,
            aspect,
            ...(style !== undefined ? { artDirection: style } : {}),
          }),
        ...routing,
      },
    },
  };
}
