# Working in this repo

An npm workspaces monorepo — `packages/*` and `apps/*` — on Windows, shipped as an Electron
desktop app. This file covers the things that have actually cost sessions time here. It is not a
tour of the architecture. Start with [AGENTS.md](AGENTS.md) and the
[developer code map](docs/development/code-map.md) for navigation, then the relevant spec.
This file is the shared operational reference for all coding agents; keep these rules here
rather than duplicating them in package guides.

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
npm run build       # client and desktop build
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

## Character audio foundation (issue #117)

Shared audio contracts live in `packages/contracts/src/audio.ts`; local preparation, QC, rights,
transcript comparison and clearance live in coordinator `src/audio/`. Reuse them for #255/#111;
do not introduce performance persistence as a prerequisite for a character sample. Desktop audio
and video QC share the bounded process runner. Consumer UI and automatic route transport are
separate work. Read [the integration/recovery notes](docs/architecture/character-audio-foundation.md)
before adding a consumer, particularly frozen candidates, current rights and conservative cleanup.

## Harness dependencies (issue #828)

Harness dependencies (issue #828): concrete adapter imports under coordinator/src belong only in
`harness/v2-launch.ts`, the shared desktop/dev composition module. The package intentionally
depends on both adapters; Coordinator itself consumes contracts. Credential-environment policy
lives in contracts (`harness-env.ts`). The dev entry stays here, so providers and voice are runtime
dependencies. See SPEC-005 §1.1; do not remove these dependencies based on the historical AR-2 audit.

## World ownership checks (issue #827)

World ownership (issue #827): preserve the disk identity checks in WorldStore/Committer and the
three-failure heartbeat cutoff. Ownership loss disables writes until reopen; do not retry under
the old claim or remove a successor's lock. These checks are not an atomic fence. See
[ADR-002's desktop decision](docs/decisions/002-ownership-is-a-revision.md#desktop-decision--issue-827-2026-09-05)
and SPEC-002 §2.9 for the retained stale-reclaim policy and local-filesystem support limits.

## Journal flush boundaries (issue #826)

JobJournal, LedgerFile and ProviderCallStore use `appendFlushed` inside their existing WriteQueue:
write, file sync, close, then acknowledge. Preserve this order before external side effects.
Repair/compaction replacements must also sync their file. Never retry an uncertain append or
infer that a rejected write proves no charge occurred. ChangeLog is unflushed diagnostics.
See [SPEC-009 §2.2.1](docs/specifications/009.the-job-queue-and-dispatch.md#221-supported-crash-model)
for the crash model, directory-persistence limits and measured cost before considering batching.

## The coordinator session is authenticated (issue #825)

Loopback is an address, not authorization. `Transport` requires a fresh 32-byte capability for
WebSocket hello and every media GET. Missing or wrong credentials close the socket before any
snapshot or command, or return HTTP 401. Refusals are logged without credentials. There is no
unauthenticated fallback, including when constructing a Coordinator without explicit transport
options: `start()` returns its generated token alongside the port for trusted host/test callers.

- **Desktop:** main mints the capability and sends it over private startup IPC. Preload adds it
  to hello and exposes only sanitized startup state. Main attaches media authorization headers
  only for the current window and coordinator endpoint. Never expose the token through the
  public bridge, renderer URLs, process arguments, snapshots or logs. Keep header removal on
  redirects to other endpoints.
- **Origins:** Electron's file page sends `file://` on WebSocket handshakes and `null` on media
  fetches. Both are explicitly allowed and both still require the token. Development windows
  use their configured HTTP origin. Do not restore wildcard CORS or mistake an Origin check
  for authentication.
- **Browser development:** start `dev:coordinator`, then `dev`, and open Vite's **Arke session**
  terminal link. The URL fragment supplies the capability; the browser removes it from the
  address bar and stores it for that tab/endpoint. Media uses a query credential in this mode
  because there is no isolated preload. Restart Vite for a fresh link after a coordinator
  restart. Custom ports/origins are documented in [CONTRIBUTING.md](CONTRIBUTING.md).
- **The dev handoff is private:** `.dev/transport-<port>.json` must remain gitignored and denied
  by Vite's filesystem-serving rules, including `/@fs` and raw/import requests. Never put the
  token in public HTML, a bootstrap endpoint or a build-time `VITE_*` variable. A public token
  handoff would recreate the unauthenticated service this fix removes.

For transport changes, preserve snapshot/reconnect sequencing and authenticated media ranges.
The relevant regressions are coordinator `test/transport.test.ts`, desktop
`test/transport-auth.test.ts` and `test/preload-auth.test.ts`, and client
`test/dev-session.test.ts` and `test/dev-session-server.test.ts`. Run client tests from
`packages/client`. Check an actual sandboxed Electron **file page**, not only a data URL or a
mock: the differing origins were caught by that smoke check. Typecheck after test edits.

Implementation entry points: coordinator `src/transport.ts`; desktop `src/transport-auth.ts`,
`src/main.ts` and `src/preload.ts`; client `dev-session-plugin.ts` and `src/lib/dev-session.ts`.
The product-level explanation is in [the architecture guide](docs/architecture/the-program.html).

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
