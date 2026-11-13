/**
 * JSON with every object's keys in code-unit order, recursively (#2824): the bytes a digest, a
 * fingerprint or an equality check is taken over, whatever order a record's keys were written or
 * parsed in. Code-unit order is the same on every host; locale collation is not, which is why the
 * few serialisers that sort with `localeCompare` keep their own code: what they wrote is already
 * persisted. Arrays keep their order, because an order there is a decision.
 *
 * Undefined members are dropped, as `JSON.stringify` drops them. A value JSON cannot hold —
 * `undefined` itself, a function, a symbol — is refused, unless `unsupported: "null"` asks for
 * it to be written as null, as `JSON.stringify` writes one inside an array. That is for digests
 * taken over values that may carry one; the client and the coordinator compute the same history
 * receipt with it, so they must never be given different rules.
 */
export function canonicalJson(value: unknown, options: { unsupported?: "throw" | "null" } = {}): string {
  const write = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(write).join(",")}]`;
    if (item !== null && typeof item === "object") {
      return `{${Object.entries(item).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => `${JSON.stringify(key)}:${write(child)}`).join(",")}}`;
    }
    const text = JSON.stringify(item);
    if (text !== undefined) return text;
    if (options.unsupported === "null") return "null";
    throw new TypeError("canonicalJson: the value holds something JSON cannot");
  };
  return write(value);
}
