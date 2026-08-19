import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RunQuery } from "./claude-adapter.js";

/**
 * The Agent SDK behind {@link RunQuery} — the adapter's entire coupling to it, in one place.
 *
 * Separate from the adapter for the same reason `sdk-probe.ts` is separate from
 * `confinement-probe.ts`: the decision logic stays testable without the SDK, a subscription, or
 * a 326MB binary, and the part that cannot be tested that way stays small enough to read.
 *
 * The casts are the seam. `RunQuery` describes what the adapter needs — a prompt it can push
 * onto and a stream of messages back — rather than restating the SDK's option surface, so a new
 * option the SDK grows does not become a type this package has to track.
 */
export const sdkQuery: RunQuery = ({ prompt, options }) =>
  query({ prompt: prompt as never, options: options as never });
