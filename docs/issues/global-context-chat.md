# Global Chat entry point — interaction proposal

Proposed 2026-10-13. No global Chat UI is implemented in the OpenCode image-handoff increment.

One persistent Chat icon in the application's right-hand titlebar controls can make Arke easier
to reach. It should open the existing conversation for the current context, preserving the
world/production authorities, tool leases and ordinary approval cards. SPEC-051 records this
proposal. [Design turn 220](../../design-system/global-chat-220.review.html) supplies nine
HTML drawings and an interactive fixture. Application implementation must wait for the
author's explicit design approval, followed by responsive browser validation.

## Context and conversation

| Current surface when opening Chat | Conversation context |
| --- | --- |
| World | World Chat for that world |
| Production | That production's conversation |
| Scene or shot | The existing scene/shot context, including the selection |
| Stage, takes, Generate or Cut | The existing workspace context |
| Bench | The selected Bench session |
| No open world | An appropriate existing pre-world surface, or an explicit unavailable state |

The expanded panel should show a context label, for example `The Undersong / Saltlight / Shot 4`.
This describes what the conversation can currently read and propose; it is not a decorative
breadcrumb. One global entry point does not mean one transcript spanning unrelated worlds.

Opening the closed panel can follow the page. Once a chat is open, navigation should leave its
thread, draft and active work intact. Offer **Use this page** or an explicit conversation switch
to resume or create the conversation for the new subject, rather than rebinding the old thread.
Capture route context and selected entities at send time; an in-flight
turn or approval cannot be moved to another subject by navigation. Switching worlds detaches
the prior world's live tool access and leaves its durable conversation history where it belongs.

## Implementation seams

- `components/chrome.tsx` owns the right-hand controls. Add the Chat icon without disturbing the
  existing Activity/Settings grouping or the header's responsive behavior.
- An application-level provider should own panel visibility, the selected conversation and
  unsent drafts. It should use existing route/context resolution instead of duplicating world
  state in a second store.
- `components/conversation.tsx` already supplies world and production conversations.
  `production-studio-context.tsx` preserves a single mounted conversation/card through portals;
  reuse that lifecycle so approvals, native Stage work and unsaved reviews are not cloned.
- Keep the selected conversation id separate from the currently viewed page. Existing subject
  docks should open that same conversation through the shared controller.

Use a resizable side panel on desktop and the existing sheet pattern on phones. Closing it hides
the view and does not cancel generation. Give the button an accessible name/expanded state,
restore focus on close, support Escape, and retain clear pending-decision/running-work signals.

## Acceptance scenarios

Open from world, production, shot, Stage, Cut and Bench; navigate with a typed draft and an active
run; reopen the previous thread; explicitly adopt a new page; switch worlds; refresh mid-run;
approve or deny a retained card; open Activity/Settings; use phone keyboard and narrow layouts.
Verify that no turn, lease, result, disclosure or approval acquires a new world or subject merely
because its page changed. Verify one conversation/card instance rather than duplicate mounts.

The proposal is advisable as consistent navigation. Specialist delegation and a director agent
are a separate orchestration feature and are not prerequisites for this entry point.
