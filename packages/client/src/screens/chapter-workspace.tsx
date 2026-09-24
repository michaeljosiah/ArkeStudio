import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Link, useParams, useNavigate, useSearchParams } from "react-router";
import {
  chapterParagraphs,
  countWords,
  paragraphSpans,
  passageOf,
  passageDiff,
  composePassage,
  type PassageSegment,
  targetWords,
  type ChangedSpan,
  type ChapterContinuity,
  type ChapterSummary,
  type ChapterVoices,
  type ChapterAudiobook,
  DEFAULT_NARRATOR,
  legacyVoiceModel,
  voicedBlocks,
  type ProductionBundle,
  type ProseReadSource,
  type StagedProposal,
  type WorldChatSubject,
  type WorldBundle,
  overviewMoved,
} from "@arke-studio/contracts";
import { ProductionConversation, StagedDecision, type DockAsk } from "../components/conversation.js";
import { RichMarkdownEditor } from "../components/editor/rich-markdown-editor.js";
import { updateRichModeGate, type RichModeGate } from "../components/editor/rich-mode.js";
import { Pin, RotateCcw } from "../components/icons.js";
import { PageReadControl, useProsePageRead, type PageReadBlock } from "../components/page-read.js";
import { EmptyState, Screen } from "../components/layout.js";
import { Button, cx } from "../components/ui.js";
import { continuityStamp } from "../lib/continuity.js";
import { passageAction, passageActions, type PassageAction } from "../lib/passage-actions.js";
import { useProduction } from "../lib/selectors.js";
import { EditableText, SceneTitle } from "./storyboard.js";
import { AudiobookBlocks, AudiobookSide, DirectionCard, useChapterAudiobook, type AudiobookIntent } from "./chapter-audiobook.js";
import { playClip } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import {
  openChapter,
  restoreChapter,
  saveChapter,
  subscribeChapterOpenResults,
  subscribeChapterSaveResults,
  type ChapterOpenResult,
  type ChapterSaveResult,
  useStore,
  editChapterPlan,
  deriveContinuity,
  stopContinuity,
  useDeriving,
  castVoices,
  requestVoiceCatalogue,
  stopVoices,
  useCasting,
  useAudiobookRuns,
  useAudiobookRecords,
  acceptProposal,
  onWorldChange,
  subscribeWorldChatSendResults,
  updateProposalPassage,
  useGateNotices,
  type GateNotice,
} from "../lib/store.js";

/**
 * The chapter, opened (design turn 126, issue 874): a manuscript you can read, type into and
 * hear, beside what it draws on and the thread that drafts it.
 *
 * The scene workspace's sibling, and drawn on its shell: the rail folded to marks, the
 * manuscript in the centre, Arke docked on the right. What is different is what the centre holds.
 * A chapter is prose with an order (SPEC-012 §2.1), so the centre is an editor at a reading
 * measure and nothing here mentions shots, takes or dispatch.
 *
 * Three things this screen holds by rule rather than by habit:
 *
 * - The body is fetched on open and never carried on the summary. `ChapterSummary` is body-free
 *   so the bundle is not the book; `open-chapter` answers with the body, its version and the hash
 *   of the bytes read, and the editor holds those three until the record moves.
 * - Typing saves in place after a pause, with no proposal and no version cut (SPEC-012 R-5).
 *   The save names the base it read, so a save over a file that moved is refused, not merged.
 * - Arke's drafts arrive as the staged card in the thread (issue 714). While one waits the
 *   editor locks and the draft stands in the prose's place; Accept and Discard live on the card.
 */

/** Long enough that a pause reads as a pause, short enough that nobody watches the word "Saving". */
const AUTOSAVE_MS = 1200;

/** What an empty chapter says. */
const PLACEHOLDER = "Start here. It saves as you go.";

type OpenedRecord = {
  body: string;
  version: number;
  hash: string;
  versions: number[];
  /** The continuity record beside the chapter (turn 129), read with it; "unreadable" when one is there but cannot be read. */
  continuity: ChapterContinuity | "unreadable" | null;
  /** The cast of lines beside the chapter (turn 130), the same way. */
  voices: ChapterVoices | "unreadable" | null;
  /** The audiobook record beside the chapter (turn 146, SPEC-047 R-1), the same way. */
  audiobook: ChapterAudiobook | "unreadable" | null;
  /** The takes that record names that are gone from the shelf, as the coordinator found them at open (codex on PR 1183). */
  audiobookMissing: readonly string[];
};

/**
 * A save that must follow one still in flight after the screen is gone (codex, PR 879): the
 * answer to the first names the base the second needs, so the second waits for it here, outside
 * any component. A refusal keeps the text for the next screen to recover.
 */
function flushAfter(
  pending: string,
  save: { worldId: string; prodId: string; file: string; value: string; baseHash: string; landedBody: string | null },
): void {
  // Parked first, sent later: the reply this waits for never comes if the transport drops, and
  // a reconnect brings a snapshot rather than the event. The next screen to open the chapter
  // takes the parked text up and settles it against what is on disk (codex, PR 879).
  const key = parkedKey(save.worldId, save.prodId, save.file);
  const waiting: ParkedDraft = { value: save.value, baseHash: save.baseHash, landedBody: save.landedBody };
  parkedDrafts.get(key)?.cancel?.();
  parkedDrafts.set(key, waiting);
  const unsubscribe = subscribeChapterSaveResults((result) => {
    if (result.requestId !== pending) return;
    unsubscribe();
    if (parkedDrafts.get(key) !== waiting) return;
    if (result.disposition !== "saved" || result.hash === undefined) {
      const held = parkedDrafts.get(key);
      if (held?.value === save.value) held.conflict = true;
      return;
    }
    const held = { value: save.value, baseHash: result.hash, landedBody: null };
    parkedDrafts.set(key, held);
    keepUntilSaved(key, held, saveChapter(save.worldId, save.prodId, save.file, save.value, result.hash));
  });
  waiting.cancel = unsubscribe;
}

/**
 * Drafts a screen could not save before it was gone: disconnected or still awaiting a result.
 * Kept here, outside any component,
 * by chapter file, and taken up by the next screen to open that chapter, which sends them against
 * the base they were written on if the record has not moved since — or against the text an
 * older save of the same screen carried, `landedBody`, if that is what is on disk — and says so
 * if the record has genuinely moved.
 */
type ParkedDraft = { value: string; baseHash: string; landedBody: string | null; conflict?: boolean; cancel?: () => void };
const parkedDrafts = new Map<string, ParkedDraft>();
const parkedKey = (worldId: string, prodId: string, file: string): string => `${worldId}/${prodId}/${file}`;

/**
 * Asks from the passage menu, by chapter, until the dock is done with them (codex on PR 1232).
 * Outside any component for the same reason as the drafts above: the screen is keyed by chapter
 * and goes when the author moves to another, and an ask waiting, sent or not taken is still
 * theirs when they come back.
 */
const heldAsks = new Map<string, DockAsk>();
// Only for the world's session they were pressed in (codex on PR 1232): closed and opened again,
// an ask still waiting would otherwise go by itself, quoting prose that may have moved since.
onWorldChange(() => heldAsks.clear());
// The answer to a held ask is kept with it (codex on PR 1232): the store remembers only recent
// answers, and a chapter left for long enough would come back to one it no longer has.
subscribeWorldChatSendResults((result) => {
  for (const [key, held] of heldAsks) {
    if (held.sent?.requestId === result.requestId) heldAsks.set(key, { ...held, answered: result.admitted });
  }
});
/** Test hook: asks outlive a screen by design, so each test starts with none. */
export function __clearHeldAsksForTest(): void {
  heldAsks.clear();
}

/** Sending is not saving: an answer can refuse after the editor has unmounted. */
function keepUntilSaved(key: string, held: ParkedDraft, requestId: string | null): void {
  if (requestId === null) return;
  const unsubscribe = subscribeChapterSaveResults((result) => {
    if (result.requestId !== requestId) return;
    unsubscribe();
    if (parkedDrafts.get(key) !== held) return;
    if (result.disposition === "saved") parkedDrafts.delete(key);
    else held.conflict = true;
  });
  held.cancel = unsubscribe;
}

/** The most paragraphs one page read carries — the frame's own cap, so a longer chapter reads its first thousand. */
const PAGE_READ_BLOCK_CAP = 1000;

/**
 * The dock's first prompt follows the plan (turn 127): a chapter with a synopsis and no prose is
 * drafted from the synopsis; a chapter with prose is continued. A pure decision, so it is one.
 */
export function firstPrompt(live: string, synopsis: string | undefined): string {
  return live.trim() === "" && synopsis !== undefined && synopsis.trim() !== "" ? "Draft from the synopsis" : "Draft the rest";
}

export function ChapterScreen() {
  const { worldId, prodId, chapterId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const chapter = production?.chapters.find((c) => c.id === chapterId || c.file === chapterId);
  // The bundle is here and does not hold it: a bookmark to a chapter since deleted, or a typo.
  // Said, with the way back, rather than left on "Opening…" for a body that will never come.
  if (world && production && !chapter) {
    return (
      <Screen id="chapter">
        <EmptyState
          title="No such chapter"
          action={
            <Button onClick={() => navigate(`/w/${encodeURIComponent(world.meta.worldId)}/p/${encodeURIComponent(production.meta.id)}/story/chapters`)}>
              Chapters
            </Button>
          }
        />
      </Screen>
    );
  }
  if (world && production && chapter) {
    return (
      <ChapterWorkspace
        key={`${world.meta.worldId}/${production.meta.id}/${chapter.id}`}
        world={world}
        production={production}
        chapter={chapter}
      />
    );
  }
  return (
    <Screen id="chapter">
      <EmptyState title="Opening chapter…" />
    </Screen>
  );
}

/** Where the chapter's file lives, world-relative — the path a staged draft names as its target. */
function chapterPath(production: ProductionBundle, chapter: ChapterSummary): string {
  return `productions/${production.meta.id}/chapters/${chapter.file}.md`;
}

/**
 * The draft waiting on this chapter, if one is (the scene workspace's rule for a staged scene).
 *
 * Newest first, because two drafts can target one file and the one the thread is showing is the
 * later one. The review projection carries the prose (`chapter-review.test.ts`), which is what
 * lets the page draw the draft without a second read path.
 */
export function stagedChapterDraft(
  proposals: readonly StagedProposal[],
  path: string,
): { staged: StagedProposal; body: string | null; before: string | null } | undefined {
  const staged = [...proposals]
    .filter((entry) => entry.proposal.kind === "chapter-draft" && entry.proposal.targets.some((t) => t.path === path))
    .sort((left, right) =>
      left.proposal.created.localeCompare(right.proposal.created) || left.proposal.id.localeCompare(right.proposal.id),
    )
    .at(-1);
  if (!staged) return undefined;
  const prose = staged.review?.targets.find((t) => t.path === path)?.fields.find((f) => f.field === "Prose");
  // Both sides, so the passage a revision changed is drawn from the two rather than carried twice
  // (turn 128).
  return { staged, body: prose?.proposed ?? null, before: prose?.before ?? null };
}

/** The most a selection may hold to be asked about (turn 128). */
const PASSAGE_MAX = 1_200;

/**
 * The selection as a subject, or null when it is not one (turn 128): three words or more, at
 * most 1,200 characters, and inside one paragraph — that is where the coordinator will look for
 * it, so a selection across a blank line could never be found. Under, over or across, nothing is
 * offered, and the reason is not on the screen.
 */
export function passageSubject(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "" || countWords(trimmed) < 3 || trimmed.length > PASSAGE_MAX) return null;
  if (/\r?\n[ \t]*\r?\n/.test(trimmed)) return null;
  return trimmed;
}

/**
 * The paragraph a selection starts in, counted from one by blank lines as the coordinator counts
 * them (turn 128), or null when the text has no such paragraph. What anchors the ask: the
 * coordinator looks for the passage there and only there.
 */
export function paragraphAt(text: string, offset: number): number | null {
  const index = paragraphSpans(text).findIndex((span) => offset >= span.start && offset <= span.end);
  return index < 0 ? null : index + 1;
}

const TIGHTEN = passageAction("tighten")!;
const NONE_REFUSED: ReadonlySet<number> = new Set();
const HOLD_TO_STYLE = passageAction("style")!;
/** The menu's groups, ruled apart: what rewrites the passage, what only answers, and the rest. */
const groupOf = (action: PassageAction) => (action.replyOnly ? "reply" : action.id === "other" ? "other" : "rewrite");

/**
 * The press beside a selection (turn 128), opened into what can be asked of it. Mouse-down is
 * swallowed on the press and on every item, so a click does not collapse the selection it is
 * about before it lands; the menu is keyed by the selection, so a new one starts it closed.
 */
function PassageMenu({
  words,
  top,
  left,
  end,
  actions,
  onAsk,
  held,
}: {
  words: number;
  top: number;
  left: number;
  /** Near the manuscript's right edge: the menu opens leftward. */
  end: boolean;
  /** Why nothing can be asked yet — the selected words are not saved — said on the press. */
  held?: string;
  actions: readonly PassageAction[];
  onAsk: (action: PassageAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const move = (from: number, by: number) => items.current[(from + by + actions.length) % actions.length]?.focus();
  /*
   * Opened from the keyboard, the caret goes into the menu (codex on PR 1232), or its arrow keys
   * could not be reached. Opened with the mouse it stays in the manuscript, whose selection the
   * menu is about.
   */
  const [enter, setEnter] = useState(false);
  useEffect(() => {
    if (!open || !enter) return;
    items.current[0]?.focus();
    setEnter(false);
  }, [open, enter]);
  return (
    <div
      className="fy-ch__ask-wrap"
      style={{ top, left }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          // Back to the press, so the keyboard keeps its place (codex on PR 1232).
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="fy-ch__ask"
        aria-haspopup="menu"
        aria-expanded={open && held === undefined}
        disabled={held !== undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          // A click with no pointer behind it (detail 0) is Enter or Space.
          if (!open && e.detail === 0) setEnter(true);
          setOpen((was) => !was);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setEnter(true);
            setOpen(true);
          }
        }}
      >
        Ask Arke · {held ?? `${words.toLocaleString()} words`}
      </button>
      {open && held === undefined && (
        <div className={cx("fy-ch__ask-menu", end && "fy-ch__ask-menu--end")} role="menu" aria-label="Ask about this passage">
          {actions.map((action, i) => (
            <button
              key={action.id}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitem"
              className={cx("fy-ch__ask-item", i > 0 && groupOf(actions[i - 1]!) !== groupOf(action) && "fy-ch__ask-item--rule")}
              onMouseDown={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  move(i, 1);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  move(i, -1);
                }
              }}
              onClick={() => {
                setOpen(false);
                onAsk(action);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The widest the menu of asks draws, its border and padding included (fidelity.css). */
const ASK_MENU_WIDTH = 200;

/**
 * Where the press beside a selection goes: at the end of the selected words, in the manuscript's
 * own coordinates. Off screen (no DOM selection to measure, as under test) it sits at the top.
 */
function askAt(host: HTMLElement | null): { top: number; left: number; end: boolean } {
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  if (!host || !selection || selection.rangeCount === 0) return { top: 0, left: 0, end: false };
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const frame = host.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return { top: 0, left: 0, end: false };
  const at = rect.right - frame.left + 8;
  return {
    top: Math.max(0, rect.bottom - frame.top - 22),
    left: Math.max(0, Math.min(at, frame.width - 150)),
    // The menu is wider than the press (codex on PR 1232): near the right edge it opens leftward
    // from the press's end rather than over the dock.
    end: at > frame.width - ASK_MENU_WIDTH,
  };
}

export function ChapterWorkspace({
  world,
  production,
  chapter,
}: {
  world: WorldBundle;
  production: ProductionBundle;
  chapter: ChapterSummary;
}) {
  const worldId = world.meta.worldId;
  const prodId = production.meta.id;
  const path = chapterPath(production, chapter);
  const connection = useStore().connection;

  /*
   * What was read, and the request that read it.
   *
   * Re-asked when the summary's version or file hash moves, including same-version plan edits,
   * and after a refusal. An unchanged saved body lets local typing continue on the new base;
   * competing prose keeps the draft for an explicit choice. Our saves return their own hash.
   */
  const [record, setRecord] = useState<OpenedRecord | null>(null);
  /**
   * The continuity record a derivation finished with (turn 129), held rather than read back off
   * the store each render: a rerun that fails replaces the store's last word, and the last
   * record must still stand. A fresh open replaces it (codex on PR 907): what the disk holds now
   * is the record, whether that is a newer one, none, or one that cannot be read.
   */
  const [finishedRecord, setFinishedRecord] = useState<ChapterContinuity | null>(null);
  /** The cast a run finished with (turn 130), held for the same reason; a fresh open replaces it. */
  const [finishedCast, setFinishedCast] = useState<ChapterVoices | null>(null);
  /** The audiobook record a run finished with (turn 146), the same way. */
  const [finishedAudiobook, setFinishedAudiobook] = useState<ChapterAudiobook | null>(null);
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const [reopen, setReopen] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveRefusal, setSaveRefusal] = useState<string | null>(null);
  const [readNow, setReadNow] = useState(false);
  const [voicedNow, setVoicedNow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The save in flight, by requestId; a newer draft waits in `queuedDraft` until it answers. */
  const pendingSave = useRef<string | null>(null);
  const queuedDraft = useRef<string | null>(null);
  /**
   * A draft the transport could not carry, and the base it was written against; sent on the next
   * open against the record just read. Begins as whatever the last screen on this chapter parked.
   */
  const parked = parkedDrafts.get(parkedKey(worldId, prodId, chapter.file));
  const [draftConflict, setDraftConflict] = useState(parked?.conflict ?? false);
  const conflictRef = useRef(draftConflict);
  conflictRef.current = draftConflict;
  const unsentDraft = useRef<string | null>(parked?.value ?? null);
  const unsentBase = useRef<string | null>(parked?.baseHash ?? null);
  /** The text an older save of the screen that parked this carried; on disk, it is not a move. */
  const unsentLanded = useRef<string | null>(parked?.landedBody ?? null);
  /** The text the pending save carried, so the answer can become the record without a re-read. */
  const savedText = useRef<string | null>(null);
  /** A read asked for while a save was pending; begun once the save lands (turn 126's fourth rule). */
  const readAfterSave = useRef(false);
  /** A derivation asked for while a save was pending; sent once the save lands (turn 129, SPEC-012 R-41). */
  const deriveAfterSave = useRef(false);
  /** A cast asked for while a save was pending, the same way (turn 130). */
  const castAfterSave = useRef(false);
  /** A voiced read asked for while a save was pending (turn 130): begun once the save lands. */
  const voicedAfterSave = useRef(false);
  /** An audiobook read, or a direction, asked for while a save was pending (turn 146): sent once the save lands, so the takes are of the words on disk. */
  const audiobookAfterSave = useRef<AudiobookIntent | null>(null);
  /** The hook's own sender for that intent, held for the save handler, which outlives the render that made it. */
  const audiobookResume = useRef<(intent: AudiobookIntent) => void>(() => {});
  /*
   * The latest record and draft, for callbacks that outlive the render that made them: the
   * autosave timer, the save answer and the unmount flush all need the base hash as it is now,
   * not as it was when they were created — a queued callback holding an older hash is a save
   * refused for a base this editor itself moved (codex, PR 879).
   */
  const recordRef = useRef<OpenedRecord | null>(null);
  recordRef.current = record;
  const draftRef = useRef<string | null>(null);
  draftRef.current = draft;
  /*
   * Which editor's words count. Adopting a record from disk replaces the editor's document, and
   * the editor being replaced can flush its last serialisation on the way out; a change carrying
   * an older epoch is that flush, and is dropped rather than written over the adopted text.
   */
  const epoch = useRef(0);

  useEffect(() => {
    // Nothing leaves the client while the transport is down; the connection coming back is a
    // dependency so a chapter opened during an outage does not sit on "Opening…" for good.
    parkedDrafts.get(parkedKey(worldId, prodId, chapter.file))?.cancel?.();
    if (connection !== "open") return;
    // Taken up above, at mount; the next screen must not take it up again after this one sends it.
    parkedDrafts.delete(parkedKey(worldId, prodId, chapter.file));
    const requestId = openChapter(worldId, prodId, chapter.id);
    if (requestId === null) return;
    return subscribeChapterOpenResults((result: ChapterOpenResult) => {
      if (result.requestId !== requestId) return;
      // The save result owns the next base while a write is in flight. A refusal asks again.
      if (pendingSave.current !== null) return;
      if (result.disposition === "opened" && result.body !== undefined && result.version !== undefined && result.hash !== undefined) {
        const opened: OpenedRecord = {
          body: result.body,
          version: result.version,
          hash: result.hash,
          versions: result.versions ?? [],
          continuity: result.continuityUnreadable === true ? "unreadable" : (result.continuity ?? null),
          voices: result.voicesUnreadable === true ? "unreadable" : (result.voices ?? null),
          audiobook: result.audiobookUnreadable === true ? "unreadable" : (result.audiobook ?? null),
          audiobookMissing: result.audiobookMissing ?? [],
        };
        const previous = recordRef.current;
        recordRef.current = opened;
        setRecord(opened);
        setFinishedRecord(null);
        setFinishedCast(null);
        setFinishedAudiobook(null);
        setOpenFailure(null);
        // A plan edit can change the file hash without changing its prose. Keep the local
        // words and adopt that base only when the saved prose is still the body we read.
        const unsent = unsentDraft.current ?? (draftRef.current !== previous?.body ? draftRef.current : null);
        const unsentAgainst = unsentBase.current ?? previous?.hash ?? null;
        const landed = unsentLanded.current;
        unsentDraft.current = null;
        unsentBase.current = null;
        unsentLanded.current = null;
        // Our own save landing just before the transport dropped is not a move: the body read is
        // the text that save carried, and the newer text goes out against its hash. The same for
        // the save a previous screen on this chapter had in flight when it parked the text.
        const ours =
          (savedText.current !== null && opened.body === savedText.current) ||
          (landed !== null && opened.body === landed);
        if (unsent !== null && !conflictRef.current &&
            (unsentAgainst === opened.hash || ours || (previous !== null && previous.body === opened.body))) {
          if (opened.body !== unsent) {
            draftRef.current = unsent;
            setDraft(unsent);
            setSaving(true);
            setSaveRefusal(null);
            flushSave(unsent);
            return;
          }
        } else if (unsent !== null) {
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = null;
          queuedDraft.current = null;
          draftRef.current = unsent;
          setDraft(unsent);
          conflictRef.current = true;
          setDraftConflict(true);
          setSaving(false);
          setSaveRefusal("the chapter changed · your draft is kept");
          return;
        }
        // Adopting cancels what the record being replaced still had going: a timer holding
        // pre-adoption text would fire, read the adopted hash, and write the old words over the
        // restored or accepted ones without cutting a version; a save in flight is answered for
        // a record this screen no longer shows (codex, PR 879).
        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        queuedDraft.current = null;
        pendingSave.current = null;
        epoch.current += 1;
        setSaving(false);
        // Someone else's edit is adopted, ours has already been saved: either way the text on
        // disk is the text (the Bible's three-writer rule).
        setDraft(null);
      } else {
        setOpenFailure(result.reason ?? "The chapter could not be opened.");
      }
    });
  }, [worldId, prodId, chapter.id, chapter.version, chapter.hash, reopen, connection]);

  const live = record?.body ?? "";
  const text = draft ?? live;

  const flushSave = useCallback(
    (value: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const current = recordRef.current;
      if (current === null) return;
      if (conflictRef.current) {
        setSaving(false);
        setSaveRefusal("the chapter changed · your draft is kept");
        return;
      }
      // One save at a time: a second sent before the first answers would name a base the first
      // is about to move, and be refused for it. The newer text waits for the answer instead.
      if (pendingSave.current !== null) {
        queuedDraft.current = value;
        return;
      }
      savedText.current = value;
      const requestId = saveChapter(worldId, prodId, chapter.file, value, current.hash);
      if (requestId === null) {
        // Nothing left the client. Said so, and kept for the reconnect, rather than reported
        // saved because the timer fired.
        unsentDraft.current = value;
        unsentBase.current = current.hash;
        setSaving(false);
        setSaveRefusal("offline · kept to send");
        return;
      }
      pendingSave.current = requestId;
    },
    [worldId, prodId, chapter.file],
  );

  useEffect(() => {
    return subscribeChapterSaveResults((result: ChapterSaveResult) => {
      if (result.requestId !== pendingSave.current) return;
      pendingSave.current = null;
      if (result.disposition === "saved" && result.version !== undefined && result.hash !== undefined) {
        const savedBody = savedText.current;
        const saved = {
          body: savedBody ?? recordRef.current?.body ?? "",
          version: result.version,
          hash: result.hash,
          versions: recordRef.current?.versions ?? [],
          // The record beside the chapter is untouched by a save; the summary's hash moving past
          // it is what makes it stale (turn 129).
          continuity: recordRef.current?.continuity ?? null,
          voices: recordRef.current?.voices ?? null,
          audiobook: recordRef.current?.audiobook ?? null,
          audiobookMissing: recordRef.current?.audiobookMissing ?? [],
        };
        recordRef.current = saved;
        setRecord(saved);
        setSaveRefusal(null);
        // Typed since the save left: the newer text goes out now, against the base just returned.
        if (queuedDraft.current !== null) {
          const next = queuedDraft.current;
          queuedDraft.current = null;
          flushSave(next);
          return;
        }
        setSaving(false);
        // Dropped only when the editor still holds exactly what was saved; a keystroke since
        // then is a newer draft and stays.
        setDraft((current) => (current === savedBody ? null : current));
        if (readAfterSave.current) {
          readAfterSave.current = false;
          setReadNow(true);
        }
        // The press waited for the words to land, so the run reads what landed and never pays
        // for a record against words the screen had already left behind.
        if (deriveAfterSave.current) {
          deriveAfterSave.current = false;
          deriveContinuity(worldId, prodId, chapter.file);
        }
        if (castAfterSave.current) {
          castAfterSave.current = false;
          castVoices(worldId, prodId, chapter.file);
        }
        if (voicedAfterSave.current) {
          voicedAfterSave.current = false;
          setVoicedNow(true);
        }
        if (audiobookAfterSave.current !== null) {
          // Back through the hook, not straight to the store (codex on PR 1186): the hook keeps
          // the intent's blocks for every answer to a price or a consent that follows.
          const intent = audiobookAfterSave.current;
          audiobookAfterSave.current = null;
          audiobookResume.current(intent);
        }
      } else {
        // Keep the latest words, including typing after the refused request. Read the new
        // base to distinguish a plan-only change from competing prose, never merge blindly.
        unsentDraft.current = draftRef.current ?? queuedDraft.current ?? savedText.current;
        unsentBase.current = recordRef.current?.hash ?? null;
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
        setSaving(false);
        queuedDraft.current = null;
        readAfterSave.current = false;
        deriveAfterSave.current = false;
        castAfterSave.current = false;
        voicedAfterSave.current = false;
        audiobookAfterSave.current = null;
        setSaveRefusal("save refused · your draft is kept");
        setReopen((n) => n + 1);
      }
    });
  }, [flushSave]);

  /*
   * A save in flight when the transport drops never answers: the connection coming back brings
   * a snapshot, not the result. Its newest text is kept as unsent, so the reopen above sends it
   * against a fresh base, and the foot says so rather than staying on "Saving…" (codex, PR 879).
   */
  useEffect(() => {
    if (connection === "open") return;
    // The newest text not yet on disk: what is being typed inside the pause, else what waits
    // behind the save in flight, else what that save carried. The pause itself is cancelled —
    // its timer would find no transport — and the reopen on reconnect sends the text instead
    // of adopting the disk over it (codex, PR 879).
    const typing = timer.current !== null ? draftRef.current : null;
    const value = typing ?? queuedDraft.current ?? (pendingSave.current !== null ? savedText.current : null);
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pendingSave.current = null;
    queuedDraft.current = null;
    if (value === null || value === recordRef.current?.body) return;
    unsentDraft.current = value;
    unsentBase.current = recordRef.current?.hash ?? null;
    setSaving(false);
    setSaveRefusal("offline · kept to send");
  }, [connection]);

  /*
   * Leaving flushes what has not gone out rather than cancelling it: the screen promises the
   * chapter saves as you type, and the sentence before a rail press is the one most easily
   * lost. The newest text is the draft; if it is the text of a save already in flight there is
   * nothing to do, if a save is in flight with older text the flush waits behind it for the
   * base that save returns (`flushAfter`), and otherwise it goes now against the base the
   * editor holds. Park the words until the answer proves they saved, even after this listener
   * is gone; the next screen can recover a refusal (issue 954).
   */
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const current = recordRef.current;
      // The newest text: what is being typed, else what was already waiting for a transport.
      const value = draftRef.current ?? unsentDraft.current;
      const base = draftRef.current !== null ? (current?.hash ?? unsentBase.current) : unsentBase.current;
      if (value === null || base === null) return;
      if (current !== null && value === current.body && unsentDraft.current === null) return;
      const key = parkedKey(worldId, prodId, chapter.file);
      const held: ParkedDraft = { value, baseHash: base, landedBody: savedText.current, conflict: conflictRef.current };
      parkedDrafts.get(key)?.cancel?.();
      parkedDrafts.set(key, held);
      if (conflictRef.current) return;
      if (pendingSave.current !== null) {
        if (savedText.current !== value) {
          flushAfter(pendingSave.current, {
            worldId,
            prodId,
            file: chapter.file,
            value,
            baseHash: base,
            landedBody: savedText.current,
          });
        } else keepUntilSaved(key, held, pendingSave.current);
        return;
      }
      // A transport that is down here would lose the words with the screen; they are parked for
      // the next one to open this chapter (codex, PR 879).
      const sent = saveChapter(worldId, prodId, chapter.file, value, base);
      keepUntilSaved(key, held, sent);
    },
    [worldId, prodId, chapter.file],
  );

  const onChangeAt = (at: number) => (value: string) => {
    // A change from an editor already replaced by an adoption is its parting flush, not typing.
    if (at !== epoch.current) return;
    richWrite.current = richMode ? value : null;
    draftRef.current = value;
    setDraft(value);
    if (conflictRef.current) return;
    setSaving(true);
    setSaveRefusal(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flushSave(value), AUTOSAVE_MS);
  };
  const onChange = onChangeAt(epoch.current);

  /* Which editor owns this chapter: the Bible's gate, for the Bible's reasons. */
  const [preferSource, setPreferSource] = useState(false);
  const richWrite = useRef<string | null>(null);
  const gate = useRef<RichModeGate | null>(null);
  if (!preferSource) gate.current = updateRichModeGate(gate.current, text, richWrite.current);
  const richRefusal = gate.current?.verdict ?? null;
  const richMode = richRefusal === null && !preferSource;

  /* The draft waiting on this chapter, if one is; the editor locks while it waits. */
  const stagedDraft = stagedChapterDraft(world.proposals, path);
  const locked = stagedDraft !== undefined || record === null;

  /*
   * Read the chapter: a page read, one block per paragraph, of the saved record (issue 859).
   *
   * The blocks are declared from the text on screen and resolved against the file, so the
   * press waits out a pending save before it asks — otherwise the voice and the page would
   * disagree about what the chapter says.
   */
  const paragraphs = useMemo(() => chapterParagraphs(live), [live]);
  const blocks: (PageReadBlock & { source: ProseReadSource })[] = paragraphs.slice(0, PAGE_READ_BLOCK_CAP).map((body, i) => ({
    heading: `${i + 1} of ${paragraphs.length}`,
    body,
    source: { of: "chapter", productionId: prodId, chapterId: chapter.id, paragraph: i },
  }));
  const pageRead = useProsePageRead({ pageId: chapter.id, title: chapter.title, blocks });
  useEffect(() => {
    if (!readNow) return;
    setReadNow(false);
    pageRead.begin();
  }, [readNow, pageRead]);

  /*
   * The voiced read (turn 130, SPEC-012 R-46): the same page read, its blocks the chapter's
   * paragraphs split at the cast lines by the one rule both ends use, narration in the
   * narrator's voice and a line in its speaker's. The frame names the chapter once and the
   * coordinator expands it, so a cast of four hundred lines never overflows the frame; the
   * blocks here label and count. A stale cast still reads what it still finds.
   */
  const castingState = useCasting()[`${worldId}/${prodId}/${chapter.id}`];
  useEffect(() => {
    if (castingState?.state === "cast" && castingState.record !== undefined) setFinishedCast(castingState.record);
  }, [castingState]);
  const voices = useMemo((): ChapterVoices | "unreadable" | null => {
    const opened = record?.voices ?? null;
    if (finishedCast === null) return opened;
    if (opened === null || opened === "unreadable" || finishedCast.derivedAt >= opened.derivedAt) return finishedCast;
    return opened;
  }, [record?.voices, finishedCast]);
  const castingNow = castingState?.state === "casting";
  const voicesRecord = voices === "unreadable" ? null : voices;
  const voicesStale = voicesRecord !== null && chapter.bodyHash !== undefined && chapter.bodyHash !== voicesRecord.hash;
  const voiced = useMemo(() => voicedBlocks(live, voicesRecord), [live, voicesRecord]);
  const sheetNameOf = (id: string) => world.sheets.find((sheet) => sheet.id === id)?.name ?? id;
  const voicedRead = useProsePageRead({
    pageId: `${chapter.id}#voiced`,
    title: chapter.title,
    blocks: voiced.blocks.map((block) => ({
      heading: block.speaker === undefined ? "Narration" : block.sheet !== undefined ? sheetNameOf(block.sheet) : block.speaker,
      body: block.text,
      source: { of: "chapter-voiced", productionId: prodId, chapterId: chapter.id },
    })),
    sources: [{ of: "chapter-voiced", productionId: prodId, chapterId: chapter.id }],
    voiceOf: (index) => {
      const block = voiced.blocks[index];
      return block?.speaker === undefined ? "narrator" : block.sheet !== undefined ? sheetNameOf(block.sheet) : block.speaker;
    },
  });
  useEffect(() => {
    if (!voicedNow) return;
    setVoicedNow(false);
    voicedRead.begin();
  }, [voicedNow, voicedRead]);
  // A recast landing while a voiced read plays would remap the band, the count and the speaker
  // labels onto audio made from the earlier cast (codex on PR 914, round two): the read stops
  // with the cast it was made from, and the next press reads the new one.
  // When it was cast is part of the key (codex on PR 924): a recast that reads the same prose
  // and finds the same number of lines can still name different speakers.
  const castKey = voicesRecord === null ? null : `${voicesRecord.hash}:${voicesRecord.derivedAt}:${voicesRecord.lines.length}`;
  const readCast = useRef<string | null>(null);
  useEffect(() => {
    if (!voicedRead.reading) {
      readCast.current = castKey;
      return;
    }
    if (readCast.current !== castKey) voicedRead.stop();
  }, [castKey, voicedRead]);
  const castNote =
    castingState?.state === "unavailable" || castingState?.state === "failed"
      ? `could not cast · ${castingState.reason ?? "the run failed"}`
      : castingState?.state === "stopped"
        ? "stopped · the last cast stands"
        : null;
  const castLinesPress = () => {
    if (castingNow || locked) return;
    if ((draft !== null && draft !== live) || pendingSave.current !== null) {
      castAfterSave.current = true;
      if (draft !== null && draft !== live) flushSave(draft);
      return;
    }
    castVoices(worldId, prodId, chapter.file);
  };
  /** Who speaks, by lines, the narration first: the Voices panel's rows. */
  const speakers = useMemo(() => {
    const counts = new Map<string, { speaker: string; sheet?: string; lines: number }>();
    for (const line of voicesRecord?.lines ?? []) {
      const key = line.sheet ?? line.speaker;
      const held = counts.get(key);
      if (held !== undefined) held.lines += 1;
      else counts.set(key, { speaker: line.speaker, ...(line.sheet !== undefined ? { sheet: line.sheet } : {}), lines: 1 });
    }
    return [...counts.values()].sort((a, b) => b.lines - a.lines || a.speaker.localeCompare(b.speaker));
  }, [voicesRecord]);
  const narrationBlocks = voiced.blocks.filter((block) => block.speaker === undefined).length;
  const narratorName = useStore().state?.app.narrator?.label ?? DEFAULT_NARRATOR.label;
  // The catalogue says whether an assigned voice can speak now (turn 130's rule, codex on PR
  // 914): asked for once a cast is shown, and a voice it lacks or marks reads in the
  // narrator's, said so in the row rather than found out when the block fails.
  const catalogue = useStore().voiceCatalogue;
  const castShown = voicesRecord !== null;
  useEffect(() => {
    if (castShown && connection === "open") requestVoiceCatalogue(worldId);
  }, [castShown, connection, worldId]);
  const voiceUnavailable = (voice: { provider: string; model?: string; voiceId: string }): boolean => {
    if (catalogue === null) return false;
    const model = voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId, world.clonedVoices ?? []);
    const listed = catalogue.find(
      (candidate) => candidate.provider === voice.provider && candidate.voiceId === voice.voiceId && (model === null || candidate.model === model),
    );
    return listed === undefined || listed.unavailableReason !== undefined;
  };
  // A read under way when a draft arrives is stopped with it: the manuscript now shows the
  // draft, and the accepted prose must not go on sounding under it (codex, PR 879).
  const drafted = stagedDraft !== undefined;
  useEffect(() => {
    if (drafted && pageRead.reading) pageRead.stop();
    if (drafted && voicedRead.reading) voicedRead.stop();
  }, [drafted, pageRead.reading, pageRead.stop, voicedRead.reading, voicedRead.stop]);
  const readVoiced = {
    ...voicedRead,
    begin: () => {
      if ((draft !== null && draft !== live) || pendingSave.current !== null) {
        voicedAfterSave.current = true;
        if (draft !== null && draft !== live) flushSave(draft);
        return;
      }
      voicedRead.begin();
    },
  };
  // The block being read, for the band over the manuscript (turn 130).
  const voicedAt = voicedRead.reading && voicedRead.at !== null ? voiced.blocks[voicedRead.at] ?? null : null;
  /*
   * The Audiobook view (turn 146, SPEC-047 R-30): the same room, the prose as blocks with a
   * state each. Carried in the address so a row on the door opens straight into it and a test
   * can mount it; the manuscript's editor stays mounted underneath, hidden, so its autosave
   * and its draft are exactly where they were when the view goes back.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const view: "manuscript" | "audiobook" = searchParams.get("view") === "audiobook" ? "audiobook" : "manuscript";
  const chooseView = (next: "manuscript" | "audiobook") =>
    setSearchParams(
      (params) => {
        const copy = new URLSearchParams(params);
        if (next === "audiobook") copy.set("view", "audiobook");
        else copy.delete("view");
        return copy;
      },
      { replace: true },
    );
  // The record a run finished with stands until a fresh open replaces it, as the cast's does:
  // the run's last word arrives on its finished event, and what the disk holds now is read
  // again only when the chapter is.
  const audiobookRun = useAudiobookRuns()[`${worldId}/${prodId}/${chapter.id}`];
  useEffect(() => {
    if (audiobookRun?.record !== undefined) setFinishedAudiobook(audiobookRun.record);
  }, [audiobookRun?.record]);
  // A write outside a run — a block's direction set, a card accepted (turn 146) — answers with
  // the record too, and is taken the same way: the newest record stands, whoever wrote it.
  const writtenAudiobook = useAudiobookRecords()[`${worldId}/${prodId}/${chapter.id}`];
  useEffect(() => {
    if (writtenAudiobook?.record !== undefined) setFinishedAudiobook((held) => (held === null || writtenAudiobook.record!.updatedAt >= held.updatedAt ? writtenAudiobook.record! : held));
  }, [writtenAudiobook]);
  // The takes the coordinator found gone belong to the record it was answering with: a run's
  // record, taken when newer, has made them again, so the list goes with the opened record alone.
  const audiobookRecord = useMemo((): { record: ChapterAudiobook | "unreadable" | null; missing: readonly string[] } => {
    const opened = record?.audiobook ?? null;
    const missing = record?.audiobookMissing ?? [];
    if (finishedAudiobook === null) return { record: opened, missing };
    if (opened === null || opened === "unreadable" || finishedAudiobook.updatedAt >= opened.updatedAt) return { record: finishedAudiobook, missing: [] };
    return { record: opened, missing };
  }, [record?.audiobook, record?.audiobookMissing, finishedAudiobook]);
  const audiobook = useChapterAudiobook({
    worldId,
    prodId,
    chapter,
    body: record?.body ?? "",
    cast: voicesRecord,
    record: audiobookRecord.record,
    missing: audiobookRecord.missing,
    reading: production.audiobook?.reading ?? "narrator",
    connection,
    locked: locked || record === null,
    // The press waits out the autosave (turn 126's fourth rule, codex on PR 1180): a read of
    // the words on disk while newer ones are on their way would make takes stale on arrival.
    beforeRead: (intent) => {
      if ((draft !== null && draft !== live) || pendingSave.current !== null) {
        audiobookAfterSave.current = intent;
        if (draft !== null && draft !== live) flushSave(draft);
        return false;
      }
      return true;
    },
  });
  const audiobookColumn = useRef<HTMLDivElement | null>(null);
  audiobookResume.current = audiobook.resume;
  const directionStands = audiobook.directedBlocks > 0;
  const worldSlug = world.meta.slug;
  const read = {
    ...pageRead,
    begin: () => {
      if (draft !== null && draft !== live) {
        readAfterSave.current = true;
        flushSave(draft);
        return;
      }
      pageRead.begin();
    },
  };

  // The words of the text on screen once it is here; the summary's count only while it is not.
  const words = record === null ? (chapter.words ?? 0) : countWords(text);
  const activeChapters = production.chapters.filter((c) => !c.retired);
  const bookWords = activeChapters.reduce((sum, c) => sum + (c.words ?? 0), 0);
  const target = targetWords(production.story?.targetLength, activeChapters.length);
  // The versions a snapshot exists for, newest first — read off the open answer, never counted
  // down from the number, so no Restore is offered that would silently fail.
  const history = useMemo(() => [...(record?.versions ?? [])].sort((a, b) => b - a).slice(0, 12), [record?.versions]);

  const [dock, setDock] = useState(true);
  /*
   * The plan (turn 127): typed where it reads and saved in place, one write for every field.
   * A fact proposed is said into the production thread in the author's name — handed to the
   * dock as its opening line, which says it once per mount, so the dock is keyed by the press.
   */
  const plan = (changes: Parameters<typeof editChapterPlan>[3]) => editChapterPlan(worldId, prodId, chapter.file, changes);
  const [say, setSay] = useState<{ line: string; seq: number } | null>(null);
  const implies = chapter.implies ?? [];
  const stale = overviewMoved(chapter, production.story);
  const characters = world.sheets.filter(
    (sheet) => sheet.type === "character" && !sheet.retired && (sheet.production === undefined || sheet.production === prodId),
  );
  const draws = chapter.draws ?? { sheets: [], canon: [] };
  const drawsEmpty = draws.sheets.length === 0 && draws.canon.length === 0;
  const chapterLabel = `chapter ${String(chapter.order).padStart(2, "0")}`;
  /* The style the book is written in (turn 128), said in one line beside the manuscript. */
  const style = production.proseStyle ?? null;

  /*
   * After this chapter (turn 129, SPEC-012 §2.4.1): the record beside the chapter, read with it,
   * and replaced by the one a derivation finishes with, so the lines are here without a second
   * read. Stale when the summary's hash has moved past the record's — a direct save keeps the
   * version, so the hash decides. The press flushes the editor first and waits for its save to
   * land, as Read the chapter does, so a record is never paid for against words the screen had
   * left behind; a second press while one runs does nothing, and every ending short of derived
   * leaves the last record standing and says so.
   */
  const derivingState = useDeriving()[`${worldId}/${prodId}/${chapter.id}`];
  useEffect(() => {
    if (derivingState?.state === "derived" && derivingState.record !== undefined) setFinishedRecord(derivingState.record);
  }, [derivingState]);
  const continuity = useMemo((): ChapterContinuity | "unreadable" | null => {
    const opened = record?.continuity ?? null;
    if (finishedRecord === null) return opened;
    if (opened === null || opened === "unreadable" || finishedRecord.derivedAt >= opened.derivedAt) return finishedRecord;
    return opened;
  }, [record?.continuity, finishedRecord]);
  const derivingNow = derivingState?.state === "deriving";
  const continuityRecord = continuity === "unreadable" ? null : continuity;
  // The record is keyed to the prose, and the summary carries the prose's own hash (R-39).
  const continuityStale = continuityRecord !== null && chapter.bodyHash !== undefined && chapter.bodyHash !== continuityRecord.hash;
  // Every ending short of derived is said where chapter moved is said (codex on PR 907): a
  // stop as much as a failure, so a press that ended a run sees that it ended.
  const deriveNote =
    derivingState?.state === "unavailable" || derivingState?.state === "failed"
      ? `could not derive · ${derivingState.reason ?? "the run failed"}`
      : derivingState?.state === "stopped"
        ? "stopped · the last record stands"
        : null;
  const derive = () => {
    // A record is derived from the saved chapter, never from a draft standing in its place
    // (codex on PR 907): while one waits the press is disabled, as Read the chapter is.
    if (derivingNow || locked) return;
    // A save still in flight is waited for even when the editor has come back to the saved
    // words (codex on PR 907, round five): the run reads what finally lands, never the middle.
    if ((draft !== null && draft !== live) || pendingSave.current !== null) {
      deriveAfterSave.current = true;
      if (draft !== null && draft !== live) flushSave(draft);
      return;
    }
    deriveContinuity(worldId, prodId, chapter.file);
  };
  const sheetName = (id: string) => world.sheets.find((sheet) => sheet.id === id)?.name ?? id;
  // A name the cast did not know when the record was read, and knows now (codex on turn 129):
  // the record is not stale, and Derive again is how the name becomes a column.
  const sheetNow = (who: { character: string; sheet?: string }) =>
    who.sheet === undefined &&
    world.sheets.some((sheet) => sheet.type === "character" && !sheet.retired && sheet.name.trim().toLowerCase() === who.character.trim().toLowerCase());
  const named = (who: { character: string; sheet?: string }) => sheetName(who.sheet ?? who.character);
  const placedFirst = continuityRecord?.characters[0];
  const placedSecond = continuityRecord?.characters[1] ?? placedFirst;

  /*
   * The passage selected (turn 128): the words, which become the dock's subject, and where they
   * end, for the press beside them. The words rather than positions, because what is said about
   * them goes into the production's thread, which never sees the editor.
   */
  const [selection, setSelection] = useState<{ text: string; paragraph: number | null; top: number; left: number; end: boolean } | null>(null);
  const manuscriptRef = useRef<HTMLDivElement | null>(null);
  // The paragraph rides with the words (codex on turn 128): the coordinator looks for the passage
  // there and only there, so an occurrence elsewhere can never be the one changed.
  const onSelect = useCallback((text: string | null, paragraph: number | null = null) => {
    const subject = passageSubject(text);
    setSelection(subject === null ? null : { text: subject, paragraph, ...askAt(manuscriptRef.current) });
    // A subject flushes the pending autosave, as Read the chapter does (codex on turn 128): the
    // words the thread hears must be the words the coordinator will find, and an ask sent inside
    // the autosave window would otherwise quote prose the file does not hold yet.
    if (subject !== null && timer.current !== null && draftRef.current !== null) flushSave(draftRef.current);
  }, [flushSave]);
  // The words come from the text the editor holds, not the element's value: the two are the same
  // string in a browser, and only the first is there under test.
  const onTextareaSelect = (e: { currentTarget: HTMLTextAreaElement }) => {
    const { selectionStart, selectionEnd } = e.currentTarget;
    const selected = text.slice(selectionStart, selectionEnd);
    // Anchored at the first word the ask quotes (codex on PR 1232): a drag begun on the blank line
    // before a paragraph is trimmed to that paragraph's words, and must be placed in it too.
    const lead = selected.length - selected.trimStart().length;
    onSelect(selectionStart === selectionEnd ? null : selected, paragraphAt(text, selectionStart + lead));
  };
  useEffect(() => {
    if (locked) setSelection(null);
  }, [locked]);
  const passage = selection?.text ?? null;
  /*
   * What the dock is about and what it says first: the passage, when one is selected. The dock's
   * own quick asks read these at the send; the menu's are fixed at the press (codex on PR 1232),
   * because an ask that has to wait is still about the passage it was pressed on.
   */
  const dockSubject: WorldChatSubject = passage === null
    ? { kind: "chapter", chapterId: chapter.id }
    : { kind: "passage", chapterId: chapter.id, ...(selection?.paragraph ? { paragraph: selection.paragraph } : {}), text: passage };
  const dockPrefix = passage !== null
    ? `About this passage in ${chapterLabel}${selection?.paragraph ? `, paragraph ${selection.paragraph}` : ""}: «${passage}»`
    : `About ${chapterLabel}:`;
  /*
   * An ask from the menu beside the selection. The page holds it, not the dock, until the dock
   * says it is done with it (codex on PR 1232): putting the dock away while it waits, or while
   * the thread has yet to show it, loses nothing.
   */
  const askKey = parkedKey(worldId, prodId, path);
  const [ask, setAskState] = useState<DockAsk | null>(() => heldAsks.get(askKey) ?? null);
  const setAsk = useCallback((next: DockAsk | null) => {
    if (next === null) heldAsks.delete(askKey);
    else heldAsks.set(askKey, next);
    setAskState(next);
  }, [askKey]);
  // The screen's own copy takes its answer too, for a dock put away while it came.
  useEffect(() => subscribeWorldChatSendResults((result) => {
    setAskState((held) => (held?.sent?.requestId === result.requestId ? { ...held, answered: result.admitted } : held));
  }), []);
  // Any ask held is about the passage it was pressed on, waiting, sent or not taken (codex on
  // PR 1232): the dock says so, whatever is selected by then.
  const shownSubject = ask?.subject ?? dockSubject;
  // One ask at a time (codex on PR 1232): a second press would replace one still waiting or
  // being answered, and a refusal or a lost answer would then have nowhere to be shown. A line
  // only started, or one shown as not sent, is the author's to replace.
  const asking = ask !== null && ask.draft !== true && ask.declined !== true;
  const askPassage = (action: PassageAction) => {
    setDock(true);
    setAsk({
      press: crypto.randomUUID(),
      line: action.line,
      text: `${dockPrefix} ${action.line}`,
      subject: dockSubject,
      ...(action.replyOnly ? { replyOnly: true } : {}),
      ...(action.draft ? { draft: true } : {}),
    });
  };

  /*
   * A passage waits (turn 128): the staged draft changes one span and leaves the rest of the
   * chapter as it was. Drawn from the review's before and proposed; a draft that changes more
   * than one span is a draft, and is drawn as one.
   */
  // Only when the action was a passage (its origin says so): a chapter recast between an
  // untouched opening and closing has one span too, and is a draft.
  const passageChange: ChangedSpan | null =
    stagedDraft === undefined || stagedDraft.staged.proposal.origin?.gesture !== "passage-revision"
      ? null
      : passageOf(stagedDraft.before, stagedDraft.body);
  const waiting = stagedDraft === undefined ? null : passageChange === null ? "draft" : "passage";

  /*
   * Keeping part of a passage: the revision taken apart into edits, each kept until the author
   * refuses it. Only a revision of two edits or more offers the choice — one edit refused is a
   * discard, which the card already has. What is refused belongs to the draft revision it was
   * chosen against, so a revision that moves (the part kept, landed) starts every edit kept.
   */
  const segments = useMemo(
    (): PassageSegment[] => (passageChange === null ? [] : passageDiff(passageChange.before, passageChange.after)),
    [passageChange?.before, passageChange?.after],
  );
  const editCount = segments.filter((segment) => segment.kind === "edit").length;
  const passageParagraphs = stagedDraft === undefined ? [] : paragraphSpans(stagedDraft.body ?? live);
  const anchorParagraph = passageChange === null
    ? -1
    : passageParagraphs.findIndex((paragraph) => paragraph.end >= passageChange.start && paragraph.start <= passageChange.start + Math.max(passageChange.after.length, 1));
  const choosing = stagedDraft !== undefined && passageChange !== null && editCount > 1;
  // The passage is in the key as well as the revision (codex on PR 1232): an authoring run can
  // rewrite the staged file without moving the revision, and an index refused against one set of
  // edits must never refuse a different edit of the next.
  const choiceKey = stagedDraft === undefined || passageChange === null
    ? null
    : `${stagedDraft.staged.proposal.id}:${stagedDraft.staged.proposal.draftRevision}:${passageChange.before}\u0000${passageChange.after}`;
  const [refusedFor, setRefusedFor] = useState<{ key: string | null; refused: ReadonlySet<number> }>({ key: null, refused: new Set() });
  const refused = choosing && refusedFor.key === choiceKey ? refusedFor.refused : NONE_REFUSED;
  const keptCount = editCount - refused.size;
  const toggleEdit = (index: number) => {
    const next = new Set(refused);
    if (!next.delete(index)) next.add(index);
    setRefusedFor({ key: choiceKey, refused: next });
  };
  /*
   * Accepting part is two presses the author makes as one: the part is kept through the gate,
   * and once it lands, the revision it landed as is accepted. A refusal of the first (a notice
   * for the proposal, new since the press) ends it there, said on the card, and accepts nothing.
   * A newer revision alone is not proof the keep landed (codex on PR 1232): another window can
   * move the draft on, and this keep is then refused as stale in the same breath. So the refusal
   * is looked at first, and a revision is accepted only when its passage is the one this press
   * composed — anything else is somebody else's draft, and the author decides it afresh.
   */
  const notices = useGateNotices();
  const [keeping, setKeeping] = useState<{ id: string; revision: number; notice: GateNotice | undefined; expected: string } | null>(null);
  const stagedId = stagedDraft?.staged.proposal.id;
  const stagedRevision = stagedDraft?.staged.proposal.draftRevision;
  const stagedBody = stagedDraft?.body ?? null;
  // A keep sent into a connection that then dropped has no answer coming (codex on PR 1232): the
  // rejoin brings the snapshot as it was, so the wait ends with the connection, not with a reply.
  useEffect(() => {
    if (keeping === null) return;
    if (connection !== "open" || stagedId !== keeping.id || notices[keeping.id] !== keeping.notice) setKeeping(null);
    else if (stagedRevision !== undefined && stagedRevision > keeping.revision) {
      // Only the keep's own revision is accepted, and fenced to it (codex on PR 1232): the keep
      // moves the draft exactly one revision, so a later one carries some other edit too —
      // perhaps to a field the prose does not show — and is left for the author. One moved on
      // again before the accept reaches the gate is refused there as stale.
      if (stagedRevision === keeping.revision + 1 && stagedBody === keeping.expected) {
        acceptProposal(worldId, keeping.id, undefined, stagedRevision);
      }
      setKeeping(null);
    }
  }, [keeping, connection, stagedId, stagedRevision, stagedBody, notices, worldId]);
  /*
   * A whole accept in flight holds the choices too (codex on PR 1232): toggled after the press,
   * they would show a count the gate is not accepting. It is fenced to the revision on screen,
   * and held until the proposal is gone, the gate answers with a notice, or the connection drops.
   */
  const [accepting, setAccepting] = useState<{ id: string; notice: GateNotice | undefined } | null>(null);
  useEffect(() => {
    if (accepting === null) return;
    if (connection !== "open" || stagedId !== accepting.id || notices[accepting.id] !== accepting.notice) setAccepting(null);
  }, [accepting, connection, stagedId, notices]);
  const accept = !choosing || stagedDraft === undefined || passageChange === null
    ? undefined
    : keptCount === editCount
      ? {
          label: "Accept",
          ...(accepting !== null ? { blocked: "Accepting…" } : {}),
          onAccept: (confirmSignature?: string) => {
            const proposal = stagedDraft.staged.proposal;
            if (acceptProposal(worldId, proposal.id, confirmSignature, proposal.draftRevision)) {
              setAccepting({ id: proposal.id, notice: notices[proposal.id] });
            }
          },
        }
      : {
          label: `Accept ${keptCount} of ${editCount}`,
          ...(keptCount === 0 ? { blocked: "Nothing kept" } : keeping !== null ? { blocked: "Keeping…" } : {}),
          onAccept: () => {
            const proposal = stagedDraft.staged.proposal;
            const kept = segments.flatMap((segment) => (segment.kind === "edit" && !refused.has(segment.index) ? [segment.index] : []));
            // Nothing sent is nothing to wait for (codex on PR 1232): the press stays the author's.
            if (!updateProposalPassage(worldId, proposal.id, path, passageChange, kept, proposal.draftRevision)) return;
            const body = stagedDraft.body ?? live;
            const expected = body.slice(0, passageChange.start) + composePassage(segments, new Set(kept)) + body.slice(passageChange.start + passageChange.after.length);
            setKeeping({ id: proposal.id, revision: proposal.draftRevision, notice: notices[proposal.id], expected });
          },
        };
  const foot = locked && stagedDraft !== undefined
    ? `Locked while a ${waiting} waits · v${record?.version ?? chapter.version} · ${words.toLocaleString()} words`
    : saveRefusal !== null
      ? `Not saved · ${saveRefusal}`
      : saving
        ? "Saving…"
        : `Saved · v${record?.version ?? chapter.version} · ${words.toLocaleString()} words`;

  return (
    <div className="fy-sw" data-screen="chapter" data-testid="chapter-workspace" data-dock={dock ? "true" : "false"}>
      <main className="fy-sw__centre">
        <header className="fy-sw__head">
          <p className="fy-sw__breadcrumb">
            CHAPTER {String(chapter.order).padStart(2, "0")} OF {production.chapters.length}
          </p>
          <div className="fy-sw__headline">
            <h1 className="fy-sw__title">
              <SceneTitle title={chapter.title} locked={locked} onCommit={(title) => plan({ title })} />
            </h1>
            <div className="fy-sw__actions">
              {/* Not while a draft stands in the prose's place: the read speaks the saved chapter,
                  and the words on screen are the draft's (codex, PR 879). */}
              {view === "audiobook" ? (
                stagedDraft === undefined && audiobook.head
              ) : (
                <>
                  {paragraphs.length > 0 && stagedDraft === undefined && !voicedRead.reading && <PageReadControl read={read} label="Read the chapter" />}
                  {paragraphs.length > 0 && stagedDraft === undefined && voicesRecord !== null && !pageRead.reading && (
                    <PageReadControl read={readVoiced} label="Voiced" />
                  )}
                </>
              )}
            </div>
          </div>
          {/* The synopsis, typed where it reads (turn 127), the way the scene's is. */}
          {locked ? (
            chapter.synopsis !== undefined && chapter.synopsis !== "" ? (
              <div className="fy-sbsynopsis fy-ch__synopsis--locked">{chapter.synopsis}</div>
            ) : null
          ) : (
            <EditableText
              value={chapter.synopsis ?? ""}
              placeholder="What this chapter is for."
              className="fy-sbsynopsis"
              rows={2}
              onCommit={(next) => plan({ synopsis: next.trim() === "" ? null : next.trim() })}
            />
          )}
          <div className="fy-sw__context" aria-label="Chapter state">
            <span className="fy-ch__mark">
              <select
                className="fy-ch__pick"
                aria-label="Point of view"
                value={chapter.pov ?? ""}
                disabled={locked}
                onChange={(e) => plan({ pov: e.target.value === "" ? null : e.target.value })}
              >
                <option value="">Point of view</option>
                {characters.map((sheet) => (
                  <option key={sheet.id} value={sheet.id}>
                    {sheet.name}
                  </option>
                ))}
              </select>
            </span>
            <span className="fy-ch__mark">
              {locked ? (
                <span className="fy-mono">{chapter.when ?? ""}</span>
              ) : (
                <EditableText
                  value={chapter.when ?? ""}
                  placeholder="When"
                  className="fy-ch__when"
                  rows={1}
                  onCommit={(next) => plan({ when: next.trim() === "" ? null : next.trim() })}
                />
              )}
            </span>
            <span>{chapter.status}</span>
            <span>{words.toLocaleString()} words</span>
            <span>{waiting !== null ? `${waiting} waiting` : saveRefusal !== null ? "not saved" : saving ? "saving" : "saved"}</span>
            {stale && (
              <span className="fy-ch__moved">
                overview moved · v{chapter.draftedAgainst} → v{production.story?.version}
              </span>
            )}
          </div>
          {/* The view row (turn 146): the Chapters door's seg, Manuscript or Audiobook. */}
          <nav className="fy-seg fy-ch__viewrow" aria-label="Chapter view">
            <button type="button" className={cx("fy-seg__item", view === "manuscript" && "fy-seg__item--active")} onClick={() => chooseView("manuscript")}>
              Manuscript
            </button>
            <button type="button" className={cx("fy-seg__item", view === "audiobook" && "fy-seg__item--active")} onClick={() => chooseView("audiobook")}>
              Audiobook
            </button>
          </nav>
        </header>

        <div className="fy-ch__body">
          {view === "audiobook" && (
            <div className="fy-ch__manuscript" data-testid="audiobook-column" ref={audiobookColumn}>
              {audiobook.sounding !== null && (
                <div className="fy-ch__band" data-testid="audiobook-band">
                  <span className="fy-ch__band-who">{audiobook.sounding.mark}</span>
                  <span className="fy-ch__band-push" />
                  <span className="fy-ch__band-line">{audiobook.sounding.block.text}</span>
                </div>
              )}
              {openFailure !== null ? (
                <EmptyState title={openFailure} />
              ) : record === null ? (
                <p className="fy-bible__empty">Opening…</p>
              ) : (
                <AudiobookBlocks
                  rows={audiobook.rows}
                  sounding={audiobook.sounding}
                  selected={audiobook.selected}
                  onSelect={audiobook.setSelected}
                  slug={worldSlug}
                  onPlayOne={(row) => {
                    if (row.artifact === null) return;
                    void playClip({ id: row.artifact.id, url: mediaUrl(worldSlug, `artifacts/${row.artifact.file}`), title: `${chapter.title} · ${row.mark}`, sub: "audiobook · one block" });
                  }}
                />
              )}
              <div className="fy-ab__foot" data-testid="audiobook-foot">
                <span>{`Saved · v${record?.version ?? chapter.version} · ${words.toLocaleString()} words`}</span>
                <span className="fy-ab__foot-push" />
                {audiobook.note !== null && <span className="fy-ch__who-where--warn">{audiobook.note}</span>}
                <span>
                  {[
                    `${audiobook.counts.total} block${audiobook.counts.total === 1 ? "" : "s"}`,
                    `${audiobook.counts.made} made`,
                    ...(audiobook.counts.stale > 0 ? [`${audiobook.counts.stale} stale`] : []),
                    ...(audiobook.counts.flagged > 0 ? [`${audiobook.counts.flagged} flagged`] : []),
                    ...(audiobook.counts.notMade > 0 ? [`${audiobook.counts.notMade} not made`] : []),
                  ].join(" · ")}
                </span>
              </div>
            </div>
          )}
          <div className="fy-ch__manuscript" ref={manuscriptRef} hidden={view === "audiobook"}>
            {voicedAt !== null && (
              <div className="fy-ch__band" data-testid="voiced-band">
                <span className="fy-ch__band-who">{voicedAt.speaker === undefined ? narratorName : voicedAt.sheet !== undefined ? sheetNameOf(voicedAt.sheet) : voicedAt.speaker}</span>
                <span className="fy-mono">{(voicedRead.at ?? 0) + 1} of {voiced.blocks.length}</span>
                <span className="fy-ch__band-push" />
                <span className="fy-ch__band-line">{voicedAt.text}</span>
              </div>
            )}
            {openFailure !== null ? (
              <EmptyState title={openFailure} />
            ) : record === null ? (
              <EmptyState title="Opening…" />
            ) : stagedDraft !== undefined && passageChange !== null ? (
              <div className="fy-ch__prose">
                {/* A passage waits (turn 128): the replacement stands in the passage's place, the
                    rest of the chapter untouched, and the band counts the span both ways. */}
                <div className="fy-ch__band">
                  <span className="fy-ch__band-who">Arke&rsquo;s passage</span>
                  <span>· {countWords(passageChange.before).toLocaleString()} → {countWords(passageChange.after).toLocaleString()} words</span>
                  {choosing && <span>· {keptCount} of {editCount} changes kept</span>}
                  <span>· against v{record.version}</span>
                  <span className="fy-ch__band-push" />
                  <span>decide in the thread</span>
                </div>
                <div className="fy-ch__draft-passage" aria-label="Arke's passage">
                  {passageParagraphs.map((paragraph, i) => {
                    // Inclusive at both ends, and at least one character wide (codex on PR 899):
                    // a deletion at a paragraph's first character, or of a whole paragraph, is a
                    // zero-width span on a boundary, and the paragraph it touches is still marked.
                    const from = passageChange.start;
                    const to = from + Math.max(passageChange.after.length, 1);
                    const changed = paragraph.end >= from && paragraph.start <= to;
                    // With edits to choose among, the paragraph the span starts in carries the
                    // whole span as edits, and any later paragraph the span reached is not drawn
                    // twice: the edits are the passage, head and tail around them as they stand.
                    if (!choosing || !changed) {
                      return (
                        <p key={i} className={changed ? "fy-ch__passage" : undefined}>
                          {paragraph.text}
                        </p>
                      );
                    }
                    const body = stagedDraft.body ?? live;
                    // The first paragraph the span touches draws it, even when the span begins in
                    // the blank line before it (a paragraph removed whole).
                    if (anchorParagraph !== i) return null;
                    const endOfSpan = from + passageChange.after.length;
                    // The passage runs to the end of the last paragraph the span touches — the
                    // same paragraphs marked changed above, and drawn nowhere else — found by the
                    // spans, not by a separator, so a blank line holding spaces is still a
                    // boundary (codex on PR 1232).
                    const touched = passageParagraphs.filter((p) => p.end >= from && p.start <= to);
                    const tailEnd = Math.max(endOfSpan, touched[touched.length - 1]?.end ?? endOfSpan);
                    return (
                      <p key={i} className="fy-ch__passage fy-ch__passage--choose">
                        {body.slice(Math.min(paragraph.start, from), from)}
                        {segments.map((segment, n) =>
                          segment.kind === "same" ? (
                            <span key={n}>{segment.text}</span>
                          ) : (
                            <button
                              key={n}
                              type="button"
                              // Held while a keep is in flight (codex on PR 1232): what lands is
                              // what was pressed, never a choice changed after it.
                              disabled={keeping !== null || accepting !== null}
                              className={cx("fy-ch__edit", refused.has(segment.index) && "fy-ch__edit--refused")}
                              aria-pressed={!refused.has(segment.index)}
                              title={refused.has(segment.index) ? "Refused · press to keep" : "Kept · press to refuse"}
                              onClick={() => toggleEdit(segment.index)}
                            >
                              {segment.before !== "" && <del>{segment.before}</del>}
                              {segment.after !== "" && <ins>{segment.after}</ins>}
                            </button>
                          ),
                        )}
                        {body.slice(endOfSpan, tailEnd)}
                      </p>
                    );
                  })}
                </div>
              </div>
            ) : stagedDraft !== undefined ? (
              <div className="fy-ch__prose">
                <div className="fy-ch__band">
                  <span className="fy-ch__band-who">Arke&rsquo;s draft</span>
                  {stagedDraft.body !== null && <span>· {countWords(stagedDraft.body).toLocaleString()} words</span>}
                  <span>· against v{record.version}</span>
                  <span className="fy-ch__band-push" />
                  <span>decide in the thread</span>
                </div>
                {/* Read, not edited: the draft is decided on the card, so it is drawn as paragraphs
                    rather than handed to an editor that would have to refuse every keystroke. */}
                <div className="fy-ch__draft" aria-label="Arke's draft">
                  {chapterParagraphs(stagedDraft.body ?? live).map((paragraph, i) => (
                    <p key={i}>{paragraph}</p>
                  ))}
                </div>
              </div>
            ) : richMode ? (
              <div className="fy-ch__prose">
                <RichMarkdownEditor
                  // Remounting on the record is what re-reads the document; without it a second
                  // chapter would open into the first one's editor, holding the first one's text.
                  key={`${chapter.id}:${epoch.current}`}
                  value={text}
                  onChange={onChange}
                  onSelect={onSelect}
                  placeholder={PLACEHOLDER}
                  ariaLabel={`Chapter ${chapter.order}`}
                />
              </div>
            ) : (
              <textarea
                className="fy-ch__source"
                value={text}
                onChange={(e) => onChange(e.target.value)}
                onSelect={onTextareaSelect}
                onKeyUp={onTextareaSelect}
                onMouseUp={onTextareaSelect}
                spellCheck
                placeholder={PLACEHOLDER}
                aria-label={`Chapter ${chapter.order}`}
              />
            )}
            {draftConflict && !locked && (
              <div role="alert">
                <p>Not saved · your draft is kept. Choose which text to keep.</p>
                <details><summary>Saved chapter</summary><pre>{live || "Empty chapter"}</pre></details>
                <Button onClick={() => {
                  conflictRef.current = false;
                  setDraftConflict(false);
                  setSaveRefusal(null);
                  setSaving(true);
                  flushSave(draftRef.current ?? live);
                }}>Save my draft</Button>
                <Button onClick={() => {
                  conflictRef.current = false;
                  setDraftConflict(false);
                  draftRef.current = null;
                  setDraft(null);
                  setSaveRefusal(null);
                  epoch.current += 1;
                }}>Use saved chapter</Button>
              </div>
            )}
            {/* The press beside a selection (turn 128). Mouse-down is swallowed so the press does
                not collapse the selection it is about before the click lands. */}
            {selection !== null && !locked && (
              <PassageMenu
                key={selection.text}
                words={countWords(selection.text)}
                top={selection.top}
                left={selection.left}
                end={selection.end}
                actions={passageActions(style !== null)}
                onAsk={askPassage}
                // Asked only about words on disk (codex on PR 1232): a revision comes back as a
                // span of the saved chapter, so text still being saved — or refused — has none.
                {...(draftConflict || saveRefusal !== null
                  ? { held: "not saved" }
                  : saving || draft !== null
                    ? { held: "saving…" }
                    : asking
                      ? { held: "asking…" }
                      : {})}
              />
            )}
            <div className="fy-ch__foot">
              <span className="fy-mono">{foot}</span>
              <span className="fy-ch__foot-push" />
              {richRefusal ? (
                <span className="fy-mono">{richRefusal.message}</span>
              ) : (
                <Button variant="ghost" disabled={locked} onClick={() => setPreferSource((source) => !source)}>
                  {preferSource ? "Rich text" : "Markdown source"}
                </Button>
              )}
            </div>
          </div>

          <aside className="fy-ch__side">
            {view === "audiobook" && (
              <AudiobookSide
                rows={audiobook.rows}
                selected={audiobook.selected}
                record={audiobookRecord.record === "unreadable" ? null : audiobookRecord.record}
                artifacts={world.artifacts}
                slug={worldSlug}
                productionId={prodId}
                chapterId={chapter.id}
                chapterTitle={chapter.title}
                modelOf={audiobook.modelOf}
                onSetDirection={audiobook.setDirection}
                onMakeAgain={audiobook.makeAgain}
                refused={audiobook.lastRecord?.refused ?? null}
                blockHost={(key) => audiobookColumn.current?.querySelector<HTMLElement>(`[data-block="${key}"] .fy-ab__text`) ?? null}
              />
            )}
            <section className="fy-bible__panel">
              <h2 className="fy-bible__paneltitle">The book</h2>
              <p className="fy-bible__empty fy-mono">
                {target === null
                  ? `${bookWords.toLocaleString()} words`
                  : `${bookWords.toLocaleString()} of ${target.toLocaleString()} words`}
              </p>
              {target !== null && (
                <div className="fy-ch__target" role="progressbar" aria-valuemin={0} aria-valuemax={target} aria-valuenow={Math.min(bookWords, target)}>
                  <span style={{ width: `${Math.min(100, Math.round((bookWords / target) * 100))}%` }} />
                </div>
              )}
            </section>

            {/* The style, in one line (turn 128); the cards are on the Overview, where it was settled. */}
            <section className="fy-bible__panel" data-testid="chapter-continuity">
              <h2 className="fy-bible__paneltitle fy-ch__paneltitle--row">
                After this chapter
                <span className="fy-ch__panelpush" />
                {derivingNow ? (
                  <span className="fy-ch__deriving">
                    <span className="fy-mono">deriving…</span>
                    {/* Stop stands where the press stood (codex on PR 907): a slow or mistaken run
                        is the author's to end, and a stop leaves the last record standing. */}
                    <button type="button" className="fy-ch__derive" onClick={() => stopContinuity(worldId, prodId, chapter.file)}>
                      Stop
                    </button>
                  </span>
                ) : (
                  <button type="button" className="fy-ch__derive" disabled={locked || connection !== "open"} onClick={derive}>
                    <RotateCcw size={11} />
                    {continuity === null ? "Derive" : "Derive again"}
                  </button>
                )}
              </h2>
              <p className="fy-ch__scope fy-mono">where they end up · what they learn here</p>
              {continuity === "unreadable" && <div className="fy-ch__moved fy-ch__moved--line">record unreadable · Derive again replaces it</div>}
              {continuityStale && continuityRecord !== null && (
                <div className="fy-ch__moved fy-ch__moved--line">chapter moved · derived against v{continuityRecord.version}</div>
              )}
              {deriveNote !== null && !derivingNow && <div className="fy-ch__moved fy-ch__moved--line">{deriveNote}</div>}
              {continuityRecord === null ? (
                continuity === "unreadable" ? null : <p className="fy-bible__empty">Not derived yet.</p>
              ) : continuityRecord.characters.length === 0 ? (
                <p className="fy-bible__empty">Nothing placed yet.</p>
              ) : (
                <ul className="fy-ch__who">
                  {continuityRecord.characters.map((who) => (
                    <li key={who.sheet ?? who.character}>
                      <div className="fy-ch__who-head">
                        <span className="fy-ch__who-name">{named(who)}</span>
                        {who.where !== undefined && (
                          <span className="fy-ch__who-where fy-mono" title={who.placed}>
                            <Pin size={10} />
                            {sheetName(who.where)}
                          </span>
                        )}
                        {!who.present && (
                          <span className="fy-ch__who-where fy-mono" title={who.placed}>
                            gone
                          </span>
                        )}
                        {who.unsure && (
                          <span className="fy-ch__who-where fy-mono" title="the chapter said they moved and could not prove where">
                            place dropped
                          </span>
                        )}
                        {sheetNow(who) && (
                          <span className="fy-ch__who-where fy-mono" title="Derive again to make them a column">
                            has a sheet now
                          </span>
                        )}
                      </div>
                      {who.knows.slice(0, 3).map((line) => (
                        <div key={line} className="fy-ch__line">“{line}”</div>
                      ))}
                      {who.knows.length > 3 && <div className="fy-ch__line fy-ch__line--more">and {who.knows.length - 3} more</div>}
                    </li>
                  ))}
                </ul>
              )}
              {continuityRecord !== null && <p className="fy-ch__stamp fy-mono">{continuityStamp(continuityRecord)}</p>}
            </section>

            <section className="fy-bible__panel" data-testid="chapter-voices">
              <h2 className="fy-bible__paneltitle fy-ch__paneltitle--row">
                Voices
                <span className="fy-ch__panelpush" />
                {castingNow ? (
                  <span className="fy-ch__deriving">
                    <span className="fy-mono">casting…</span>
                    <button type="button" className="fy-ch__derive" onClick={() => stopVoices(worldId, prodId, chapter.file)}>
                      Stop
                    </button>
                  </span>
                ) : (
                  <button type="button" className="fy-ch__derive" disabled={locked || connection !== "open"} onClick={castLinesPress}>
                    <RotateCcw size={11} />
                    {voices === null ? "Cast the lines" : "Cast again"}
                  </button>
                )}
              </h2>
              <p className="fy-ch__scope fy-mono">who speaks · in whose voice</p>
              {voices === "unreadable" && <div className="fy-ch__moved fy-ch__moved--line">record unreadable · Cast again replaces it</div>}
              {voicesStale && voicesRecord !== null && (
                <div className="fy-ch__moved fy-ch__moved--line">chapter moved · cast against v{voicesRecord.version}</div>
              )}
              {castNote !== null && !castingNow && <div className="fy-ch__moved fy-ch__moved--line">{castNote}</div>}
              {voicesRecord === null ? (
                voices === "unreadable" ? null : <p className="fy-bible__empty">Not cast yet.</p>
              ) : (
                <ul className="fy-ch__who">
                  <li>
                    <div className="fy-ch__who-head">
                      <span className="fy-ch__who-name">Narration</span>
                      <span className="fy-ch__who-where fy-mono">{narratorName} · narrator</span>
                      <span className="fy-ch__who-count fy-mono">{narrationBlocks} blocks</span>
                    </div>
                  </li>
                  {speakers.map((who) => {
                    const sheet = who.sheet === undefined ? undefined : world.sheets.find((candidate) => candidate.id === who.sheet);
                    const voice = sheet?.voice;
                    return (
                      <li key={who.sheet ?? who.speaker}>
                        <div className="fy-ch__who-head">
                          <span className="fy-ch__who-name">{sheet?.name ?? who.speaker}</span>
                          {voice !== undefined && voiceUnavailable(voice) ? (
                            <span className="fy-ch__who-where fy-mono fy-ch__who-where--warn">voice unavailable · narrator</span>
                          ) : voice !== undefined ? (
                            <span className="fy-ch__who-where fy-mono">{voice.label ?? voice.voiceId} · {voice.provider}</span>
                          ) : who.sheet === undefined ? (
                            <span className="fy-ch__who-where fy-mono fy-ch__who-where--warn">no sheet · narrator</span>
                          ) : (
                            <span className="fy-ch__who-where fy-mono fy-ch__who-where--warn">no voice · narrator</span>
                          )}
                          <span className="fy-ch__who-count fy-mono">{who.lines} line{who.lines === 1 ? "" : "s"}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {voicesRecord !== null && (
                <p className="fy-ch__stamp fy-mono">
                  {[
                    `cast · v${voicesRecord.version}`,
                    `${voicesRecord.lines.length} line${voicesRecord.lines.length === 1 ? "" : "s"}`,
                    `${speakers.length} speaker${speakers.length === 1 ? "" : "s"}`,
                    voicesRecord.dropped === 0 ? "every line is the chapter’s own words" : `${voicesRecord.dropped} line${voicesRecord.dropped === 1 ? "" : "s"} dropped, not in the chapter`,
                    ...(voicesRecord.omitted > 0 ? [`${voicesRecord.omitted} line${voicesRecord.omitted === 1 ? "" : "s"} over the cap`] : []),
                    ...(voiced.ambiguous > 0 ? [`${voiced.ambiguous} ambiguous`] : []),
                  ].join(" · ")}
                </p>
              )}
            </section>

            {style !== null && (
              <section className="fy-bible__panel" data-testid="chapter-style">
                <h2 className="fy-bible__paneltitle">Style</h2>
                <p className="fy-ch__style">
                  {[...(style.pov !== undefined ? [style.pov] : []), ...(style.tense !== undefined ? [style.tense] : []), `v${style.version}`].join(" · ")}
                </p>
                <p className="fy-bible__empty fy-mono">settled in Develop</p>
              </section>
            )}

            <section className="fy-bible__panel">
              <h2 className="fy-bible__paneltitle">
                Implies <span className="fy-mono">{implies.length}</span>
              </h2>
              {implies.length === 0 ? (
                <p className="fy-bible__empty">Nothing implied yet.</p>
              ) : (
                <ul className="fy-ch__implies">
                  {implies.map((fact, i) => {
                    // The state lives on the item (codex on turn 127): a reload keeps what was
                    // pressed, and a proposed fact offers no Dismiss — the card is where a
                    // proposal is discarded.
                    const key = fact.id ?? `${i}:${fact.kind}:${fact.what}`;
                    const isProposed = fact.state === "proposed";
                    return (
                      <li key={key}>
                        <span className="fy-mono">{fact.kind}</span>
                        <span className="fy-ch__fact">{fact.what}</span>
                        {isProposed ? (
                          <span className="fy-mono">proposed</span>
                        ) : (
                          <Button
                            variant="ghost"
                            disabled={locked}
                            onClick={() => {
                              // Written first, said second: the state is the record, the line is the ask.
                              plan({ implies: implies.map((other, j) => (j === i ? { ...other, state: "proposed" as const } : other)) });
                              setSay((current) => ({ line: `Propose as ${fact.kind}: ${fact.what}`, seq: (current?.seq ?? 0) + 1 }));
                            }}
                          >
                            Propose
                          </Button>
                        )}
                        {!isProposed && (
                          <button
                            type="button"
                            className="fy-ch__dismiss"
                            aria-label="Dismiss"
                            disabled={locked}
                            onClick={() => {
                              const rest = implies.filter((_, j) => j !== i);
                              plan({ implies: rest.length === 0 ? null : rest });
                            }}
                          >
                            ×
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="fy-bible__panel">
              <h2 className="fy-bible__paneltitle">Draws on</h2>
              {drawsEmpty ? (
                <p className="fy-bible__empty">Draws on nothing yet</p>
              ) : (
                <ul className="fy-ch__draws">
                  {draws.sheets.map((slug) => {
                    const sheet = world.sheets.find((s) => s.id === slug);
                    // Each kind has its own screen; a sheet the world no longer holds still links
                    // to where it would be, and says its slug, rather than vanishing from the list.
                    const shelf = sheet?.type === "location" ? "locations" : sheet?.type === "faction" ? "factions" : "cast";
                    return (
                      <li key={`sheet:${slug}`}>
                        <Link className="fy-ch__draw" to={`/w/${encodeURIComponent(worldId)}/${shelf}/${encodeURIComponent(slug)}`}>
                          <span className="fy-mono">{sheet?.type ?? "sheet"}</span>
                          <span className="fy-ch__draw-name">{sheet?.name ?? slug}</span>
                        </Link>
                      </li>
                    );
                  })}
                  {draws.canon.map((id) => {
                    const entry = world.canon.find((c) => c.id === id);
                    return (
                      <li key={`canon:${id}`}>
                        <Link className="fy-ch__draw" to={`/w/${encodeURIComponent(worldId)}/canon/${encodeURIComponent(id)}`}>
                          <span className="fy-mono">{id}</span>
                          <span className="fy-ch__draw-name">{entry?.title ?? id}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="fy-bible__panel">
              <h2 className="fy-bible__paneltitle">Earlier versions</h2>
              {history.length === 0 ? (
                <p className="fy-bible__empty">No earlier version kept.</p>
              ) : (
                <>
                  <ul className="fy-bible__versions">
                    {history.map((version) => (
                      <li key={version}>
                        <span className="fy-mono">v{version}</span>
                        <Button variant="ghost" disabled={locked} onClick={() => restoreChapter(worldId, prodId, chapter.file, version)}>
                          Restore
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </aside>
        </div>
      </main>

      {dock ? (
        <ProductionConversation
          key={`dock:${say?.seq ?? 0}`}
          worldId={worldId}
          productionId={prodId}
          entry={{ kind: "production", productionId: prodId }}
          {...(say === null ? {} : { openWith: say.line })}
          // The selection travels beside the words as well as inside them (codex on turn 128):
          // the coordinator holds a revision that comes back to this chapter, this paragraph
          // and these words, whatever the model retold.
          subject={dockSubject}
          dock={{
            title: `Arke · Chapter ${String(chapter.order).padStart(2, "0")}`,
            subject: `${chapter.title} · ${production.meta.title}`,
            conversationFirst: true,
            onPutAway: () => setDock(false),
            ...(ask !== null ? { ask } : {}),
            onAsk: setAsk,
            // The first prompt follows the plan (turn 127): a synopsis with no prose is drafted
            // from; a chapter with prose is continued. While a passage is selected the prompts
            // are a revision's (turn 128), and the passage is the subject.
            // Holding against the style is a reply and nothing else: the send says so, and the
            // coordinator refuses any action the turn comes back with.
            // Under a derived chapter the prompts are questions the record can answer (turn 129);
            // under a stale one, the press that reads again and a question the prose answers.
            // In the Audiobook view the prompts are the reading's (turn 146, SPEC-047 R-31):
            // the direction, again once one stands, and two questions the blocks answer.
            prompts: view === "audiobook"
              ? [{ label: directionStands ? "Direct again" : "Direct this chapter", press: audiobook.directPress }, "Who reads this chapter?", "Which blocks are stale?"]
              : passage !== null
              ? [TIGHTEN.line, { label: HOLD_TO_STYLE.line, replyOnly: true }]
              : voicesRecord !== null && voicesStale
                ? [{ label: "Cast again", press: castLinesPress }, "Who speaks in this chapter?"]
                : voicesRecord !== null && speakers.length > 0 && !(continuityRecord !== null && continuityStale)
                  ? ["Who speaks in this chapter?", `Which lines are ${speakers[0]!.sheet !== undefined ? sheetNameOf(speakers[0]!.sheet) : speakers[0]!.speaker}’s?`]
              : continuityRecord !== null && continuityStale
                ? [{ label: "Derive again", press: derive }, "Who is in this chapter?"]
                : continuityRecord !== null && placedFirst !== undefined
                  ? [`What does ${named(placedFirst)} learn here?`, `Where is ${named(placedSecond ?? placedFirst)} now?`]
                  : [firstPrompt(live, chapter.synopsis), style !== null ? { label: "Hold this against the style", replyOnly: true } : "What does this chapter draw on?"],
            // The thread is the production's own (no new entry context, turn 126): the chapter
            // the dock names has to be in the words themselves or the studio never hears it.
            subjectPrefix: dockPrefix,
            // A line a menu press started is about the passage it was pressed on, and the dock
            // says that one, not whatever is selected now (codex on PR 1232).
            ...(shownSubject.kind === "passage" ? { subjectLine: `about this passage · ${countWords(shownSubject.text).toLocaleString()} words` } : {}),
          }}
          openingNote="opening…"
          emptyLine={`Nothing written with Arke for ${chapterLabel} yet.`}
          placeholder={`Ask about ${chapterLabel}`}
          {...(stagedDraft === undefined && view === "audiobook" && audiobook.directionRun !== undefined
            ? { side: <DirectionCard run={audiobook.directionRun} chapterOrder={chapter.order} onAccept={audiobook.accept} onDiscard={audiobook.discard} /> }
            : stagedDraft === undefined
            ? { pointsEmpty: "Nothing understood yet. As you talk, what Arke takes from the chapter appears here." }
            : {
                side: (
                  <StagedDecision
                    worldId={worldId}
                    subject={chapterLabel}
                    staged={stagedDraft.staged}
                    {...(accept !== undefined ? { accept } : {})}
                    items={[
                      passageChange !== null
                        ? {
                            label: `${chapterLabel} · passage`,
                            meta: `${countWords(passageChange.before).toLocaleString()} → ${countWords(passageChange.after).toLocaleString()} words`,
                          }
                        : {
                            label: `${chapterLabel} · draft`,
                            meta: stagedDraft.body !== null ? `${countWords(stagedDraft.body).toLocaleString()} words` : "draft",
                          },
                    ]}
                  />
                ),
              })}
        />
      ) : (
        <button type="button" className="fy-sw__rail" title="Pin the assistant back" onClick={() => setDock(true)}>
          <span className="fy-sw__rail-dot" aria-hidden="true" />
          <span className="fy-sw__rail-label">Ask Arke</span>
          <span className="fy-sw__rail-pin"><Pin size={13} /></span>
        </button>
      )}
    </div>
  );
}
