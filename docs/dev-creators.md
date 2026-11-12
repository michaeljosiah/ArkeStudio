# Studio Dev for invited creators

The Windows x64 **Arke Studio Dev** installer carries the `arke-worlds-dev` publishing profile.
No environment variable or hand-written configuration file is required. Accept the AONIK
invitation using the invited email, create an account on the sign-in page if needed, and verify
that email. In Studio, connect the Arke account, export a frozen Arke Player edition, and submit
it with the displayed `dev-creator-v1` declaration. Track validation and review in the receipt.
Only a separately authorised reviewer/publisher can approve and release it.

Approved dev releases have publicly accessible catalogue and download URLs. Uploads remain
private before release. Withdrawal removes discovery, but downloaded and offline copies remain.
Do not submit material you are not permitted to distribute.

Dev installs alongside ordinary Studio. Its default library is `%USERPROFILE%/ArkeStudioDev`,
with Electron state in `%APPDATA%/ArkeStudioDev`. It does not install production auto-updates.
To update, install the next Dev installer over the existing Dev install; do not uninstall or
remove your library. The uninstaller retains local work and account state.

Build using the **Package Studio Dev (Windows)** Actions workflow. Download its
`ArkeStudioDev-Windows-x64` artifact, check `SHA256SUMS.txt`, and run the installer. The package
uses the complete normal runtime/licence verification pipeline. `build-info.txt` records the
source commit. These dev installers are unsigned, like the existing on-demand Windows builds.

For a local build, set `ARKE_BUILD_CHANNEL=development`, then run `npm run build` and
`npm run package --workspace @arke-studio/desktop`. The resulting installer is in
`apps/desktop/release-dev`. The packager rejects a compiled channel mismatch and refuses to
publish a dev installer to the production update feed.
