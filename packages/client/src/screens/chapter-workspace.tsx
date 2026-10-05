import { Composer } from "../components/composer.js";
import { HeldBar } from "../components/held-bar.js";
import { ResponsiveSheet } from "../components/responsive-sheet.js";
import { SceneBackRow } from "./scene-workspace/responsive-chrome.js";
import { Fragment, useId, useLayoutEffect, useEffect, useMemo, useRef, useState, useCallback } from "react";
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
  type BlockTimingInput,
  type ChapterAudiobook,
  narratorLabelFor,
  audiobookSpeakerColours,
  pinTarget,
  performanceNote,
  pinnedLines,
  castStanding,
  reconcileCast,
  legacyVoiceModel,
  voicedBlocks,
  type ProductionBundle,
  type ProseReadSource,
  type StagedProposal,
  type WorldChatSubject,
  type WorldBundle,
  overviewMoved,
  PASSAGE_KEPT_MAX,
  PASSAGE_SPAN_MAX,
  readerPlace,
  audiobookReadingNotes,
  voiceDisplayLabel,
  mainPhotoFor,
} from "@arke-studio/contracts";
import { ProductionConversation, StagedDecision, type DockAsk } from "../components/conversation.js";
import { RichMarkdownEditor } from "../components/editor/rich-markdown-editor.js";
import { updateRichModeGate, type RichModeGate } from "../components/editor/rich-mode.js";
import { Chat, ChevronDown, FileText, Pin, Play, RotateCcw, Sparkle, Speaker, X } from "../components/icons.js";
import { useMediaQuery } from "../lib/media-query.js";
import { rememberDock, rememberedDocks } from "../lib/chapter-dock.js";
import { PageReadControl, useProsePageRead, type PageRead, type PageReadBlock } from "../components/page-read.js";
import { EmptyState, Screen } from "../components/layout.js";
import { Button, cx } from "../components/ui.js";
import { continuityStamp } from "../lib/continuity.js";
import { passageAction, passageActions, type PassageAction } from "../lib/passage-actions.js";
import { useProduction } from "../lib/selectors.js";
import { EditableText, SceneTitle } from "./storyboard.js";
import { ListenButton, listenLeads } from "../components/audiobook-player.js";
import { BlockPicturePanel, pictureStart, useChapterPictures } from "../components/audiobook-picture.js";
import { IllustrationSheet, IllustrationStatus, useIllustration, useIllustrationSheet } from "../components/audiobook-illustrate.js";
import { LookSheet } from "../components/audiobook-look.js";
import { NewLookSheet } from "../components/audiobook-new-look.js";
import { AudiobookBlocks, AudiobookFilterMenu, AudiobookSide, BlockPanel, BlocksPress, useBlockSeamActs, DirectSheet, DirectionCard, MenuPress, NotesPress, ReadSheet, PerformedSpeaker, ReadingMenu, SpeakerLinesDialog, blockPanelHead, blockTakes, paragraphsToCast, useChapterAudiobook, type AudiobookIntent, type BlockRow, type PanelTab, type SpeakerChoices, type SpeakerPick } from "./chapter-audiobook.js";
import { NarratorDialog } from "./audiobook-narrator.js";
import { BlockTimingPanel, TimingProposalCard, TimingSide, TimingView, betweenClocks, chapterTimingOf, proposedView, timingLanes, useTimingProposal } from "./chapter-timing.js";
import { BedPanel, ReactionsPanel } from "../components/audiobook-beds.js";
import { dismissPlayback, playClip } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import {
  openChapter,
  setAudiobookReading,
  setAudiobookTiming,
  setAudiobookReaction,
  setAudiobookBed,
  setAudiobookSound,
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
  setAudiobookRecorded,
  setVoicePin,
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
  gateAnswered,
  forgetGateRequest,
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
/** Draws on's Add, started in the thread for the author to finish (design turn 192). */
const DRAWS_ON_LINE = "This chapter draws on ";

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

/** A suggested question: asked for its answer, so nothing is staged from it (issue 1295). */
function question(label: string): { label: string; replyOnly: true } {
  return { label, replyOnly: true };
}

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
/**
 * A partial accept on its way, by chapter, for the same reason (codex on PR 1232): the keep lands
 * after the screen may have gone, and the accept it promised is sent by the next one to see it.
 */
type HeldKeep = {
  id: string;
  revision: number;
  expected: string;
  rejoins: number;
  /** The consequences confirmed with the press, carried to the accept the keep promised. */
  confirm?: string;
  /** The keep itself, to send again under its own id after a rejoin that may have lost it. */
  request: { requestId: string; path: string; span: { before: string; after: string }; kept: number[] };
};
const heldKeeps = new Map<string, HeldKeep>();
/**
 * An accept on its way, by chapter: its decision holds the others until it settles. It keeps
 * what it sent, to send again under its own id after a rejoin that may have lost it.
 */
type HeldAccept = { id: string; rejoins: number; requestId: string; revision: number; confirm?: string };
const heldAccepts = new Map<string, HeldAccept>();
// Only for the world's session they were pressed in (codex on PR 1232): closed and opened again,
// an ask still waiting would otherwise go by itself, quoting prose that may have moved since.
onWorldChange(() => {
  heldAsks.clear();
  heldKeeps.clear();
  heldAccepts.clear();
});
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
  heldKeeps.clear();
  heldAccepts.clear();
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

/** What the Looks item says (design turn 194d): how many of the chapter's characters have a look chosen. */
function lookState(record: ChapterAudiobook | "unreadable" | null): string {
  const chosen = record === null || record === "unreadable" ? 0 : Object.values(record.look?.characters ?? {}).filter((who) => who.lookId !== undefined).length;
  return chosen > 0 ? `${chosen} chosen` : "";
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
  /** One proposal by id, whether or not it is the newest (codex on PR 1232). */
  id?: string,
): { staged: StagedProposal; body: string | null; before: string | null } | undefined {
  const staged = [...proposals]
    .filter((entry) => entry.proposal.kind === "chapter-draft" && entry.proposal.targets.some((t) => t.path === path))
    .filter((entry) => id === undefined || entry.proposal.id === id)
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
type AskAt = { top: number; left: number; end: boolean };
const ASK_UNPLACED: AskAt = { top: 0, left: 0, end: false };

/** The press beside words ending at (`right`, `bottom`) on screen, in the host's coordinates. */
function askBeside(host: HTMLElement, right: number, bottom: number): AskAt {
  const frame = host.getBoundingClientRect();
  const at = right - frame.left + 8;
  return {
    top: Math.max(0, bottom - frame.top - 22),
    left: Math.max(0, Math.min(at, frame.width - 150)),
    // The menu is wider than the press (codex on PR 1232): near the right edge it opens leftward
    // from the press's end rather than over the dock.
    end: at > frame.width - ASK_MENU_WIDTH,
  };
}

function askAt(host: HTMLElement | null): AskAt {
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  if (!host || !selection || selection.rangeCount === 0) return ASK_UNPLACED;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return ASK_UNPLACED;
  return askBeside(host, rect.right, rect.bottom);
}

/** What lays text out in a textarea, copied to the mirror that measures where a selection ends. */
const MIRRORED = [
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "fontFamily", "fontSize", "fontStyle", "fontVariant", "fontWeight", "letterSpacing", "lineHeight",
  "textIndent", "textTransform", "tabSize", "wordSpacing",
] as const;

/**
 * The same for the Markdown source (codex on PR 1232): a textarea's selection is not the
 * document's, so `getSelection` measures nothing there, or something stale elsewhere. Where its
 * selection ends is found by laying the text before it out again in a hidden copy of the box.
 */
function askAtSource(host: HTMLElement | null, area: HTMLTextAreaElement): AskAt {
  if (!host || typeof window.getComputedStyle !== "function") return ASK_UNPLACED;
  const box = area.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return ASK_UNPLACED;
  const style = window.getComputedStyle(area);
  const mirror = document.createElement("div");
  for (const key of MIRRORED) mirror.style[key] = style[key];
  // As wide as the text the box actually wraps (codex on PR 1232): its client width, padding in
  // and border and scrollbar out. The CSS width would include a scrollbar the mirror lacks, and
  // lines would break elsewhere. The border is added back when the offsets are placed.
  Object.assign(mirror.style, {
    position: "absolute", top: "0", left: "-9999px", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word",
    height: "auto", boxSizing: "border-box", border: "0",
    ...(area.clientWidth > 0 ? { width: `${area.clientWidth}px` } : {}),
  });
  mirror.textContent = area.value.slice(0, area.selectionEnd);
  const mark = document.createElement("span");
  mark.textContent = "\u200b";
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  // A layout-less DOM (the tests') measures nothing; the offsets then count as the box's corner.
  const [offsetTop, offsetHeight] = [mark.offsetTop || 0, mark.offsetHeight || 0];
  mirror.remove();
  const border = (side: string) => parseFloat(side) || 0;
  return askBeside(
    host,
    // Keep the line's height, but put the press in the source's reserved right gutter. The
    // selection can end mid-line, where anchoring at its last word would cover the next ones.
    box.right,
    box.top + border(style.borderTopWidth) + offsetTop + offsetHeight - (area.scrollTop || 0),
  );
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
  const navigate = useNavigate();
  const prodId = production.meta.id;
  const path = chapterPath(production, chapter);
  const { connection, rejoins } = useStore();

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
  /** A cast asked for while a save was pending, the same way (turn 130); `changed` for the edited paragraphs alone (turn 198). */
  const castAfterSave = useRef<false | { scope?: "changed" }>(false);
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
        if (castAfterSave.current !== false) {
          const { scope } = castAfterSave.current;
          castAfterSave.current = false;
          castVoices(worldId, prodId, chapter.file, scope);
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
  // Where the cast stands against the saved words (design turn 198): current, stale in the
  // paragraphs an edit touched, or — a cast from before paragraph hashes — stale whole (`moved`).
  const castStand = useMemo(
    () => (voicesRecord === null ? null : castStanding(voicesRecord, record?.body ?? live, chapter.bodyHash)),
    [voicesRecord, record?.body, live, chapter.bodyHash],
  );
  const voicesStale = castStand !== null && !castStand.current;
  const voicesMoved = voicesStale && castStand.legacy;
  const toCastCount = castStand?.toCast.length ?? 0;
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
  // `changed` casts only the paragraphs edited since the cast (design turn 198, rule 13).
  const castLinesPress = (scope?: "changed") => {
    if (castingNow || locked) return;
    if ((draft !== null && draft !== live) || pendingSave.current !== null) {
      castAfterSave.current = scope !== undefined ? { scope } : {};
      if (draft !== null && draft !== live) flushSave(draft);
      return;
    }
    castVoices(worldId, prodId, chapter.file, scope);
  };
  /** Who speaks, by lines, the narration first: the Voices panel's rows. */
  // The lines as read, the author's pins applied (SPEC-012 R-64): what the panel counts is what is voiced.
  // Held to the prose first (design turn 198): a moved paragraph keeps its lines, a kept line counts.
  const castLinesRead = useMemo(() => {
    if (voicesRecord === null) return [];
    const standing = reconcileCast(voicesRecord, live);
    return pinnedLines(standing.lines, standing.pins, live).lines;
  }, [voicesRecord, live]);
  const speakers = useMemo(() => {
    const counts = new Map<string, { speaker: string; sheet?: string; lines: number }>();
    for (const line of castLinesRead) {
      const key = line.sheet ?? line.speaker;
      const held = counts.get(key);
      if (held !== undefined) held.lines += 1;
      else counts.set(key, { speaker: line.speaker, ...(line.sheet !== undefined ? { sheet: line.sheet } : {}), lines: 1 });
    }
    return [...counts.values()].sort((a, b) => b.lines - a.lines || a.speaker.localeCompare(b.speaker));
  }, [castLinesRead]);
  const narrationBlocks = voiced.blocks.filter((block) => block.speaker === undefined).length;
  // The Voices dot is the Audiobook view's speaker colour (SPEC-047 R-33), one a speaker across the book.
  const speakerColours = useMemo(
    () => audiobookSpeakerColours(production?.chapters ?? [], speakers.flatMap((who) => (who.sheet !== undefined ? [who.sheet] : []))),
    [production?.chapters, speakers],
  );
  const narratorName = narratorLabelFor(useStore().state?.app.narrator ?? null, world.meta.worldId);
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
    // The shipped narrator's read (design turn 182) waits for the save too; a second press reads.
    beginShipped: () => {
      if ((draft !== null && draft !== live) || pendingSave.current !== null) {
        if (draft !== null && draft !== live) flushSave(draft);
        return;
      }
      voicedRead.beginShipped();
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
  // Timing (design turn 187) is the third view, in the address the same way.
  const viewParam = searchParams.get("view");
  const view: "manuscript" | "audiobook" | "timing" = viewParam === "audiobook" ? "audiobook" : viewParam === "timing" ? "timing" : "manuscript";
  const chooseView = (next: "manuscript" | "audiobook" | "timing") =>
    setSearchParams(
      (params) => {
        const copy = new URLSearchParams(params);
        if (next !== "manuscript") copy.set("view", next);
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
  // Below 700 the Audiobook view is one column and a block's panel is a sheet (turn 165l).
  const phone = useMediaQuery("(max-width: 599px)");
  const compact = useMediaQuery("(max-width: 1099px)");
  const coarse = useMediaQuery("(pointer: coarse)");
  const [notesOpen, setNotesOpen] = useState(false);
  const [synopsisOpen, setSynopsisOpen] = useState(false);
  const [blockSheet, setBlockSheet] = useState(compact);
  const [blockSelection, setBlockSelection] = useState<import("./chapter-audiobook.js").BlockSelection | null>(null);
  // The Timing view's playhead (turn 187a), on the view's clock; a new chapter starts at its head.
  const [playhead, setPlayhead] = useState(0);
  useEffect(() => setPlayhead(0), [chapter.id]);
  const chapterCentre = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = chapterCentre.current;
    if (!node) return;
    const measure = () => setBlockSheet(compact || node.clientWidth > 0 && node.clientWidth < 900);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [compact]);
  // Illustrate this chapter (design turn 191b): the proposal this window holds, dashed on the blocks and listed in the dock's card.
  const illustration = useIllustration(worldId, prodId, chapter);
  const illustrationSheet = useIllustrationSheet(illustration.run);
  const [illustrationLookOpen, setIllustrationLookOpen] = useState(false);
  // Make a look from a held row of the proposal (design turn 193h, rule 17): the same sheet the Looks opens, for that character.
  const [lookToMake, setLookToMake] = useState<{ key: string; name: string; sheet: string; line: string } | null>(null);
  const audiobook = useChapterAudiobook({
    worldId,
    prodId,
    chapter,
    body: record?.body ?? "",
    cast: voicesRecord,
    record: audiobookRecord.record,
    missing: audiobookRecord.missing,
    reading: production.audiobook?.reading ?? "narrator",
    ...(production.audiobook?.recorded !== undefined ? { recorded: production.audiobook.recorded } : {}),
    ...(production.audiobook?.notes !== undefined ? { notes: production.audiobook.notes } : {}),
    ...(production.audiobook?.narrator !== undefined ? { bookNarrator: production.audiobook.narrator } : {}),
    readingNotes: audiobookReadingNotes(production.audiobook, chapter.id),
    ...(production.audiobook?.requests !== undefined ? { requests: production.audiobook.requests } : {}),
    connection,
    locked: locked || record === null,
    listenLeads: listenLeads(production, chapter.id),
    compact,
    // On a phone the Blocks press and its Reset are in the toolbar's ⋯ (design turn 198, rule 10).
    seamsInMenu: phone,
    // What the Direct and illustrate menu says of each (design turn 194, rule 3), and the run line
    // that takes the menu's place while pictures are read or made.
    illustrate: {
      press: illustration.press,
      busy: illustration.busy,
      again: illustration.run?.state === "proposed",
      state: illustration.run?.state === "proposed" ? `${illustration.proposed.size} to make` : "",
      ...(illustration.run?.state === "reading"
        ? { running: { line: "illustrating…", stop: illustration.stop } }
        : illustration.run?.state === "making" && illustration.run.progress !== undefined
          ? { running: { line: `making pictures · ${illustration.run.progress.made.length} of ${illustration.run.progress.total}`, stop: illustration.stop } }
          : {}),
    },
    looks: { open: () => setIllustrationLookOpen(true), state: lookState(audiobookRecord.record) },
    // Cast the edited paragraphs or the chapter from the view (design turn 198), as the rail does.
    casting: { press: castLinesPress, busy: castingNow },
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
  // Who a block can be given to (design turn 155b, SPEC-012 R-63): offered while the cast can be
  // written — a pin names a paragraph and an occurrence in the saved prose. A cast stale only in
  // some paragraphs keeps it on (design turn 198, rule 14); the row whose words wait for their
  // paragraph's cast has none. A cast stale whole, from before paragraph hashes, does not.
  const pinChoices = useMemo((): SpeakerChoices | null => {
    if (voicesRecord === null || voicesMoved || castingNow || locked || record === null || connection !== "open") return null;
    const chapterSpeakers = new Map<string, SpeakerChoices["chapter"][number]>();
    for (const row of audiobook.rows) {
      if (row.speakerKey === null || chapterSpeakers.has(row.speakerKey)) continue;
      chapterSpeakers.set(row.speakerKey, { key: row.speakerKey, label: row.full, ...(row.block.sheet !== undefined ? { sheet: row.block.sheet } : {}), colour: row.colour });
    }
    const cast = world.sheets
      .filter((sheet) => sheet.type === "character" && !sheet.retired && (sheet.production === undefined || sheet.production === prodId) && !chapterSpeakers.has(sheet.id))
      .map((sheet) => ({ sheet: sheet.id, label: sheet.name, voice: sheet.voice === undefined ? null : voiceDisplayLabel(sheet.voice, world), colour: null }));
    return { chapter: [...chapterSpeakers.values()], cast };
  }, [voicesRecord, voicesMoved, castingNow, locked, record, connection, audiobook.rows, world.sheets, prodId]);
  const pinBlock = (row: BlockRow, pick: SpeakerPick, selection?: { from: number; to: number }) => {
    const index = audiobook.rows.indexOf(row);
    const target = pinTarget(record?.body ?? "", audiobook.rows.map((candidate) => candidate.block), index, selection);
    if (target === null) return;
    setVoicePin(worldId, prodId, chapter.file, { ...target, ...pick });
  };
  // A recorded speaker's lines out and back (turn 155d), opened from the block's Takes panel.
  const [linesFor, setLinesFor] = useState<{ speaker: string; label: string } | null>(null);
  // One narrator performs the cast (turn 155g): the speaker whose note row is focused, and the
  // book's narrator dialog, opened from the Narration row (R-46).
  const [performer, setPerformer] = useState<string | null>(null);
  const [narratorOpen, setNarratorOpen] = useState(false);
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
    beginShipped: () => {
      if (draft !== null && draft !== live) {
        flushSave(draft);
        return;
      }
      pageRead.beginShipped();
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

  /*
   * Arke's dock, by view (design turn 194, rule 13). The Manuscript keeps it open at 1100 and wider;
   * Audiobook and Timing start with it put away, the list and the panel taking its room. Whatever the
   * author does with it is remembered on this device for that view, so opening it in Audiobook keeps
   * it open there next time. It used to be one `useState(!compact)`, forgotten on every visit, which
   * put the thread over a list that needed the width. Narrow, the dock is a sheet and starts closed.
   */
  const [dockByView, setDockByView] = useState(rememberedDocks);
  const [compactDock, setCompactDock] = useState(false);
  const dock = compact ? compactDock : dockByView[view];
  const setDock = useCallback((open: boolean) => {
    if (compact) {
      setCompactDock(open);
      return;
    }
    setDockByView((held) => ({ ...held, [view]: open }));
    rememberDock(view, open);
  }, [compact, view]);
  const [passageLine, setPassageLine] = useState("");
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
  const onSelect = useCallback((text: string | null, paragraph: number | null = null, source?: HTMLTextAreaElement) => {
    const subject = passageSubject(text);
    const at = source === undefined ? askAt(manuscriptRef.current) : askAtSource(manuscriptRef.current, source);
    // Native selection may collapse when the ask field receives focus. Keep its captured subject.
    const inAsk = document.activeElement?.closest(".fy-passage-ask");
    if (subject !== null || !coarse || !inAsk) setSelection(subject === null ? null : { text: subject, paragraph, ...at });
    // A subject flushes the pending autosave, as Read the chapter does (codex on turn 128): the
    // words the thread hears must be the words the coordinator will find, and an ask sent inside
    // the autosave window would otherwise quote prose the file does not hold yet.
    if (subject !== null && timer.current !== null && draftRef.current !== null) flushSave(draftRef.current);
  }, [flushSave, coarse]);
  // The words come from the text the editor holds, not the element's value: the two are the same
  // string in a browser, and only the first is there under test.
  const onTextareaSelect = (e: { currentTarget: HTMLTextAreaElement }) => {
    const { selectionStart, selectionEnd } = e.currentTarget;
    const selected = text.slice(selectionStart, selectionEnd);
    // Anchored at the first word the ask quotes (codex on PR 1232): a drag begun on the blank line
    // before a paragraph is trimmed to that paragraph's words, and must be placed in it too.
    const lead = selected.length - selected.trimStart().length;
    onSelect(selectionStart === selectionEnd ? null : selected, paragraphAt(text, selectionStart + lead), e.currentTarget);
  };
  useEffect(() => {
    const selected = () => {
      const area = document.activeElement;
      if (area?.tagName === "TEXTAREA" && manuscriptRef.current?.contains(area)) onTextareaSelect({ currentTarget: area as HTMLTextAreaElement });
    };
    document.addEventListener("selectionchange", selected);
    return () => document.removeEventListener("selectionchange", selected);
  }, [text, onSelect]);
  useLayoutEffect(() => {
    const area = manuscriptRef.current?.querySelector<HTMLTextAreaElement>(".fy-ch__source");
    if (!area || !compact) return;
    const fit = () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight}px`; };
    fit();
    window.addEventListener("resize", fit);
    return () => { window.removeEventListener("resize", fit); area.style.height = ""; };
  }, [compact, text, view, richMode]);
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
  // The dock's head, and the sheet's on a phone: Arke names what it is about (126a, 172a, 195g).
  const dockTitle = `Arke · Chapter ${String(chapter.order).padStart(2, "0")}`;
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
  // Draws on is changed in the thread (turn 126): Add only starts the line there, for the author
  // to finish with what the chapter draws on.
  const askDraws = () => {
    setDock(true);
    setAsk({ press: crypto.randomUUID(), line: DRAWS_ON_LINE, text: `${dockPrefix} ${DRAWS_ON_LINE}`, draft: true });
  };
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
  // A passage that removes whole paragraphs has no replacement to stand in their place: what it
  // removes is drawn struck instead, or the page would show nothing to decide (codex on PR 1232).
  // Read from its one edit rather than the span, which is widened to whole words and so carries
  // the next paragraph's first word when the cut is in the chapter's middle. Told by a line
  // break among what goes: words cut inside a paragraph still mark the paragraph, as always.
  const lone = editCount === 1 ? segments.find((segment) => segment.kind === "edit") : undefined;
  const removed = lone?.kind === "edit" && lone.after.trim() === "" && lone.before.includes("\n") ? lone.before.trim() : null;
  const cut = removed !== null;
  const struck = removed === null ? null : <p className="fy-ch__passage"><del>{removed}</del></p>;
  const edits = () =>
    segments.map((segment, n) =>
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
          {coarse && <span className="fy-ch__edit-state">{refused.has(segment.index) ? "Refused" : "Kept"}</span>}
        </button>
      ),
    );
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
  const [keeping, setKeepingState] = useState<HeldKeep | null>(() => heldKeeps.get(parkedKey(worldId, prodId, path)) ?? null);
  const setKeeping = (next: HeldKeep | null) => {
    const key = parkedKey(worldId, prodId, path);
    // A settled request's answer is no longer wanted; the store keeps it until told so.
    const was = heldKeeps.get(key)?.request.requestId;
    if (was !== undefined && was !== next?.request.requestId) forgetGateRequest(was);
    if (next === null) heldKeeps.delete(key);
    else heldKeeps.set(key, next);
    setKeepingState(next);
  };
  // A keep sent into a connection that then dropped has no answer coming (codex on PR 1232): the
  // rejoin brings the snapshot as it was, so the wait ends with the connection, not with a reply.
  // The keep's own proposal, whether or not a newer draft has since taken the card (codex on PR
  // 1232): the keep can still land on it, and its accept is still owed.
  const kept = keeping === null ? undefined : stagedChapterDraft(world.proposals, path, keeping.id);
  const keptRevision = kept?.staged.proposal.draftRevision;
  const keptBody = kept?.body ?? null;
  useEffect(() => {
    if (keeping === null) return;
    if (kept === undefined) setKeeping(null);
    else if (keptRevision !== undefined && keptRevision > keeping.revision) {
      // Only the keep's own revision is accepted, and fenced to it (codex on PR 1232): the keep
      // moves the draft exactly one revision, so a later one carries some other edit too —
      // perhaps to a field the prose does not show — and is left for the author. One moved on
      // again before the accept reaches the gate is refused there as stale. The accept holds the
      // controls in its turn, so nothing races it between the two (codex on PR 1232).
      const requestId = crypto.randomUUID();
      if (keptRevision === keeping.revision + 1 && keptBody === keeping.expected
        && acceptProposal(worldId, keeping.id, keeping.confirm, keptRevision, requestId)) {
        setAccepting({ id: keeping.id, requestId, revision: keptRevision, ...(keeping.confirm !== undefined ? { confirm: keeping.confirm } : {}) });
      }
      setKeeping(null);
    } else if (gateAnswered(keeping.request.requestId)) {
      setKeeping(null);
    } else if (connection === "open" && rejoins !== keeping.rejoins) {
      // A rejoin does not say whether the keep landed (codex on PR 1232): it may have reached the
      // gate before the drop and still be writing. Sent again under its own id, the gate makes
      // the same edit once — landed already, it answers with it; lost, it lands now.
      const { requestId, path: keptPath, span, kept } = keeping.request;
      if (updateProposalPassage(worldId, keeping.id, keptPath, span, kept, keeping.revision, requestId)) {
        setKeeping({ ...keeping, rejoins });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keeping, connection, rejoins, kept === undefined, keptRevision, keptBody, notices, worldId]);
  /*
   * A whole accept in flight holds the choices too (codex on PR 1232): toggled after the press,
   * they would show a count the gate is not accepting. It is fenced to the revision on screen,
   * and held until the proposal is gone or the gate refuses this request by its id.
   */
  // Held outside the screen, like the keep (codex on PR 1232): back on the chapter while it runs,
  // the other decisions still wait. Settled by the proposal going or by its own refusal; a rejoin
  // that may have lost the answer sends the same accept again, fenced to the same revision, which
  // cannot land twice — accepted already, the proposal is gone.
  const [accepting, setAcceptingState] = useState<HeldAccept | null>(() => heldAccepts.get(parkedKey(worldId, prodId, path)) ?? null);
  const setAccepting = (next: Omit<HeldAccept, "rejoins"> | null) => {
    const key = parkedKey(worldId, prodId, path);
    const was = heldAccepts.get(key)?.requestId;
    if (was !== undefined && was !== next?.requestId) forgetGateRequest(was);
    const held = next === null ? null : { ...next, rejoins };
    if (held === null) heldAccepts.delete(key);
    else heldAccepts.set(key, held);
    setAcceptingState(held);
  };
  // Its own proposal too: gone is accepted (or discarded); a newer draft on the card is not.
  const acceptingGone = accepting !== null && stagedChapterDraft(world.proposals, path, accepting.id) === undefined;
  useEffect(() => {
    if (accepting === null) return;
    if (acceptingGone || gateAnswered(accepting.requestId)) setAccepting(null);
    else if (connection === "open" && rejoins !== accepting.rejoins
      && acceptProposal(worldId, accepting.id, accepting.confirm, accepting.revision, accepting.requestId)) {
      setAccepting(accepting);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accepting, connection, rejoins, acceptingGone, notices]);
  // Every passage accept is fenced to the revision on screen (codex on PR 1232), one edit or many.
  const pending = keeping !== null || accepting !== null;
  // Too long for the frame a keep travels in (codex on PR 1232): a span widened to whole words
  // round an unbroken run can outgrow it, and the transport would drop the keep unanswered.
  const keepFits = passageChange !== null && passageChange.before.length <= PASSAGE_SPAN_MAX
    && passageChange.after.length <= PASSAGE_SPAN_MAX && editCount <= PASSAGE_KEPT_MAX;
  const accept = stagedDraft === undefined
    ? undefined
    : passageChange === null
      // A newer draft that took the card while a keep or accept of the passage before it is
      // still held (codex on PR 1232): the same chapter, so its decisions wait for that one.
      ? pending ? { pending, blocked: keeping !== null ? "Keeping…" : "Accepting…" } : undefined
    : !choosing || keptCount === editCount
      ? {
          label: "Accept",
          pending,
          ...(accepting !== null ? { blocked: "Accepting…" } : {}),
          onAccept: (confirmSignature?: string) => {
            const proposal = stagedDraft.staged.proposal;
            const requestId = crypto.randomUUID();
            if (acceptProposal(worldId, proposal.id, confirmSignature, proposal.draftRevision, requestId)) {
              setAccepting({
                id: proposal.id, requestId, revision: proposal.draftRevision,
                ...(confirmSignature !== undefined ? { confirm: confirmSignature } : {}),
              });
            }
          },
        }
      : {
          label: `Accept ${keptCount} of ${editCount}`,
          pending,
          ...(keptCount === 0
            ? { blocked: "Nothing kept" }
            : !keepFits ? { blocked: "Too long to keep in part" } : keeping !== null ? { blocked: "Keeping…" } : {}),
          onAccept: (confirmSignature?: string) => {
            if (!keepFits) return;
            const proposal = stagedDraft.staged.proposal;
            const kept = segments.flatMap((segment) => (segment.kind === "edit" && !refused.has(segment.index) ? [segment.index] : []));
            // Nothing sent is nothing to wait for (codex on PR 1232): the press stays the author's.
            const requestId = crypto.randomUUID();
            if (!updateProposalPassage(worldId, proposal.id, path, passageChange, kept, proposal.draftRevision, requestId)) return;
            const body = stagedDraft.body ?? live;
            const expected = body.slice(0, passageChange.start) + composePassage(segments, new Set(kept)) + body.slice(passageChange.start + passageChange.after.length);
            setKeeping({
              id: proposal.id, revision: proposal.draftRevision, expected, rejoins,
              // The consequences confirmed with this press (codex on PR 1232): the accept after
              // the keep carries them, rather than asking the author to confirm them again.
              ...(confirmSignature !== undefined ? { confirm: confirmSignature } : {}),
              request: { requestId, path, span: { before: passageChange.before, after: passageChange.after }, kept },
            });
          },
        };
  const foot = locked && stagedDraft !== undefined
    ? `Locked while a ${waiting} waits · v${record?.version ?? chapter.version} · ${words.toLocaleString()} words`
    : saveRefusal !== null
      ? `Not saved · ${saveRefusal}`
      : saving
        ? "Saving…"
        : `Saved · v${record?.version ?? chapter.version} · ${words.toLocaleString()} words`;

  // Timing (design turn 187): one write a change, answered as the record; the same values from
  // the Timing view and from the block panel.
  const timingLocked = locked || record === null || connection !== "open" || audiobook.run?.state === "reading";
  // Propose timing (design turn 187b): drawn dashed on the view until accepted whole.
  const timingProposal = useTimingProposal({ worldId, prodId, chapterId: chapter.id, chapterFile: chapter.file, connection });
  const proposalView = useMemo(
    () => proposedView(audiobookRecord.record === "unreadable" ? null : audiobookRecord.record, timingProposal.proposal, audiobook.rows.map((row) => row.block)),
    [audiobookRecord.record, timingProposal.proposal, audiobook.rows],
  );
  const shownTiming = useMemo(
    () => (timingProposal.proposal === null ? audiobook.timing : chapterTimingOf(audiobook.rows, proposalView.record, world.artifacts, production.audiobook?.reading ?? "narrator", "estimate", audiobookRecord.missing)),
    [timingProposal.proposal, audiobook.timing, audiobook.rows, proposalView.record, world.artifacts, production.audiobook?.reading, audiobookRecord.missing],
  );
  const onTiming = (key: string, input: BlockTimingInput) => {
    if (timingLocked) return;
    setAudiobookTiming(worldId, prodId, chapter.file, key, input);
  };
  const selectedBar = audiobook.timing.bars.find((bar) => bar.key === audiobook.selected) ?? null;
  const selectedTimingRow = audiobook.rows.find((row) => row.block.key === audiobook.selected) ?? null;
  const mixAt = audiobook.mixPlayer.playing ? audiobook.mixPlayer.at : null;
  const shownPlayhead = mixAt !== null ? betweenClocks(audiobook.mixed, audiobook.timing, mixAt) : playhead;
  const selectedGroup = (() => {
    const held = audiobookRecord.record === "unreadable" ? null : audiobookRecord.record;
    const take = held?.takes[audiobook.selected ?? ""];
    if (take?.grouped === undefined) return null;
    // Numbered as the chapter's requests fall in reading order.
    const requests = [...new Set(audiobook.rows.flatMap((row) => { const grouped = held?.takes[row.block.key]?.grouped; return grouped !== undefined ? [grouped.request] : []; }))];
    return `request ${requests.indexOf(take.grouped.request) + 1}`;
  })();
  // Reactions under the block, and the bed and the sound on it (design turn 187a, 187d).
  const timedRecord = audiobookRecord.record === "unreadable" ? null : audiobookRecord.record;
  const reactors = [{ key: "narrator", name: "Narrator" }, ...timingLanes(audiobook.rows).filter((lane) => lane.id !== "narration").map((lane) => ({ key: lane.id, name: lane.name }))];
  const soundsPanel = selectedTimingRow === null ? null : (
    <>
      <ReactionsPanel
        record={timedRecord}
        timing={audiobook.timing}
        row={selectedTimingRow}
        speakers={reactors}
        locked={timingLocked}
        onReaction={(key, reaction) => !timingLocked && setAudiobookReaction(worldId, prodId, chapter.file, key, reaction)}
      />
      <BedPanel
        worldId={worldId}
        world={world}
        record={timedRecord}
        timing={audiobook.timing}
        rows={audiobook.rows}
        row={selectedTimingRow}
        locked={timingLocked}
        onBed={(key, bed) => !timingLocked && setAudiobookBed(worldId, prodId, chapter.file, key, bed)}
        onSound={(key, sound) => !timingLocked && setAudiobookSound(worldId, prodId, chapter.file, key, sound)}
      />
    </>
  );
  // The block panel's Timing tab (design turn 194g): its timing, then its reactions and bed, then
  // Play with neighbours and Open in Timing — the Timing view, on the same block.
  const timingPanel = (
    <BlockTimingPanel
      bar={selectedBar}
      timing={audiobook.timing}
      slug={worldSlug}
      onTiming={onTiming}
      onPlayWindow={(from, to) => audiobook.mixPlayer.play(betweenClocks(audiobook.timing, audiobook.mixed, from), betweenClocks(audiobook.timing, audiobook.mixed, to), true)}
      locked={timingLocked}
      grouped={selectedGroup}
      revision={audiobook.lastRecord?.seq}
      onOpenTiming={() => chooseView("timing")}
    >
      {soundsPanel}
    </BlockTimingPanel>
  );

  // The pictures set on blocks (design turn 186c): the margin's chips and the block's Picture.
  const placedPictures = useChapterPictures(world, audiobook.rows, audiobookRecord.record === "unreadable" ? null : audiobookRecord.record);
  // What the margin draws: the pictures set, and — dashed — those Arke proposes until they are accepted (191b).
  const chapterPictures = useMemo(() => ({ ...placedPictures, proposed: illustration.proposed }), [placedPictures, illustration.proposed]);
  const pictureRow = audiobook.rows.find((row) => row.block.key === audiobook.selected) ?? null;
  // The block panel's tab (design turn 194, rule 12): Picture when the block has a picture or one
  // proposed, Voice otherwise; a tab the author chooses holds from block to block until they leave
  // the view.
  const [chosenTab, setChosenTab] = useState<PanelTab | null>(null);
  useEffect(() => setChosenTab(null), [view, chapter.id]);
  const shownPicture = pictureRow === null ? undefined : placedPictures.byKey.get(pictureRow.block.key);
  const panelTab: PanelTab = chosenTab ?? (shownPicture !== undefined || (pictureRow !== null && illustration.proposed.has(pictureRow.block.key)) ? "picture" : "voice");
  const panelHead = pictureRow === null ? null : blockPanelHead(pictureRow, audiobook.rows, audiobookRecord.record === "unreadable" ? null : audiobookRecord.record, chapter.title, world);
  const panelTakes = pictureRow === null ? 0 : blockTakes(world.artifacts, prodId, chapter.id, pictureRow.block.key, pictureRow.block.shaped === true ? pictureRow.block.text : undefined).length;
  // The block's seams on touch (design turn 198j): Join next and Split under the sheet's head; a
  // fine pointer finds them on the list's lines instead.
  const pictured = useMemo(() => new Set(placedPictures.byKey.keys()), [placedPictures]);
  const seamActs = useBlockSeamActs({
    row: coarse || phone ? pictureRow : null,
    rows: audiobook.rows,
    gaps: audiobook.seams.gaps,
    held: audiobook.seams.held,
    onPress: audiobook.seams.press,
    pictured,
  });
  /*
   * The Audiobook view's side is the block's panel (165k/146b), and it is never left empty
   * (turn 188). With nothing chosen it used to show the manuscript's rail, the book and the
   * chapter's continuity, which is not what this view is about. So entering the view with the panel
   * beside the blocks chooses the first block, once per chapter, and the rail stays with the
   * manuscript. Where the panel is a sheet, choosing would open it over the page, so nothing is chosen.
   */
  const firstBlock = audiobook.rows[0]?.block.key ?? null;
  const chosenOnEntry = useRef<string | null>(null);
  const { selected: chosenBlock, setSelected: chooseBlock } = audiobook;
  useEffect(() => {
    if (view !== "audiobook" || blockSheet) {
      chosenOnEntry.current = null;
      return;
    }
    if (firstBlock === null || chosenOnEntry.current === chapter.id) return;
    chosenOnEntry.current = chapter.id;
    if (chosenBlock === null) chooseBlock(firstBlock);
  }, [view, blockSheet, firstBlock, chapter.id, chosenBlock, chooseBlock]);
  // The block's panel, beside the blocks or, on a phone, in a sheet (turn 165): one set of props.
  const blockPanel: Parameters<typeof AudiobookSide>[0] = {
    rows: audiobook.rows,
    selected: audiobook.selected,
    record: audiobookRecord.record === "unreadable" ? null : audiobookRecord.record,
    artifacts: world.artifacts,
    slug: worldSlug,
    productionId: prodId,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    modelOf: audiobook.modelOf,
    onSetDirection: audiobook.setDirection,
    onMarker: audiobook.setMarker,
    onMakeAgain: audiobook.makeAgain,
    onKeepSplit: audiobook.keepSplit,
    reReadPrice: audiobook.reReadPrice,
    refused: audiobook.lastRecord?.refused ?? null,
    onUpload: audiobook.uploadTake,
    onRecorded: (speaker, on) => setAudiobookRecorded(worldId, prodId, speaker, on),
    onLines: (speaker, label) => setLinesFor({ speaker, label }),
    capturedSelection: blockSelection,
    inSheet: blockSheet,
    ...(pinChoices !== null ? { choices: pinChoices, onPin: pinBlock } : {}),
    hear: { worldId, chapterFile: chapter.file },
    blockHost: (key) => audiobookColumn.current?.querySelector<HTMLElement>(`[data-block="${key}"] .fy-ab__text`) ?? null,
  };
  // The Arke press ends the Audiobook and Timing toolbars (design turn 194, rule 13), where the
  // folded rail's Ask Arke stood: put away, the dock leaves no strip and the list and the panel run
  // to the window's edge. Below 1100 (rule 15) the press is still in the bar: a tablet's toolbar
  // ends with it, a phone's app bar takes it in the place of the ⋯ menu, which held only Notes
  // (now on the toolbar) and Ask Arke. Timing's narrow dock keeps its floating press.
  const foldedAudiobook = compact && view === "audiobook";
  const toolbarDock = view !== "manuscript" && (!compact || foldedAudiobook);
  const arkePress = toolbarDock ? (
    <button
      type="button"
      className={cx("fy-ab__ico", dock && "fy-ab__ico--on")}
      aria-label={dock ? "Put Arke away" : "Open Arke"}
      aria-pressed={dock}
      title="Arke"
      onClick={() => setDock(!dock)}
      data-testid="audiobook-arke"
    >
      <Chat size={16} />
    </button>
  ) : null;
  const barArke = phone && foldedAudiobook ? arkePress : null;
  return (
    <div className="fy-sw" data-screen="chapter" data-testid="chapter-workspace" data-dock={dock ? "true" : "false"} data-view={view}>
      <main className="fy-sw__centre" ref={chapterCentre}>
        {/* 194h: one line, the chevron back to Chapters and the chapter's title, in every view, so
            the bar stays put when the switch below it changes view (the master draws Audiobook). */}
        {phone && <SceneBackRow back="Chapters" title={chapter.title} onBack={() => navigate(`/w/${worldId}/p/${prodId}/story/chapters`)} {...(barArke !== null ? { press: barArke } : {})}><Button onClick={() => setNotesOpen(true)}>Notes</Button><Button onClick={() => setDock(true)}>Ask Arke</Button></SceneBackRow>}
        <header className="fy-sw__head">
          {/* The page head is the Manuscript's (design turn 194, rule 2): the label, the title, the
              synopsis and the marks are set there. Audiobook and Timing open on their toolbar, and
              the chapter's title is the app bar's last crumb. */}
          {view === "manuscript" && (
          <>
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
              {/* In Audiobook the head's presses sit on the view row with the reading (turn 165a). */}
              {/* One outline press reads the chapter (126a); a cast chapter's voiced read is its
                  menu, not a second button beside it (design turn 192). While either reads, its
                  own controls stand in the press's place. */}
              {view !== "manuscript" || paragraphs.length === 0 || stagedDraft !== undefined ? null : voicedRead.reading ? (
                <PageReadControl read={readVoiced} label="Voiced" />
              ) : pageRead.reading ? (
                <PageReadControl read={read} label="Read the chapter" />
              ) : (
                <ReadPress read={read} voiced={voicesRecord !== null ? readVoiced : null} />
              )}
            </div>
          </div>
          {/* The synopsis, typed where it reads (turn 127), the way the scene's is. */}
          {/* Two lines until it is pressed (design turn 192, 129a's one line under the title):
              a press opens it to type, or, locked, to read whole. */}
          {locked ? (
            chapter.synopsis !== undefined && chapter.synopsis !== "" ? (
              <div
                className={cx("fy-sbsynopsis fy-ch__synopsis--locked fy-ch__synopsis-clamp", synopsisOpen && "fy-ch__synopsis-clamp--open")}
                onClick={() => setSynopsisOpen((open) => !open)}
              >
                {chapter.synopsis}
              </div>
            ) : null
          ) : (
            <EditableText
              value={chapter.synopsis ?? ""}
              placeholder="What this chapter is for."
              className="fy-sbsynopsis fy-ch__synopsis-clamp"
              rows={2}
              onCommit={(next) => plan({ synopsis: next.trim() === "" ? null : next.trim() })}
            />
          )}
          <div className="fy-sw__context" aria-label="Chapter state">
            {/* Unset, a mark is a quiet press to set it, and on a narrow screen (where the plan
                is set in Notes) not drawn at all (design turn 192): an empty pill says nothing. */}
            {compact ? (
              chapter.pov ? <span className="fy-ch__mark"><span>{sheetName(chapter.pov)}</span></span> : null
            ) : (
            <span className={cx("fy-ch__mark", !chapter.pov && "fy-ch__mark--unset")}>
              <select
                className="fy-ch__pick"
                aria-label="Point of view"
                value={chapter.pov ?? ""}
                disabled={locked}
                onChange={(e) => plan({ pov: e.target.value === "" ? null : e.target.value })}
              >
                <option value="">+ Point of view</option>
                {characters.map((sheet) => (
                  <option key={sheet.id} value={sheet.id}>
                    {sheet.name}
                  </option>
                ))}
              </select>
            </span>
            )}
            {/* Read-only (locked, or the compact head) with no time set, there is nothing to show
                and nothing to press: the mark stays out rather than standing as an empty pill. */}
            {(locked || compact) && !chapter.when ? null : (
              <span className="fy-ch__mark">
                {locked || compact ? (
                  <span className="fy-mono">{chapter.when}</span>
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
            )}
            <span>{chapter.status}</span>
            <span>{words.toLocaleString()} words{compact && ` · ${waiting !== null ? `${waiting} waiting` : saveRefusal !== null ? "not saved" : saving ? "saving" : "saved"}`}</span>
            {!compact && <span>{waiting !== null ? `${waiting} waiting` : saveRefusal !== null ? "not saved" : saving ? "saving" : "saved"}</span>}
            {stale && (
              <span className="fy-ch__moved">
                overview moved · v{chapter.draftedAgainst} → v{production.story?.version}
              </span>
            )}
          </div>
          </>
          )}
          {/* The view row (turn 146): the Chapters door's seg, Manuscript or Audiobook. In Audiobook it
              is the whole head, one line (design turn 194, rule 1): the reading, Notes, the speaker
              filter, then Direct and illustrate, the priced read, Listen and the Arke press. */}
          <div className="fy-ch__viewline">
            <nav className="fy-seg fy-ch__viewrow" aria-label="Chapter view">
              <button type="button" className={cx("fy-seg__item", view === "manuscript" && "fy-seg__item--active")} onClick={() => chooseView("manuscript")}>
                Manuscript
              </button>
              <button type="button" className={cx("fy-seg__item", view === "audiobook" && "fy-seg__item--active")} onClick={() => chooseView("audiobook")}>
                Audiobook
              </button>
              <button type="button" className={cx("fy-seg__item", view === "timing" && "fy-seg__item--active")} onClick={() => chooseView("timing")}>
                Timing
              </button>
            </nav>
            {/* Timing (turn 187a): the reading, then Play from the playhead with the timing as set. */}
            {view === "timing" && (
              <>
                <ReadingMenu
                  reading={production.audiobook?.reading ?? "narrator"}
                  narrator={audiobook.narrator.label ?? narratorName}
                  disabled={audiobook.run?.state === "reading" || connection !== "open"}
                  onReading={(reading) => setAudiobookReading(worldId, prodId, reading)}
                  onNarrator={() => setNarratorOpen(true)}
                />
                <span className="fy-ch__viewpush" />
                {timingProposal.proposal === null && (
                  <Button variant="secondary" disabled={timingLocked || timingProposal.pending} onClick={timingProposal.propose} data-testid="timing-propose">
                    {timingProposal.pending ? "Proposing…" : "Propose timing"}
                  </Button>
                )}
                {timingProposal.proposal === null && timingProposal.refused !== null && <span className="fy-mono fy-ch__who-where--warn">{timingProposal.refused}</span>}
                {audiobook.mixPlayer.playing ? (
                  <Button variant="ghost" onClick={() => dismissPlayback()} data-testid="timing-stop">Stop</Button>
                ) : (
                  <Button variant="primary" disabled={audiobook.mixPlayer.pending || audiobook.mixed.bars.length === 0} onClick={() => audiobook.mixPlayer.play(betweenClocks(audiobook.timing, audiobook.mixed, playhead))} data-testid="timing-play">
                    {audiobook.mixPlayer.pending ? "Mixing…" : "Play"}
                  </Button>
                )}
                {audiobook.mixPlayer.refused !== null && <span className="fy-mono fy-ch__who-where--warn">{audiobook.mixPlayer.refused}</span>}
                {arkePress}
              </>
            )}
            {compact && <div className="fy-ch__compact-actions">{view === "manuscript" && paragraphs.length > 0 && stagedDraft === undefined && !voicedRead.reading && <PageReadControl read={read} label={<><Play size={18} /><span className="fy-sr-only">Read the chapter</span></>} />}{view === "manuscript" && paragraphs.length > 0 && stagedDraft === undefined && voicesRecord !== null && !pageRead.reading && <PageReadControl read={readVoiced} label={phone ? <><Speaker size={18} /><span className="fy-sr-only">Read voiced chapter</span></> : "Voiced"} />}{/* In Audiobook, Notes is the reading's book and chapter note (194, rule 5); the rail's sheet is the Manuscript's. */}{view !== "audiobook" && <button type="button" className="ui-btn" aria-label="Notes" onClick={() => setNotesOpen(true)}><FileText size={18} />{!phone && "Notes"}</button>}</div>}
            {view === "audiobook" && (
              <>
                <ReadingMenu
                  reading={production.audiobook?.reading ?? "narrator"}
                  narrator={audiobook.narrator.label ?? narratorName}
                  disabled={audiobook.run?.state === "reading" || connection !== "open"}
                  onReading={(reading) => setAudiobookReading(worldId, prodId, reading)}
                  onNarrator={() => setNarratorOpen(true)}
                />
                {/* The book note and the chapter note behind one press (194, rule 5; turn 184, R-53). */}
                <NotesPress
                  worldId={worldId}
                  productionId={prodId}
                  chapterFile={chapter.file}
                  notes={audiobookReadingNotes(production.audiobook, chapter.id)}
                  disabled={connection !== "open" || audiobook.run?.state === "reading"}
                />
                {record !== null && <AudiobookFilterMenu filters={audiobook.filters} filter={audiobook.filter} onFilter={audiobook.setFilter} />}
                {/* Blocks · 3 changed (design turn 198, rule 10): after the filter once a seam is set by hand; on a phone it is in the ⋯. */}
                {record !== null && !phone && audiobook.seams.label !== null && <BlocksPress label={audiobook.seams.label} changed={audiobook.seams.changed} held={audiobook.seams.held} onReset={audiobook.seams.reset} />}
                {/* The paragraphs an edit left to cast (design turn 198h), after the filter; on a phone they head the ⋯ (198j). */}
                {record !== null && !phone && stagedDraft === undefined && audiobook.castPress}
                <span className="fy-ch__viewpush" />
                {/* Below 1100 (194, rule 15) the line ends with the Direct and illustrate ⋯ and the
                    tablet's Arke press; the read and Listen are held at the foot, under the list. */}
                {stagedDraft === undefined && (compact ? audiobook.headMenu : audiobook.head)}
                {/* Listen (design turn 186): the book from this chapter, after the chapter's own read. */}
                {stagedDraft === undefined && !compact && <ListenButton worldId={worldId} production={production} chapterId={chapter.id} solid />}
                {!phone && arkePress}
              </>
            )}
          </div>
        </header>

        <div className={cx("fy-ch__body", view !== "manuscript" && "fy-ch__body--audiobook")}>
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
                <>
                <AudiobookBlocks
                  brackets={audiobook.brackets}
                  onReRead={audiobook.makeAgain}
                  reReadPrice={audiobook.reReadPrice}
                  {...(pinChoices !== null ? { choices: pinChoices, onPin: pinBlock } : {})}
                  filter={audiobook.filter}
                  marker={audiobook.marker}
                  onMarker={audiobook.setMarker}
                  modelOf={audiobook.modelOf}
                  onDirect={audiobook.setDirection}
                  rows={audiobook.rows}
                  sounding={audiobook.sounding}
                  selected={audiobook.selected}
                  onSelectionChange={setBlockSelection}
                  onSelect={audiobook.setSelected}
                  slug={worldSlug}
                  pictures={chapterPictures}
                  // Join and Split on hover (design turn 198); none while a read runs.
                  {...(!audiobook.seams.held ? { seams: { gaps: audiobook.seams.gaps, onPress: audiobook.seams.press } } : {})}
                  madeAgain={audiobook.seams.madeAgain}
                  onPlayOne={(row) => {
                    if (row.artifact === null) return;
                    void playClip({ id: row.artifact.id, url: mediaUrl(worldSlug, `artifacts/${row.artifact.file}`), title: `${chapter.title} · ${row.mark}`, sub: "audiobook · one block" });
                  }}
                />
                </>
              )}
              {audiobook.uploadDialog}
              {linesFor !== null && (
                <SpeakerLinesDialog
                  worldId={worldId}
                  productionId={prodId}
                  speaker={linesFor.speaker}
                  label={linesFor.label}
                  tone={(() => {
                    const row = audiobook.rows.find((candidate) => (candidate.speakerKey === null ? "narrator" : (candidate.block.sheet ?? candidate.block.speaker)) === linesFor.speaker);
                    return row === undefined || row.speakerKey === null ? "narrator" : row.colour === null ? "none" : String(row.colour);
                  })()}
                  onClose={() => setLinesFor(null)}
                />
              )}
            </div>
          )}
          {view === "timing" && (
            <div className="fy-ch__manuscript fy-ch__timing" data-testid="timing-column">
              {openFailure !== null ? (
                <EmptyState title={openFailure} />
              ) : record === null ? (
                <p className="fy-bible__empty">Opening…</p>
              ) : (
                <>
                  {timingProposal.proposal !== null && (
                    <TimingProposalCard proposal={timingProposal.proposal} onAccept={timingProposal.accept} onDiscard={timingProposal.discard} refused={timingProposal.refused} locked={timingLocked} />
                  )}
                  <TimingView
                    timing={shownTiming}
                    lanes={timingLanes(audiobook.rows)}
                    rows={audiobook.rows}
                    selected={audiobook.selected}
                    onSelect={audiobook.setSelected}
                    onTiming={onTiming}
                    playhead={shownPlayhead}
                    onPlayhead={setPlayhead}
                    reactionLabels={Object.fromEntries(Object.entries(proposalView.record?.reactions ?? {}).map(([key, reaction]) => [key, reaction.sound ?? reaction.words ?? key]))}
                    proposed={proposalView.proposed}
                    // A proposal held is looked at, not edited around: accepted or discarded first.
                    locked={timingLocked || timingProposal.proposal !== null}
                  />
                </>
              )}
            </div>
          )}
          <div className="fy-ch__manuscript" ref={manuscriptRef} hidden={view !== "manuscript"}>
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
            ) : stagedDraft !== undefined && passageChange !== null && coarse ? (
              <div className="fy-ch__prose fy-ch__touch-draft" aria-label="Arke's passage">
                {(() => {
                  const body = stagedDraft.body ?? live, from = passageChange.start, to = from + passageChange.after.length;
                  const first = passageParagraphs.find(p => p.end >= from)?.start ?? from;
                  const last = passageParagraphs.find(p => p.end >= to)?.end ?? to;
                  return <>
                    {chapterParagraphs(body.slice(0, first)).map((p,i) => <p key={`before-${i}`}>{p}</p>)}
                    <section className="fy-passage-band">
                      <header><Sparkle size={14} /><strong>Arke’s passage</strong><span>{countWords(passageChange.before)} → {countWords(passageChange.after)} words · against v{record.version}</span></header>
                      <p>{body.slice(first,from)}{segments.map((segment,i) => segment.kind === "same" ? <span key={i}>{segment.text}</span> : <span key={i}>{segment.before && <del>{segment.before}</del>}{segment.after && <ins>{segment.after}</ins>}</span>)}{body.slice(to,last)}</p>
                      {choosing && <div className="fy-passage-edits">{segments.filter(segment => segment.kind === "edit").map(segment => <button type="button" key={segment.index} disabled={keeping !== null || accepting !== null} aria-pressed={!refused.has(segment.index)} onClick={() => toggleEdit(segment.index)}><b>“{segment.after || segment.before}”</b><span className={cx("fy-ch__edit-state", refused.has(segment.index) && "fy-ch__edit-state--refused")}>{refused.has(segment.index) ? "Refused" : "Kept"}</span></button>)}</div>}
                    </section>
                    {chapterParagraphs(body.slice(last)).map((p,i) => <p key={`after-${i}`}>{p}</p>)}
                  </>;
                })()}
              </div>
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
                      const line = (
                        <p key={i} className={changed ? "fy-ch__passage" : undefined}>
                          {paragraph.text}
                        </p>
                      );
                      if (!cut || anchorParagraph !== i) return line;
                      // A cut replaces nothing, so what goes is drawn beside the paragraph it
                      // touched, on the side it stood (codex on PR 1232).
                      return passageChange.start <= paragraph.start
                        ? <Fragment key={i}>{struck}{line}</Fragment>
                        : <Fragment key={i}>{line}{struck}</Fragment>;
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
                        {edits()}
                        {body.slice(endOfSpan, tailEnd)}
                      </p>
                    );
                  })}
                  {/* A passage cut from the chapter's end may touch no paragraph that is left
                      (codex on PR 1232): what goes is drawn where it stood, so there is something
                      to decide on the page as well as on the card. */}
                  {anchorParagraph === -1 && (choosing
                    ? <p className="fy-ch__passage fy-ch__passage--choose">{edits()}</p>
                    : struck ?? <p className="fy-ch__passage"><del>{passageChange.before.trim()}</del></p>)}
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
            {selection !== null && !locked && !coarse && (
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
            {selection !== null && !locked && coarse && <TouchPassageAsk manuscript={manuscriptRef.current} selectionTop={selection.top} paragraph={selection.paragraph} words={countWords(selection.text)} actions={passageActions(style !== null)} held={draftConflict || saveRefusal !== null ? "not saved" : saving || draft !== null ? "saving…" : asking ? "asking…" : undefined} onClose={() => setSelection(null)} onAsk={askPassage} value={passageLine} onChange={setPassageLine} onSubmit={() => { askPassage({ ...TIGHTEN, line: passageLine.trim(), replyOnly: false }); setPassageLine(""); }} />}
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

          {/* In the Audiobook view the side is the block's panel, then Voices (turn 188): the rest of
              the manuscript's rail is hidden there by chapter-responsive.css, not unmounted, so
              Voices keeps its speakers' notes and the narrator's dialog. */}
          <div className="fy-ch__panels">
          {/* A grouped read is confirmed in its sheet (design turn 185a): requests beside blocks and the estimate. */}
          {view === "audiobook" && audiobook.readSheet !== null && (
            <ResponsiveSheet sheet={blockSheet} open title="Read the chapter" onClose={audiobook.readSheet.cancel} className="fy-chapter-block-sheet">
              <aside className="fy-ch__side fy-ch__block-side">
                <ReadSheet sheet={audiobook.readSheet} />
              </aside>
            </ResponsiveSheet>
          )}
          {/* The Direct sheet (design turn 184a): what the director reads, before it runs. */}
          {view === "audiobook" && audiobook.directOpen && (
            <ResponsiveSheet sheet={blockSheet} open title="Direct this chapter" onClose={audiobook.closeDirect} className="fy-chapter-block-sheet">
              <aside className="fy-ch__side fy-ch__block-side">
                <DirectSheet
                  worldId={worldId}
                  productionId={prodId}
                  chapterFile={chapter.file}
                  chapterOrder={chapter.order}
                  blocks={audiobook.rows.length}
                  reading={production.audiobook?.reading ?? "narrator"}
                  chapterNote={production.audiobook?.chapterNotes?.[chapter.id] !== undefined}
                  onCancel={audiobook.closeDirect}
                  // The proposal comes back as the dock's card, Accept and Discard on it (turn 184b):
                  // with the dock put away by default here (194), Direct opens it to show the run.
                  onDirect={(also) => {
                    if (!compact) setDock(true);
                    audiobook.direct(also);
                  }}
                />
              </aside>
            </ResponsiveSheet>
          )}
          {/* The chapter's Looks (design turn 193a): from the Audiobook head and from the rail's Voices in any view (rule 18). */}
          <LookSheet open={illustrationLookOpen} onClose={() => setIllustrationLookOpen(false)} worldId={worldId} productionId={prodId} chapterFile={chapter.file} chapterOrder={chapter.order} record={audiobookRecord.record === "unreadable" ? null : audiobookRecord.record} blockKeys={audiobook.rows.map((row) => row.block.key)} />
          {view === "audiobook" && lookToMake !== null && <NewLookSheet open onClose={() => setLookToMake(null)} worldId={worldId} productionId={prodId} chapterFile={chapter.file} chapterOrder={chapter.order} who={{ key: lookToMake.key, name: lookToMake.name, sheet: lookToMake.sheet }} line={lookToMake.line} />}
          {/* The block's panel (design turn 194, rules 11 and 12): its head, then Picture, Voice and Timing as tabs.
              Raised as a sheet, the panel's head is the sheet's (194h): one title, one close. */}
          {view === "audiobook" && (
            <ResponsiveSheet sheet={blockSheet} open={audiobook.selected !== null} title={panelHead?.title ?? "Block"} onClose={() => audiobook.setSelected(null)} className="fy-chapter-block-sheet" headless={panelHead !== null}>
              <aside className="fy-ch__side fy-ch__block-side">
                {pictureRow !== null && panelHead !== null && (
                  <BlockPanel
                    acts={seamActs.bar}
                    lines={seamActs.lines}
                    head={panelHead}
                    tab={panelTab}
                    onTab={setChosenTab}
                    facts={{
                      ...(shownPicture !== undefined ? { picture: pictureStart(shownPicture) } : {}),
                      ...(panelTakes > 0 ? { voice: `v${panelTakes}` } : {}),
                    }}
                    onClose={() => audiobook.setSelected(null)}
                  >
                    {{
                      picture: <BlockPicturePanel worldId={worldId} production={production} chapterFile={chapter.file} chapterOrder={chapter.order} row={pictureRow} rows={audiobook.rows} pictures={chapterPictures} record={audiobookRecord.record === "unreadable" ? null : audiobookRecord.record} />,
                      voice: <AudiobookSide {...blockPanel} />,
                      timing: timingPanel,
                    }}
                  </BlockPanel>
                )}
              </aside>
            </ResponsiveSheet>
          )}
          {/* The Timing view's side (turn 187a): the bar selected, the same values as the block panel's. */}
          {view === "timing" && <ResponsiveSheet sheet={blockSheet} open={selectedBar !== null} title={`${selectedTimingRow?.mark ?? "Reaction"} · ${audiobook.selected ?? ""}`} onClose={() => audiobook.setSelected(null)} className="fy-chapter-block-sheet"><aside className="fy-ch__side fy-ch__block-side"><TimingSide bar={selectedBar} row={selectedTimingRow} timing={audiobook.timing} rows={audiobook.rows} onTiming={onTiming} onPlayFrom={(at) => { setPlayhead(at); audiobook.mixPlayer.play(betweenClocks(audiobook.timing, audiobook.mixed, at)); }} refused={audiobook.lastRecord?.refused ?? null} locked={timingLocked} revision={audiobook.lastRecord?.seq} /></aside></ResponsiveSheet>}
          <ResponsiveSheet sheet={compact} open={notesOpen} title={`Chapter ${String(chapter.order).padStart(2,"0")} · notes`} onClose={() => setNotesOpen(false)} className="fy-chapter-notes-sheet">
          <aside className="fy-ch__side fy-ch__notes">
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
              {continuity === "unreadable" && <div className="fy-ch__moved fy-ch__moved--line">record unreadable · Derive again replaces it</div>}
              {continuityStale && continuityRecord !== null && (
                <div className="fy-ch__moved fy-ch__moved--line">chapter moved · derived against v{continuityRecord.version}</div>
              )}
              {deriveNote !== null && !derivingNow && <div className="fy-ch__moved fy-ch__moved--line">{deriveNote}</div>}
              {/* Not derived is the heading and its Derive press, one line (design turn 192): a
                  panel says nothing until there is something to say. */}
              {continuityRecord === null ? null : continuityRecord.characters.length === 0 ? (
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
                {/* The chapter's Looks from the rail too (design turn 193, rule 18), so Manuscript reaches them;
                    once the chapter is cast, since an uncast panel is its heading and its press alone (turn 192). */}
                {voicesRecord !== null && (
                  <button type="button" className="fy-ch__derive" disabled={connection !== "open"} onClick={() => setIllustrationLookOpen(true)} data-testid="voices-looks">
                    Looks
                  </button>
                )}
                {castingNow ? (
                  <span className="fy-ch__deriving">
                    <span className="fy-mono">casting…</span>
                    <button type="button" className="fy-ch__derive" onClick={() => stopVoices(worldId, prodId, chapter.file)}>
                      Stop
                    </button>
                  </span>
                ) : toCastCount > 0 && audiobook.castItems.length > 0 ? (
                  // Only edited paragraphs need casting (design turn 198, rule 13): Cast again offers
                  // them beside the chapter, as the Audiobook toolbar's press does.
                  <MenuPress className="fy-ch__derive" testId="voices-cast-again" items={audiobook.castItems} disabled={locked || connection !== "open"} end label={<><RotateCcw size={11} />Cast again</>} />
                ) : (
                  <button type="button" className="fy-ch__derive" disabled={locked || connection !== "open"} onClick={() => castLinesPress()}>
                    <RotateCcw size={11} />
                    {voices === null ? "Cast the lines" : "Cast again"}
                  </button>
                )}
              </h2>
              {voices === "unreadable" && <div className="fy-ch__moved fy-ch__moved--line">record unreadable · Cast again replaces it</div>}
              {voicesMoved && voicesRecord !== null && (
                <div className="fy-ch__moved fy-ch__moved--line">chapter moved · cast against v{voicesRecord.version}</div>
              )}
              {toCastCount > 0 && <div className="fy-ch__moved fy-ch__moved--line">{paragraphsToCast(toCastCount)}</div>}
              {castNote !== null && !castingNow && <div className="fy-ch__moved fy-ch__moved--line">{castNote}</div>}
              {voicesRecord === null ? null : (
                <ul className="fy-ch__who">
                  <li>
                    <div className="fy-ch__who-head">
                      <span className="fy-ch__who-name"><i className="fy-ab__speaker-dot fy-voice--narrator" aria-hidden="true" /><span>Narration</span></span>
                      <button type="button" className="fy-ch__who-where fy-mono fy-ab__narrator-press" onClick={() => setNarratorOpen(true)} data-testid="voices-narrator">
                        {audiobook.narrator.label ?? narratorName} · {production?.audiobook?.narrator !== undefined ? "this book" : "narrator"}
                      </button>
                      <span className="fy-ch__who-count fy-mono">{narrationBlocks} blocks</span>
                    </div>
                  </li>
                  {production?.audiobook?.reading === "performed" &&
                    speakers.map((who) => {
                      const key = who.sheet ?? who.speaker;
                      const sheet = who.sheet === undefined ? undefined : world.sheets.find((candidate) => candidate.id === who.sheet);
                      const note = production.audiobook?.notes?.[key];
                      const model = audiobook.modelOf(audiobook.narrator);
                      const selectedRow = audiobook.rows.find((row) => row.block.key === audiobook.selected);
                      // A speaker's line may sit inside a block of several turns (design turn 190).
                      const holds = (row: (typeof audiobook.rows)[number]) => row.speakerKey === key || (row.speakers ?? []).some((turn) => turn.key === key);
                      const line = selectedRow !== undefined && holds(selectedRow) ? selectedRow : (audiobook.rows.find(holds) ?? null);
                      return (
                        <PerformedSpeaker
                          key={key}
                          worldId={worldId}
                          productionId={prodId}
                          chapterFile={chapter.file}
                          speakerKey={key}
                          name={sheet?.name ?? who.speaker}
                          lines={who.lines}
                          tone={who.sheet === undefined ? "none" : String(speakerColours.get(who.sheet) ?? "none")}
                          {...(note !== undefined ? { note } : {})}
                          noteHeld={model === null || performanceNote(note ?? "x", model).mode === "unsupported"}
                          line={line}
                          model={model}
                          slug={worldSlug}
                          focused={performer === key}
                          onFocus={() => setPerformer(key)}
                        />
                      );
                    })}
                  {production?.audiobook?.reading !== "performed" && speakers.map((who) => {
                    const sheet = who.sheet === undefined ? undefined : world.sheets.find((candidate) => candidate.id === who.sheet);
                    const voice = sheet?.voice;
                    return (
                      <li key={who.sheet ?? who.speaker}>
                        <div className="fy-ch__who-head">
                          <span className="fy-ch__who-name">
                            <i className={`fy-ab__speaker-dot fy-voice--${who.sheet === undefined ? "none" : (speakerColours.get(who.sheet) ?? "none")}`} aria-hidden="true" />
                            <span>{sheet?.name ?? who.speaker}</span>
                          </span>
                          {voice !== undefined && voiceUnavailable(voice) ? (
                            <span className="fy-ch__who-where fy-mono fy-ch__who-where--warn">voice unavailable · narrator</span>
                          ) : voice !== undefined ? (
                            <span className="fy-ch__who-where fy-mono" title={`${voiceDisplayLabel(voice, world)} · ${readerPlace(voice.provider)}`}>{voiceDisplayLabel(voice, world)} · {readerPlace(voice.provider)}</span>
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
                    `${castLinesRead.length} line${castLinesRead.length === 1 ? "" : "s"}`,
                    `${speakers.length} speaker${speakers.length === 1 ? "" : "s"}`,
                    // A drop is said; a clean check is the count alone (design turn 192).
                    ...(voicesRecord.dropped > 0 ? [`${voicesRecord.dropped} line${voicesRecord.dropped === 1 ? "" : "s"} dropped, not in the chapter`] : []),
                    ...(voicesRecord.omitted > 0 ? [`${voicesRecord.omitted} line${voicesRecord.omitted === 1 ? "" : "s"} over the cap`] : []),
                    ...(voiced.ambiguous > 0 ? [`${voiced.ambiguous} ambiguous`] : []),
                    ...((voicesRecord.pins?.length ?? 0) > 0 ? [`${voicesRecord.pins!.length} set by you`] : []),
                    ...(voicesRecord.lost !== undefined ? [`${voicesRecord.lost} correction${voicesRecord.lost === 1 ? "" : "s"} lost`] : []),
                  ].join(" · ")}
                </p>
              )}
              {narratorOpen && (
                <NarratorDialog
                  worldId={worldId}
                  productionId={prodId}
                  narratorLabel={audiobook.narrator.label ?? narratorName}
                  {...(production?.audiobook?.narrator !== undefined ? { bookNarrator: production.audiobook.narrator } : {})}
                  appLabel={narratorName}
                  trial={{ chapterFile: chapter.file, block: audiobook.selected ?? "title" }}
                  slug={worldSlug}
                  data={`${chapter.title} · ${audiobook.rows.length} blocks`}
                  onClose={() => setNarratorOpen(false)}
                />
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

            {/* Implies appears with its first fact (design turn 192; 127b draws it only with items). */}
            {implies.length > 0 && (
            <section className="fy-bible__panel">
              <h2 className="fy-bible__paneltitle">
                Implies <span className="fy-mono">{implies.length}</span>
              </h2>
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
            </section>
            )}

            <section className="fy-bible__panel" data-testid="chapter-draws">
              {/* Empty, Draws on is its heading and an Add press, one line (design turn 192,
                  amending 126): Add starts the line in the thread, where draws is changed. */}
              <h2 className="fy-bible__paneltitle fy-ch__paneltitle--row">
                Draws on
                {drawsEmpty && <span className="fy-ch__panelpush" />}
                {drawsEmpty && (
                  <button type="button" className="fy-ch__derive" disabled={locked || asking} onClick={askDraws}>
                    Add
                  </button>
                )}
              </h2>
              {drawsEmpty ? null : (
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

            {/* Earlier versions appears with the first one kept (design turn 192). */}
            {history.length > 0 && (
              <section className="fy-bible__panel">
                <h2 className="fy-bible__paneltitle">Earlier versions</h2>
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
              </section>
            )}
            {compact && <section className="fy-bible__panel fy-ch__plan"><h2 className="fy-bible__paneltitle">Chapter plan</h2>
              <label>Title{locked ? <span>{chapter.title}</span> : <span className="fy-ch__plan-field"><SceneTitle title={chapter.title} label="Chapter title" onCommit={title => plan({ title })} /></span>}</label>
              <label>Synopsis{locked ? <span>{chapter.synopsis}</span> : <EditableText value={chapter.synopsis ?? ""} placeholder="What this chapter is for." className="fy-ch__plan-field" rows={2} onCommit={synopsis => plan({ synopsis: synopsis || null })} />}</label>
              <label>Point of view<select aria-label="Point of view" disabled={locked} value={chapter.pov ?? ""} onChange={event => plan({ pov: event.target.value || null })}><option value="">Not set</option>{characters.map(sheet => <option key={sheet.id} value={sheet.id}>{sheet.name}</option>)}</select></label>
              <label>When{locked ? <span>{chapter.when}</span> : <EditableText value={chapter.when ?? ""} placeholder="When" className="fy-ch__plan-field" rows={1} onCommit={when => plan({ when: when || null })} />}</label>
            </section>}
          </aside>
          </ResponsiveSheet>
          </div>
        </div>
        {/* The foot line under the list and the panel (design turn 194, rule 4): the chapter's Play at
            its left, the saved state, and the counts that say what is left to do. */}
        {view === "audiobook" && (
          <div className="fy-ab__foot" data-testid="audiobook-foot">
            {stagedDraft === undefined && audiobook.footPlay}
            {stagedDraft === undefined && <span aria-hidden="true">·</span>}
            <span>{`Saved · v${record?.version ?? chapter.version} · ${words.toLocaleString()} words`}</span>
            <span className="fy-ab__foot-push" />
            {audiobook.mixRefused !== null && <span className="fy-ch__who-where--warn">{audiobook.mixRefused}</span>}
            {audiobook.note !== null && <span className="fy-ch__who-where--warn">{audiobook.note}</span>}
            {castingState?.pinRefused !== undefined && <span className="fy-ch__who-where--warn">{castingState.pinRefused}</span>}
            <span>
              {[
                `${audiobook.counts.total} block${audiobook.counts.total === 1 ? "" : "s"}`,
                `${audiobook.counts.made} made`,
                ...(audiobook.counts.stale > 0 ? [`${audiobook.counts.stale} stale`] : []),
                ...(audiobook.counts.flagged > 0 ? [`${audiobook.counts.flagged} flagged`] : []),
                // A block a seam shaped is `not read` (design turn 198c), apart from the blocks never made.
                ...(audiobook.counts.notMade - audiobook.seams.notRead > 0 ? [`${audiobook.counts.notMade - audiobook.seams.notRead} not made`] : []),
                ...(audiobook.seams.notRead > 0 ? [`${audiobook.seams.notRead} not read`] : []),
                ...(audiobook.counts.awaiting > 0 ? [`${audiobook.counts.awaiting} awaiting recording`] : []),
              ].join(" · ")}
            </span>
          </div>
        )}
        {/* Below 1100 (design turn 194, rule 15) Read and Listen are held at the foot, 44 high, in the
            place the toolbar's line gave up: the read's own control (or its price, its progress) at
            the left and Listen at the right, both the width of the room they share. */}
        {foldedAudiobook && stagedDraft === undefined && (
          <div className="fy-ab__hold" data-testid="audiobook-hold">
            {audiobook.headRead}
            <ListenButton worldId={worldId} production={production} chapterId={chapter.id} solid />
          </div>
        )}
      </main>

      {/* Illustrate this chapter (design turn 193h, 193j): the proposal as a sheet over the main area,
          beside the dock rather than in it. Closing keeps the proposal; the dock's status reopens it. */}
      {view === "audiobook" && illustrationSheet.open && illustration.run !== undefined && (
        <IllustrationSheet
          run={illustration.run}
          chapterOrder={chapter.order}
          slug={worldSlug}
          wordsOf={(block) => audiobook.rows.find((row) => row.block.key === block)?.block.text}
          offline={connection !== "open"}
          onAccept={() => {
            illustration.accept();
            illustrationSheet.hide();
          }}
          onDiscard={() => {
            illustration.discard();
            illustrationSheet.hide();
          }}
          onSkip={illustration.skip}
          onWithout={illustration.without}
          onMakeLook={(who) => {
            // A character with a main photo has a look made here, over the proposal; a place, or a
            // character with no main photo to make a look from, is made on its own page.
            const kit = who.kind === "character" && who.sheet !== undefined ? world.referenceKits.find((candidate) => candidate.sheetId === who.sheet) : undefined;
            if (kit !== undefined && who.sheet !== undefined && mainPhotoFor(kit) !== null) {
              const record = audiobookRecord.record === "unreadable" ? null : audiobookRecord.record;
              setLookToMake({ key: who.key, name: who.name, sheet: who.sheet, line: record?.look?.characters[who.key]?.text ?? "" });
              return;
            }
            void navigate(`/w/${worldId}/${who.kind === "place" ? "locations" : "cast"}/${who.sheet}`);
          }}
          onAgain={illustration.press}
          onClose={illustrationSheet.hide}
          onLook={() => setIllustrationLookOpen(true)}
        />
      )}

      {compact && stagedDraft !== undefined && passageChange !== null && <HeldBar className="fy-passage-decision"><span>{keptCount} of {editCount} kept</span><StagedDecision worldId={worldId} subject={chapterLabel} staged={stagedDraft.staged} {...(accept !== undefined ? { accept } : {})} /></HeldBar>}
      <ResponsiveSheet sheet={compact || !dock} open={compact && dock} title={dockTitle} onClose={() => setDock(false)} className="fy-season-arke-sheet">
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
            title: dockTitle,
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
            // A question is asked for its answer and nothing else (issue 1295): sent as an open
            // ask, a 12B model answered "What does this chapter draw on?" with an invented action,
            // and the whole reply was rejected twice.
            prompts: view === "audiobook"
              ? [{ label: directionStands ? "Direct again" : "Direct this chapter", press: audiobook.directPress }, question("Who reads this chapter?"), question("Which blocks are stale?")]
              : passage !== null
              // Held against the style only when there is one (codex on PR 1232), as the menu does.
              ? [TIGHTEN.line, { label: (style !== null ? HOLD_TO_STYLE : passageAction("critique")!).line, replyOnly: true }]
              : voicesRecord !== null && voicesStale
                ? [toCastCount > 0 ? { label: `Cast ${toCastCount} paragraph${toCastCount === 1 ? "" : "s"}`, press: () => castLinesPress("changed") } : { label: "Cast again", press: () => castLinesPress() }, question("Who speaks in this chapter?")]
                : voicesRecord !== null && speakers.length > 0 && !(continuityRecord !== null && continuityStale)
                  ? [question("Who speaks in this chapter?"), question(`Which lines are ${speakers[0]!.sheet !== undefined ? sheetNameOf(speakers[0]!.sheet) : speakers[0]!.speaker}’s?`)]
              : continuityRecord !== null && continuityStale
                ? [{ label: "Derive again", press: derive }, question("Who is in this chapter?")]
                : continuityRecord !== null && placedFirst !== undefined
                  ? [question(`What does ${named(placedFirst)} learn here?`), question(`Where is ${named(placedSecond ?? placedFirst)} now?`)]
                  : [firstPrompt(live, chapter.synopsis), style !== null ? { label: "Hold this against the style", replyOnly: true } : question("What does this chapter draw on?")],
            // The thread is the production's own (no new entry context, turn 126): the chapter
            // the dock names has to be in the words themselves or the studio never hears it.
            subjectPrefix: dockPrefix,
            about: chapterLabel,
            // A line a menu press started is about the passage it was pressed on, and the dock
            // says that one, not whatever is selected now (codex on PR 1232).
            ...(shownSubject.kind === "passage" ? { subjectLine: `about this passage · ${countWords(shownSubject.text).toLocaleString()} words` } : {}),
          }}
          openingNote="opening…"
          emptyLine={`Nothing written with Arke for ${chapterLabel} yet.`}
          placeholder={`Ask about ${chapterLabel}`}
          {...(stagedDraft === undefined && view === "audiobook" && audiobook.directionRun !== undefined
            ? { side: <DirectionCard run={audiobook.directionRun} chapterOrder={chapter.order} blocks={audiobook.rows.length} onAccept={audiobook.accept} onDiscard={audiobook.discard} /> }
            : stagedDraft === undefined && view === "audiobook" && illustration.run !== undefined
            ? {
                side: (
                  <IllustrationStatus
                    run={illustration.run}
                    onReview={illustrationSheet.show}
                    onStop={illustration.stop}
                    onDiscard={illustration.discard}
                  />
                ),
              }
            : stagedDraft === undefined || compact && passageChange !== null
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
      </ResponsiveSheet>
      {((compact && !foldedAudiobook) || (!dock && !toolbarDock)) && (
        <button type="button" className={phone ? "fy-season-arke" : "fy-sw__rail fy-season-arke-rail"} aria-label="Open Arke" title="Pin the assistant back" onClick={() => setDock(true)}>
          {compact ? <Sparkle size={16} /> : <span className="fy-sw__rail-dot" aria-hidden="true" />}
          <span className="fy-sw__rail-label">{phone ? "Arke" : "Ask Arke"}</span>
          <span className="fy-sw__rail-pin"><Pin size={13} /></span>
        </button>
      )}
    </div>
  );
}

/**
 * Read the chapter, one outline press with its play mark (126a). A cast chapter's voiced read is
 * the press's menu (design turn 192) rather than a second grey button beside it: two presses of
 * the same weight made the head ask which, every time, for a choice made once.
 */
function ReadPress({ read, voiced }: { read: PageRead; voiced: PageRead | null }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <span className="fy-ch__readpress" ref={menu}>
      <Button variant="outline" onClick={read.begin}>
        <Play size={13} />
        Read the chapter
      </Button>
      {voiced !== null && (
        <Button variant="outline" size="icon" aria-label="More ways to read" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          <ChevronDown size={14} />
        </Button>
      )}
      {voiced !== null && open && (
        <span className="fy-ch__readmenu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              voiced.begin();
            }}
          >
            Voiced
          </button>
        </span>
      )}
    </span>
  );
}

/** The touch bar preserves the native selection and its handles; only Close dismisses its subject. */
function TouchPassageAsk({ manuscript, selectionTop, paragraph, words, actions, held, onClose, onAsk, value, onChange, onSubmit }: {
  manuscript: HTMLElement | null; selectionTop: number; paragraph: number | null; words: number; actions: readonly PassageAction[]; held?: string;
  onClose: () => void; onAsk: (action: PassageAction) => void; value: string; onChange: (value: string) => void; onSubmit: () => void;
}) {
  const phone = useMediaQuery("(max-width: 599px)");
  const bar = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);
  const [reserve, setReserve] = useState(0);
  const anchorId = useId();
  useLayoutEffect(() => {
    if (!phone || !manuscript) return;
    const panel = document.querySelector<HTMLElement>(".fy-passage-ask");
    const page = manuscript.closest<HTMLElement>(".fy-sw");
    if (!panel || !page) return;
    // Raising the keyboard-aware bar must not leave the native selection behind it.
    const reveal = () => {
      const selection = window.getSelection?.();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const source = manuscript.querySelector(".fy-ch__source");
      if (!source && (!range || !manuscript.contains(range.commonAncestorContainer) || !range.getBoundingClientRect)) return;
      const bottom = source ? manuscript.getBoundingClientRect().top + selectionTop + 22 : range!.getBoundingClientRect().bottom;
      const hidden = bottom - panel.getBoundingClientRect().top + 16;
      if (hidden > 0) page.scrollTop += hidden;
    };
    reveal();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    observer?.observe(panel);
    return () => observer?.disconnect();
  }, [phone, manuscript, paragraph, words, selectionTop]);

  useLayoutEffect(() => {
    if (phone || !manuscript || !bar.current || paragraph === null) { setTop(null); return; }
    const block = manuscript.querySelector<HTMLElement>(`.fy-rme__doc > :nth-child(${paragraph})`);
    const source = manuscript.querySelector<HTMLTextAreaElement>(".fy-ch__source");
    if (!block && !source) { setTop(null); return; }
    // Style outside ProseMirror's document. Mutating a paragraph makes its DOM observer
    // replace that node, collapsing the native selection and invalidating its coordinates.
    manuscript.dataset.touchAsk = anchorId;
    const measure = () => {
      const current = manuscript.querySelector<HTMLElement>(`.fy-rme__doc > :nth-child(${paragraph})`);
      if (!bar.current) return;
      setReserve(bar.current.getBoundingClientRect().height + 40);
      // The source mirror captures a textarea selection; it has no native DOM Range.
      setTop(current ? current.getBoundingClientRect().bottom - manuscript.getBoundingClientRect().top + 20 : selectionTop + 42);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(bar.current); window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); delete manuscript.dataset.touchAsk; };
  }, [phone, manuscript, paragraph, words, anchorId, selectionTop]);
  return <div ref={bar} style={top === null ? undefined : { position: "absolute", top, left: 0, right: 0 }} className="fy-passage-anchor">{!phone && reserve > 0 && <style>{`[data-touch-ask="${anchorId}"] .fy-rme__doc > :nth-child(${paragraph}), [data-touch-ask="${anchorId}"] .fy-ch__source { margin-bottom: ${reserve}px; }`}</style>}<HeldBar className="fy-passage-ask">
    <header><Sparkle size={16} /><strong>About this passage</strong><span>{words} words · paragraph {paragraph ?? "—"}</span><button type="button" aria-label="Close passage" onClick={onClose}><X size={18} /></button></header>
    <div className="fy-passage-prompts">{actions.filter(action => !action.draft).sort((a,b) => (["tighten","style","simplify"].includes(a.id) ? ["tighten","style","simplify"].indexOf(a.id) : 99) - (["tighten","style","simplify"].includes(b.id) ? ["tighten","style","simplify"].indexOf(b.id) : 99)).map(action => <button key={action.id} type="button" disabled={held !== undefined} onMouseDown={event => event.preventDefault()} onClick={() => onAsk(action)}>{action.id === "tighten" ? "Tighten this" : action.id === "style" ? "Hold it against the style" : action.id === "simplify" ? "Say it plainer" : action.label}</button>)}</div>
    <Composer value={value} onChange={onChange} onSubmit={onSubmit} onDictate={line => onChange(value ? `${value} ${line}` : line)} placeholder="Ask about this passage…" disabledReason={held} />
  </HeldBar></div>;
}
