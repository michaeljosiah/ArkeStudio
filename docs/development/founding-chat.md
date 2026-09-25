# Founding conversations

Issue #1268 adds draft discovery and resumption through `genesis-list` and
`genesis-load`. The new-world URL carries the draft identity. Returning to New world
offers unfinished conversations; separate drafts keep separate transcripts and attachments.

Draft content lives in `.genesis/<id>/workspace/`, the harness confinement boundary.
Draft messages use the existing WorldChatStore journal in the sibling
`.conversation/` directory. Application receipts also live outside the workspace.
Old draft content is moved into the workspace without promoting agent-authored files to receipts.
Messages are flushed before dispatch/display and represented by
`founding.message` events, which the ordinary world-chat fold also understands. A restarted
harness receives the stored history and the existing blueprint files.

Begin reserves a world identity before creating anything. The filesystem provider initializes
that world outside the library and publishes it with a directory rename. Retrying the reserved
identity returns the published world. Conversation handoff appends each source event with its
original event identity as an idempotency key; an interrupted prefix can be replayed safely.

The founding marker and sandbox remain after completion so a repeated Begin joins its original
world and draft URLs can resolve the ongoing conversation. They are not abandoned drafts.
Explicit abandonment only removes an unfounded, idle sandbox. Completed-sandbox garbage
collection is deliberately separate from founding; it must preserve the replay mapping.

The founding screen displays build progress in the conversation and continues at the same
conversation ID in World Chat. Other entry points can still use the Building screen.

Relevant checks:

- Coordinator `test/harness/genesis-conversation.test.ts`: disk resume, separate draft identities,
  interrupted/replayed transcript transfer and reserved world creation.
- Coordinator `test/harness/genesis.test.ts`: restored model context and existing turn lifecycle.
- Coordinator `test/world/founding-build.test.ts`: build/queue recovery and founding outcomes.

This documents the implemented continuity foundation. Content, media, import and voice approvals
are tracked separately in #1267 and #1269–#1273.
# Reviewing founding content

Issue #1269 adds versioned content decisions to the founding conversation. The agent proposes
full sheet sections, relationship targets and canon entries in the draft. The coordinator
normalizes the displayed sheet shape and hashes each proposal. Approve and reject commands
must name that exact hash; a stale batch writes no decisions.

Decisions live in the private conversation journal outside the harness workspace. Rejected
edits preserve the previous approved version. Entity filenames identify relationships across
display-name changes. Begin materializes the approved blueprint through the ordinary proposal
gate without asking a harness to expand the content again. Canon threads remain open.

The inline review shows current proposals, changes since approval and the approved counts.
Unapproved proposals are carried into the continuing conversation as explicitly unestablished
content; subsequent edits use the normal world-chat approval workflow. The founding plan calls
out partial approval. Image selection and generation are tracked separately in #1267.
