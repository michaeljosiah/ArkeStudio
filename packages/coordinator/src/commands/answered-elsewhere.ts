import type { CommandModule } from "./router.js";

/**
 * Messages answered before any command is: hello by the transport, and the owner's reply channels
 * by their hosts in `onMessage`, never through world or model commands. They are listed so that
 * every kind is routed somewhere, as the switch's exhaustive end requires; reaching here does nothing.
 */
export function answeredElsewhereCommands() {
  return {
    hello: { scope: "none", handle() {} },
    "voice-conversation": { scope: "none", handle() {} },
    "studio-assistant": { scope: "none", handle() {} },
    "text-draft": { scope: "none", handle() {} },
    "text-typefaces": { scope: "none", handle() {} },
  } satisfies CommandModule;
}
