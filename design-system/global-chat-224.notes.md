# Global Chat · turn 224 revision 6

Approved by the author on 13 October 2026, with the model-choice bullet removed. The provider
mark, model name, separate effort, picker actions and context-specific model rules remain.
Turn 195 was recovered from d5c1a0ac / restoration PR #1576. Its seven frames and eleven rules
are preserved except for that explicit amendment; model-choice-amendment.mjs records the exact
transformation. The original stylesheet is retained. Other turns are unchanged.

## Implementation

App mounts GlobalChatProvider. The titlebar opens the current registered workspace or the
route fallback. A selected conversation remains independent of navigation. ProductionStudio
moves its single chat portal into the panel while native canvas/review instances keep their
existing owner. Detached resting canvases do not open as floating Studios. World Chat and
production setup reuse their existing view/protocol; local Arke/Scene/Bench entries use the
same owner. Phone/deep-production titlebars retain the global entry point.

Drafts, per-chat model/effort choices and omitted attachments belong to the durable thread
when its id is known. Window session storage restores the selected thread and unsent draft.
World switching unmounts the old live view and displays an explicit boundary. Close releases
capture and retains its editable transcription in the originating draft; context switching
waits for transcription. Typing/dictation never accepts cards or automatically sends.

Phone workspace content is inert beneath the sheet; its focus is contained while titlebar
controls remain reachable. Activity/Settings and nested sheets temporarily cover the retained
chat. Keyboard inset uses the visual viewport. Desktop width is keyboard/pointer resizable
within 360–560px and the available workspace room. Existing native decision gates are unchanged.

## Verification

From the repository root after locked dependencies are installed:

    node design-system/global-chat-224.specimens-build.mjs
    node design-system/global-chat-224.mjs
    node design-system/check-master.mjs --record
    node design-system/build-review.mjs
    node design-system/global-chat-224.native-build.mjs
    node design-system/global-chat-224.master-build.mjs
    node design-system/global-chat-224.parity-check.mjs
    node design-system/global-chat-224.parity-check.mjs --touch
    node design-system/global-chat-224.application-check.mjs
    node design-system/global-chat-224.application-check.mjs --touch
    node design-system/global-chat-224.native-check.mjs
    node design-system/global-chat-224.check.mjs

The three master/layout gates recover the original plus approved amendment, compare ten
rendered native/master controls and test 65 whole-page cases with fine/coarse pointers. They
measure 8px margins, icon centring, overlap, clipping and actual hit targets. Restored 195b’s
static flex rows compress to about 27.3px; its binding 34px desktop / 48px phone scrolling rows
govern the native control. The original desktop CSS is a negative control that must fail.

The application fixture exercises the actual App, not manual reparenting. Its bridge records
commands; it uses deterministic fake microphone/transcription data only for the lifecycle
checks. Ordinary review media actions remain disabled. Application checks cover native typing,
one transcript through navigation and an active run, explicit switching, microphone release,
no auto-send, original-draft delivery, world boundaries, overlay coexistence, scoped send,
refresh recovery and a simulated on-screen keyboard. Installed microphone/codec/Voxa behavior
and physical-device keyboard behavior still require host acceptance; no paid provider is used.

Client tests include global-chat.test.ts and the existing composer/model/conversation suites.
Reports, generated bundles and screenshots live under .dev/global-chat-design and are not
committed. Agent delegation and additional video/audio inspection tools are separate increments.
