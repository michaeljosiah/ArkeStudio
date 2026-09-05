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
npm install          # npm workspaces monorepo, Node >= 20
npm run typecheck    # every workspace
npm run lint         # oxlint
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

Run those four before you push. CI runs the same ones, so a green local run is a green CI run.

## How changes are shaped

Arke Studio is **specification-first**. `docs/specification.md` is the master product spec, and
`docs/specifications/NNN.*.md` are the capability specs that break out of its §19. Behaviour is
decided in a spec and then built.

So:

- **A change to behaviour needs a spec change.** Amend the relevant capability spec in the same
  pull request, or link the spec section your change implements. A pull request that changes what
  the product does without touching a spec will be asked for one.
- **A bug fix, a refactor, a test, a typo** needs none of that. Just send it.
- Specs use RFC-2119 keywords and numbered acceptance criteria (`R-1`, `R-2`, …). Match the house
  format of the file you are editing.
- Record *why*, not just *what*. The specs keep decision tables for reversed and rejected
  decisions, because the reasoning outlives the decision.

## Pull requests

- Branch from `main`. One concern per pull request.
- Write the commit subject as a statement of what is now true — `A conversation can change a shot,
  and a scene can be deleted` — not as an instruction.
- Say what you tested. If it touches the world folder, the accept gate, the job queue or
  packaging, say how you know it is safe: those four are where a mistake is expensive and quiet.
- Never commit credentials, world content, or anything from `.dev/`.

## Reporting a security issue

Do not open a public issue. Email the address on
[github.com/michaeljosiah](https://github.com/michaeljosiah) with what you found and how to
reproduce it, and you will get a reply.
