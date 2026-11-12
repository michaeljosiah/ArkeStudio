import { join } from "node:path";
import type { ClientState, WorldSummary } from "@arke-studio/contracts";
import { describeCoordinatorError } from "../errors/user-message.js";
import { checkWorldImport } from "../world/import-world.js";
import { cleanupStoryDownload, discardStoryDownload, downloadStory, type StoryDownload } from "../world/story-download.js";
import type { WorldProvider } from "../world-provider.js";
import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

/**
 * The story download and the world import in flight, at most one of each: the flag is what stops a
 * second click starting a second copy while the first is still being written. The coordinator holds
 * one, for its stop.
 */
export class WorldInstalls {
  sample: AbortController | null = null;
  import: AbortController | null = null;
  stopAll(): void {
    this.sample?.abort();
    this.import?.abort();
  }
}

/** The world library: a story downloaded and installed, its download refreshed, cancelled or discarded, a world imported. No world. */
export function worldLibraryCommands(ctx: CommandContext, deps: {
  installs: WorldInstalls;
  provider: WorldProvider;
  appRoot: () => string | undefined;
  sampleWorldPath: () => string | null | undefined;
  sampleWorldDownload: () => StoryDownload | undefined;
  chooseWorldFolder: () => (() => Promise<string | null>) | undefined;
  sampleWorld: () => ClientState["app"]["sampleWorld"];
  setSampleWorld(patch: Partial<ClientState["app"]["sampleWorld"]>): void;
  setWorlds(worlds: WorldSummary[]): void;
  broadcastSnapshot(): void;
  refreshStoryDownload(): Promise<void>;
  backgroundWork: Set<Promise<unknown>>;
}) {
  const { installs } = deps;
  return {
    "refresh-sample-world-download": {
      scope: "none",
      async handle() {
        await deps.refreshStoryDownload();
        if (!ctx.stopping()) deps.broadcastSnapshot();
      },
    },
    "cancel-sample-world-download": {
      scope: "none",
      handle() {
        if (deps.sampleWorld().cancellable && installs.sample) {
          deps.setSampleWorld({ cancellable: false, note: { text: "Stopping download…", refused: false } });
          installs.sample.abort(new Error("Story download cancelled. Retained data can be resumed or removed."));
          deps.broadcastSnapshot();
        }
      },
    },
    "discard-sample-world-download": {
      scope: "none",
      async handle() {
        const release = deps.sampleWorldDownload(), appRoot = deps.appRoot();
        if (ctx.stopping() || installs.sample || !release || !appRoot) return;
        installs.sample = new AbortController();
        deps.setSampleWorld({ installing: true, cancellable: false, note: { text: "Removing downloaded data…", refused: false } });
        deps.broadcastSnapshot();
        try {
          await discardStoryDownload(release, join(appRoot, "downloads"));
          deps.setSampleWorld({ note: { text: "Downloaded data removed. Installed worlds are unchanged.", refused: false } });
        } catch (error) { deps.setSampleWorld({ note: { text: describeCoordinatorError(error), refused: true } }); }
        finally {
          installs.sample = null;
          deps.setSampleWorld({ installing: false });
          await deps.refreshStoryDownload();
          if (!ctx.stopping()) deps.broadcastSnapshot();
        }
      },
    },
    "import-world": {
      scope: "none",
      async handle(msg) {
        const answer = (result: { worldId?: string; reason?: string; cancelled?: boolean }) => {
          if (!ctx.stopping()) ctx.emit({ at: ctx.nowIso(), type: "world.import-result", requestId: msg.requestId, ...result });
        };
        const chooseWorldFolder = deps.chooseWorldFolder(), installSampleWorld = deps.provider.installSampleWorld, appRoot = deps.appRoot();
        if (!chooseWorldFolder || !installSampleWorld || !appRoot) { answer({ reason: "Import a world from the desktop app on your computer." }); return; }
        if (installs.import || ctx.stopping()) { answer({ reason: "A world import is already in progress." }); return; }
        const control = new AbortController(); installs.import = control;
        const work = (async () => {
          try {
            const source = await chooseWorldFolder();
            if (source === null) { answer({ cancelled: true }); return; }
            const checked = await checkWorldImport(source, appRoot, control.signal);
            const result = await installSampleWorld.call(deps.provider, checked, control.signal);
            if (ctx.stopping()) return;
            deps.setWorlds(await deps.provider.listWorlds());
            deps.broadcastSnapshot();
            answer({ worldId: result.worldId });
          } catch (error) { answer({ reason: describeCoordinatorError(error) }); }
          finally { installs.import = null; }
        })();
        deps.backgroundWork.add(work);
        try { await work; } finally { deps.backgroundWork.delete(work); }
      },
    },
    "install-sample-world": {
      scope: "none",
      async handle() {
        if (ctx.stopping() || installs.sample) return;
        const install = deps.provider.installSampleWorld?.bind(deps.provider);
        const source = deps.sampleWorldPath() ?? null;
        const release = deps.sampleWorldDownload();
        const appRoot = deps.appRoot();
        let outcomeNote = "The story download stopped.";
        let installed = false;
        const refuse = (reason: string) => {
          outcomeNote = reason;
          deps.setSampleWorld({ note: { text: reason, refused: true } });
          ctx.emit({ at: new Date().toISOString(), type: "sample-world.refused", reason });
        };
        if (!install || (source === null && (!release || !appRoot))) {
          refuse("this build has no story download configured");
          deps.broadcastSnapshot();
          return;
        }
        // Megabytes of art take a moment to copy. The flag is what stops a second click
        // starting a second copy while the first is still being written.
        const control = new AbortController();
        installs.sample = control;
        deps.setSampleWorld({ installing: true, cancellable: !!release && source === null, note: null });
        deps.broadcastSnapshot();
        let downloaded: Awaited<ReturnType<typeof downloadStory>> | undefined;
        try {
          if (release && source === null) downloaded = await downloadStory(release, join(appRoot!, "downloads"), {
            signal: control.signal,
            progress: text => {
              if (ctx.stopping()) return;
              deps.setSampleWorld({ note: { text, refused: false } });
              deps.broadcastSnapshot();
            },
          });
          control.signal.throwIfAborted();
          deps.setSampleWorld({ cancellable: false });
          deps.broadcastSnapshot();
          const { worldId, slug, name } = await install(downloaded?.directory ?? source!);
          installed = true;
          outcomeNote = `${name} is in your library.`;
          if (ctx.stopping()) return;
          deps.setWorlds(await deps.provider.listWorlds());
          deps.setSampleWorld({
            note: { text: outcomeNote, refused: false },
          });
          ctx.emit({ at: new Date().toISOString(), type: "sample-world.installed", worldId, slug, name });
        } catch (err) {
          if (!ctx.stopping()) {
            if (control.signal.aborted) {
              outcomeNote = "Download cancelled. Retained data can be resumed or removed.";
              deps.setSampleWorld({ note: { text: outcomeNote, refused: false } });
            } else refuse(describeCoordinatorError(err));
          }
        } finally {
          const cleaned = await cleanupStoryDownload(downloaded, { keepArchive: !installed });
          installs.sample = null;
          deps.setSampleWorld({ installing: false, cancellable: false });
          await deps.refreshStoryDownload();
          if (!cleaned && !ctx.stopping()) deps.setSampleWorld({
            note: { text: `${outcomeNote} Temporary download files could not be removed; check the downloads folder in your Arke app folder to reclaim space.`, refused: !installed },
          });
        }
        if (!ctx.stopping()) deps.broadcastSnapshot();
      },
    },
  } satisfies CommandModule;
}
