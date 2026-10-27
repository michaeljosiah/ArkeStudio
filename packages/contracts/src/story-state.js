// SPEC-063: pure, dependency-free story rules. The exporter embeds this exact module.
export function storyDefaults(program) {
  return Object.fromEntries((program.facts || []).map((fact) => [fact.id, fact.default]));
}

export function storyPredicate(predicate, state) {
  if (predicate === undefined) return true;
  switch (predicate.op) {
    case "eq":
      if (!Object.hasOwn(state, predicate.fact)) throw new Error(`Unknown story fact: ${predicate.fact}`);
      return state[predicate.fact] === predicate.value;
    case "not": return !storyPredicate(predicate.arg, state);
    case "all": return predicate.args.every((arg) => storyPredicate(arg, state));
    case "any": return predicate.args.some((arg) => storyPredicate(arg, state));
    default: throw new Error(`Unknown story condition: ${predicate.op}`);
  }
}

export function validateStoryProgram(program) {
  const facts = new Map();
  const literal = (id, value) => {
    const fact = facts.get(id);
    if (!fact) throw new Error(`Unknown story fact: ${id}`);
    if (fact.type === "boolean" ? typeof value !== "boolean" : !fact.values.includes(value))
      throw new Error(`Invalid value for ${id}: ${String(value)}`);
  };
  for (const fact of program.facts || []) {
    if (facts.has(fact.id)) throw new Error(`Duplicate story fact: ${fact.id}`);
    if (fact.type === "enum" && new Set(fact.values).size !== fact.values.length) throw new Error(`Duplicate values for ${fact.id}`);
    facts.set(fact.id, fact);
    literal(fact.id, fact.default);
  }
  const guard = (predicate) => {
    let count = 0;
    const visit = (p, depth) => {
      if (p === undefined) return;
      if (++count > 128 || depth > 8) throw new Error("Story condition exceeds its size limit");
      if (p.op === "eq") literal(p.fact, p.value);
      else if (p.op === "not") visit(p.arg, depth + 1);
      else if (["all", "any"].includes(p.op) && p.args.length) p.args.forEach((arg) => visit(arg, depth + 1));
      else throw new Error("Invalid story condition");
    };
    visit(predicate, 1);
  };
  for (const choice of program.choices) {
    guard(choice.when);
    const assigned = new Set();
    for (const effect of choice.effects || []) {
      literal(effect.fact, effect.value);
      if (assigned.has(effect.fact)) throw new Error(`Choice ${choice.id} assigns ${effect.fact} twice`);
      assigned.add(effect.fact);
    }
  }
  const scenes = new Set();
  for (const entry of program.presentation || []) {
    if (scenes.has(entry.sceneId)) throw new Error(`Duplicate presentation scene: ${entry.sceneId}`);
    scenes.add(entry.sceneId);
    for (const [kind, key] of [["blocks", "blockId"], ["shots", "shotId"]]) {
      const ids = new Set();
      for (const rule of entry[kind] || []) {
        if (ids.has(rule[key])) throw new Error(`Duplicate ${kind} guard: ${rule[key]}`);
        ids.add(rule[key]);
        guard(rule.when);
      }
    }
  }
  for (const ending of program.endings || []) {
    const ids = new Set();
    let fallbacks = 0;
    for (const variant of ending.variants || []) {
      if (ids.has(variant.id)) throw new Error(`Duplicate ending variant: ${variant.id}`);
      ids.add(variant.id);
      if (variant.fallback) fallbacks++;
      else guard(variant.when);
    }
    if (fallbacks > 1) throw new Error(`Multiple fallback endings at ${ending.sceneId}`);
  }
}

export function storyReplay(program, prefix = []) {
  validateStoryProgram(program);
  if (!Array.isArray(prefix)) throw new Error("Invalid choice prefix");
  const state = storyDefaults(program);
  let point = { sceneId: program.start, state, origins: Object.fromEntries(Object.keys(state).map(id => [id, null])) };
  for (const id of prefix) point = storyAdvance(program, point, id);
  return point;
}

function storyAdvance(program, point, id) {
  const choice = program.choices.find(candidate => candidate.id === id);
  if (!choice || choice.from !== point.sceneId || !storyPredicate(choice.when, point.state)) throw new Error(`Invalid route at ${id}`);
  const state = { ...point.state }, origins = { ...point.origins };
  for (const effect of choice.effects || []) { state[effect.fact] = effect.value; origins[effect.fact] = id; }
  return { sceneId: choice.to, state, origins };
}

// Canonical content, SHA-256: stable in Node and offline browsers without async crypto.
function storyCanonical(value) {
  if (Array.isArray(value)) return "[" + value.map(storyCanonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ":" + storyCanonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
const STORY_SHA256_K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
export function storyIdentity(value) {
  const bytes = new TextEncoder().encode(storyCanonical(value));
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(length);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(length - 4, (bytes.length * 8) >>> 0);
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const w = new Uint32Array(64);
  const rotate = (v, n) => (v >>> n) | (v << (32 - n));
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i-15], y = w[i-2];
      w[i] = (w[i-16] + (rotate(x,7)^rotate(x,18)^(x>>>3)) + w[i-7] + (rotate(y,17)^rotate(y,19)^(y>>>10))) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) {
      const first = (h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + STORY_SHA256_K[i] + w[i]) >>> 0;
      const second = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0;
      h=g;g=f;f=e;e=(d+first)>>>0;d=c;c=b;b=a;a=(first+second)>>>0;
    }
    [a,b,c,d,e,f,g,h].forEach((v,i) => { hash[i] = (hash[i] + v) >>> 0; });
  }
  return "sha256:" + hash.map(v => v.toString(16).padStart(8,"0")).join("");
}

export function storyEnding(program, sceneId, state) {
  const ending = program.endings.find((entry) => entry.sceneId === sceneId);
  if (!ending || !ending.variants) return ending;
  const matches = ending.variants.filter((variant) => !variant.fallback && storyPredicate(variant.when, state));
  if (matches.length > 1) throw new Error(`Overlapping ending variants at ${sceneId}`);
  const selected = matches[0] || ending.variants.find((variant) => variant.fallback);
  if (!selected) throw new Error(`No matching ending at ${sceneId}`);
  return selected;
}

export function storyVisibleBeats(program, sceneId, beats, state) {
  const rules = (program.presentation || []).find((entry) => entry.sceneId === sceneId);
  return beats.filter((beat) => storyPredicate(rules?.shots?.find((rule) => rule.shotId === beat.shotId)?.when, state)
    && storyPredicate(rules?.blocks?.find((rule) => rule.blockId === beat.blockId)?.when, state))
    .map(beat => storyPredicate(rules?.shots?.find(rule => rule.shotId === beat.pictureShotId)?.when, state) ? beat : { ...beat, picture: undefined, keep: undefined });
}

export function exploreStory(program, limits = {}) {
  validateStoryProgram(program);
  const maxStates = limits.states ?? 100000, maxTransitions = limits.transitions ?? 1000000;
  const maxWitnessEntries = Math.min(limits.witnessEntries ?? 1000000, 1000000);
  let witnessEntries = 0;
  const initial = storyReplay(program);
  const queue = [{ ...initial, prefix: [] }], seen = new Map();
  const transitions = [], problems = [];
  seen.set(storyIdentity([initial.sceneId, initial.state]), 0);
  for (let at = 0; at < queue.length; at++) {
    const point = queue[at];
    const outgoing = program.choices.filter((choice) => choice.from === point.sceneId && storyPredicate(choice.when, point.state));
    try {
      const ending = storyEnding(program, point.sceneId, point.state);
      if (!outgoing.length && !ending) problems.push({ ...point, detail: "No available choice or ending" });
      if (outgoing.length && ending) problems.push({ ...point, detail: "Ending still offers choices" });
    } catch (error) { problems.push({ ...point, detail: error.message }); }
    for (const choice of outgoing) {
      if (transitions.length >= maxTransitions) return { complete: false, points: queue, transitions, problems };
      const next = storyAdvance(program, point, choice.id);
      const key = storyIdentity([next.sceneId, next.state]);
      let to = seen.get(key);
      if (to === undefined) {
        if (queue.length >= maxStates) return { complete: false, points: queue, transitions, problems };
        const depth = point.prefix.length + 1;
        if (depth > 2048 || witnessEntries + depth > maxWitnessEntries) return { complete: false, limit: "witness", points: queue, transitions, problems };
        witnessEntries += depth;
        const prefix = [...point.prefix, choice.id];
        to = queue.length;
        seen.set(key, to);
        queue.push({ ...next, prefix });
      }
      transitions.push({ from: at, to, choiceId: choice.id });
    }
  }
  const canEnd = new Set(queue.flatMap((point, index) => program.endings.some((ending) => ending.sceneId === point.sceneId) ? [index] : []));
  const reverse = new Map();
  for (const edge of transitions) reverse.set(edge.to, [...(reverse.get(edge.to) || []), edge.from]);
  const pending = [...canEnd];
  for (let at = 0; at < pending.length; at++) for (const parent of reverse.get(pending[at]) || []) if (!canEnd.has(parent)) { canEnd.add(parent); pending.push(parent); }
  queue.forEach((point, index) => { if (!canEnd.has(index)) problems.push({ ...point, detail: "This state cannot reach an ending" }); });
  return { complete: true, points: queue, transitions, problems };
}

/** Stable authoring references, so a fact can be renamed without silently changing its identity. */
export function storyFactReferences(program, id) {
  const uses = [];
  const mentions = p => p !== undefined && (p.op === "eq" ? p.fact === id : p.op === "not" ? mentions(p.arg) : p.args.some(mentions));
  for (const choice of program.choices) {
    if (mentions(choice.when)) uses.push({ kind: "condition", id: choice.id, label: choice.label || choice.id });
    if ((choice.effects || []).some(e => e.fact === id)) uses.push({ kind: "remember", id: choice.id, label: choice.label || choice.id });
  }
  for (const scene of program.presentation || []) for (const rule of [...scene.blocks, ...scene.shots]) if (mentions(rule.when)) uses.push({ kind: "show", id: rule.blockId || rule.shotId, label: scene.sceneId + " · " + (rule.blockId || rule.shotId) });
  for (const ending of program.endings) for (const variant of ending.variants || []) if (mentions(variant.when)) uses.push({ kind: "ending", id: variant.id, label: variant.title });
  return uses;
}
