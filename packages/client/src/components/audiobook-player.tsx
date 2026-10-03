import { useEffect, useRef, useState } from "react";
import {
  mountAudiobookPlayer,
  type AudiobookListening,
  type AudiobookPlayerChapter,
  type AudiobookPlayerHandle,
  type ProductionBundle,
} from "@arke-studio/contracts";
import { mediaUrl } from "../lib/media.js";
import { openAudiobookListening, subscribeAudiobookListening, useAudiobookRecords, useAudiobookRuns, useStore } from "../lib/store.js";
import { Button } from "./ui.js";

/**
 * The audiobook player in the app (design turn 186, SPEC-047 R-57): the same module the exported
 * package inlines, mounted over the window and left to run. React owns the element, the plan it
 * is fed and its lifetime; the player owns everything inside it, so the book an author listens to
 * here is the book a listener opens from the package.
 *
 * The plan is the coordinator's answer to `open-audiobook-listening`, asked again whenever a take
 * lands or a picture moves while the player is open, and pushed into the running player — which
 * keeps the listener's place by its block, so a chapter being read under it fills in around them.
 */

/** Where a book's listener's place is kept on this device, in the app. */
export const audiobookPlaceKey = (worldId: string, productionId: string): string => `arke-ab-${worldId}-${productionId}`;

/** The plan as the player reads it: each file a URL the app serves, each chapter its takes in order. */
export function playerChapters(listening: AudiobookListening, src: (file: string) => string): AudiobookPlayerChapter[] {
  return listening.chapters.map((chapter) => ({
    id: chapter.chapterId,
    order: chapter.order,
    title: chapter.title,
    state: chapter.state,
    seconds: chapter.seconds,
    blocks: chapter.blocks.map((block) => ({ key: block.key, at: block.at, seconds: block.seconds, src: src(block.file), sentences: block.sentences })),
    gaps: chapter.gaps,
    pictures: chapter.pictures.map((picture) => ({ at: picture.at, src: src(picture.file) })),
    opening: chapter.opening === null ? null : src(chapter.opening),
  }));
}

/** Whether anything of the book is made yet: Listen waits for one block anywhere (R-58). */
export function bookHasTakes(production: Pick<ProductionBundle, "chapters"> | null): boolean {
  return (production?.chapters ?? []).some((chapter) => !chapter.retired && chapter.audiobook !== undefined && "takes" in chapter.audiobook && chapter.audiobook.takes > 0);
}

/** What moves the plan while the player is open: each chapter's record and the runs reading it. */
function usePlanStamp(worldId: string, productionId: string, production: ProductionBundle | null): string {
  const records = useAudiobookRecords();
  const runs = useAudiobookRuns();
  const prefix = `${worldId}/${productionId}/`;
  return JSON.stringify([
    (production?.chapters ?? []).map((chapter) => [chapter.id, chapter.version, chapter.bodyHash ?? "", chapter.audiobook ?? null]),
    Object.entries(records).filter(([key]) => key.startsWith(prefix)).map(([key, held]) => [key, held.seq]),
    Object.entries(runs).filter(([key]) => key.startsWith(prefix)).map(([key, run]) => [key, run.state, run.made]),
  ]);
}

export function AudiobookPlayerView({ worldId, production, chapterId, onClose }: {
  worldId: string;
  production: ProductionBundle;
  /** Listen on a chapter: start there. */
  chapterId?: string;
  onClose: () => void;
}) {
  const productionId = production.meta.id;
  const slug = useStore().state?.world?.meta.slug ?? null;
  const connection = useStore().connection;
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<AudiobookPlayerHandle | null>(null);
  const asked = useRef<string | null>(null);
  const [plan, setPlan] = useState<AudiobookListening | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const closing = useRef(onClose);
  closing.current = onClose;
  const stamp = usePlanStamp(worldId, productionId, production);

  useEffect(
    () =>
      subscribeAudiobookListening((answer) => {
        if (answer.requestId !== asked.current) return;
        if (answer.listening === null) setRefused(answer.refused ?? "could not open the book");
        else setPlan(answer.listening);
      }),
    [],
  );
  // Asked at once, and again — a breath after the book moves — while the player is open.
  const first = useRef(true);
  useEffect(() => {
    if (connection !== "open") return;
    if (first.current) {
      first.current = false;
      asked.current = openAudiobookListening(worldId, productionId);
      return;
    }
    const timer = setTimeout(() => {
      asked.current = openAudiobookListening(worldId, productionId);
    }, 1200);
    return () => clearTimeout(timer);
  }, [worldId, productionId, connection, stamp]);

  // A modal from the moment it opens: focus returns to what opened it, and Tab and Shift+Tab stay
  // inside while it is up — past the player's last control is the screen behind it.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const opener = element.ownerDocument.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const shown = (el: HTMLElement) => el.closest("[hidden]") === null && (typeof el.checkVisibility !== "function" || el.checkVisibility());
      const focusable = [element, ...[...element.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter(shown)];
      const firstEl = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const at = element.ownerDocument.activeElement;
      if (event.shiftKey && (at === firstEl || !element.contains(at))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (at === last || !element.contains(at))) {
        event.preventDefault();
        firstEl.focus();
      }
    };
    element.addEventListener("keydown", trap);
    return () => {
      element.removeEventListener("keydown", trap);
      handle.current?.destroy();
      handle.current = null;
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
    };
  }, []);

  // The player is mounted on the first plan; every later plan is pushed into it.
  const ready = plan !== null && slug !== null;
  useEffect(() => {
    const element = host.current;
    if (!element || plan === null || slug === null) return;
    const src = (file: string) => mediaUrl(slug, file);
    const chapters = playerChapters(plan, src);
    if (handle.current !== null) {
      handle.current.update(chapters);
      return;
    }
    handle.current = mountAudiobookPlayer(element, {
      title: plan.title,
      cover: plan.cover === null ? null : src(plan.cover),
      chapters,
      storageKey: audiobookPlaceKey(worldId, productionId),
      ...(chapterId !== undefined ? { chapterId } : {}),
      // Listen on a chapter plays it; Listen on the book opens on Continue when a place is kept.
      autoplay: true,
      continueFirst: chapterId === undefined,
      onClose: () => closing.current(),
    });
    element.focus();
    // The options are read once, at the mount; the plan is the one thing pushed in after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, slug]);

  return (
    <div className="fy-abplayer" data-testid="audiobook-player" style={{ position: "fixed", inset: 0, zIndex: 60 }}>
      <div ref={host} role="dialog" aria-modal="true" aria-label="Audiobook" style={{ position: "absolute", inset: 0 }} />
      {!ready && (
        <div className="fy-abplayer__wait" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 12, background: "var(--media-overlay-bg)", color: "var(--media-overlay-fg)" }}>
          <span className="fy-mono">{refused ?? "opening…"}</span>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </div>
  );
}

/** `Listen` (design turn 186, R-57): on the audiobook door and on a chapter, the book as a listener hears it. */
export function ListenButton({ worldId, production, chapterId, className }: { worldId: string; production: ProductionBundle; chapterId?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const connection = useStore().connection;
  return (
    <>
      <Button variant="ghost" className={className} disabled={!bookHasTakes(production) || connection !== "open"} onClick={() => setOpen(true)} data-testid="audiobook-listen">
        Listen
      </Button>
      {open && <AudiobookPlayerView worldId={worldId} production={production} {...(chapterId !== undefined ? { chapterId } : {})} onClose={() => setOpen(false)} />}
    </>
  );
}
