# Global contextual Chat

The author approved design turn 224 on 13 October 2026, with its model-choice bullet removed.
Revision 6 amends the recovered turn 195 reference and implements the global entry point in
ArkeStudio PR #1737. The OpenCode image-handoff increment remains the separate PR #1736.

The right-hand titlebar Chat control opens World Chat in a world and Builder Chat in a production,
using the existing scene/shot/Stage/takes/Generate/Cut, Bench and production-setup context where
applicable. The panel names its world and subject. Navigation preserves the selected conversation,
draft and active work; Use this page explicitly switches context. Changing worlds pauses the prior
live view. No send, result, disclosure, tool lease or decision is retargeted by navigation.

App’s GlobalChatProvider and lib/global-chat.ts own presentation and per-thread draft/model state.
Native conversation controllers and ProductionStudio portals retain one active conversation and
card instances across navigation. Local docks share the controller; they do not open competing
phone sheets. Desktop is resizable; phones retain the titlebar, contain focus, isolate workspace
content and lift the composer above the visual keyboard viewport. Activity/Settings can cover the
retained view. Window session storage recovers the selected thread and unsent draft on refresh.

The shared Composer retains picker/drop/paste uploads, attachment readability/refusal chips,
Stop referring to and explicit File in world, dictation, context-specific model controls and Read
replies. Dictation releases capture on close/suspension and delivers editable words to the original
draft, including after world navigation. Switching waits for transcription. It never auto-sends.
Backend decision/spend authorities and the original conversation protocols remain unchanged.

[Master/design notes](../../design-system/global-chat-224.notes.md) document provenance, approval
and verification commands. The native review now imports the implemented App with a recording
bridge. Lifecycle tests use fake media; installed microphone/codec/Voxa and physical keyboard
acceptance remain separate. Additional video/audio review tools and master-agent delegation remain
separate toolkit increments.
