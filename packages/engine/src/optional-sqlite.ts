import { createRequire } from "node:module";

// This module is bundled only into ./local. Core hosts need no native SQLite installation.
const loadNative = createRequire(import.meta.url);
try {
  loadNative("better-sqlite3");
} catch (cause) {
  throw new Error("The @arke-studio/engine/local adapter requires better-sqlite3. Install it with npm install better-sqlite3, or use the root engine with your own adapters.", { cause });
}
