import { useEffect, useRef, useState } from "react";
import {
  mountAudiobookPlayer,
  type AudiobookListening,
  type AudiobookPlayerChapter,
  type AudiobookPlayerHandle,
  type ProductionBundle,
} from "@arke-studio/contracts";
import { clearQueue, dismissPlayback } from "../lib/audio.js";
import { claimRead, releaseRead } from "../lib/reply-reads.js";
import { mediaUrl } from "../lib/media.js";
import { openAudiobookListening, subscribeAudiobookListening, useAudiobookRecords, useAudiobookRuns, useStore } from "../lib/store.js";
import { BodyLayer } from "./body-layer.js";
import { Play, PlaySolid } from "./icons.js";
import { Button } from "./ui.js";
import { audiobookPlaceKey } from "../lib/audiobook-place.js";

/**
 * The audiobook player in the app (design turn 186, SPEC-047 R-66): the same module the exported
 * package inlines, mounted over the window and left to run. React owns the element, the plan it
 * is fed and its lifetime; the player owns everything inside it, so the book an author listens to
 * here is the book a listener opens from the package.
 *
 * The plan is the coordinator's answer to `open-audiobook-listening`, asked again whenever a take
 * lands or a picture moves while the player is open, and pushed into the running player — which
 * keeps the listener's place by its block, so a chapter being read under it fills in around them.
 */

/** The book's claim on the app's one read (design turn 183's rule). */
const READ_KEY = "audiobook-player";

/** The plan as the player reads it: each file a URL the app serves, each chapter its takes in order. */
export function playerChapters(listening: AudiobookListening, src: (file: string) => string): AudiobookPlayerChapter[] {
  return listening.chapters.map((chapter) => ({
    id: chapter.chapterId,
    order: chapter.order,
    title: chapter.title,
    state: chapter.state,
    seconds: chapter.seconds,
    // A chapter with timing plays its one mix (design turn 187, R-85): overlaps and beds as set.
    ...(chapter.mix !== undefined ? { audio: [{ src: src(chapter.mix.file), at: 0, seconds: chapter.mix.seconds }] } : {}),
    blocks: chapter.blocks.map((block) => ({ key: block.key, at: block.at, seconds: block.seconds, src: src(block.file), sentences: block.sentences })),
    gaps: chapter.gaps,
    pictures: chapter.pictures.map((picture) => ({ at: picture.at, src: src(picture.file), ...(picture.motion !== undefined ? { motion: { src: src(picture.motion.file), seconds: picture.motion.seconds, behavior: picture.motion.behavior } } : {}), ...(picture.motionProblem !== undefined ? { motionProblem: picture.motionProblem } : {}) })),
    opening: chapter.opening === null ? null : src(chapter.opening),
  }));
}

/** Whether anything of the book is made yet: Listen waits for one block anywhere (R-67). */
export function bookHasTakes(production: Pick<ProductionBundle, "chapters"> | null): boolean {
  return (production?.chapters ?? []).some((chapter) => !chapter.retired && chapter.audiobook !== undefined && "takes" in chapter.audiobook && chapter.audiobook.takes > 0);
}

/**
 * Whether Listen leads the head it sits in (owner, 2026-10-03: the player went unfound as a ghost
 * beside Export). On the door, once a block anywhere is made; on a chapter, once a block of that
 * chapter is — before then the chapter's own read is the work, and Listen stands back.
 */
export function listenLeads(production: Pick<ProductionBundle, "chapters"> | null, chapterId?: string): boolean {
  if (chapterId === undefined) return bookHasTakes(production);
  const chapter = production?.chapters.find((candidate) => candidate.id === chapterId);
  return chapter !== undefined && !chapter.retired && chapter.audiobook !== undefined && "takes" in chapter.audiobook && chapter.audiobook.takes > 0;
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
  const shell = useRef<HTMLDivElement>(null);
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

  /** The book takes the app's one read: the previous owner stopped, the dock's clip let go. */
  const claimBook = () => {
    claimRead(READ_KEY, () => handle.current?.pause());
    clearQueue();
    dismissPlayback();
  };

  // A modal from the moment it opens, before its plan is answered (codex on PR 1493): focus moves
  // in at once and returns to what opened it, Tab and Shift+Tab stay inside while it is up, and
  // Esc closes it while it waits — past the player's last control is the screen behind it.
  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    // One voice at a time: a chapter read or a clip in the dock stops as the book opens (codex on PR 1493).
    // A read still being made would queue its first piece over the book when it lands, so the book
    // claims the one read the app has, which stops the read's owner outright (codex on PR 1495),
    // and a read started while the book plays pauses the book.
    claimBook();
    const opener = element.ownerDocument.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape" && handle.current === null) {
        event.preventDefault();
        closing.current();
        return;
      }
      if (event.key !== "Tab") return;
      const shown = (el: HTMLElement) => el.closest("[hidden]") === null && (typeof el.checkVisibility !== "function" || el.checkVisibility());
      // The boundary is the first and last control Tab actually reaches: the shell itself is out of
      // the sequence (tabIndex -1), so with it as the first, Shift+Tab left the modal (codex on PR 1495).
      const focusable = [...element.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter(shown);
      const at = element.ownerDocument.activeElement;
      if (focusable.length === 0) {
        event.preventDefault();
        element.focus();
        return;
      }
      const firstEl = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (at === firstEl || at === element || !element.contains(at))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (at === last || !element.contains(at))) {
        event.preventDefault();
        firstEl.focus();
      }
    };
    element.addEventListener("keydown", trap);
    element.focus();
    return () => {
      element.removeEventListener("keydown", trap);
      releaseRead(READ_KEY);
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
      // Every play or resume — a press, a key, the lock screen — takes the voice back from a read
      // that took it meanwhile (codex on PR 1499).
      onPlay: () => claimBook(),
    });
    element.focus();
    // The options are read once, at the mount; the plan is the one thing pushed in after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, slug]);

  // Drawn on the body: the door's title row enters with fy-fade-up, and that transformed ancestor
  // turned this fixed, full-window player into a transparent box over the row.
  return (
    <BodyLayer>
      <div ref={shell} className="fy-abplayer" data-testid="audiobook-player" role="dialog" aria-modal="true" aria-label="Audiobook" tabIndex={-1} style={{ position: "fixed", inset: 0, zIndex: 60 }}>
        <div ref={host} style={{ position: "absolute", inset: 0 }} />
        {!ready && (
          <div className="fy-abplayer__wait" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 12, background: "var(--media-overlay-bg)", color: "var(--media-overlay-fg)" }}>
            <span className="fy-mono">{refused ?? "opening…"}</span>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        )}
      </div>
    </BodyLayer>
  );
}

/**
 * `Listen` (design turn 186, R-66): on the audiobook door and on a chapter, the book as a listener
 * hears it — the head's one primary, with a play icon, once there is something to hear there.
 */
export function ListenButton({ worldId, production, chapterId, className, solid = false }: { worldId: string; production: ProductionBundle; chapterId?: string; className?: string; /** The filled transport mark the chapter's Audiobook toolbar draws (design turn 194). */ solid?: boolean }) {
  const [open, setOpen] = useState(false);
  const connection = useStore().connection;
  return (
    <>
      <Button variant={listenLeads(production, chapterId) ? "primary" : "ghost"} className={className} disabled={!bookHasTakes(production) || connection !== "open"} onClick={() => setOpen(true)} data-testid="audiobook-listen">
        {solid ? <PlaySolid size={13} /> : <Play size={14} />}
        Listen
      </Button>
      {open && <AudiobookPlayerView worldId={worldId} production={production} {...(chapterId !== undefined ? { chapterId } : {})} onClose={() => setOpen(false)} />}
    </>
  );
}
