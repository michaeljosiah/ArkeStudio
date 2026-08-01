// The licence gate (SPEC-016 R-9, D5): every component present in build-resources/ must have
// its obligations recorded in THIRD-PARTY-NOTICES.md BEFORE it may be bundled. A missing row
// fails the package step — a licence question found here is a task, not a shipping delay.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const noticesPath = resolve(here, "../../../THIRD-PARTY-NOTICES.md");
const buildResources = resolve(here, "../build-resources");

// build-resources subdirectory → the notice row that must exist for it.
const REQUIRED_ROW = {
  opencode: "OpenCode",
  voxa: "Voxa",
  ffmpeg: "ffmpeg",
  "espeak-ng": "espeak-ng",
};

const notices = readFileSync(noticesPath, "utf8");
const failures = [];

// Components always in the bundle regardless of build-resources.
for (const always of ["better-sqlite3", "Electron", "SQLite", "Geist"]) {
  if (!notices.includes(always)) failures.push(`"${always}" ships in every build but has no notice row`);
}

if (existsSync(buildResources)) {
  for (const entry of readdirSync(buildResources, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const required = REQUIRED_ROW[entry.name];
    if (required === undefined) {
      failures.push(`build-resources/${entry.name} is staged for bundling but is not a known component — record it before shipping it`);
      continue;
    }
    if (!notices.includes(required)) {
      failures.push(`build-resources/${entry.name} is staged but "${required}" has no row in THIRD-PARTY-NOTICES.md`);
    }
    // GPL components must carry the never-linked arrangement in their recorded obligations (R-10).
    if (entry.name === "espeak-ng" && !/espeak-ng[^|]*\|[^|]*GPL[^|]*\|[^|]*[Nn]ever linked/s.test(notices)) {
      failures.push("espeak-ng is staged but its notice row does not record the never-linked arrangement (R-10)");
    }
  }
}

if (failures.length > 0) {
  console.error("licence gate FAILED (SPEC-016 R-9):");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("licence gate: every bundled component has recorded obligations");
