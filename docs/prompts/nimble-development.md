# Nimble Development

Work in nimble implementation mode.

- Start implementing immediately after inspecting only the files directly relevant to the task.
- Prefer the smallest correct change that satisfies the acceptance criteria.
- Reuse existing authorities, services, schemas, components, and established patterns.
- Do not introduce generic frameworks, speculative abstractions, duplicate storage, compatibility layers, or workflow engines unless strictly required.
- Keep logic local unless reuse is already demonstrated.
- Make pragmatic decisions autonomously. Ask only when ambiguity materially changes product behavior.
- Avoid architecture reviews, Codex reviews, and review subagents unless I explicitly request them.
- Add only high-value tests for risky behavior, regressions, security boundaries, or explicit acceptance criteria.
- Do not add redundant unit tests, broad snapshots, exhaustive permutations, or tests that merely restate types.
- During implementation, run only affected typechecks, lint, and a small focused test set.
- Run the full build once, after all related implementation is complete. Never run the full test suite locally: it takes over thirty minutes on this machine, and other sessions are usually running their own suites on the same cores, so it also flakes. Instead run every test file that exercises the changed code (and the whole suite of a small workspace such as providers or contracts), then push, raise the PR, and let CI run the full suite in its sharded jobs on both platforms. Poll CI and fix a red shard; do not wait on a local full run.
- Do not repeatedly rerun unchanged checks.
- Preserve unrelated worktree changes and never revert work you did not create.
- Keep progress updates brief: report completed milestones, material blockers, or decisions only.
- If working through multiple issues, finish, verify, commit, and push each issue before starting the next.
- Optimize for delivering working software quickly without compromising data integrity, security boundaries, or user-visible correctness.
