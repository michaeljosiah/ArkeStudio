import { createHash } from "node:crypto";
import { canonicalJson } from "@arke-studio/contracts";

/** What a value JSON cannot hold is written as null: these digest whatever a payload carries. The
 * client's history card computes the same receipt with the same rule, from contracts. */
export const stableJson = (value: unknown) => canonicalJson(value, { unsupported: "null" });

export function conversationActionDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}
