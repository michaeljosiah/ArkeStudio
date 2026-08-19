import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Load the built main bundle far enough to prove it can start.
 *
 * The bundle is the only artifact nothing else exercises. tests, typecheck and `electron .` in dev
 * all run the TypeScript through tsx as ESM, where `import.meta.url` is a real value; the CJS
 * bundle is the one place it is not, and a bundled ESM dependency reading it at module scope takes
 * the whole main process down before the first window opens. That failure is invisible everywhere
 * upstream of here and looks, from the build log, like a completely successful build.
 *
 * "Far enough" is module scope: every top-level side effect of every bundled dependency runs, which
 * is where this class of failure lives. Electron is stubbed rather than launched — the app never
 * gets past `whenReady`, and this stays a sub-second check rather than a windowed one.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Defaults to the freshly built bundle; takes a path so the copy inside a built
// installer can be checked too (asar extract app.asar/main.cjs, then point this at it).
const bundle = process.argv[2] ? resolve(process.argv[2]) : join(root, "dist", "main.cjs");
const require = createRequire(import.meta.url);

const inert = new Proxy(function () {}, {
  // `then` must stay undefined or an accidental await on a stub would hang forever.
  get: (_t, key) => (key === "then" ? undefined : inert),
  apply: () => inert,
  construct: () => inert,
});

const electron = {
  app: {
    // Never resolves: module scope is all we want, so the app is left waiting on the runtime.
    whenReady: () => new Promise(() => {}),
    on: () => {}, once: () => {}, quit: () => {}, exit: () => {},
    getPath: () => join(root, "dist"), setPath: () => {}, getName: () => "Arke Studio",
    getVersion: () => "0.0.0-smoke", setAppUserModelId: () => {},
    requestSingleInstanceLock: () => true, disableHardwareAcceleration: () => {},
  },
  BrowserWindow: inert, ipcMain: inert, shell: inert, dialog: inert, session: inert,
  protocol: inert, nativeTheme: inert, Menu: inert, net: inert, safeStorage: inert,
  powerSaveBlocker: inert, systemPreferences: inert, screen: inert, clipboard: inert,
};

const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electron;
  if (request === "electron-updater") return { autoUpdater: inert };
  return load.call(this, request, ...rest);
};

try {
  require(bundle);
} catch (error) {
  console.error(`the built main bundle failed to load: ${bundle}\n`);
  console.error(error);
  if (error?.code === "ERR_INVALID_ARG_VALUE" && /createRequire/.test(error.stack ?? "")) {
    console.error(
      "\nThis is the `import.meta.url` shim: a bundled ESM dependency read it at module scope and " +
        "got undefined. See the banner/define in scripts/build.mjs.",
    );
  }
  process.exit(1);
}

console.log("[smoke] dist/main.cjs loads");
process.exit(0);
