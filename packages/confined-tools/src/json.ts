/** The loose JSON object the tool arguments and world-query answers arrive as. */
export type JsonObject = Record<string, unknown>;
/** A value as an object, or an empty one: callers then refuse on the missing fields they need. */
export function object(value: unknown): JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
