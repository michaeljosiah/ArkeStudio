# Saving sheet sections

Use the public `stage-sheet-edit` command for changes to existing sheet sections. It applies only
`dirtyHeadings`, whether the destination is the live sheet or an open proposal. `sections` may
contain the whole form or only those changed headings. Omitted sections and unchanged form fields
are preserved from the destination; stale text in an unchanged form field cannot overwrite them.

For example, changing only Customs on a location sends:

```json
{
  "kind": "stage-sheet-edit",
  "worldId": "<open-world-id>",
  "requestId": "<fresh-ULID>",
  "path": "locations/bell-house.md",
  "summary": "Update Bell House customs",
  "sections": [{ "heading": "Customs", "body": "The revised customs." }],
  "dirtyHeadings": ["Customs"]
}
```

An empty body clears the named section's text; omission does not delete it. Duplicate submitted
headings, a dirty heading missing from `sections`, and headings absent from the destination are
refused. A role-only edit supplies the existing sections, an empty `dirtyHeadings` list and the
new `role` (or an empty role to clear it). The current wire contract requires a nonempty `sections`
array even for a role-only edit.

Await the correlated `sheet.edit-result`. `accepted` means the normal gate committed the edit;
`undoVersion` can be passed to `restore-sheet-version`. `merged` means the changed fields joined
an existing proposal, whose other content still needs its own decision. `refused` does not grant
permission to overwrite or retry against a stale snapshot.

Before issue #1920, this command replaced the whole body when no proposal was open, despite
merging only dirty fields when a proposal existed. Automation that sent one section could lose
the others. The same partial-update rule now applies to both destinations. This command does not
add, remove or reorder headings; structural and whole-document changes use the existing explicit
content-proposal workflow, where the complete proposed document is reviewed.

The implementation stays in the existing coordinator handler and `ProposalManager.stageSheetEdit`.
Regression coverage: coordinator `test/sheet-inline-decisions.test.ts` and `test/gate/proposals.test.ts`.
See SPEC-007 R-13 and SPEC-040 R-9a for editing and decision ownership.
