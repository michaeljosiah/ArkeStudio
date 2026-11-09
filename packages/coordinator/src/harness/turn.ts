import type { HarnessAdapter, HarnessEvent, SendMessageInput } from "@arke-studio/contracts";

/**
 * How one ask of a prepared session ended (issue 2801).
 *
 * Eleven places each wrote their own loop for this, and each had its own idea of when a turn was
 * over: some ended on a harness error and some waited past it, some told the session to stop at
 * the deadline and some left it generating behind them, one ignored `session.ended` and another
 * took it as an answer. One function and a typed ending leave each caller only its own decision,
 * which is what an ending means for it.
 */
export type HarnessTurnOutcome =
  | { readonly kind: "completed"; readonly text: string }
  | { readonly kind: "failed"; readonly detail: string }
  /** The stream ended with no answer and no stated reason: the model may have run, unseen. */
  | { readonly kind: "unanswered" }
  | { readonly kind: "over-budget"; readonly detail?: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" };

export interface HarnessTurn {
  readonly sessionId: string;
  readonly parts: SendMessageInput["parts"];
  /** The wall clock for the whole ask, dispatch included. */
  readonly timeoutMs: number;
  /** The caller's stop. A stop is an ending of its own, never an empty answer. */
  readonly signal?: AbortSignal;
  /** Each of this session's events as it arrives, for progress lines and refusals. */
  readonly onEvent?: (event: HarnessEvent) => void;
  /** Work between subscribing and dispatching; a throw ends the turn failed, nothing sent. */
  readonly beforeDispatch?: () => Promise<void>;
  /** Tokens the session may spend before it is stopped as over budget. */
  readonly tokenBudget?: number;
  /**
   * Answer only once a requested interruption has settled. A conversation's queued reply must
   * not overtake the native stop of the one before it, so the chat waits; a one-off ask does not.
   */
  readonly awaitInterruption?: boolean;
}

/**
 * Ask once and say how it ended.
 *
 * Subscribed before dispatch, because registration is eager and a turn that completes between the
 * dispatch and the first pull would otherwise be lost. Any ending but an answer tells the session
 * to stop: a stream nobody reads still costs whatever the model goes on writing.
 */
export async function runHarnessTurn(adapter: HarnessAdapter, turn: HarnessTurn): Promise<HarnessTurnOutcome> {
  if (turn.signal?.aborted) return { kind: "cancelled" };
  const listen = new AbortController();
  let settle!: (outcome: HarnessTurnOutcome) => void;
  const settled = new Promise<HarnessTurnOutcome>((resolve) => { settle = resolve; });
  const stop = () => settle({ kind: "cancelled" });
  turn.signal?.addEventListener("abort", stop, { once: true });
  // Refed deliberately: an unref'd deadline never fires in a process with nothing else pending,
  // which is exactly the case a timeout is for.
  const deadline = setTimeout(() => settle({ kind: "timeout" }), turn.timeoutMs);
  const usage = adapter.usageTokens?.bind(adapter);
  let last = "";
  void (async () => {
    for await (const event of adapter.streamEvents(listen.signal)) {
      if (!("sessionId" in event) || event.sessionId !== turn.sessionId) continue;
      turn.onEvent?.(event);
      if (event.type === "message.delta") last = event.text;
      else if (event.type === "message.completed") return settle({ kind: "completed", text: event.text ?? "" });
      else if (event.type === "session.error") return settle({ kind: "failed", detail: event.message });
      else if (event.type === "session.ended") return settle(ended(event, last));
      if (turn.tokenBudget !== undefined && usage && usage(turn.sessionId) > turn.tokenBudget) {
        return settle({ kind: "over-budget", detail: `passed the ${turn.tokenBudget.toLocaleString("en-GB")}-token budget` });
      }
    }
    settle({ kind: "unanswered" });
  })().catch((error: unknown) => settle({ kind: "failed", detail: message(error) }));
  void (async () => {
    await turn.beforeDispatch?.();
    if (turn.signal?.aborted) return;
    await adapter.dispatchAsync({ sessionId: turn.sessionId, parts: turn.parts });
  })().catch((error: unknown) => settle({ kind: "failed", detail: message(error) }));
  let interruption: Promise<void> | undefined;
  try {
    const outcome = await settled;
    if (outcome.kind !== "completed") {
      interruption = (adapter.interrupt?.(turn.sessionId) ?? Promise.resolve()).catch(() => {});
    }
    return outcome;
  } finally {
    clearTimeout(deadline);
    listen.abort();
    turn.signal?.removeEventListener("abort", stop);
    if (turn.awaitInterruption && interruption) await interruption;
  }
}

function ended(event: Extract<HarnessEvent, { type: "session.ended" }>, last: string): HarnessTurnOutcome {
  switch (event.reason) {
    // A turn the harness closed as done without a final message: what it wrote is the answer.
    case "completed": return { kind: "completed", text: last };
    case "cancelled": return { kind: "cancelled" };
    case "timeout": return { kind: "timeout" };
    case "budget-exceeded": return { kind: "over-budget", ...(event.detail !== undefined ? { detail: event.detail } : {}) };
    case "error": return { kind: "failed", detail: event.detail ?? "the session ended with an error" };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
