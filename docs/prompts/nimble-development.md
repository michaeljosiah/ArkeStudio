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
- Run full build and test suites once, after all related implementation is complete.
- Do not repeatedly rerun unchanged checks.
- Preserve unrelated worktree changes and never revert work you did not create.
- Keep progress updates brief: report completed milestones, material blockers, or decisions only.
- If working through multiple issues, finish, verify, commit, and push each issue before starting the next.
- Optimize for delivering working software quickly without compromising data integrity, security boundaries, or user-visible correctness.
