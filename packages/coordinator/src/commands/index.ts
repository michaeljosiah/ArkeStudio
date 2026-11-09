import type { ClientMessage } from "@arke-studio/contracts";
import type { accountCommands } from "./account.js";
import type { guideCommands } from "./guide.js";
import type { reviewCommands } from "./reviews.js";
import type { setupCommands } from "./setup.js";
import type { voiceBackgroundCommands } from "./voice-background.js";

/**
 * Every message a domain module owns (issue 2796). The coordinator's switch ends by requiring that
 * whatever it did not handle is one of these, so a kind handled in neither place fails to compile,
 * as it did when the switch held every kind. A domain that moves out adds its module here.
 */
export type RoutedMessage = Extract<ClientMessage, {
  kind: keyof ReturnType<typeof accountCommands> | keyof ReturnType<typeof guideCommands>
    | keyof ReturnType<typeof reviewCommands> | keyof ReturnType<typeof setupCommands> | keyof ReturnType<typeof voiceBackgroundCommands>;
}>;
