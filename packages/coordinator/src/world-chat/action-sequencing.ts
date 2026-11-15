import { ModelWorldChatActionSchema, nextShotIdIn, orderedShots, sceneCommandCandidate, sceneCommandBatchCandidate,
  turnActionGroups, type ModelWorldChatAction, type NewShotId, type SceneRecord, type WorldBundle, type WorldChatDependencyPreview } from "@arke-studio/contracts";
import { sceneCommandFrom } from "../productions/scene-commands.js";

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
   * The shots each production's earlier scene cards in this turn add (issue 3149). A card for
   * another scene does not see them in its dry run, so it numbered its own new shots from the same
   * highest shot, and whichever card was approved second no longer had the numbers it showed.
   * Later cards number above them; each card keeps its numbers whichever lands first.
   */
  const reserved = new Map<string, string[]>();
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
    const held = reserved.get(action.productionId) ?? [];
    const newShotId: NewShotId = taken => nextShotIdIn([...taken, ...held]);
    let record = before;
    const commands: NonNullable<SceneAction["commands"]> = [];
    for (const member of group.members as SceneAction[]) {
      const inserted: string[] = [];
      for (const raw of sceneActionCommands(member)) {
        const command = resolveShotRefs(raw, allowedRefs, created, action);
        const previous = new Set(orderedShots(record).map(shot => shot.id));
        record = sceneCommandCandidate(working, action.productionId, record, sceneCommandFrom(command), newShotId);
        inserted.push(...orderedShots(record).filter(shot => !previous.has(shot.id)).map(shot => shot.id));
        working = replaceScene(working, action.productionId, record);
        commands.push(command);
      }
      if (member.ref) { created.set(member.ref, { productionId: action.productionId, sceneId: action.sceneId, shotIds: inserted }); allowedRefs.add(member.ref); }
    }
    const after = sceneCommandBatchCandidate(beforeBundle, action.productionId, before, commands.map(sceneCommandFrom), newShotId);
    group.scene = { before, after, beforeBundle };
    const existing = new Set(orderedShots(before).map(shot => shot.id));
    reserved.set(action.productionId, [...held, ...orderedShots(after).map(shot => shot.id).filter(id => !existing.has(id))]);
    group.action = ModelWorldChatActionSchema.parse({ kind: action.kind, productionId: action.productionId, sceneId: action.sceneId,
      commands, checkReceiptIds: [...new Set(group.members.flatMap(member => member.checkReceiptIds))] });
  }
  return groups;
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
