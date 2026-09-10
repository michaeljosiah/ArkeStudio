# Contributing to Arke Studio

Thanks for looking. This page covers the licence position first, because it is the part that
cannot be fixed after the fact, and then the ordinary business of getting a change merged.

## The licence, in short

Arke Studio is published under the **GNU Affero General Public License v3.0 only**
([LICENSE](LICENSE)). You may use it, modify it, and run it, including commercially. If you
distribute it or offer it to others over a network, AGPL §13 requires you to make your source
available to those users under the same terms.

Third-party components are recorded in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Copyleft
components — ffmpeg, espeak-ng — are invoked as **separate executables and never linked**. That
arrangement is deliberate and load-bearing; a contribution that links one of them into Arke's own
source will not be merged.

## The CLA, and why there is one

**Every contributor signs the [Contributor Licence Agreement](CLA.md) before their first change is
merged.** You keep the copyright in your work. You grant a licence broad enough that the project
can ship it under the AGPL *and* under other terms later, including commercial ones.

That relicensing right is the whole point, so it is worth being direct about it: Arke Studio is
funded by commercial products built on the same engine. Without a CLA, taking a single outside
contribution would permanently remove the ability to do that, because relicensing would then need
the agreement of every contributor who ever touched the code. The CLA keeps that door open. It
does not close the AGPL one — the published version stays AGPL, and your grant cannot be used to
withdraw it.

If that arrangement isn't for you, that is a fine position to hold. Please say so on the issue
before you write the code, rather than after.

### How to sign

1. Read [CLA.md](CLA.md).
2. In your first pull request, add a row to [contributors.md](contributors.md):

   ```
   | @your-github-username | Your Name | 1.0 | 2026-08-22 |
   ```

3. Tick the CLA box in the pull request template.

Adding the row is your signature. One signature covers all your future contributions, unless the
CLA version changes — in which case you add a new row for the new version.

Contributing on behalf of an employer, or as a company? Open an issue before you start; a
corporate agreement is a different document.

## Getting set up

```bash
npm ci               # npm workspaces monorepo, Node >= 22.12 (CI uses Node 22)
npm run typecheck    # every workspace
npm run lint         # oxlint
npm run build        # client and desktop
npm test             # every workspace with tests
npm run dev:coordinator # start the local coordinator first (separate terminal)
npm run dev          # client dev server
```

For browser development, open the **Arke session** link printed by Vite. It carries this launch's
capability in the URL fragment; the browser removes the fragment credential and keeps it in tab
session storage. The ordinary Vite URL does not grant a coordinator session. After restarting the
coordinator, restart Vite and use its new link. The gitignored `.dev/transport-<port>.json` handoff
is only for local development; it is never served as HTML or included in a build. The packaged
app instead keeps its capability in Electron main/preload and attaches media credentials in headers.

For a custom coordinator port, set `VITE_ARKE_WS` in the client terminal to its loopback WebSocket
URL. For a custom Vite port/origin, set `ARKE_DEV_ORIGIN` to that exact origin in both terminals
(and `PORT` separately for each server). The defaults allow `http://localhost:5173` and
`http://127.0.0.1:5173`.

Run lint, typecheck, build and tests before pushing code changes. CI checks Windows and Linux;
local success does not establish correctness on the other platform. For focused tests, fixtures,
native runtime checks and documentation-only validation, see [the testing guide](docs/development/testing.md).
Start with [the developer index](docs/development/README.md) for code navigation and shared agent guidance.

## How changes are shaped

Arke Studio is **specification-first**: behaviour is decided in a capability spec and then built.
The specification set is not published with the code, so a contribution cannot amend one directly.
That changes the order of work rather than the standard:

- **A change to behaviour starts with an issue, not a pull request.** Say what should be different
  and why. If it is accepted the spec is amended here, and the issue comes back with the section
  your change implements. A pull request that changes what the product does, with no spec section
  behind it, will be asked for the issue first — not because the idea is unwelcome, but because
  the spec is where that decision is recorded and it has to be recorded somewhere.
- **A bug fix, a refactor, a test, a typo** needs none of that. Just send it.
- **Cite the spec section you are implementing** in the pull request, the way the code already
  does: `SPEC-014 §3`. The document is private; the citation is not, and it is how the change is
  reviewed against what was decided.
- Record *why*, not just *what*. The reasoning outlives the decision, and in a public repository
  whose specs are private, a comment explaining the failure that motivated the code is often the
  only place that reasoning survives.

## Pull requests

- Branch from `main`. One concern per pull request.
- Write the commit subject as a statement of what is now true — `A conversation can change a shot,
  and a scene can be deleted` — not as an instruction.
- Say what you tested. If it touches the world folder, the accept gate, the job queue or
  packaging, say how you know it is safe: those four are where a mistake is expensive and quiet.
- Never commit credentials, world content, or anything from `.dev/`.

## Cutting a release

A release is a tag: push `v<major>.<minor>.<patch>` matching `apps/desktop/package.json` and the
release workflow builds, verifies and publishes it. Before tagging, write the release's card at
`docs/releases/v<version>/notes.md` with a `picture.jpg` beside it (960×540 reads well):

```markdown
---
title: A world remembers why it was made
date: 2026-08-23
picture: picture.jpg
---
The notes, as plain paragraphs separated by blank lines.
```

The workflow refuses a tag without one and publishes the GitHub release's title and body from
it; the application bundles the newest eight cards for the Activity panel's What's new. Check a
card before tagging with `node scripts/release-notes.mjs check v<version>`.

## Reporting a security issue

Do not open a public issue. Email the address on
[github.com/michaeljosiah](https://github.com/michaeljosiah) with what you found and how to
reproduce it, and you will get a reply.
