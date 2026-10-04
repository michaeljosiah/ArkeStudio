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
