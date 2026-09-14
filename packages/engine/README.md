# @arke-studio/engine

An embeddable Node engine for reading worlds, proposing and accepting characters, and generating portrait candidates. ESM; Node 22.12+; AGPL-3.0-only.

Import `createEngine` from `@arke-studio/engine` and supply world sessions, durable operations, policy and a queue. Optional folder adapters and the existing dispatcher are exported from `@arke-studio/engine/local`.

See the [engine guide](https://github.com/michaeljosiah/ArkeStudio/blob/main/docs/development/engine.md) for host requirements, lifecycle, retries and current limits. The core has no default authorization policy and does not start a server. The optional local adapter requires native better-sqlite3. Core-only hosts can install with `--omit=optional`. If the native dependency is unavailable, install it explicitly with `npm install better-sqlite3` before importing `@arke-studio/engine/local`.
