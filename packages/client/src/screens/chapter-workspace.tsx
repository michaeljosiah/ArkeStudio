import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Link, useParams, useNavigate } from "react-router";
import {
  chapterParagraphs,
  countWords,
  targetWords,
  type ChapterSummary,
  type ProductionBundle,
  type ProseReadSource,
  type StagedProposal,
  type WorldBundle,
  overviewMoved,
} from "@arke-studio/contracts";
import { ProductionConversation, StagedDecision } from "../components/conversation.js";
import { RichMarkdownEditor } from "../components/editor/rich-markdown-editor.js";
import { updateRichModeGate, type RichModeGate } from "../components/editor/rich-mode.js";
import { Pin } from "../components/icons.js";
import { PageReadControl, useProsePageRead, type PageReadBlock } from "../components/page-read.js";
import { EmptyState, Screen } from "../components/layout.js";
import { Button } from "../components/ui.js";
import { useProduction } from "../lib/selectors.js";
import { EditableText, SceneTitle } from "./storyboard.js";
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

type OpenedRecord = { body: string; version: number; hash: string; versions: number[] };

/**
 * A save that must follow one still in flight after the screen is gone (codex, PR 879): the
 * answer to the first names the base the second needs, so the second waits for it here, outside
 * any component. A refusal ends it — the base moved, and there is no screen left to adopt the
 * disk for; the next open reads the file.
 */
function flushAfter(
  pending: string,
  save: { worldId: string; prodId: string; file: string; value: string; baseHash: string; landedBody: string | null },
): void {
  // Parked first, sent later: the reply this waits for never comes if the transport drops, and
  // a reconnect brings a snapshot rather than the event. The next screen to open the chapter
  // takes the parked text up and settles it against what is on disk (codex, PR 879).
  const key = parkedKey(save.worldId, save.prodId, save.file);
  parkedDrafts.set(key, { value: save.value, baseHash: save.baseHash, landedBody: save.landedBody });
  const unsubscribe = subscribeChapterSaveResults((result) => {
    if (result.requestId !== pending) return;
    unsubscribe();
    if (result.disposition !== "saved" || result.hash === undefined) return;
    const sent = saveChapter(save.worldId, save.prodId, save.file, save.value, result.hash);
    if (sent !== null) parkedDrafts.delete(key);
    else parkedDrafts.set(key, { value: save.value, baseHash: result.hash, landedBody: null });
  });
}

/**
 * Drafts a screen could not send before it was gone (codex, PR 879): the transport was down at
 * unmount, or the flush behind a save in flight found it down. Kept here, outside any component,
 * by chapter file, and taken up by the next screen to open that chapter, which sends them against
 * the base they were written on if the record has not moved since — or against the text an
 * older save of the same screen carried, `landedBody`, if that is what is on disk — and says so
 * if the record has genuinely moved.
 */
const parkedDrafts = new Map<string, { value: string; baseHash: string; landedBody: string | null }>();
const parkedKey = (worldId: string, prodId: string, file: string): string => `${worldId}/${prodId}/${file}`;

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
): { staged: StagedProposal; body: string | null } | undefined {
  const staged = [...proposals]
    .filter((entry) => entry.proposal.kind === "chapter-draft" && entry.proposal.targets.some((t) => t.path === path))
    .sort((left, right) =>
      left.proposal.created.localeCompare(right.proposal.created) || left.proposal.id.localeCompare(right.proposal.id),
    )
    .at(-1);
  if (!staged) return undefined;
  const prose = staged.review?.targets.find((t) => t.path === path)?.fields.find((f) => f.field === "Prose");
  return { staged, body: prose?.proposed ?? null };
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
   * Re-asked whenever the summary's version moves — an accepted draft cuts a version, and the
   * editor must adopt it rather than keep showing the text it read before — and again after a
   * refused save, because a refusal means the file moved under the editor by a same-version
   * write the summary cannot show (a direct save elsewhere, an edit outside the app), and the
   * disk text is the text. A direct save of our own keeps the version and comes back through
   * `chapter.save-result` with the new hash instead.
   */
  const [record, setRecord] = useState<OpenedRecord | null>(null);
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const [reopen, setReopen] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveRefusal, setSaveRefusal] = useState<string | null>(null);
  const [readNow, setReadNow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The save in flight, by requestId; a newer draft waits in `queuedDraft` until it answers. */
  const pendingSave = useRef<string | null>(null);
  const queuedDraft = useRef<string | null>(null);
  /**
   * A draft the transport could not carry, and the base it was written against; sent on the next
   * open against the record just read. Begins as whatever the last screen on this chapter parked.
   */
  const parked = parkedDrafts.get(parkedKey(worldId, prodId, chapter.file));
  const unsentDraft = useRef<string | null>(parked?.value ?? null);
  const unsentBase = useRef<string | null>(parked?.baseHash ?? null);
  /** The text an older save of the screen that parked this carried; on disk, it is not a move. */
  const unsentLanded = useRef<string | null>(parked?.landedBody ?? null);
  /** The text the pending save carried, so the answer can become the record without a re-read. */
  const savedText = useRef<string | null>(null);
  /** A read asked for while a save was pending; begun once the save lands (turn 126's fourth rule). */
  const readAfterSave = useRef(false);
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
    if (connection !== "open") return;
    // Taken up above, at mount; the next screen must not take it up again after this one sends it.
    parkedDrafts.delete(parkedKey(worldId, prodId, chapter.file));
    const requestId = openChapter(worldId, prodId, chapter.id);
    if (requestId === null) return;
    return subscribeChapterOpenResults((result: ChapterOpenResult) => {
      if (result.requestId !== requestId) return;
      if (result.disposition === "opened" && result.body !== undefined && result.version !== undefined && result.hash !== undefined) {
        const opened = { body: result.body, version: result.version, hash: result.hash, versions: result.versions ?? [] };
        const previous = recordRef.current;
        recordRef.current = opened;
        setRecord(opened);
        setOpenFailure(null);
        // A draft the transport could not carry goes out now, against the base just read —
        // unless the record moved while it waited, in which case the disk text is the text and
        // the foot says why the words on screen went. The hash is what says whether it moved:
        // an edit outside the app keeps the version (codex, PR 879).
        const unsent = unsentDraft.current;
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
        if (unsent !== null && (unsentAgainst === opened.hash || ours)) {
          if (opened.body !== unsent) {
            setSaving(true);
            setSaveRefusal(null);
            flushSave(unsent);
            return;
          }
        } else if (unsent !== null) {
          setSaveRefusal("the chapter moved · reloaded from disk");
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
  }, [worldId, prodId, chapter.id, chapter.version, reopen, connection]);

  const live = record?.body ?? "";
  const text = draft ?? live;

  const flushSave = useCallback(
    (value: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const current = recordRef.current;
      if (current === null) return;
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
      } else {
        // Refused: the file moved underneath the editor. The draft is not merged over it; the
        // chapter is re-read and the disk text adopted, which is what the Bible does on the
        // next snapshot, and the foot says why the words on screen went.
        setSaving(false);
        queuedDraft.current = null;
        readAfterSave.current = false;
        setSaveRefusal("the chapter moved · reloaded from disk");
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
   * editor holds. The answer lands after the listener is gone, which is fine — the snapshot
   * carries the count and the next open reads the file (codex, PR 879).
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
        }
        return;
      }
      // A transport that is down here would lose the words with the screen; they are parked for
      // the next one to open this chapter (codex, PR 879).
      const sent = saveChapter(worldId, prodId, chapter.file, value, base);
      if (sent === null) parkedDrafts.set(parkedKey(worldId, prodId, chapter.file), { value, baseHash: base, landedBody: null });
    },
    [worldId, prodId, chapter.file],
  );

  const onChangeAt = (at: number) => (value: string) => {
    // A change from an editor already replaced by an adoption is its parting flush, not typing.
    if (at !== epoch.current) return;
    richWrite.current = richMode ? value : null;
    draftRef.current = value;
    setDraft(value);
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
  // A read under way when a draft arrives is stopped with it: the manuscript now shows the
  // draft, and the accepted prose must not go on sounding under it (codex, PR 879).
  const drafted = stagedDraft !== undefined;
  useEffect(() => {
    if (drafted && pageRead.reading) pageRead.stop();
  }, [drafted, pageRead.reading, pageRead.stop]);
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
  const bookWords = production.chapters.reduce((sum, c) => sum + (c.words ?? 0), 0);
  const target = targetWords(production.story?.targetLength);
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
  const [proposed, setProposed] = useState<readonly string[]>([]);
  const implies = chapter.implies ?? [];
  const stale = overviewMoved(chapter, production.story);
  const characters = world.sheets.filter(
    (sheet) => sheet.type === "character" && !sheet.retired && (sheet.production === undefined || sheet.production === prodId),
  );
  const draws = chapter.draws ?? { sheets: [], canon: [] };
  const drawsEmpty = draws.sheets.length === 0 && draws.canon.length === 0;
  const chapterLabel = `chapter ${String(chapter.order).padStart(2, "0")}`;
  const foot = locked && stagedDraft !== undefined
    ? `Locked while a draft waits · v${record?.version ?? chapter.version} · ${words.toLocaleString()} words`
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
              {paragraphs.length > 0 && stagedDraft === undefined && <PageReadControl read={read} label="Read the chapter" />}
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
            <span>{stagedDraft !== undefined ? "draft waiting" : saving ? "saving" : "saved"}</span>
            {stale && (
              <span className="fy-ch__moved">
                overview moved · v{chapter.draftedAgainst} → v{production.story?.version}
              </span>
            )}
          </div>
        </header>

        <div className="fy-ch__body">
          <div className="fy-ch__manuscript">
            {openFailure !== null ? (
              <EmptyState title={openFailure} />
            ) : record === null ? (
              <EmptyState title="Opening…" />
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
                  key={`${chapter.id}:${record.version}`}
                  value={text}
                  onChange={onChange}
                  placeholder={PLACEHOLDER}
                  ariaLabel={`Chapter ${chapter.order}`}
                />
              </div>
            ) : (
              <textarea
                className="fy-ch__source"
                value={text}
                onChange={(e) => onChange(e.target.value)}
                spellCheck
                placeholder={PLACEHOLDER}
                aria-label={`Chapter ${chapter.order}`}
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

            <section className="fy-bible__panel">
              <h2 className="fy-bible__paneltitle">
                Implies <span className="fy-mono">{implies.length}</span>
              </h2>
              {implies.length === 0 ? (
                <p className="fy-bible__empty">Nothing implied yet.</p>
              ) : (
                <ul className="fy-ch__implies">
                  {implies.map((fact, i) => {
                    const key = `${fact.kind}:${fact.what}`;
                    return (
                      <li key={key}>
                        <span className="fy-mono">{fact.kind}</span>
                        <span className="fy-ch__fact">{fact.what}</span>
                        {proposed.includes(key) ? (
                          <span className="fy-mono">proposed</span>
                        ) : (
                          <Button
                            variant="ghost"
                            disabled={locked}
                            onClick={() => {
                              setProposed((current) => [...current, key]);
                              setSay((current) => ({ line: `Propose as ${fact.kind}: ${fact.what}`, seq: (current?.seq ?? 0) + 1 }));
                            }}
                          >
                            Propose
                          </Button>
                        )}
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
                  <p className="fy-bible__empty fy-mono">restoring makes a new version</p>
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
          dock={{
            title: `Arke · Chapter ${String(chapter.order).padStart(2, "0")}`,
            subject: `${chapter.title} · ${production.meta.title}`,
            conversationFirst: true,
            onPutAway: () => setDock(false),
            // The first prompt follows the plan (turn 127): a synopsis with no prose is drafted
            // from; a chapter with prose is continued.
            prompts: [firstPrompt(live, chapter.synopsis), "What does this chapter draw on?"],
            // The thread is the production's own (no new entry context, turn 126): the chapter
            // the dock names has to be in the words themselves or the studio never hears it.
            subjectPrefix: `About ${chapterLabel}:`,
            note: "talking changes nothing here · a draft waits for your yes",
          }}
          openingNote="opening…"
          emptyLine={`Nothing written with Arke for ${chapterLabel} yet.`}
          placeholder={`Ask about ${chapterLabel}`}
          {...(stagedDraft === undefined
            ? { pointsEmpty: "Nothing understood yet. As you talk, what Arke takes from the chapter appears here." }
            : {
                side: (
                  <StagedDecision
                    worldId={worldId}
                    subject={chapterLabel}
                    staged={stagedDraft.staged}
                    writes="Replaces the chapter's prose."
                    items={[
                      {
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
