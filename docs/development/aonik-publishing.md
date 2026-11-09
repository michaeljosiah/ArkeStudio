# Creator publishing to AONIK

Studio #2391 implements SPEC-025 R-28 and SPEC-058 R-95–R-100. This is an optional
desktop adapter. Local authoring, generation, Player export and manual distribution
continue to work without an account or network.

After making a Player ZIP, open **Submit to Arke Player** beside that edition in the
export result or the world's **Publications** list. Sign in in the system browser,
choose **Review frozen edition**, inspect its filename, hash, included files and public
artwork, and complete the public details, audience, attribution and rights evidence.
The distribution permission is unchecked until the author confirms it. **Submit for
review** saves the exact intent before making a network request. It does not approve
or publish anything. This flow is separate from video/EPUB/M4B Story Publish.
Declaration fields use single lines, matching AONIK's current metadata and rights
validation; the editor does not offer unsupported paragraph breaks.

The world's Publications view shows saved receipts for the current creator, their
upload progress and current editorial state. Pause retains uploaded chunks. Cancel
cancels an unsubmitted private upload where one is known, retaining its receipt and
exact edition. Resume reconciles the original request and missing server chunks.
**Refresh receipt** reads AONIK status and creator-safe review feedback. Approved,
publication in progress and published remain separate states. Choosing an eligible
receipt under **Submission** creates a replacement revision and requires fresh review.

## Host configuration

Place `aonik-publishing.json` in the desktop app root, or set the host environment
variable `ARKE_AONIK_CONFIG` to its absolute path before launching Studio. This is
host configuration, not a renderer preference or a setting inside a source world.
No client secret is accepted. Missing or malformed configuration leaves local Studio
available and explains why cloud submission is unavailable.

```json
{
  "apiBaseUrl": "https://aonik-dev-api.delightfulisland-9fd7c1e7.uksouth.azurecontainerapps.io",
  "issuer": "https://aonik.uk.auth0.com/",
  "audience": "https://api.aonik.com",
  "clientId": "<registered-public-native-Studio-client-id>",
  "scope": "openid profile email offline_access",
  "tenantId": "<AONIK-business-tenant-UUID>",
  "channelKey": "<configured-dev-test-channel>",
  "rightsDeclarationVersion": "<owner-approved-current-version>",
  "permissionText": "<owner-approved-distribution-statement>",
  "redirectPort": 37619,
  "maxPackageBytes": 134217728
}
```

The placeholders deliberately refuse validation. They are not working credentials or
invented channel authority. Register a **public native** OIDC application with code
flow, S256 PKCE and callback `http://127.0.0.1:37619/aonik/callback`; no client secret
or admin `/v1/me` call is involved. Port zero requests a random loopback port, usable
only where the identity provider's registered native callback policy permits it.
Enable the appropriate audience/scopes and refresh-token policy for that client.
The API must recognise the user, tenant and linked creator party and grant creator
submission permission. An Azure identity-directory tenant is not the AONIK business
tenant. `accountUrl` and `planUrl` are optional HTTPS portals; absent portals are hidden.
HTTP is refused except explicit `allowLoopbackHttp: true` for literal loopback tests.

Native `safeStorage` must be available with a protected backend; Linux `basic_text`
is refused. Credentials are encrypted in `<app-root>/creator-publishing/account.dat`,
with current-user filesystem permissions. They are never sent over the Studio bridge,
written to a world, included in its changelog, or exposed as an avatar URL. Other
private publishing state and frozen copies have current-user permissions too.
Cancellation, timeout and shutdown close the callback even if the OS browser launch
has not returned. A late launch cannot complete the cancelled handoff or save tokens
(SPEC-025 R-28).
Explicit sign-in requests authentication in the browser so a reviewer or another
creator's existing browser session cannot silently select the Studio identity.
Restoring protected native credentials and rotating refresh tokens remain silent.

## Frozen editions and recovery

Only a selected, recognised completed Player export can be prepared. The coordinator
copies it to private host storage, compares its retained length/SHA-256, bounds archive
entries/documents and uses the owning Player-package reader to check its manifest,
assets and hashes. Source folders are not uploaded. A PNG/JPEG artwork asset at most
4 MiB must already be in that exact archive; Studio never silently adds or rewrites
assets. Key art and production artwork are preferred, then an eligible included
illustration. An edition without eligible public artwork remains locally usable but
must be exported with suitable artwork before it can be submitted. Parts are the
exception: they inherit the exact published base edition's approved cover and send
an empty `artworkAssetId`. An incidental illustration in a part must not replace
that cover. Every included asset still requires rights evidence, and the existing
base fingerprint/edition/sequence checks still apply. This compatibility correction
was found during AONIK #403; it requires AONIK's corresponding part-artwork fix.

Candidates, declarations, operation UUIDs, submission/revision IDs, upload sessions,
hashes and progress live outside worlds in `<app-root>/creator-publishing`. The same
candidate has one durable request identity, serialized across windows. Once confirmed,
changed details require a fresh confirmation. An uncertain response never allocates a
new identity. Restart and reconnect do not automatically replay mutations: the author
resumes the saved request. Upload reconciliation asks AONIK for missing chunks and
streams those exact byte ranges with their SHA-256. Changed private bytes refuse before
network access. Remote receipts must match the expected channel, world, edition,
revision, byte length and archive hash.

Receipt scopes bind API, issuer, client, tenant, channel and creator subject through an
opaque hash. Switching account cancels active work and clears that creator's receipt
view; late responses cannot populate another account. Publishing commands are host-only
and human-only, not agent tools. Shutdown aborts and drains handoffs, network operations,
preparation and persistence. A part must match AONIK's published base fingerprint,
edition and next part both before upload and before submission. An unpublished local
export does not establish release lineage; a changed/unavailable published base refuses.
Server verification and editorial approval remain authoritative.

## Dev qualification status — 6 November 2026

The tested AONIK application images (`78be974c`) and email configuration (`a6dc2e1d`)
are deployed to dev. API revision `aonik-dev-api--0000379` is healthy, with
private intake/delivery shares mounted and one replica of each kept running. The
isolated `arke-worlds-dev` channel belongs to Arke Kidz tenant
`1087cc03-46cc-45fa-9023-f0ce4f7bbdb8`; its admission, review and publication switches
remain closed. See the [AONIK #403 runbook](https://github.com/michaeljosiah/aonik/blob/3e65caa9/docs/runbooks/arke-publishing-dev.md)
and [PR #406](https://github.com/michaeljosiah/aonik/pull/406) for deployment
digests, storage checks and remaining prerequisites.

After owner approval, Auth0 **Arke Studio Dev** was registered as a public Native
client, ID `9SfLUjB57WtWEQUNm1twTO7UQRnsUzvY`. Its sole callback is
`http://127.0.0.1:37619/aonik/callback`; code and refresh grants are enabled and
implicit grant is disabled. Refresh rotation has a 24-hour idle lifetime, seven-day
maximum and zero overlap. The AONIK API permits offline access. Studio supplies
S256 PKCE, state and nonce. No client secret or Admin SPA client is used.

The [non-secret dev profile](https://github.com/michaeljosiah/aonik/blob/3e65caa9/iac/azure/environments/dev/arke-studio.json)
passes Studio's actual configuration parser. Set `ARKE_AONIK_CONFIG` to its local
absolute path, using an isolated Studio workspace and Electron user-data directory.
Its synthetic distribution wording is a proposed declaration, requiring the
submitting human's explicit confirmation; it is not permission for production.

The full live rehearsal is **not qualified**. Both synthetic creators completed code
+ PKCE sign-in through Studio's actual `AonikAccount` adapter in an isolated harness.
Authenticated profile reads return Active; real verification emails were delivered
and confirmed, and all required AONIK onboarding gates pass. This establishes the
adapter path, not desktop UI sign-in, refresh rotation or persistent credential
recovery. See the [sanitized account evidence](https://github.com/michaeljosiah/aonik/blob/3e65caa9/docs/runbooks/evidence/arke-creator-email-2026-11-06.json).

The isolated Azure Dynamic Sessions verifier is deployed and qualified with synthetic
fixtures; actual Worker-managed intake still needs a live job. Tenant module and
independent reviewer setup, desktop submission, and Player dev-channel support remain
outstanding. Synthetic accounts do not establish two consenting human pilot creators.
No real creator package, approval or public catalogue was changed during preparation.
Use synthetic fixtures on that test channel, interrupt/resume an upload, restart Studio,
inspect creator feedback, replace a revision, and independently approve/publish through
AONIK before checking the Player catalogue. Do not use an admin token or public storage
fallback to bypass the creator path.

## Validation

From the repository root, with Node >=22.12 and `ARKE_PRIVATE_DOCS` pointing to the live
private spec checkout:

```sh
npm run lint
npm run typecheck
npm run build
npm test
node scripts/smoke-creator-publishing.mjs
npm run smoke:main --workspace @arke-studio/desktop
```

Focused suites: coordinator `test/publishing/*.test.ts` and `test/account.test.ts`;
client `test/creator-publishing.test.tsx` and `test/account-menu.test.tsx`; desktop
`test/aonik-publishing.test.ts`, `test/transport-auth.test.ts` and `test/preload-auth.test.ts`;
contracts `test/remote-command-access.test.ts`. Run from each package's cwd with
`node --import tsx --test <files>`. Windows tests need native temporary-file/ACL access
and loopback listeners. The new golden ZIPs are synthetic fixtures with provenance.
Protocol fixtures exercise actual OIDC PKCE/nonce processing and the actual package
reader; they do not prove a live Auth0/AONIK deployment. The Electron smoke uses the
real sandboxed file page and preload at 1280/984/400 px, verifies explicit rights
confirmation, typed submission, saved-form locking and receipt presentation. Set
`ARKE_CREATOR_LAYOUT_OUTPUT` to capture its rendered screenshots.
