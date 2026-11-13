import { readFileSync } from "node:fs";

/**
 * The value a stylesheet gives one property of one element, for tests about the cascade itself:
 * which of two rules wins where they meet. The tests render in linkedom, which has no style
 * engine, so a rule beaten by a more specific one elsewhere (a sheet's 44px floor on every
 * button, say) is invisible to them. This reads the client's own files, keeps the rules whose
 * media match a given screen, matches selectors with the document's own `matches`, and ranks
 * by importance, specificity and order, as a browser does. It does no layout and no container
 * queries, and it expands only the shorthands the callers ask about.
 */

export interface Screen { width: number; height: number; pointer: "fine" | "coarse" }

interface Rule { selector: string; property: string; value: string; important: boolean; order: number }

const SHORTHANDS: Record<string, (value: string) => Record<string, string>> = {
  // `border: <width> <style> <colour>`, in any order; what is not a width or a style is the colour.
  border: value => {
    const parts = words(value);
    const width = parts.find(part => /^(\d|\.\d|thin|medium|thick)/.test(part)) ?? "medium";
    const style = parts.find(part => /^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(part)) ?? "none";
    const color = parts.filter(part => part !== width && part !== style).join(" ") || "currentcolor";
    return { "border-width": width, "border-style": style, "border-color": color };
  },
  padding: value => {
    const [top, right = top, bottom = top, left = right] = words(value);
    return { "padding-top": top ?? "0", "padding-right": right ?? "0", "padding-bottom": bottom ?? "0", "padding-left": left ?? "0" };
  },
  flex: value => {
    const parts = words(value);
    if (parts.length === 1 && parts[0] === "none") return { "flex-grow": "0", "flex-shrink": "0", "flex-basis": "auto" };
    return { "flex-grow": parts[0] ?? "0", "flex-shrink": parts[1] ?? "1", "flex-basis": parts[2] ?? "0%" };
  },
};

/** Splits a value on spaces outside parentheses: `1px solid color-mix(in srgb, a 22%, b)` is three words. */
function words(value: string): string[] {
  const out: string[] = [];
  let depth = 0, word = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === " " && depth === 0) { if (word) out.push(word); word = ""; } else word += ch;
  }
  if (word) out.push(word);
  return out;
}

/** Splits on commas outside parentheses and brackets. */
function list(text: string): string[] {
  const out: string[] = [];
  let depth = 0, item = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(item.trim()); item = ""; } else item += ch;
  }
  if (item.trim()) out.push(item.trim());
  return out;
}

function mediaMatches(query: string, screen: Screen): boolean {
  return list(query).some(one => one.split(/\s+and\s+/).every(feature => {
    const part = feature.trim();
    if (part === "screen" || part === "all") return true;
    const found = /^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/.exec(part);
    if (!found) throw new Error(`css-cascade cannot read the media feature "${part}"`);
    const name = found[1]!, value = found[2]!, px = Number.parseFloat(value);
    switch (name) {
      case "min-width": return screen.width >= px;
      case "max-width": return screen.width <= px;
      case "min-height": return screen.height >= px;
      case "max-height": return screen.height <= px;
      case "orientation": return value === (screen.width > screen.height ? "landscape" : "portrait");
      case "pointer": case "any-pointer": return value === screen.pointer;
      case "hover": case "any-hover": return value === (screen.pointer === "fine" ? "hover" : "none");
      // A light, unhurried screen: the tests ask about layout, not themes.
      default: return false;
    }
  }));
}

/** The rules of `css` that apply on `screen`, in order, numbered from `start`. */
function rulesOf(css: string, screen: Screen, start: number): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let order = start;
  // Braces and semicolons are read as structure wherever they fall: none of these sheets puts one in a string or a url.
  const walk = (body: string) => {
    let at = 0;
    while (at < body.length) {
      const open = body.indexOf("{", at);
      if (open < 0) return;
      const prelude = body.slice(at, open).trim();
      let depth = 1, close = open + 1;
      for (; close < body.length && depth > 0; close++) {
        if (body[close] === "{") depth++;
        else if (body[close] === "}") depth--;
      }
      const inner = body.slice(open + 1, close - 1);
      at = close;
      if (prelude.startsWith("@media")) { if (mediaMatches(prelude.slice(6).trim(), screen)) walk(inner); continue; }
      // Container queries, keyframes, faces and support checks are not this helper's.
      if (prelude.startsWith("@")) continue;
      for (const declaration of inner.split(";")) {
        const colon = declaration.indexOf(":");
        if (colon < 0) continue;
        const property = declaration.slice(0, colon).trim().toLowerCase();
        let value = declaration.slice(colon + 1).trim();
        const important = value.endsWith("!important");
        if (important) value = value.replace(/\s*!important$/, "");
        const longhands = SHORTHANDS[property]?.(value) ?? { [property]: value };
        for (const selector of list(prelude)) {
          order++;
          for (const [name, longhand] of Object.entries(longhands)) rules.push({ selector, property: name, value: longhand, important, order });
        }
      }
    }
  };
  walk(text);
  return rules;
}

/** Specificity as one number: ids, then classes, attributes and pseudo-classes, then types. */
export function specificity(selector: string): number {
  let ids = 0, classes = 0, types = 0;
  let rest = selector.replace(/::[a-z-]+(\([^)]*\))?/g, () => { types++; return " "; });
  // :is(), :not() and :has() count as their most specific argument; :where() counts nothing.
  rest = rest.replace(/:(is|not|has|where)\(((?:[^()]|\([^()]*\))*)\)/g, (_, name: string, inner: string) => {
    if (name !== "where") {
      const best = Math.max(...list(inner).map(specificity));
      ids += Math.floor(best / 1_000_000); classes += Math.floor(best / 1000) % 1000; types += best % 1000;
    }
    return " ";
  });
  rest = rest.replace(/\[[^\]]*\]/g, () => { classes++; return " "; });
  rest = rest.replace(/#[\w-]+/g, () => { ids++; return " "; });
  rest = rest.replace(/\.[\w-]+/g, () => { classes++; return " "; });
  rest = rest.replace(/:[\w-]+(\([^)]*\))?/g, () => { classes++; return " "; });
  types += (rest.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 1_000_000 + classes * 1000 + types;
}

/** The client's stylesheets in the order main.tsx imports them, read once. */
export function stylesheets(...names: string[]): string[] {
  return names.map(name => readFileSync(new URL(`../src/screens/${name}`, import.meta.url), "utf8"));
}

/**
 * What `property` comes to on `element` on `screen` — or on its `::before` or `::after` — as the
 * winning declaration's value as written, or undefined when nothing sets it. A state the document
 * cannot match, like :hover, is taken as not matching, as at rest.
 */
export function computed(element: Element, property: string, screen: Screen, sheets: readonly string[], pseudo?: "before" | "after"): string | undefined {
  const rank = (rule: Rule) => [Number(rule.important), specificity(rule.selector), rule.order];
  const beats = (rule: Rule, other: Rule) => {
    const [a, b] = [rank(rule), rank(other)];
    const differ = a.findIndex((value, index) => value !== b[index]);
    return differ >= 0 && a[differ]! > b[differ]!;
  };
  let best: Rule | undefined;
  for (const [index, css] of sheets.entries()) {
    // Later sheets come later in the bundle: their rules win ties.
    for (const rule of rulesOf(css, screen, index * 10_000_000)) {
      if (rule.property !== property) continue;
      const suffix = pseudo === undefined ? null : `::${pseudo}`;
      if (suffix === null ? rule.selector.includes("::") : !rule.selector.endsWith(suffix)) continue;
      const own = suffix === null ? rule.selector : rule.selector.slice(0, -suffix.length);
      if (own.includes("::")) continue;
      let matches = false;
      try { matches = element.matches(own); } catch { matches = false; }
      if (matches && (best === undefined || beats(rule, best))) best = rule;
    }
  }
  return best?.value;
}
