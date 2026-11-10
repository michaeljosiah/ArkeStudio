import type { ClientMessage } from "@arke-studio/contracts";
import type { accountCommands } from "./account.js";
import type { comicCommands } from "./comic.js";
import type { creatorPublishingCommands } from "./creator-publishing.js";
import type { diagnosticsCommands } from "./diagnostics.js";
import type { frameRunCommands } from "./frame-runs.js";
import type { guideCommands } from "./guide.js";
import type { harnessCommands } from "./harnesses.js";
import type { inboxCommands } from "./inbox.js";
import type { localEngineCommands } from "./local-engines.js";
import type { musicCommands } from "./music.js";
import type { planCommands } from "./plans.js";
import type { recoveryCommands } from "./recovery.js";
import type { reviewCommands } from "./reviews.js";
import type { setupCommands } from "./setup.js";
import type { updateCommands } from "./updates.js";
import type { voiceBackgroundCommands } from "./voice-background.js";

/**
 * Every message a domain module owns (issue 2796). The coordinator's switch ends by requiring that
 * whatever it did not handle is one of these, so a kind handled in neither place fails to compile,
 * as it did when the switch held every kind. A domain that moves out adds its module here.
 */
export type RoutedMessage = Extract<ClientMessage, {
  kind: keyof ReturnType<typeof accountCommands> | keyof ReturnType<typeof guideCommands>
    | keyof ReturnType<typeof recoveryCommands> | keyof ReturnType<typeof reviewCommands> | keyof ReturnType<typeof setupCommands> | keyof ReturnType<typeof voiceBackgroundCommands>
    | keyof ReturnType<typeof updateCommands> | keyof ReturnType<typeof diagnosticsCommands> | keyof ReturnType<typeof localEngineCommands>
    | keyof ReturnType<typeof harnessCommands> | keyof ReturnType<typeof musicCommands>
    | keyof ReturnType<typeof comicCommands> | keyof ReturnType<typeof planCommands>
    | keyof ReturnType<typeof frameRunCommands> | keyof ReturnType<typeof inboxCommands>
    | keyof ReturnType<typeof creatorPublishingCommands>;
}>;
