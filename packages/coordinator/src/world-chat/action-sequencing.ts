import { ModelWorldChatActionSchema, applyAudioSpineCommand, orderedShots, sceneCommandCandidate, sceneCommandBatchCandidate, shotDeleteBlockers,
  turnActionGroups, type ModelWorldChatAction, type SceneRecord, type WorldBundle, type WorldChatDependencyPreview } from "@arke-studio/contracts";
import { SceneCommandRefused, sceneCommandFrom } from "../productions/scene-commands.js";

export function sceneActionCommands<T>(action: { command?: T; commands?: readonly T[] }): T[] {
  if ((action.command === undefined) === (action.commands === undefined)) throw new Error("A scene action needs command or commands, never both.");
  const commands = action.commands ? [...action.commands] : [action.command!];
  if (!commands.length || commands.length > 24) throw new Error("A scene action needs between one and 24 commands.");
  return commands;
}

type SceneAction = Extract<ModelWorldChatAction, { kind: "production-scene-command" }>;
export interface TurnActionGroup {
  action: ModelWorldChatAction;
  members: ModelWorldChatAction[];
  dependencies: number[];
  scene?: { before: SceneRecord; after: SceneRecord; beforeBundle: WorldBundle };
  dependencyPreview?: { scenes: WorldChatDependencyPreview["scenes"]; beforeBundle: WorldBundle };
}

/** Explicit dependency boundaries stay separate; independent edits to one scene share a card. */
export function sequenceTurnActions(bundle: WorldBundle, actions: readonly ModelWorldChatAction[]): TurnActionGroup[] {
  const groups: TurnActionGroup[] = turnActionGroups(actions).map(group => ({ action: actions[group.members[0]!]!,
    members: group.members.map(index => actions[index]!), dependencies: group.dependencies }));
  const created = new Map<string, CreatedShots>();
  /*
   * Shot ids each production's scene cards in this turn have already given their new shots (issue
   * 3149). Each card is planned against the production as it is, so cards for two scenes each gave
   * a new shot the same next id, and approving one left the other unable to keep the id it showed.
   */
  const minted = new Map<string, string[]>();
  for (const group of groups) {
    const ancestors = new Set<number>();
    const visit = (index: number) => {
      if (ancestors.has(index)) return;
      for (const parent of groups[index]!.dependencies) visit(parent);
      ancestors.add(index);
    };
    for (const parent of group.dependencies) visit(parent);
    let working = bundle;
    const snapshots = new Map<string, WorldChatDependencyPreview["scenes"][number]>();
    for (const index of [...ancestors].sort((a, b) => a - b)) {
      const parent = groups[index]!;
      if (parent.scene && parent.action.kind === "production-scene-command") {
        working = replaceScene(working, parent.action.productionId, parent.scene.after);
        snapshots.set(`${parent.action.productionId}:${parent.scene.after.id}`, { productionId: parent.action.productionId, scene: parent.scene.after });
      }
      if (parent.action.kind === "audio-spine-command") working = afterSpineCommand(working, parent.action);
    }
    if (snapshots.size) group.dependencyPreview = { scenes: [...snapshots.values()], beforeBundle: working };
    const { ref: _ref, after: _after, ...withoutRefs } = group.action;
    // Existing guarded callers deliberately validate passage/scope rules before the payload's
    // structural parse. Removing transport metadata must preserve that validation order.
    const allowedRefs = new Set([...ancestors].flatMap(index => groups[index]!.members.flatMap(member => member.ref ? [member.ref] : [])));
    group.action = resolveShotRefs(withoutRefs, allowedRefs, created, {
      productionId: "productionId" in withoutRefs ? withoutRefs.productionId ?? undefined : undefined,
      sceneId: "sceneId" in withoutRefs ? withoutRefs.sceneId : undefined,
    }) as ModelWorldChatAction;
    if (group.action.kind !== "production-scene-command") continue;
    const action = group.action;
    const production = working.productions.find(p => p.meta.id === action.productionId);
    const before = production?.scenes.find(scene => scene.id === action.sceneId);
    if (!before) throw new Error("That scene is unavailable for the dependency dry run.");
    const beforeBundle = working;
    const reserved = minted.get(action.productionId) ?? [];
    let record = before;
    const commands: NonNullable<SceneAction["commands"]> = [];
    for (const member of group.members as SceneAction[]) {
      const inserted: string[] = [];
      for (const raw of sceneActionCommands(member)) {
        const command = resolveShotRefs(raw, allowedRefs, created, action);
        const previous = new Set(orderedShots(record).map(shot => shot.id));
        record = sceneCommandCandidate(working, action.productionId, record, sceneCommandFrom(command), reserved);
        inserted.push(...orderedShots(record).filter(shot => !previous.has(shot.id)).map(shot => shot.id));
        working = replaceScene(working, action.productionId, record);
        commands.push(command);
      }
      if (member.ref) { created.set(member.ref, { productionId: action.productionId, sceneId: action.sceneId, shotIds: inserted }); allowedRefs.add(member.ref); }
    }
    const after = sceneCommandBatchCandidate(beforeBundle, action.productionId, before, commands.map(sceneCommandFrom), reserved);
    const kept = new Set(orderedShots(before).map(shot => shot.id));
    minted.set(action.productionId, [...reserved, ...orderedShots(after).map(shot => shot.id).filter(id => !kept.has(id))]);
    const blockers = shotDeletionBlockers(beforeBundle, action.productionId, before, commands);
    if (blockers.length > 0) throw new SceneCommandRefused(blockers);
    group.scene = { before, after, beforeBundle };
    group.action = ModelWorldChatActionSchema.parse({ kind: action.kind, productionId: action.productionId, sceneId: action.sceneId,
      commands, checkReceiptIds: [...new Set(group.members.flatMap(member => member.checkReceiptIds))] });
  }
  return groups;
}

/**
 * What stands in the way of the shots a card deletes, as its authority will find it (issue 3136).
 *
 * A card deleted a scene's four shots, all pinned to the song. It was prepared and approved, and
 * only then refused: a pin, an accepted take and a storyboard panel were checked nowhere before
 * the write. They are read here off the bundle the card is prepared against, so a card that is
 * bound to be refused is never offered, and Arke is told why while it can still do something.
 *
 * The scene is the one the card starts from, before its own commands, so each shot keeps the
 * number the person sees: the dry run renumbers after every deletion, and four pinned shots
 * deleted in turn would each be reported as shot 1. A shot the same card inserts is not in that
 * scene, and is left to the authority. So are running dispatches: they are read from a journal
 * at the moment of the write, and one running now may be done by the time the card is approved.
 */
export function shotDeletionBlockers(
  bundle: WorldBundle,
  productionId: string,
  scene: SceneRecord,
  commands: readonly { kind: string; shotId?: string }[],
): string[] {
  const production = bundle.productions.find(candidate => candidate.meta.id === productionId);
  if (!production) return [];
  const present = new Set(orderedShots(scene).map(shot => shot.id));
  const deleted = commands.flatMap(command => command.kind === "delete-shot" && command.shotId !== undefined && present.has(command.shotId) ? [command.shotId] : []);
  return [...new Set(deleted.flatMap(shotId => shotDeleteBlockers(production, scene, shotId)))];
}

/**
 * The world with the song as a spine card before this one leaves it (issue 3136).
 *
 * "Unpin these shots, then delete them" is two cards in one turn, and the deletion is checked
 * against the pins. Checked against the live song, it would be refused for the very pins the
 * card before it clears. A spine card says which song it applies to by its base revision, as
 * `spineAfterDependencies` reads it for a card already prepared: one whose revision is not the
 * song's so far changes nothing here, and one the reducer refuses is refused on its own card.
 */
function afterSpineCommand(bundle: WorldBundle, action: Extract<ModelWorldChatAction, { kind: "audio-spine-command" }>): WorldBundle {
  const production = bundle.productions.find(candidate => candidate.meta.id === action.productionId);
  if (!production || action.baseRevision !== (production.spine?.revision ?? null)) return bundle;
  let spine: typeof production.spine;
  try {
    // Only the anchors are read from it, so the time it is stamped with is never seen.
    spine = applyAudioSpineCommand(production.spine, action.command, production.spine?.updatedAt ?? new Date(0).toISOString());
  } catch {
    return bundle;
  }
  return { ...bundle, productions: bundle.productions.map(candidate => candidate === production ? { ...candidate, spine } : candidate) };
}

function replaceScene(bundle: WorldBundle, productionId: string, scene: SceneRecord): WorldBundle {
  return { ...bundle, productions: bundle.productions.map(p => p.meta.id !== productionId ? p :
    { ...p, scenes: p.scenes.map(existing => existing.id === scene.id ? scene : existing) }) };
}

interface CreatedShots { productionId: string; sceneId: string; shotIds: string[] }
function resolveShotRefs<T>(command: T, allowed: ReadonlySet<string>, created: ReadonlyMap<string, CreatedShots>, scope: { productionId?: string; sceneId?: string }): T {
  const resolve = (id: string) => {
    if (!id.startsWith("ref:")) return id;
    const ref = id.slice(4), target = created.get(ref);
    if (!allowed.has(ref) || target?.shotIds.length !== 1) throw new Error(`Shot ref ${ref} must name one shot created by a preceding command or a declared dependency.`);
    if (target.productionId !== scope.productionId || target.sceneId !== scope.sceneId) throw new Error(`Shot ref ${ref} belongs to another production or scene.`);
    return target.shotIds[0]!;
  };
  const visit = (value: unknown, key?: string): unknown => {
    if (typeof value === "string" && ["shotId", "fromShotId", "toShotId", "before", "after"].includes(key ?? "")) return resolve(value);
    if (Array.isArray(value)) return key === "members" || key === "memberShotIds" ? value.map(id => resolve(String(id))) : value.map(item => visit(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    return value;
  };
  return visit(command) as T;
}

export function dependencyPreviewWorld(bundle: WorldBundle, preview?: Pick<WorldChatDependencyPreview, "scenes">): WorldBundle {
  for (const { productionId, scene } of preview?.scenes ?? []) bundle = replaceScene(bundle, productionId, scene);
  return bundle;
}
