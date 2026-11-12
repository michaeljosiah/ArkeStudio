# Offline publication fonts

Unmodified DejaVu 2.37 regular, italic/oblique, bold and bold-italic/oblique faces for Serif and
Sans. The accompanying LICENSE permits distribution and embedding. The serif family falls
back to the matching Sans face for missing glyphs; unsupported graphemes are refused.

Official archive: https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip

Published archive SHA-256 (verified before extraction):
`7576310b219e04159d35ff61dd4a4ec4cdba4f35c00e002a136f00e96a908b0a`.
Upstream checksum: https://dejavu-fonts.github.io/Download.html

The compiler checks each file against its pinned SHA-256 at runtime. Desktop packaging copies
this directory beside the bundled compiler; development resolves it beside the source module.
No operating-system fonts or network font loader are used.

The final fallback is monochrome Noto Emoji Regular 3.002, used only when the selected DejaVu
face and its matching Sans fallback cannot display a grapheme. Emoji retain their natural
regular face; they are not artificially slanted or emboldened. This supports supplementary
characters such as folded hands and clinking glasses without changing the authored text.

Unmodified variable font from Google Fonts commit `47d54ca1ebb14fd864695f1d39dc734f39017c33`:
https://github.com/google/fonts/blob/47d54ca1ebb14fd864695f1d39dc734f39017c33/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf

Stored as `NotoEmoji.ttf`; SHA-256
`de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551`.
The accompanying `NotoEmoji-OFL.txt` permits bundling and embedding under SIL OFL 1.1.

The text painter (SPEC-065 R-22) reads Geist Regular 1.7.2 from this directory: the words of a
text clip are drawn from this file's own outlines, never from a font installed on the machine.
It is the same reviewed, unmodified binary as `apps/desktop/assets/Geist-Regular.ttf`, which the
desktop ships separately for ffmpeg slates.

Stored as `Geist-Regular.ttf`; SHA-256
`85a1c6b18a6b0a06dfe9fd4f6d6a5d4979f74ec861eaef4bc7868b5492b8a117`.
The accompanying `Geist-OFL.txt`, a copy of `licenses/LICENSE.Geist.txt`, permits bundling under
SIL OFL 1.1. The painter checks the file against the hash recorded in the typeface table in
contracts before reading it, and refuses by the file's name when it is missing or differs.

The painter's other files are the faces design turn 277 approved, each unmodified from its
publisher's repository and stored under the publisher's own file name. Their SHA-256 hashes are in
the typeface table (`packages/contracts/src/editor-text-typefaces.ts`), which the painter checks
before reading a file and `apps/desktop/scripts/verify-licenses.mjs` checks before packaging. Each
licence text is the publisher's `OFL.txt` with line endings made LF.

| Face | Files | Source | Licence |
|---|---|---|---|
| Geist Bold | `Geist-Bold.ttf` | `vercel/geist-font` commit `ef2597cfc42f4797676df105517ccc0a1cfa6569`, the release Geist Regular above comes from | `Geist-OFL.txt` |
| Jost 3.7 | `Jost-400-Book.ttf`, `Jost-400-BookItalic.ttf`, `Jost-700-Bold.ttf`, `Jost-700-BoldItalic.ttf` | `indestructible-type/Jost` commit `35f141c970538f1ed0f235789c19156b3ce2a762` | `Jost-OFL.txt` |
| Comic Neue 2.003 | `ComicNeue-Regular.ttf`, `ComicNeue-Bold.ttf`, `ComicNeue-Italic.ttf`, `ComicNeue-BoldItalic.ttf` | `google/fonts` commit `c30b221beb0c1da59d563feb91ec8656a1fa972a` | `ComicNeue-OFL.txt` |
| Bangers 2.100 | `Bangers-Regular.ttf` | `google/fonts` commit `c30b221beb0c1da59d563feb91ec8656a1fa972a` | `Bangers-OFL.txt` |
| EB Garamond 1.002 (upright), 1.001 (italic) | `EBGaramond-Regular.ttf`, `EBGaramond-Bold.ttf`, `EBGaramond-Italic.ttf`, `EBGaramond-BoldItalic.ttf` | `octaviopardo/EBGaramond12` commit `106a4a6d377987459ae5e68673a4570f13b957fb` | `EBGaramond-OFL.txt` |
| Cinzel 2.000 | `Cinzel-Regular.ttf`, `Cinzel-Bold.ttf` | `NDISCOVER/Cinzel` commit `dd598495b0fb2ad84270d5cc75d642d2f1e8eabf` | `Cinzel-OFL.txt` |

Bangers has one weight and no italic, and Cinzel no italic: a look that asks for one refuses by
name rather than having it made by slanting or thickening (SPEC-065 R-7). Of the six, only EB
Garamond draws the dotted letters of Yoruba (ẹ, ọ, ṣ).
