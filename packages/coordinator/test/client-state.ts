import type { ClientState } from "@arke-studio/contracts";
import { ReadModel } from "../src/read-model.js";

/**
 * The snapshot a fresh coordinator would send, taken from the read model itself rather than spelled
 * out. Three suites used to declare a complete `ClientState` literal by hand, and every field added to
 * the snapshot was a one-line edit in each of them — thirty times over. Built from the source, a new
 * field is added once, where it is defined, and the type keeps the literal exhaustive.
 *
 * `app` overrides merge into the app slice; the rest replaces top-level fields. The health is the
 * running coordinator's (healthy, harness and voice unavailable), which is what the fresh model reports
 * once started — a test that wants the pre-start "starting" state passes it.
 */
export function emptyClientState(app: Partial<ClientState["app"]> = {}, rest: Partial<Omit<ClientState, "app">> = {}): ClientState {
  const base = new ReadModel(app.version ?? "0.0.0-test").getState();
  const unavailable = { status: "unavailable" as const, reason: "not configured" };
  return {
    ...base,
    ...rest,
    app: {
      ...base.app,
      health: { coordinator: { status: "healthy" }, harness: unavailable, voice: unavailable },
      ...app,
    },
  };
}
