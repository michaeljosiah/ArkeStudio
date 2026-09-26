# Founding conversations

Issue #1268 adds draft discovery and resumption through `genesis-list` and
`genesis-load`. The new-world URL carries the draft identity. Returning to New world
offers unfinished conversations; separate drafts keep separate transcripts and attachments.

Draft content lives in `.genesis-v2/<id>/workspace/`, the harness confinement boundary.
Draft messages use the existing WorldChatStore journal in the sibling
`.conversation/` directory. Application receipts also live outside the workspace.
Legacy `.genesis/<id>/` draft content is moved into the workspace without promoting agent-authored files to receipts.
Messages are flushed before dispatch/display and represented by
`founding.message` events, which the ordinary world-chat fold also understands. A restarted
harness receives the stored history and the existing blueprint files.

Begin reserves a world identity before creating anything. The filesystem provider initializes
that world outside the library and publishes it with a directory rename. Retrying the reserved
identity returns the published world. Conversation handoff appends each source event with its
original event identity as an idempotency key; an interrupted prefix can be replayed safely.

Begin freezes its blueprint and model choices before publishing the reserved world. Recovery
uses that input even if draft files subsequently change. Unreadable drafts block Begin; draft
recovery restores only the damaged records so valid edits remain visible. Form handoffs also
retain a pending marker until attachments and conversation history have finished copying.

Worlds containing founding conversation events require schema version 33. Older readers must
refuse the world rather than misread its strict conversation journal.

The founding marker and sandbox remain after completion so a repeated Begin joins its original
world and draft URLs can resolve the ongoing conversation. They are not abandoned drafts.
Explicit abandonment only removes an unfounded, idle sandbox. Completed-sandbox garbage
collection is deliberately separate from founding; it must preserve the replay mapping.

The founding screen displays build progress in the conversation and continues at the same
conversation ID in World Chat. Other entry points can still use the Building screen.

Relevant checks:

Document imports use the same Markdown, text and partial PDF reader as established-world
extraction. The harness proposes individual candidates in `draft/imports/`; the coordinator
verifies exact source quotes and freezes the source bytes. Chat labels the proposed wording
as interpretation and shows matching draft records and other imports. The author may edit,
merge, retain distinct records, reject, or leave a candidate undecided. Preparing a candidate
creates a draft proposal; ordinary content approval is still required before Begin.

Source identities survive entity renames and prose edits. Reimported source bytes and replayed
resolution requests reuse their existing candidates. Founding files the original source and
adds artifact links to approved sheets and allocated canon IDs. Worlds whose founding journals
contain this source metadata require schema 38; worlds without it retain their earlier boundary.

Image proposals in `draft.json` name a stable character or location slug, prompt and optional
uploaded references. The chat shows the prompt, model, reference images and estimated cost
before generation. Generating creates a candidate; it never approves the result. Use image,
Reject and Remove assignment operate on the exact preview hash.

Uploads and generated candidates are frozen in application-owned storage outside the harness
workspace. Begin files them in Artifacts, then installs approved selections through the existing
main-photo and establishing-view services. Existing selections cost nothing to reuse and replace
the corresponding generation in the build plan. Alternatives remain artifacts. Generated
artifacts retain their producing job, provider, model, parameters, cost and entity links.

Founding image decisions and generated-image provenance require schema version 35. Artifact
writes that introduce location reference provenance raise this boundary atomically as well.

- Coordinator `test/harness/genesis-images.test.ts`: immutable previews, exact decisions,
  renames, reference plans and recovery.
- Coordinator `test/dispatch-refusal.test.ts`: authenticated image command flow, stale proposal
  refusal, separate result approval and generation replay.
- Client `test/genesis-images.test.tsx`: preview and entity-specific approval controls.

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
