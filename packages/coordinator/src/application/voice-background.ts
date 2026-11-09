import type { HarnessAdapter } from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import type { WorldProvider } from "../world-provider.js";
import type { WorldQueryServer } from "../harness/world-query.js";
import { VoiceBackgroundOwner } from "../voice/background.js";
import { executeVoiceBackground } from "../voice/background-worker.js";

/** Uses the provider's retained store and existing native adapter; no ambient world lookup. */
export function createVoiceBackgroundOwner(deps: {
  provider: WorldProvider; adapter: HarnessAdapter | null; query: WorldQueryServer; sessionInput: SessionInput; scratchRoot: string;
  changed: NonNullable<ConstructorParameters<typeof VoiceBackgroundOwner>[0]["changed"]>;
}): VoiceBackgroundOwner | null {
  const withStore = deps.provider.withBackgroundWorldStore?.bind(deps.provider);
  const adapter = deps.adapter;
  if (!withStore || !adapter) return null;
  return new VoiceBackgroundOwner({ withStore, changed: deps.changed,
    execute: (store, operation, context, signal) => executeVoiceBackground({ ...deps, adapter }, store, operation, context, signal) });
}
