# Story PDF dependency notices

These files retain the unmodified licence texts from the locked npm packages used by the
offline PDF compiler and validator. The build copies this complete directory beside the PDF
worker; the installer verifies that every file matches the build.

PDFKit 0.20.2 and fontkit 2.0.4 are by Devon Govett (MIT). The fontkit, dfa and brotli npm
archives declare MIT in both package.json and README but omit a standalone licence file.
Their original declarations and author attribution are retained here, alongside the complete
MIT text in pdfkit-LICENSE.txt. No copyright year has been invented for those packages.

The brotli decoder retains Copyright 2013 Google Inc. All Rights Reserved. Its source headers
declare Apache-2.0; the exact header is retained in brotli-decoder-NOTICE.txt and the full Apache
text is in pdfjs-dist-LICENSE.txt. The decoder code is unmodified.

Other retained dependency texts cover @noble/ciphers, @noble/hashes, @swc/helpers, base64-js,
clone, fast-deep-equal, fflate, linebreak, pako, png-js, restructure, tiny-inflate,
unicode-properties and unicode-trie. They retain their upstream copyright lines and terms.

PDF.js 5.4.624 is Apache-2.0. Its npm distribution has a LICENSE but no separate NOTICE file.
DejaVu 2.37 font licensing remains with the unmodified files in ../fonts/LICENSE in the
installed dist directory, and in packages/coordinator/src/publications/fonts/LICENSE in source.
