# @arke-studio/engine

An embeddable Node engine for reading worlds, proposing and accepting characters, generating portrait candidates, and authoring prose. It supports direct chapter edits, AI drafting and revision through a host-provided writing runtime, and committed manuscript Markdown with chapter hashes. Direct edits preserve the chapter version; generated drafts require explicit proposal acceptance. ESM; Node 22.12+; AGPL-3.0-only.

Import `createEngine` from `@arke-studio/engine` and supply world sessions, durable operations, policy and a queue. Optional folder adapters and the existing dispatcher are exported from `@arke-studio/engine/local`.

See the [engine guide](https://github.com/michaeljosiah/ArkeStudio/blob/main/docs/development/engine.md) for host requirements, lifecycle, retries and current limits. The core has no default authorization policy and does not start a server. The optional local adapter requires native better-sqlite3. Core-only hosts can install with `--omit=optional`. If the native dependency is unavailable, install it explicitly with `npm install better-sqlite3` before importing `@arke-studio/engine/local`.
