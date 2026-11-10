import type { ClientMessage, ComicMode, DomainEvent, ManifestModel } from "@arke-studio/contracts";
import { describeCoordinatorError } from "../errors/user-message.js";
import { ComicExportBlocked, exportComic } from "../productions/comic-export.js";
import { acceptComicTake, comicPageRecord, comicPageRequest, comicPanelsQuote, finishComicPage, saveComicScript, seeComicWarning, setComicLettering, setComicSettings } from "../productions/graphic-novel.js";
import type { WorldStore } from "../world/store.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/**
 * A graphic novel (SPEC-064): its script, pages, lettering, takes, settings and export. Open world
 * only. Saving a script answers a world that is not open with its own refusal, which the editor
 * waits on by its request, so that one checks the world itself; Stop ends a make wherever it runs.
 */
export function comicCommands(ctx: CommandContext, deps: {
  pictureModel(store: WorldStore, productionId: string): Promise<ManifestModel | null>;
  comicMode(store: WorldStore, productionId: string): ComicMode;
  reconcileComicPage(store: WorldStore, productionId: string, pageId: string): Promise<void>;
  makeComicPanels(store: WorldStore, msg: Extract<ClientMessage, { kind: "make-comic-page" }>): Promise<void>;
  makeAndCheckComicPage(store: WorldStore, msg: Extract<ClientMessage, { kind: "make-comic-page" }>): Promise<void>;
  placeComicLettering(store: WorldStore, msg: Extract<ClientMessage, { kind: "place-comic-lettering" }>): Promise<void>;
  reviewComicPanelTake(store: WorldStore, productionId: string, page: string, take: string): Promise<unknown>;
  readComicTake(store: WorldStore, productionId: string, page: string, take: string): Promise<unknown>;
  /** Exports in flight, stopped with the coordinator. */
  exporting: Set<AbortController>;
  /** Makes in flight by run. */
  makes: Map<string, AbortController>;
}) {
  const letter = async (msg: CommandOf<"set-comic-lettering" | "finish-comic-page">, store: WorldStore) => {
    const answer = (disposition: "saved" | "finished" | "refused", reason?: string) => ctx.emit({ at: new Date().toISOString(), type: "comic.page-lettered",
      requestId: msg.requestId, worldId: msg.worldId, productionId: msg.productionId, page: msg.page, disposition, ...(reason ? { reason } : {}) });
    try {
      if (msg.kind === "set-comic-lettering") {
        await setComicLettering(store, msg.productionId, msg.page, msg.placements, msg.undoesPlacing === true);
        answer("saved");
      } else {
        await finishComicPage(store, msg.productionId, msg.page, { hash: msg.hash, jpeg: Buffer.from(msg.jpegBase64, "base64"), requestId: msg.requestId }, ctx.nowIso());
        answer("finished");
      }
    } catch (err) {
      answer("refused", describeCoordinatorError(err));
    }
    await ctx.refreshWorldSnapshot(msg.worldId);
  };
  const decideTake = async (msg: CommandOf<"see-comic-warning" | "check-comic-take" | "accept-comic-take">, store: WorldStore) => {
    const answer = (disposition: "checked" | "accepted" | "seen" | "refused", reason?: string) => ctx.emit({ at: new Date().toISOString(), type: "comic.take-result",
      requestId: msg.requestId, worldId: msg.worldId, productionId: msg.productionId, page: msg.page, take: msg.take, disposition, ...(reason ? { reason } : {}) });
    try {
      if (msg.kind === "check-comic-take") {
        const production = store.getBundle().productions.find((candidate) => candidate.meta.id === msg.productionId);
        const record = production ? comicPageRecord(production, msg.page) : null;
        if (record?.panelTakes.some((take) => take.id === msg.take)) await deps.reviewComicPanelTake(store, msg.productionId, msg.page, msg.take);
        // A finished page is the panels and the script's words: nothing in it is read (R-37b).
        else if (record?.takes.find((take) => take.id === msg.take)?.mode === "overlay") throw new Error("a finished page has no check; check its panels");
        else await deps.readComicTake(store, msg.productionId, msg.page, msg.take);
        answer("checked");
      } else if (msg.kind === "see-comic-warning") {
        await seeComicWarning(store, msg.productionId, msg.page, msg.take, msg.warning);
        answer("seen");
      } else {
        await acceptComicTake(store, msg.productionId, msg.page, msg.take, msg.override, ctx.nowIso());
        answer("accepted");
      }
    } catch (err) {
      answer("refused", describeCoordinatorError(err));
    }
    await ctx.refreshWorldSnapshot(msg.worldId);
  };
  return {
    "save-comic-script": {
      scope: "any-world",
      async handle(msg) {
        // A graphic novel chapter's comic script (SPEC-064 R-10), answered by name either way so
        // the editor knows its new base.
        const store = ctx.openStore();
        const answer = (result: { disposition: "saved"; version: number; hash: string } | { disposition: "refused"; reason: string }) =>
          ctx.emit({ at: new Date().toISOString(), type: "comic-script.save-result", requestId: msg.requestId,
            worldId: msg.worldId, productionId: msg.productionId, chapter: msg.chapter, ...result });
        if (!store || store.worldId !== msg.worldId) {
          answer({ disposition: "refused", reason: "that world is not open" });
          return;
        }
        try {
          answer({ disposition: "saved", ...await saveComicScript(store, msg.productionId,
            { chapter: msg.chapter, pages: msg.pages, baseHash: msg.baseHash }, { requestId: msg.requestId }) });
        } catch (err) {
          answer({ disposition: "refused", reason: describeCoordinatorError(err) });
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "quote-comic-page": {
      scope: "open-world",
      async handle(msg, store) {
        // Opening a page asks its price; it also files what landed while the app was closed (R-25).
        const answer = (quote: Extract<DomainEvent, { type: "comic.page-quote" }>["quote"]) =>
          ctx.emit({ at: new Date().toISOString(), type: "comic.page-quote", requestId: msg.requestId, worldId: msg.worldId, productionId: msg.productionId, page: msg.page, quote });
        try {
          await deps.reconcileComicPage(store, msg.productionId, msg.page);
          const model = await deps.pictureModel(store, msg.productionId);
          if (!model) answer({ ok: false, reason: "no picture model is on" });
          else if ((msg.mode ?? deps.comicMode(store, msg.productionId)) === "overlay") {
            const quote = comicPanelsQuote(store, msg.productionId, msg.page, model, msg.panel);
            answer(!quote.ok ? quote : { ok: true, model: model.id, modelName: model.displayName, mode: "overlay", aspect: quote.aspect, microUsd: quote.microUsd, brief: quote.brief, riding: quote.riding, missing: quote.missing });
          } else {
            const request = comicPageRequest(store, msg.productionId, msg.page, model, msg.mode);
            const riding = request.ok ? request.who.filter((entry) => entry.carried && entry.reference !== null) : [];
            answer(!request.ok ? { ok: false, reason: request.reason } : {
              ok: true, model: model.id, modelName: model.displayName, mode: request.mode, aspect: request.aspect, microUsd: request.microUsd,
              brief: request.prompt(riding.map((entry, index) => ({ name: entry.name, kind: entry.kind, token: `ref${index + 1}` }))),
              riding: riding.map((entry) => entry.name), missing: request.missing,
            });
          }
        } catch (err) {
          answer({ ok: false, reason: describeCoordinatorError(err) });
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "make-comic-page": {
      scope: "open-world",
      async handle(msg, store) {
        if ((msg.mode ?? deps.comicMode(store, msg.productionId)) === "overlay") await deps.makeComicPanels(store, msg);
        else await deps.makeAndCheckComicPage(store, msg);
      },
    },
    "set-comic-lettering": { scope: "open-world", handle: letter },
    "finish-comic-page": { scope: "open-world", handle: letter },
    "place-comic-lettering": { scope: "open-world", async handle(msg, store) { await deps.placeComicLettering(store, msg); } },
    "export-comic": {
      scope: "open-world",
      async handle(msg, store) {
        const answer = (result: Extract<DomainEvent, { type: "comic.exported" }>["result"]) =>
          ctx.emit({ at: new Date().toISOString(), type: "comic.exported", requestId: msg.requestId, worldId: msg.worldId, productionId: msg.productionId, result });
        // Stopped by the world closing and by the app stopping, as a manuscript export is (codex on PR 2225).
        const control = new AbortController();
        const onClose = () => control.abort();
        store.closingSignal.addEventListener("abort", onClose, { once: true });
        deps.exporting.add(control);
        try {
          answer({ ok: true, files: await exportComic(store, msg.productionId, msg.formats, new Date(ctx.nowIso()), control.signal, msg.requestId) });
        } catch (err) {
          // Bounded as the event is: a book of many pages names its first holds, which is enough to act on.
          answer({ ok: false, reason: describeCoordinatorError(err), blockers: err instanceof ComicExportBlocked ? err.blockers.slice(0, 500) : [] });
        } finally {
          deps.exporting.delete(control);
          store.closingSignal.removeEventListener("abort", onClose);
        }
      },
    },
    "stop-comic-make": { scope: "any-world", handle(msg) { deps.makes.get(msg.run)?.abort(); } },
    "see-comic-warning": { scope: "open-world", handle: decideTake },
    "check-comic-take": { scope: "open-world", handle: decideTake },
    "accept-comic-take": { scope: "open-world", handle: decideTake },
    "set-comic-settings": {
      scope: "open-world",
      async handle(msg, store) {
        try {
          await setComicSettings(store, msg.productionId, msg.settings);
        } catch (err) {
          ctx.emit({ at: new Date().toISOString(), type: "command.failed", command: msg.kind, requestId: null, reason: describeCoordinatorError(err) });
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
  } satisfies CommandModule;
}
