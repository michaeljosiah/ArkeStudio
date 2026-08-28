# Working in this repo

An npm workspaces monorepo — `packages/*` and `apps/*` — on Windows, shipped as an Electron
desktop app. This file covers the things that have actually cost sessions time here. It is not a
tour of the architecture; read the code and `docs/specifications/` for that.

## Never hand-roll branch or worktree deletion

Use `/cleanup`, or `node scripts/prune-merged.mjs` directly. Dry run is the default.

A session once tidied branches by improvising `git branch -D` and `git worktree remove` loops. The
branch half was right — every deletion verified merged, every SHA recorded. The worktree half took
a live worktree holding uncommitted work on an unmerged branch, and that work was gone. The script
gates both halves on the same question and gates worktrees twice, because "merged" says nothing
about the files sitting in the directory right now. If it declines to remove something, that is
the tool working; do not reach past it for raw git.

## Worktrees

Claude worktrees live at `.claude/worktrees/<name>` — **inside** the repo. Two consequences:

**They have no `node_modules`.** Cross-package imports resolve upward to the main checkout, whose
`@arke-studio/*` entries are junctions into *its* packages — so a worktree can typecheck and test a
different branch's source while reporting green. Before trusting any cross-package result, add
worktree-local junctions (PowerShell, not `mklink` through Git Bash, which silently creates
nothing):

```powershell
New-Item -ItemType Junction -Path "$wt\node_modules\@arke-studio\<pkg>" -Target "$wt\packages\<pkg>"
```

**Eviction is silent.** If another session removes your worktree mid-task, nothing errors: the
`.git` file vanishes, git walks up, finds the main checkout, and every later command operates on
`main`. A commit from that directory lands on main. Detect it with `git rev-parse --show-toplevel`
— if that is not your worktree path, you have been evicted. Worth running before any git write
after a long gap, or the moment a git result looks unfamiliar. Push early: the pushed branch is the
only thing eviction cannot touch.

## The stash stack is shared

Every worktree and the main checkout share one stash stack, and sessions run concurrently. Never
use bare `git stash` / `git stash pop` — you can pop another session's work. Prefer a temporary WIP
commit. If you must stash, tag it (`git stash push -u -m "<unique-tag>"`), capture your entry's SHA
from `git stash list`, and restore with `git stash apply <sha>`, never `pop`.

## Checks

```
npm run lint        # oxlint packages apps — note: NOT scripts/
npm run typecheck   # tsc --noEmit per workspace
npm test            # node --test per workspace
```

CI runs lint, typecheck, build, then test, on **both** windows-latest and ubuntu-latest, in four
shards per platform. A healthy shard is 2m34s–12m14s on Windows and under 3m30s on Linux, against
a 30-minute ceiling. A step that prints nothing for ten minutes is killed as hung — that, not the
ceiling, is what catches a leaked watcher, so a red check means something failed rather than that
the runner was busy. The two numbers are coupled: the guard only reports first while pre-Test work
plus the Test step plus ten minutes fits inside the ceiling, so move them together. Each run prints
the longest silence it actually saw, which is how you tell whether ten minutes still holds — and
measure over days, not hours, or you will sample a quiet afternoon and set the number too tight.

- **`tsx` does not typecheck.** A green `npm test` proves nothing about types. Run `typecheck`
  after your last test edit, not before.
- **Local green on Windows is not green.** The Linux job catches path and case assumptions — a
  `/`→`\` swap before `path.join`, a wrong-cased import — that Windows accepts silently.
- **Client tests need `cwd = packages/client`.** Run from the repo root they all fail at once,
  which reads as a catastrophic regression rather than a wrong directory.
- **Do not run `npm run format`.** The codebase is hand-formatted to a house style prettier
  disagrees with; `format:check` fails on files nobody has touched. `oxlint` is the gate that
  actually passes clean. Before assuming you broke formatting, check the file was already failing
  at `HEAD`.
- A test file that hangs freezes the whole runner's log while later files keep running, so a
  frozen tail is not necessarily a dead run.

## Pull requests

Branch, push, raise the PR, then comment `@codex review` on it. Fix every P1 and re-request until a
round comes back clean. There are no required checks on this repo, so `--auto` merges immediately —
poll CI yourself before merging rather than trusting auto-merge to gate.

`gh pr merge --delete-branch` switches your checkout to main, and commits made there afterwards
skip PR review entirely. Prefer merging without it and cleaning up separately.

## House style

Comments explain *why*, in prose, at the point where the reasoning is non-obvious — usually the
failure that motivated the code. Match the density and voice of the file you are editing rather
than a general standard. On-screen copy is the opposite: labels over sentences, and drastically
plainer than the prose in comments and specs.
