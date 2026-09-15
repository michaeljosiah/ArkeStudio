import {
  resolvedAuthoredDuration,
  type ProseReadSource,
  targetWords,
  overviewMoved,
} from "@arke-studio/contracts";
import { createContext, useContext, useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import {
  productionShape,
  isManuscriptLanguage,
  type ChapterSummary,
  type ProductionBundle,
  type Scene,
  type WorldBundle,
  orderedShots,
} from "@arke-studio/contracts";
import { EmptyState, Screen } from "../components/layout.js";
import { Badge, Button, IconButton, Input, cx } from "../components/ui.js";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  Upload,
} from "../components/icons.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { ReadAloud } from "../components/read-aloud.js";
import { PageReadControl, useProsePageRead, type PageReadBlock } from "../components/page-read.js";
import { Portrait } from "../components/portrait.js";
import { seconds } from "../lib/format.js";
import { downloadMedia } from "../lib/download.js";
import {
  acceptedTakeId,
  useProduction,
} from "../lib/selectors.js";
import { DevelopmentWorkspace } from "./development.js";
import { SceneWorkspace } from "./scene-workspace/workspace.js";
import {
  cancelExport,
  cancelManuscript,
  exportManuscript,
  importManuscript,
  openExportsFolder,
  pickManuscript,
  rereadManuscript,
  useManuscripts,
  createScene,
  useExports,
  useStore,
  useWorld,
  subscribeSceneCreateResults,
  createChapter,
  subscribeChapterCreateResults,
  setChapterRetired,
  reorderChapters,
} from "../lib/store.js";
import { continuityRows, continuityRowStamp, rememberChaptersView, rememberedChaptersView, type ChaptersView } from "../lib/continuity.js";
import { defaultEpisodeFor } from "./production-shell.js";

/**
 * The scene's on-disk stem, from the bundle's scan-captured record (issue 387) — never a
 * reconstruction from number and slug, which goes blind the moment a file's name stops
 * matching. Null means the bundle predates the record; the senders skip rather than guess.
 */
export function sceneFileOf(
  production: { sceneFiles: Record<string, string> } | null | undefined,
  scene: Scene,
): string | null {
  return production?.sceneFiles[scene.id] ?? null;
}

/**
 * The one way a scene begins (SPEC-036 R-37): pressed anywhere, it makes an empty scene and
 * opens it. Pending until the correlated result arrives, the way a production create is
 * (issue 384): success opens the scene it made, never the list; failure is the toaster's to
 * say, so the button here only has to come back.
 */
export function useNewScene(worldId: string | undefined, prodId: string | undefined) {
  const navigate = useNavigate();
  const connection = useStore().connection;
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  useEffect(() => {
    if (pendingRequest === null) return;
    return subscribeSceneCreateResults((result) => {
      if (result.requestId !== pendingRequest) return;
      setPendingRequest(null);
      // The destination is the result's own world and production, not this route's (codex,
      // PR 708): the layout stays mounted across a production switch, and a scene made in the
      // one you left must not be opened under the one you arrived at.
      if (result.disposition === "created" && result.sceneId !== undefined) {
        navigate(
          `/w/${encodeURIComponent(result.worldId)}/p/${encodeURIComponent(result.productionId)}/scenes/${encodeURIComponent(result.sceneId)}`,
        );
      }
    });
  }, [pendingRequest, navigate]);
  // A result lost to a dropped connection never arrives — reconnect brings a snapshot, not the
  // answer — and a press that waited on it would stay disabled for the session (codex, PR 708).
  // The scene may well exist by then; the rail shows it, and the press is offered again.
  useEffect(() => {
    if (connection !== "open") setPendingRequest(null);
  }, [connection]);
  return {
    pending: pendingRequest !== null,
    create: (episodeId?: string) => {
      if (!worldId || !prodId || pendingRequest !== null) return;
      setPendingRequest(createScene(worldId, prodId, episodeId === undefined ? {} : { episodeId }));
    },
  };
}

/**
 * `New chapter` (turn 126): a press, not a form. It creates `Untitled` live and opens it, the
 * shape SPEC-036 R-37 gave `New scene`, on the answer `create-chapter` now returns.
 */
export function useNewChapter(worldId: string | undefined, prodId: string | undefined) {
  const navigate = useNavigate();
  const connection = useStore().connection;
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  useEffect(() => {
    if (pendingRequest === null) return;
    return subscribeChapterCreateResults((result) => {
      if (result.requestId !== pendingRequest) return;
      setPendingRequest(null);
      // The result's own world and production, not this route's (the New scene lesson, PR 708).
      if (result.disposition === "created" && result.chapterId !== undefined) {
        navigate(
          `/w/${encodeURIComponent(result.worldId)}/p/${encodeURIComponent(result.productionId)}/story/chapters/${encodeURIComponent(result.chapterId)}`,
        );
      }
    });
  }, [pendingRequest, navigate]);
  // A result lost to a dropped connection never arrives; the press is offered again on reconnect.
  useEffect(() => {
    if (connection !== "open") setPendingRequest(null);
  }, [connection]);
  return {
    pending: pendingRequest !== null,
    create: (order: number) => {
      if (!worldId || !prodId || pendingRequest !== null) return;
      setPendingRequest(createChapter(worldId, prodId, "Untitled", order));
    },
  };
}

/**
 * The layout's one pending press, shared with the screens under it (codex, PR 708): a press on
 * the Scenes screen followed by a rail link unmounts that screen with its listener, and the
 * scene it made would never be opened. The layout outlives the screens, so it holds the request,
 * and every New scene control in a production reads the same pending state.
 */
export const NewSceneContext = createContext<ReturnType<typeof useNewScene> | null>(null);

/** The layout's press where there is one, else this screen's own (screens rendered alone). */
export function useSharedNewScene(worldId: string | undefined, prodId: string | undefined) {
  const own = useNewScene(worldId, prodId);
  return useContext(NewSceneContext) ?? own;
}

/** The same for `New chapter`: a press followed by a rail link must still open what it made. */
export const NewChapterContext = createContext<ReturnType<typeof useNewChapter> | null>(null);

function useSharedNewChapter(worldId: string | undefined, prodId: string | undefined) {
  const own = useNewChapter(worldId, prodId);
  return useContext(NewChapterContext) ?? own;
}

export function storyShotCount(production: ProductionBundle | null | undefined): number {
  return production?.scenes.reduce((count, scene) => count + orderedShots(scene).length, 0) ?? 0;
}

// ---- Story (10b) -----------------------------------------------------------

export function StoryScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  // An episodic production's details are the four-view workspace (turn 48; issue 397); a
  // non-episodic one keeps the single overview — no fake episode or season controls. The
  // branch is a component boundary, not an early return: returning before the overview's own
  // hooks broke the Rules of Hooks the moment a production's shape settled after first render.
  if (production && productionShape(production.meta).isEpisodic) return <DevelopmentWorkspace />;
  return <OverviewStoryScreen />;
}

function OverviewStoryScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const story = production?.story ?? null;
  /*
   * What is already waiting on a decision for this production's overview (turn 86).
   *
   * The rail marks each field the staged proposal would change, using the proposal's own
   * field-by-field review — computed from the captured base against the proposed file — so the
   * screen cannot claim a change the gate would not make.
   */
  const staged = (world?.proposals ?? []).find((sp) =>
    sp.proposal.targets.some((t) => t.path === `productions/${prodId}/story.json` || t.path === `productions/${prodId}/prose-style.json`),
  );
  /** Every field the staged proposal would change, flattened out of its per-target review. */
  const stagedFields = staged?.review?.targets.flatMap((t) => t.fields) ?? [];
  const spineLines = (story?.spine ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  /*
   * The overview is one document, so it is also one listen (issue 859).
   *
   * The cards below each carry their own speaker; this reads them through in the order they are
   * drawn. Declared here rather than taken from the page, because the page is cards, headings
   * and a composer, and only this list says which of it is the document.
   */
  const actsSpoken = (story?.acts ?? [])
    .map((act, i) => `${i + 1}. ${act.title}${act.summary ? ` — ${act.summary}` : ""}`)
    .join(" ");
  const overviewTitle = production?.meta.title ?? "Overview";
  /* The style the book is written in (turn 128): its cards sit under the overview's. */
  const style = production?.proseStyle ?? null;
  // A blank sample in a hand-edited record is no listen and no card line (codex on PR 903) —
  // and the ones that remain keep their places in the record, because the read names a sample
  // by its index there, and a compacted list would read the wrong one aloud.
  const samples = (style?.samples ?? [])
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => sample.trim() !== "");
  const pageBlocks: (PageReadBlock & { source: ProseReadSource })[] = [
    ...(
      [
        ["logline", "Logline", story?.logline ?? ""],
        ["spine", "Spine", story?.spine ?? ""],
        ["question", "Dramatic question", story?.question ?? ""],
        ["ending", "Ending", story?.ending ?? ""],
        ["acts", "Acts", actsSpoken],
        ["treatment", "Treatment", production?.treatment ?? ""],
        ["voice", "Voice", style?.voice ?? ""],
      ] as const
    )
      .filter(([, , body]) => body.trim() !== "")
      .map(([field, heading, body]) => ({
        heading,
        body,
        source: { of: "story", productionId: prodId ?? "", field } as ProseReadSource,
      })),
    // One block per sample (codex on turn 128), so no single read outruns a narrator's cap.
    ...samples.map(({ sample, index }) => ({
      heading: `Sample ${index + 1}`,
      body: sample,
      source: { of: "story", productionId: prodId ?? "", field: "samples", sample: index } as ProseReadSource,
    })),
  ];
  const pageRead = useProsePageRead({ pageId: prodId, title: overviewTitle, blocks: pageBlocks });
  return (
    <div className="fy-story" data-screen="story-overview">
      {/* The details, not a conversation (turn 88): what the thread settled, read and worked
          with. Changing any of it is done next door, where it was decided. */}
      <div className="fy-story__chat">
        <div className="fy-story__chathead">
          <div className="fy-eyebrow-sm">
            OVERVIEW · {production ? productionShape(production.meta).displayLabel.toLowerCase() : ""}
          </div>
          <h1 className="fy-story__h1">{story || style ? "The story, as it stands" : "Nothing settled yet"}</h1>
          {/* Page scale (issue 859): the cards below, read through in the order drawn. Only once
              there is more than one — a page read of a lone logline is that card's own press. */}
          {pageBlocks.length > 1 && (
            <div style={{ marginTop: 10 }}>
              <PageReadControl read={pageRead} label="Read the overview" />
            </div>
          )}
        </div>
        <div className="fy-story__log">
          {/* A style can be settled before an overview is (codex on turn 128): either is enough
              for the page to have something to draw. */}
          {story || style ? (
            <div style={{ display: "grid", gap: 14 }}>
              {/*
                The overview is one document, and its cards are the blocks it is read in
                (issue 857). Each carries its own read-aloud rather than the screen carrying one:
                a logline and a treatment are not the same length of listen, and the press should
                say which of them it is starting.
              */}
              {story && (
                <div className="fy-draftcard fy-texthost">
                  <div className="fy-eyebrow-sm">LOGLINE</div>
                  <div className="fy-draftcard__logline">“{story.logline}”</div>
                  <ReadAloud
                    source={{ of: "story", productionId: prodId ?? "", field: "logline" }}
                    title={`${production?.meta.title ?? "Overview"} · logline`}
                    text={story.logline ?? ""}
                  />
                </div>
              )}
              {(["question", "ending"] as const).map((field) => story?.[field] ? (
                <div key={field} className="fy-draftcard fy-texthost">
                  <div className="fy-eyebrow-sm">{field === "question" ? "DRAMATIC QUESTION" : "ENDING"}</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{story[field]}</div>
                  <ReadAloud source={{ of: "story", productionId: prodId ?? "", field }}
                    title={field === "question" ? "Dramatic question" : "Ending"} text={story[field]} />
                </div>
              ) : null)}
              {spineLines.length > 0 && (
                <div className="fy-draftcard fy-texthost">
                  <div className="fy-eyebrow-sm">SPINE</div>
                  {spineLines.map((line) => (
                    <div key={line} style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4 }}>
                      {line}
                    </div>
                  ))}
                  <ReadAloud
                    source={{ of: "story", productionId: prodId ?? "", field: "spine" }}
                    title={`${production?.meta.title ?? "Overview"} · spine`}
                    text={story?.spine ?? ""}
                  />
                </div>
              )}
              {(story?.acts ?? []).length > 0 && (
                <div className="fy-draftcard fy-texthost">
                  <div className="fy-eyebrow-sm">ACTS</div>
                  {(story?.acts ?? []).map((act, i) => (
                    <div key={act.title} style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4 }}>
                      {i + 1}. {act.title}
                      {act.summary ? ` — ${act.summary}` : ""}
                    </div>
                  ))}
                  <ReadAloud
                    source={{ of: "story", productionId: prodId ?? "", field: "acts" }}
                    title={`${production?.meta.title ?? "Overview"} · acts`}
                    text={(story?.acts ?? [])
                      .map((act, i) => `${i + 1}. ${act.title}${act.summary ? ` — ${act.summary}` : ""}`)
                      .join(" ")}
                  />
                </div>
              )}
              {production?.treatment && (
                <div className="fy-draftcard fy-texthost">
                  <div className="fy-eyebrow-sm">TREATMENT</div>
                  <div
                    style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4, whiteSpace: "pre-wrap" }}
                  >
                    {production.treatment}
                  </div>
                  <ReadAloud
                    source={{ of: "story", productionId: prodId ?? "", field: "treatment" }}
                    title={`${production.meta.title} · treatment`}
                    text={production.treatment}
                  />
                </div>
              )}
              {/*
                The style the book is written in (turn 128): the overview's cards, at the
                overview's measure, under a heading that says where it was settled and who reads
                it. Voice and samples read aloud; point of view and tense are labels, not a listen.
              */}
              {style !== null && (
                <>
                  <div className="fy-story__stylehead" data-testid="prose-style">
                    <span style={{ font: "600 13px var(--font-sans)" }}>Style</span>
                    <span className="fy-mono">v{style.version} · settled in Develop</span>
                  </div>
                  {style.pov !== undefined && (
                    <div className="fy-draftcard fy-texthost">
                      <div className="fy-eyebrow-sm">POINT OF VIEW</div>
                      <div style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4 }}>{style.pov}</div>
                    </div>
                  )}
                  {style.tense !== undefined && (
                    <div className="fy-draftcard fy-texthost">
                      <div className="fy-eyebrow-sm">TENSE</div>
                      <div style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4 }}>{style.tense}</div>
                    </div>
                  )}
                  {style.voice !== undefined && (
                    <div className="fy-draftcard fy-texthost">
                      <div className="fy-eyebrow-sm">VOICE</div>
                      <div style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4, whiteSpace: "pre-wrap" }}>{style.voice}</div>
                      <ReadAloud
                        source={{ of: "story", productionId: prodId ?? "", field: "voice" }}
                        title={`${overviewTitle} · voice`}
                        text={style.voice}
                      />
                    </div>
                  )}
                  {samples.length > 0 && (
                    <div className="fy-draftcard fy-texthost">
                      <div className="fy-eyebrow-sm">SAMPLES · {samples.length}</div>
                      {/* One read per sample (codex on turn 128): six at their bound read as one
                          block outrun a narrator's prompt cap, so each sample is its own listen. */}
                      {samples.map(({ sample, index }) => (
                        <div key={`${index}:${sample}`} style={{ marginTop: 4 }} data-sample={index}>
                          <div className="fy-draftcard__logline">“{sample}”</div>
                          <ReadAloud
                            source={{ of: "story", productionId: prodId ?? "", field: "samples", sample: index }}
                            title={`${overviewTitle} · sample ${index + 1}`}
                            text={sample}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <EmptyState
              title="Nothing settled yet"
            />
          )}
        </div>
        <div
          style={{ flex: "none", padding: "14px 36px 22px", display: "flex", gap: 10, alignItems: "center" }}
        >
          <NavLink to={`/w/${worldId}/p/${prodId}/story`} className="fy-linkbtn">
            &larr; Production Chat
          </NavLink>
          <span className="fy-mono">
            the overview steers scene and chapter drafting · it never overwrites a scene you have locked
          </span>
        </div>
      </div>
      {/* The rail beside a details screen holds what is staged against it (turn 86/88) — the
          object itself is the screen, so repeating it here would be two copies of one thing. */}
      <div className="fy-story__side">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ font: "600 15px var(--font-sans)" }}>Waiting on you</div>
          <span className="fy-mono" style={{ color: staged ? "var(--warning)" : undefined }}>
            {staged
              ? `${stagedFields.length} change${stagedFields.length === 1 ? "" : "s"}`
              : "nothing staged"}
          </span>
        </div>
        {staged ? (
          <div style={{ display: "grid", gap: 12 }}>
            {stagedFields.map((field) => (
              <div key={field.field} className="fy-draftcard">
                <div className="fy-draftcard__head">
                  <span className="fy-eyebrow-sm">{field.field}</span>
                  <Badge tone="warning">would change</Badge>
                </div>
                <div style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 6 }}>
                  {field.proposed ?? "(removed)"}
                </div>
                {field.before !== null && <div className="fy-draftcard__was">Accepted: “{field.before}”</div>}
              </div>
            ))}
            <div className="fy-mono">return to Production Chat to accept, revise, or discard it</div>
          </div>
        ) : (
          <div className="fy-emptycard">
            <div style={{ font: "400 13px/1.7 var(--font-sans)" }}>
              Nothing waiting. What Production Chat settles arrives here to be accepted before it lands.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Chapters, the door (turn 126): every row a destination, the in-hand chapter marked, the book's
 * count as a band under the title, and `New chapter` as a press. The screen is called by the
 * rail's word; "Chapter tree" was a title nobody pressed.
 */
export function ChapterPlan({ chapter, world, story }: { chapter: ChapterSummary; world: WorldBundle | null; story: ProductionBundle["story"] }) {
  const pov = chapter.pov === undefined ? null : world?.sheets.find((sheet) => sheet.id === chapter.pov)?.name ?? chapter.pov;
  const moved = overviewMoved(chapter, story);
  return <>
    {chapter.synopsis && <span className="fy-row__syn">{chapter.synopsis}</span>}
    {(pov || chapter.when || moved) && <span className="fy-row__marks">
      {pov && <span className="fy-mono">{pov}</span>}
      {chapter.when && <span className="fy-mono">{pov ? "· " : ""}{chapter.when}</span>}
      {moved && <span className="fy-row__moved">overview moved · v{chapter.draftedAgainst} → v{story?.version}</span>}
    </span>}
  </>;
}

export function ChapterOutlineRow({ chapter: c, world, story, inHand, onOpen }: {
  chapter: ChapterSummary; world: WorldBundle | null; story: ProductionBundle["story"]; inHand: boolean; onOpen: () => void;
}) {
  return <button type="button" className={cx("fy-row", inHand && "fy-row--inhand")} style={{ flex: 1, minWidth: 0 }} onClick={onOpen}>
    <span className="fy-mono">{String(c.order).padStart(2, "0")}</span>
    <span className="fy-row__plan"><span className="fy-row__name">{c.title}</span><ChapterPlan chapter={c} world={world} story={story} /></span>
    {c.source !== undefined && <Badge tone="outline">imported</Badge>}
    <Badge tone="outline">v{c.version}</Badge>
    <span className="fy-row__meta">{c.words ? `${c.words.toLocaleString()} words` : c.status}{inHand ? " · in hand" : ""}</span>
    <span className="fy-row__chev"><ChevronRight size={15} /></span>
  </button>;
}

export function ChapterTreeScreen() {
  const { prodId, worldId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const newChapter = useSharedNewChapter(worldId, prodId);
  const allChapters = production?.chapters ?? [];
  const chapters = allChapters.filter((c) => !c.retired);
  const retiredChapters = allChapters.filter((c) => c.retired);
  const move = (chapter: ChapterSummary, direction: number) => {
    const neighbour = chapters[chapters.indexOf(chapter) + direction];
    if (!worldId || !prodId || !neighbour) return;
    const files = allChapters.map((c) => c.file);
    const a = files.indexOf(chapter.file), b = files.indexOf(neighbour.file);
    [files[a], files[b]] = [files[b]!, files[a]!];
    reorderChapters(worldId, prodId, files);
  };
  const isStory = production ? productionShape(production.meta).hasChapters : false;
  /*
   * A manuscript out and in (turn 131): two presses beside New chapter and two sheets in the
   * film export dialog's shape. The import's request is the sheet's; what came of it is the
   * session's line under the band.
   */
  const [sheet, setSheet] = useState<"export" | "import" | null>(null);
  const [importRequest, setImportRequest] = useState<string | null>(null);
  const [imported, setImported] = useState<{ fileName: string; created: number; after: number } | null>(null);
  const manuscripts = useManuscripts();
  const importState = importRequest === null ? undefined : manuscripts[importRequest];
  useEffect(() => {
    if (importRequest === null) return;
    // The picker closed without a file is no action (codex on PR 924): the sheet closes.
    if (importState?.state === "cancelled") {
      setImportRequest(null);
      setSheet(null);
      return;
    }
    if (importState?.state !== "imported") return;
    setImported({ fileName: importState.fileName ?? "", created: importState.created ?? 0, after: importState.after ?? 0 });
    setImportRequest(null);
    setSheet(null);
  }, [importState, importRequest]);
  useEffect(() => {
    setImported(null);
  }, [prodId]);
  const beginImport = () => {
    if (!worldId || !prodId) return;
    setImportRequest(pickManuscript(worldId, prodId));
    setSheet("import");
  };
  const closeImport = () => {
    if (worldId && importRequest !== null && importState?.state !== "importing") cancelManuscript(worldId, importRequest);
    setImportRequest(null);
    setSheet(null);
  };
  const drafted = chapters.filter((c) => (c.words ?? 0) > 0).length;
  const bookWords = chapters.reduce((sum, c) => sum + (c.words ?? 0), 0);
  const target = targetWords(production?.story?.targetLength, chapters.length);
  // The outline marks the first chapter with no words yet.
  const inHand = chapters.find((c) => !c.words) ?? null;
  /*
   * The door's two views (turn 129): Outline is turn 127's; Continuity is where everyone is,
   * chapters down and the cast across, computed from the summaries' placings alone. The view
   * remembers itself for the session.
   */
  const [view, setView] = useState<ChaptersView>(() => rememberedChaptersView(prodId));
  // The screen stays mounted when only the production changes (codex on PR 907): the view is
  // the production's own, so it is read again for the next one.
  useEffect(() => {
    setView(rememberedChaptersView(prodId));
  }, [prodId]);
  const choose = (next: ChaptersView) => {
    setView(next);
    rememberChaptersView(prodId, next);
  };
  const cast = (world?.sheets ?? []).filter(
    (sheet) => sheet.type === "character" && !sheet.retired && (sheet.production === undefined || sheet.production === prodId),
  );
  const rows = view === "continuity" ? continuityRows(chapters, cast.map((sheet) => sheet.id)) : [];
  const derivedCount = chapters.filter((c) => c.continuity !== undefined && !("unreadable" in c.continuity)).length;
  const placeName = (id: string) => world?.sheets.find((sheet) => sheet.id === id)?.name ?? id;
  const pad = (order: number) => String(order).padStart(2, "0");
  return (
    <div className="fy-prodmain" data-screen="chapter-tree">
      <div className="fy-h1row">
        <h1 className="fy-h1">{view === "continuity" ? "Where everyone is" : "Chapters"}</h1>
        <span className="fy-h1row__meta">
          {chapters.length} chapter{chapters.length === 1 ? "" : "s"} · {drafted} drafted ·{" "}
          {target === null
            ? `${bookWords.toLocaleString()} words`
            : `${bookWords.toLocaleString()} of ${target.toLocaleString()} words`}
        </span>
        {isStory && (
          <nav className="fy-seg" aria-label="Chapters view">
            <button type="button" className={cx("fy-seg__item", view === "outline" && "fy-seg__item--active")} onClick={() => choose("outline")}>
              Outline
            </button>
            <button type="button" className={cx("fy-seg__item", view === "continuity" && "fy-seg__item--active")} onClick={() => choose("continuity")}>
              Continuity
            </button>
          </nav>
        )}
        <span className="fy-h1row__push" />
        {isStory && (
          <>
            <Button onClick={() => setSheet("export")} data-testid="export-manuscript">
              <Download size={13} />
              Export
            </Button>
            <Button onClick={beginImport} data-testid="import-manuscript">
              <Upload size={13} />
              Import
            </Button>
            <Button variant="primary" disabled={newChapter.pending} onClick={() => newChapter.create(chapters.length + 1)}>
              New chapter
            </Button>
          </>
        )}
      </div>
      {isStory && production && (
        <ManuscriptExportSheet open={sheet === "export"} onClose={() => setSheet(null)} worldId={worldId} prodId={prodId} production={production} chapters={chapters} />
      )}
      {isStory && (
        <ManuscriptImportSheet
          open={sheet === "import"}
          onClose={closeImport}
          worldId={worldId}
          prodId={prodId}
          requestId={importRequest}
          state={importState}
        />
      )}
      {view === "outline" && imported !== null && (
        <div className="fy-cont__meta" data-testid="imported-line">
          imported · {imported.fileName} · {imported.created} chapter{imported.created === 1 ? "" : "s"} · after {imported.after}
        </div>
      )}
      {view === "outline" && target !== null && (
        <div className="fy-ch__target fy-ch__target--page" role="progressbar" aria-valuemin={0} aria-valuemax={target} aria-valuenow={Math.min(bookWords, target)}>
          <span style={{ width: `${Math.min(100, Math.round((bookWords / target) * 100))}%` }} />
        </div>
      )}
      {view === "continuity" && (
        <div className="fy-cont__meta">
          after each chapter · derived from the prose, never written into the world · {chapters.length} chapter{chapters.length === 1 ? "" : "s"}, {derivedCount} derived · a
          quiet cell is carried from the chapter it names · nothing carries past a chapter not derived
        </div>
      )}
      {production && chapters.length > 0 && view === "continuity" ? (
        <div className="fy-cont" data-testid="continuity-table">
          <table className="fy-cont__table">
            <thead>
              <tr>
                <th className="fy-cont__th fy-cont__th--chapter">Chapter</th>
                {cast.map((sheet) => (
                  <th key={sheet.id} className="fy-cont__th">
                    {sheet.name}
                  </th>
                ))}
                <th className="fy-cont__th" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = () => navigate(`/w/${worldId}/p/${prodId}/story/chapters/${encodeURIComponent(row.chapter.id)}`);
                const warn = row.stamp.kind === "stale";
                return (
                  <tr
                    key={row.chapter.id}
                    className={cx("fy-cont__row", warn && "fy-cont__row--warn")}
                    role="button"
                    tabIndex={0}
                    data-stamp={row.stamp.kind}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open();
                      }
                    }}
                  >
                    <td className="fy-cont__chapter">
                      <span className="fy-mono">{pad(row.chapter.order)}</span>
                      <span className="fy-cont__title">{row.chapter.title}</span>
                      <span className="fy-mono">v{row.chapter.version}</span>
                    </td>
                    {row.cells.map((cell, i) =>
                      cell === null || cell.gone || cell.unsure ? (
                        <td
                          key={cast[i]!.id}
                          className={cx("fy-cont__cell fy-cont__cell--none", cell?.warn && "fy-cont__cell--warn")}
                          {...(cell?.gone
                            ? { title: `gone since ${pad(cell.since!)}${cell.warn ? " · that chapter moved" : ""}` }
                            : cell?.unsure
                              ? { title: "place dropped · the chapter said they moved and could not prove where" }
                              : {})}
                        >
                          —
                        </td>
                      ) : (
                        <td key={cast[i]!.id} className={cx("fy-cont__cell", cell.since !== undefined && "fy-cont__cell--carried", cell.warn && "fy-cont__cell--warn")}>
                          {placeName(cell.where ?? "")}
                          {cell.since !== undefined && <span className="fy-cont__since fy-mono">since {pad(cell.since)}</span>}
                        </td>
                      ),
                    )}
                    <td className={cx("fy-cont__stamp fy-mono", warn && "fy-cont__stamp--warn")}>{continuityRowStamp(row.stamp)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : production && chapters.length > 0 ? (
        <div className="fy-ledger">
          {chapters.map((c, index) => {
            return (
            <div key={c.id} style={{ display: "flex", alignItems: "center" }}>
            <ChapterOutlineRow chapter={c} world={world} story={production.story} inHand={c === inHand}
              onOpen={() => navigate(`/w/${worldId}/p/${prodId}/story/chapters/${encodeURIComponent(c.id)}`)} />
            {/* One register per row (issue 1010, U1): the two arrows were already glyphs, and
                Retire beside them repeated the word once per chapter. */}
            <IconButton label={`Move ${c.title} up`} disabled={index === 0} onClick={() => move(c, -1)}><ChevronUp /></IconButton>
            <IconButton label={`Move ${c.title} down`} disabled={index === chapters.length - 1} onClick={() => move(c, 1)}><ChevronDown /></IconButton>
            <IconButton label={`Retire ${c.title}`} onClick={() => worldId && prodId && setChapterRetired(worldId, prodId, c.file, true)}><Archive /></IconButton>
            </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title={
            production && productionShape(production.meta).hasChapters
              ? "No chapters yet"
              : "Chapters belong to Story productions"
          }
          hint={
            production && productionShape(production.meta).hasChapters
              ? "Chapters hang beneath the overview and are drafted through the gate."
              : "This production's structure lives in Scenes."
          }
        />
      )}
      {retiredChapters.length > 0 && <details>
        <summary>{retiredChapters.length} retired chapter{retiredChapters.length === 1 ? "" : "s"}</summary>
        {retiredChapters.map((c) => <div key={c.id} className="fy-row">
          <span className="fy-row__name">{c.title}</span>
          <Button onClick={() => worldId && prodId && setChapterRetired(worldId, prodId, c.file, false)}>Restore {c.title}</Button>
        </div>)}
      </details>}
    </div>
  );
}

/**
 * The export sheet (turn 131, SPEC-012 R-49, R-51): the format, what goes in and what is left
 * out, the language an EPUB is marked with, and what was delivered. The file is built whole by
 * the coordinator and lands under the world's exports folder; the sheet only names and counts.
 */
function ManuscriptExportSheet({
  open,
  onClose,
  worldId,
  prodId,
  production,
  chapters,
}: {
  open: boolean;
  onClose: () => void;
  worldId: string | undefined;
  prodId: string | undefined;
  production: ProductionBundle;
  chapters: readonly ChapterSummary[];
}) {
  const [format, setFormat] = useState<"docx" | "epub">("docx");
  const [language, setLanguage] = useState("en");
  // A BCP 47 tag or nothing (codex on PR 916): "English" in the package would make an EPUB a
  // reader may refuse, so the press waits until the field is one.
  const languageOk = format !== "epub" || isManuscriptLanguage(language.trim());
  const exportsState = useExports();
  const world = useWorld();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const withProse = chapters.filter((c) => (c.words ?? 0) > 0);
  const words = withProse.reduce((sum, c) => sum + (c.words ?? 0), 0);
  const leftOut = chapters.length - withProse.length;
  const delivered = Object.entries(exportsState)
    .filter(([id, entry]) => id.startsWith("ms_") && entry.productionId === prodId && (entry.worldId === undefined || entry.worldId === worldId))
    .slice(-4);
  // Only a host can open a folder (R-51): a browser session lists the file and has no folder to open.
  const hosted = typeof window !== "undefined" && window.arke?.openDataFolder !== undefined;
  const name = (output: string | null) => output?.split("/").pop() ?? "";
  return (
    <EditorDialog open={open} title="Export manuscript" subtitle={`${production.meta.title} · ${withProse.length} of ${chapters.length} chapters · ${words.toLocaleString()} words`} onClose={onClose} width={430} labelledBy="manuscript-export-title">
      <div className="fy-exsheet" data-testid="manuscript-export">
        <nav className="fy-seg" aria-label="Format">
          <button type="button" className={cx("fy-seg__item", format === "docx" && "fy-seg__item--active")} onClick={() => setFormat("docx")}>
            Word · .docx
          </button>
          <button type="button" className={cx("fy-seg__item", format === "epub" && "fy-seg__item--active")} onClick={() => setFormat("epub")}>
            EPUB
          </button>
        </nav>
        <div className="fy-ms__line">
          {withProse.length} chapter{withProse.length === 1 ? "" : "s"} with prose, in order{leftOut > 0 ? ` · ${leftOut} planned left out` : ""}
        </div>
        <div className="fy-ms__line">
          title page · chapter titles as headings · *emphasis* kept · *** as a scene break
          {format === "epub" ? " · language " : ""}
          {format === "epub" && (
            <Input aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)} style={{ width: 64, display: "inline-block" }} />
          )}
        </div>
        {delivered.length > 0 && (
          <div className="fy-ms__delivered">
            <span className="fy-ms__label">Delivered</span>
            {delivered.map(([id, entry]) => (
              <div key={id} className="fy-ms__row" data-testid="manuscript-delivery">
                <span className="fy-ms__row-mono">{entry.output ? name(entry.output) : id.slice(0, 9)}</span>
                <span className="fy-ms__row-meta">
                  {entry.status}
                  {entry.status === "running" ? ` · ${Math.round(entry.percent)}%` : ""}
                  {entry.error ? ` · ${entry.error}` : ""}
                </span>
                {entry.status === "running" && (
                  <button type="button" className="fy-exsheet__chip" onClick={() => worldId && cancelExport(worldId, id)}>
                    Cancel
                  </button>
                )}
                {entry.status === "done" && hosted && (
                  <button type="button" className="fy-exsheet__chip" onClick={() => worldId && openExportsFolder(worldId)}>
                    Show in folder
                  </button>
                )}
                {entry.status === "done" && !hosted && entry.output && world && world.meta.worldId === worldId && (
                  <button type="button" className="fy-exsheet__chip" onClick={async () => {
                    setDownloadError(null);
                    const result = await downloadMedia(world.meta.slug, entry.output!, null, "manuscript");
                    if (!result.ok && !result.cancelled) setDownloadError(result.reason);
                  }}>
                    Download
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {/* Said from the summaries, and the press stays live (codex on PR 916): a chapter written
            outside the app carries no count until it is next saved, so the export reads the
            chapters themselves and refuses in these words only when there is truly nothing. */}
        {withProse.length === 0 && <div className="fy-ms__line fy-ms__line--warn">nothing to export · no chapter has prose yet</div>}
        {!languageOk && <div className="fy-ms__line fy-ms__line--warn">language · not a BCP 47 tag</div>}
        {downloadError && <div role="alert" className="fy-ms__line fy-ms__line--warn">{downloadError}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={chapters.length === 0 || !languageOk || !worldId || !prodId}
            onClick={() => worldId && prodId && exportManuscript(worldId, prodId, format, language.trim())}
          >
            {format === "docx" ? "Export .docx" : "Export EPUB"}
          </Button>
        </div>
      </div>
    </EditorDialog>
  );
}

/**
 * The import sheet (turn 131, R-50, R-51): the file read and shown before anything is written,
 * the chapters as rows, and the press that counts them. Cancel writes nothing.
 */
function ManuscriptImportSheet({
  open,
  onClose,
  worldId,
  prodId,
  requestId,
  state,
}: {
  open: boolean;
  onClose: () => void;
  worldId: string | undefined;
  prodId: string | undefined;
  requestId: string | null;
  state: ReturnType<typeof useManuscripts>[string] | undefined;
}) {
  const found = state?.chapters ?? [];
  const after = state?.after ?? 0;
  const shown = found.slice(0, 6);
  const subtitle =
    state?.state === "read" || state?.state === "importing"
      ? `${state.fileName} · ${(state.words ?? 0).toLocaleString()} words · read, nothing written yet`
      : state?.state === "refused"
        ? (state.fileName ?? "")
        : "reading…";
  return (
    <EditorDialog open={open} title="Import manuscript" subtitle={subtitle} onClose={onClose} width={430} labelledBy="manuscript-import-title">
      <div className="fy-exsheet" data-testid="manuscript-import">
        {state?.state === "refused" && <div className="fy-ms__line fy-ms__line--warn">could not read · {state.reason}</div>}
        {state?.state === "failed" && <div className="fy-ms__line fy-ms__line--warn">could not import · {state.reason}</div>}
        {(state?.state === "read" || state?.state === "importing") && (
          <>
            <div className="fy-ms__line">
              {found.length} chapter{found.length === 1 ? "" : "s"}
              {state.headingLevel !== undefined ? ` · ${state.headingLevel} as chapter titles` : " · no headings · the file name is the title"}
              {(state.leftOut ?? 0) > 0 ? ` · ${state.leftOut} heading${state.leftOut === 1 ? "" : "s"} above left out` : ""}
              {(state.notes ?? 0) > 0 ? ` · ${state.notes} footnote${state.notes === 1 ? "" : "s"} not carried` : ""}
              {(state.links ?? 0) > 0 ? ` · ${state.links} link${state.links === 1 ? "" : "s"} kept as words` : ""} · after chapter {after} · nothing existing changes
            </div>
            {(state.levels?.length ?? 0) > 1 && (
              <nav className="fy-seg" aria-label="Chapter level" data-testid="manuscript-levels">
                {state.levels!.map((entry) => (
                  <button
                    key={entry.level}
                    type="button"
                    className={cx("fy-seg__item", entry.chosen && "fy-seg__item--active")}
                    disabled={state.state === "importing"}
                    onClick={() => worldId && prodId && requestId !== null && !entry.chosen && rereadManuscript(worldId, prodId, requestId, entry.level)}
                  >
                    {entry.level === "document" ? entry.label : `${entry.label} · ${entry.count}`}
                  </button>
                ))}
              </nav>
            )}
            <div className="fy-ms__delivered">
              {shown.map((chapter, index) => (
                <div key={index} className="fy-ms__row" data-testid="manuscript-row">
                  <span className="fy-ms__row-meta">{String(after + index + 1).padStart(2, "0")}</span>
                  <span className="fy-ms__row-name">{chapter.title}</span>
                  <span className="fy-ms__row-meta">{chapter.words.toLocaleString()} words</span>
                </div>
              ))}
              {found.length > shown.length && <div className="fy-ms__line">and {found.length - shown.length} more</div>}
            </div>
          </>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {(state?.state === "read" || state?.state === "importing") && (
            <Button
              variant="primary"
              disabled={state.state === "importing" || !worldId || !prodId || requestId === null}
              onClick={() => worldId && prodId && requestId !== null && importManuscript(worldId, prodId, requestId)}
            >
              Import {found.length} chapter{found.length === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      </div>
    </EditorDialog>
  );
}

// ---- Scenes ----------------------------------------------------------------

export function ScenesScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const newScene = useSharedNewScene(worldId, prodId);
  const totalSec =
    production?.scenes.reduce((s, sc) => s + orderedShots(sc).reduce((x, sh) => x + resolvedAuthoredDuration(sh), 0), 0) ??
    0;
  return (
    <div className="fy-prodmain" data-screen="scenes">
      <div className="fy-h1row">
        <h1 className="fy-h1">Scenes</h1>
        <span className="fy-h1row__meta">
          {production?.scenes.length ?? 0} scenes · {seconds(totalSec)}
        </span>
        <span className="fy-h1row__push" />
        <Button
          variant="primary"
          disabled={newScene.pending}
          onClick={() => newScene.create(defaultEpisodeFor(production))}
        >
          New scene
        </Button>
      </div>
      {production && production.scenes.length > 0 ? (
        <div className="fy-ledger">
          {production.scenes.map((scene) => {
            const sceneShots = orderedShots(scene);
            const covered = sceneShots.filter((s) => acceptedTakeId(production, s.id)).length;
            return (
              <button
                key={scene.id}
                type="button"
                className="fy-row"
                onClick={() => navigate(`/w/${worldId}/p/${prodId}/scenes/${scene.id}`)}
              >
                <div className="fy-row__thumb">
                  <Portrait
                    worldSlug={world?.meta.slug}
                    path={scene.board ? `productions/${production.meta.id}/${scene.board.image}` : ""}
                    label={String(scene.number)}
                    radius={6}
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="fy-row__name">
                    {scene.number} · {scene.title}
                    <span
                      className={`fy-dot fy-dot--${covered === sceneShots.length && sceneShots.length > 0 ? "ok" : "warn"}`}
                    />
                  </div>
                  <div className="fy-row__sub">
                    {sceneShots.length} shots ·{" "}
                    {seconds(sceneShots.reduce((s, x) => s + resolvedAuthoredDuration(x), 0))}
                    {scene.inherits?.location ? ` · @${scene.inherits.location}` : ""}
                    {scene.inherits?.timeOfDay ? ` · ${scene.inherits.timeOfDay}` : ""}
                  </div>
                </div>
                <span className="fy-row__meta">
                  v{scene.version}
                  {scene.board ? ` · board v${scene.board.version}` : " · no board"}
                </span>
                <span className="fy-row__chev">
                  <ChevronRight size={15} />
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="No scenes yet"
          hint="Draft a scene and its shots inherit location, time and tone."
        />
      )}
    </div>
  );
}

// ---- Scene detail (14a) ----------------------------------------------------

export function SceneDetailScreen() {
  const { worldId, prodId, sceneId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const record = production?.scenes.find((s) => s.id === sceneId);
  if (world && production && record) {
    return <SceneWorkspace key={`${world.meta.worldId}/${production.meta.id}/${record.id}`} world={world} production={production} scene={record} />;
  }
  return (
    <Screen id="scene-detail">
      <EmptyState title="Opening scene…" />
    </Screen>
  );
}
