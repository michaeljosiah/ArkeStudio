---
description: Remove local branches and Claude worktrees that origin/main has already absorbed, showing exactly what would go before anything goes.
argument-hint: "[--keep-worktrees] [--base <ref>]"
---

Prune merged branches and worktrees using `scripts/prune-merged.mjs`. Never do this by hand.

## Why this command exists

On 2026-08-26 a session tidied branches by improvising `git branch -D` and `git worktree remove`
loops. The branch half was right — every deletion was verified merged and its SHA recorded. The
worktree half took a live worktree holding uncommitted work on an unmerged branch, and that work
was gone. A second session was evicted mid-task and, because `.claude/worktrees/<name>` sits
inside the repo, silently spent the rest of its turn operating on `main` instead.

The script has the gates. Your job is not to re-derive them, and not to reach for raw git when the
script declines something — a refusal is the tool working.

## Do this

1. Run the dry run first, always. It is the default; no flag is needed.

   ```
   node scripts/prune-merged.mjs $ARGUMENTS
   ```

2. Show the user its output more or less verbatim — both the `keep` lines and the `would` lines.
   The keep lines are the interesting half: they are the record of what was protected and why.

3. **Stop there.** Do not run `--apply` until the user asks for it in this conversation. Approval
   from an earlier cleanup, or from earlier in this session, does not carry.

4. Call out by name any worktree in the `would` list. Clean and merged does not mean idle: another
   session may have just pushed and be about to keep working in it. The script cannot know that;
   the user can.

5. Only after they agree, re-run with `--apply` and report what actually happened — including any
   `failed` lines. Do not summarise a partial run as a success.

## Never

- **Never pass `--all-worktrees`** unless the user explicitly asks for that flag. It removes the
  restriction to `.claude/worktrees`, putting their own checkouts elsewhere on disk in scope.
- **Never** fall back to `git branch -D`, `git worktree remove`, or `git worktree prune` because
  the script skipped something you thought should go.
- **Never** run this from a worktree you are also asking it to remove. The script refuses to take
  the one it is running in, but the clearest place to run it from is the main checkout.
- **Never** run `--apply` unattended, on a schedule, or as a step inside some larger task.

## If something looks wrong afterwards

Every applied run writes `.claude/pruned-<date>.txt` before it removes anything, with the SHA of
every branch and worktree it was about to take. Restore from there:

```
git branch <name> <sha>
git worktree add <path> <branch>
```

An unreferenced commit is not findable by name once its branch is gone, so that manifest is the
only way back. Read it before concluding anything is lost.
