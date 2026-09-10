#!/usr/bin/env node
// The release card for a tag (SPEC-016 R-18): docs/releases/<tag>/notes.md, front matter naming a
// title, a date and a picture file beside it, then the notes as plain paragraphs. The release
// workflow refuses a tag whose card is missing and publishes the GitHub release's title and body
// from it, so the two never disagree; the application bundles the same file for What's new.
//
//   node scripts/release-notes.mjs check v0.5.49        exits 1 with the reason when the card is unfit
//   node scripts/release-notes.mjs title v0.5.49        prints "v0.5.49 — <title>"
//   node scripts/release-notes.mjs body  v0.5.49        prints the notes without the front matter
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [command, tag] = process.argv.slice(2);

function fail(message) {
  console.error(`release-notes: ${message}`);
  process.exit(1);
}

if (!command || !tag || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag)) {
  fail("usage: node scripts/release-notes.mjs <check|title|body> v<major>.<minor>.<patch>");
}

const dir = join(root, "docs", "releases", tag);
const file = join(dir, "notes.md");
if (!existsSync(file)) fail(`no card at docs/releases/${tag}/notes.md — every release carries one (SPEC-016 R-18)`);

const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
if (!match) fail(`docs/releases/${tag}/notes.md has no front matter`);

const fields = {};
for (const line of match[1].split("\n")) {
  const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
  if (field) fields[field[1].toLowerCase()] = field[2].trim().replace(/^(["'])(.*)\1$/, "$2");
}
if (!fields.title) fail(`docs/releases/${tag}/notes.md names no title`);
if (!fields.date || !/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) fail(`docs/releases/${tag}/notes.md needs a date as YYYY-MM-DD`);
// The client bundles same-folder jpg/jpeg/png/webp files and nothing else (packages/client/src/lib/
// releases.ts), so a card is fit only when its picture is one of those, by basename, and there.
if (!fields.picture) fail(`docs/releases/${tag}/notes.md names no picture`);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp)$/i.test(fields.picture)) {
  fail(`docs/releases/${tag}/notes.md names "${fields.picture}"; a picture is a jpg, jpeg, png or webp file beside the notes, by basename`);
}
const picturePath = join(dir, fields.picture);
if (!existsSync(picturePath) || !statSync(picturePath).isFile()) fail(`docs/releases/${tag}/${fields.picture} is missing`);

const body = match[2].trim();
if (body.length === 0) fail(`docs/releases/${tag}/notes.md has no notes under its front matter`);

switch (command) {
  case "check":
    console.log(`docs/releases/${tag}: "${fields.title}", ${fields.date}, ${fields.picture}, ${body.split(/\n\s*\n/).length} paragraph(s)`);
    break;
  case "title":
    process.stdout.write(`${tag} — ${fields.title}\n`);
    break;
  case "body":
    process.stdout.write(`${body}\n`);
    break;
  default:
    fail(`unknown command ${command}`);
}
