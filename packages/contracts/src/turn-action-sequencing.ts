/** Turn-local references never consult an earlier turn's labels (SPEC-051 R-14). */
export function turnActionDependencyIndexes(actions: readonly { ref?: string; after?: readonly string[] }[]): number[][] {
  const refs = new Map<string, number>();
  for (const [index, action] of actions.entries()) {
    if (!action.ref) continue;
    if (refs.has(action.ref)) throw new Error(`Action ref ${action.ref} is repeated in this turn.`);
    refs.set(action.ref, index);
  }
  const edges = actions.map(action => {
    const after = action.after ?? [];
    if (new Set(after).size !== after.length) throw new Error("An action repeats the same after reference.");
    return after.map(ref => {
      const index = refs.get(ref);
      if (index === undefined) throw new Error(`Action ref ${ref} is not in this turn; earlier-turn refs cannot be used.`);
      return index;
    });
  });
  const visiting = new Set<number>(), visited = new Set<number>();
  const visit = (index: number) => {
    if (visiting.has(index)) throw new Error("Turn action dependencies contain a cycle.");
    if (visited.has(index)) return;
    visiting.add(index);
    for (const parent of edges[index]!) visit(parent);
    visiting.delete(index); visited.add(index);
  };
  for (const [index, parents] of edges.entries()) {
    visit(index);
    if (parents.some(parent => parent >= index)) throw new Error("An after reference must name an earlier action in this turn.");
  }
  return edges;
}

/** The same grouping and aggregate cap apply at model validation and authoritative preparation. */
export function turnActionGroups(actions: readonly { kind: string; ref?: string; after?: readonly string[];
  productionId?: string | null; sceneId?: string; command?: unknown; commands?: readonly unknown[] }[]): Array<{ members: number[]; dependencies: number[] }> {
  const edges = turnActionDependencyIndexes(actions), groups: Array<{ members: number[]; dependencies: number[] }> = [];
  const groupOf = new Map<number, number>(), scenes = new Map<string, number>();
  for (const [index, action] of actions.entries()) {
    const dependencies = [...new Set(edges[index]!.map(parent => groupOf.get(parent)!))].sort((a, b) => a - b);
    const key = action.kind === "production-scene-command" ? JSON.stringify([action.productionId, action.sceneId, dependencies]) : null;
    const existing = key ? scenes.get(key) : undefined;
    if (existing !== undefined) { groups[existing]!.members.push(index); groupOf.set(index, existing); }
    else {
      const group = groups.length;
      groups.push({ members: [index], dependencies }); groupOf.set(index, group);
      if (key) scenes.set(key, group);
    }
  }
  for (const group of groups) {
    if (actions[group.members[0]!]!.kind !== "production-scene-command") continue;
    const count = group.members.reduce((total, index) => total + (actions[index]!.commands?.length ?? 1), 0);
    if (count > 24) throw new Error("Independent commands on one scene share a batch; that batch may contain at most 24 commands. Use a separate turn or an explicit dependency boundary.");
  }
  return groups;
}
