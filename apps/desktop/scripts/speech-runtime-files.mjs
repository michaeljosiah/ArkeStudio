import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// The x64 service never uses foreign-architecture package-manager launchers.
// NSIS installation omitted these four files; exclude them before manifesting.
const foreignLaunchers = [
  "pip/_vendor/distlib/t64-arm.exe", "pip/_vendor/distlib/w64-arm.exe",
  "setuptools/cli-arm64.exe", "setuptools/gui-arm64.exe",
];

export function pruneUnsupportedSpeechFiles(python) {
  for (const relative of foreignLaunchers) rmSync(join(python, "Lib/site-packages", relative), { force: true });
}

export function assertSupportedSpeechFiles(python) {
  for (const relative of foreignLaunchers)
    if (existsSync(join(python, "Lib/site-packages", relative))) throw new Error(`Unsupported speech bootstrap launcher: ${relative}`);
}
