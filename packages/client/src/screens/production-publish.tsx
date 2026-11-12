import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { comicBook, productionShape, type MediaMeasurementSource, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { ArkePlayerExportSheet } from "../components/arke-player-sheet.js";
import { AudiobookExportSheet } from "../components/audiobook-export.js";
import { EmptyState, Screen } from "../components/layout.js";
import { madeCount, ProductionMade, useProductionMade } from "../components/production-made.js";
import { StoryExportSheet } from "../components/story-export.js";
import { StoryPublishSheet } from "../components/story-publish.js";
import { TriangleAlert } from "../components/icons.js";
import { Button } from "../components/ui.js";
import { publishReadiness, type PublishGo, type PublishOutputKey, type PublishReadiness, type PublishReads } from "../lib/publish-readiness.js";
import { useProduction } from "../lib/selectors.js";
import { openAudiobookListening, readStoryExport, requestMediaMeasurement, subscribeAudiobookListening, subscribeStoryExportState, useConnection } from "../lib/store.js";
import { measurementSubject } from "./editor-media-measurement.js";
import { ComicExport } from "./comic-pages.js";
import { ManuscriptExportSheet } from "./production-story.js";

/** The sheets this page opens over itself; the rest live on the screen whose work they export. */
type Sheet = "edition" | "audiobook" | "player" | "manuscript" | "comic-files" | "story-player" | "story-web";

/** One thing a production can be published as: a card on the page (design turn 276, rule 4). */
export interface PublishOutput {
  /** Which output this is, so its readiness is read the way its sheet reads it (rule 6). */
  key: PublishOutputKey;
  name: string;
  /** What the sheet makes, as data: `EPUB · PDF · M4B`. */
  formats: string;
  /** The plate in `public/publish`, one per output for every production (rule 5). */
  plate: "edition" | "audiobook" | "player" | "manuscript" | "comic" | "web" | "film" | "drama" | "playable";
  press: string;
  /** A sheet over this page, or the address of the screen that opens it on arrival. */
  opens: { sheet: Sheet } | { to: string };
}

/**
 * The outputs a kind makes, in the order the page shows them (turn 276 rule 4). Each opens the sheet
 * that makes it today. The album's, the audio drama's and the film's sheets read what their own
 * screens hold, so their cards open those screens with the sheet up, as the Cut's old Exports
 * address already did.
 */
export function publishOutputs(production: ProductionBundle, base: string, desktop: boolean): PublishOutput[] {
  const shape = productionShape(production.meta);
  const player = (key: PublishOutputKey, opens: PublishOutput["opens"], formats = "package"): PublishOutput => ({ key, name: "Arke Player", formats, plate: "player", press: "Make package", opens });
  const edition: PublishOutput = { key: "edition", name: "Edition", formats: "EPUB · PDF · M4B", plate: "edition", press: "Create edition", opens: { sheet: "edition" } };
  if (shape.isMusic) return [player("music-player", { to: `${base}?export=1` })];
  if (shape.isAudioDrama) return [{ key: "drama", name: "Edition", formats: "MP3 · WAV · transcript · script", plate: "drama", press: "Create edition", opens: { to: `${base}?publish=1` } }];
  if (shape.hasPages) {
    // A graphic novel whose chapters hold prose can still make the book's edition of them.
    const prose = production.chapters.some((chapter) => !chapter.retired && (chapter.words ?? 0) > 0);
    return [
      { key: "comic", name: "Comic files", formats: "CBZ · PDF · EPUB", plate: "comic", press: "Export", opens: { sheet: "comic-files" } },
      player("comic-player", { sheet: "player" }),
      ...(prose ? [edition] : []),
    ];
  }
  if (shape.hasChapters) return [
    edition,
    { key: "audiobook", name: "Audiobook", formats: "player · MP3 · video", plate: "audiobook", press: "Export", opens: { sheet: "audiobook" } },
    player("book-player", { sheet: "player" }, "package · part"),
    { key: "manuscript", name: "Manuscript", formats: "Word · EPUB", plate: "manuscript", press: "Export", opens: { sheet: "manuscript" } },
  ];
  const film: PublishOutput = { key: "film", name: "Film", formats: "H.264 · MP4", plate: "film", press: "Export", opens: { to: `${base}/cut?export=1` } };
  if (shape.isBranching) return [
    player("story-player", { sheet: "story-player" }, "story · offline"),
    { key: "web", name: "Web package", formats: "player.html", plate: "web", press: "Export", opens: { sheet: "story-web" } },
    ...(shape.playsAsBeats ? [] : [film]),
  ];
  // A playable edition is made in the desktop app only (publication-export.tsx); elsewhere it is not offered.
  return [film, ...(desktop ? [{ key: "playable" as const, name: "Playable edition", formats: "MP4 · subtitles", plate: "playable" as const, press: "Create edition", opens: { to: `${base}/cut?export=1` } }] : [])];
}

/**
 * Publish (design turn 276, SPEC-058 R-103's sheet among them): one page per production, the rail's
 * last item for every kind, its outputs as cards that open the sheets that make them. A production
 * was exported from seven screens under five labels; this is the one place to begin.
 */
export function ProductionPublishScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  if (!world || !production) return <Screen id="production-publish"><EmptyState title="Opening production…" /></Screen>;
  return <ProductionPublish world={world} production={production} />;
}

function ProductionPublish({ world, production }: { world: WorldBundle; production: ProductionBundle }) {
  const navigate = useNavigate();
  const worldId = world.meta.worldId;
  const base = `/w/${worldId}/p/${production.meta.id}`;
  const outputs = publishOutputs(production, base, typeof window !== "undefined" && window.arke?.publications !== undefined);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const close = () => setSheet(null);
  const reads = usePublishReads(worldId, production, outputs);
  const made = useProductionMade(worldId, production, sheet !== null);
  const open = (output: PublishOutput) => ("sheet" in output.opens ? setSheet(output.opens.sheet) : navigate(output.opens.to));
  // Go to from the comic's sheet: the page itself on Pages, in its chapter, where it is cleared.
  const book = sheet === "comic-files" || sheet === "player" ? comicBook(production) : [];
  const pageOf = (id: string) => {
    const chapter = book.find((entry) => entry.id === id)?.chapter;
    navigate(`${base}/story/pages?${chapter === undefined ? "" : `chapter=${encodeURIComponent(chapter)}&`}page=${encodeURIComponent(id)}`);
  };
  const goTo = (go: PublishGo) => navigate(
    "page" in go ? `${base}/story/pages?chapter=${encodeURIComponent(go.chapter)}&page=${encodeURIComponent(go.page)}`
      : "scene" in go ? `${base}/scenes/${encodeURIComponent(go.scene)}`
        : go.path === "" ? base : `${base}/${go.path}`,
  );
  // The Cut's Measure media for every unmeasured source at once; the card reads again as each lands.
  const [measuring, setMeasuring] = useState(false);
  const measure = async (sources: readonly MediaMeasurementSource[]) => {
    setMeasuring(true);
    try {
      for (const source of sources) {
        const expectedHash = measurementSubject(production, world.artifacts, source)?.expectedHash;
        await requestMediaMeasurement({ worldId, productionId: production.meta.id, source, ...(expectedHash ? { expectedHash } : {}) }, new AbortController().signal).catch(() => null);
      }
    } finally {
      setMeasuring(false);
    }
  };
  return (
    <div className="fy-prodmain" data-screen="production-publish">
      <div className="fy-h1row">
        <h1 className="fy-h1">Publish</h1>
        <span className="fy-h1row__meta">{outputs.length} output{outputs.length === 1 ? "" : "s"}{made === null ? "" : madeCount(made) === 0 ? " · nothing made" : ` · ${madeCount(made)} made`}</span>
      </div>
      <div className="fy-publish-outs">
        {outputs.map((output) => (
          <section key={output.name} className="fy-publish-out" data-testid={`publish-${output.plate}`}>
            <img className="fy-publish-out__plate" src={`./publish/${output.plate}.webp`} alt="" />
            <div className="fy-publish-out__copy">
              <h2 className="fy-publish-out__name">{output.name}</h2>
              <p className="fy-publish-out__formats">{output.formats}</p>
              <ReadinessLine readiness={publishReadiness(output.key, world, production, reads)} goTo={goTo} measuring={measuring} onMeasure={measure} />
            </div>
            <Button size="sm" variant={output.plate === "player" ? "primary" : "secondary"} onClick={() => open(output)}>{output.press}</Button>
          </section>
        ))}
      </div>
      <ProductionMade worldId={worldId} worldSlug={world.meta.slug} rows={made} />
      {sheet === "edition" && <StoryPublishSheet worldId={worldId} production={production} onClose={close} />}
      {sheet === "audiobook" && (
        <AudiobookExportSheet worldId={worldId} production={production} onClose={close}
          onReviewChapters={() => { close(); navigate(`${base}/story/chapters`); }} />
      )}
      <ManuscriptExportSheet open={sheet === "manuscript"} onClose={close} worldId={worldId} prodId={production.meta.id} production={production} chapters={production.chapters.filter((chapter) => !chapter.retired)} />
      {sheet === "comic-files" && <ComicExport world={world} production={production} onClose={close} goTo={pageOf} />}
      {sheet === "player" && <ArkePlayerExportSheet world={world} production={production} onClose={close} goToPage={pageOf} />}
      {(sheet === "story-player" || sheet === "story-web") && (
        <StoryExportSheet worldId={worldId} production={production} initialKind={sheet === "story-web" ? "web" : "arke"} onClose={close}
          onGoTo={(sceneId) => navigate(`${base}/scenes/${sceneId}`)} />
      )}
    </div>
  );
}

/**
 * What the cards' readiness needs from the coordinator, asked as the sheets ask it: a book's
 * listening plan, a story's export state. Asked again when the connection comes back, which a
 * dropped connection may have lost the answer to.
 */
function usePublishReads(worldId: string, production: ProductionBundle, outputs: readonly PublishOutput[]): PublishReads {
  const connection = useConnection();
  const productionId = production.meta.id;
  const wantsListening = outputs.some((output) => output.key === "audiobook" || output.key === "book-player");
  const wantsStory = outputs.some((output) => output.key === "story-player" || output.key === "web");
  const [reads, setReads] = useState<PublishReads>({});
  const asked = useRef<{ listening: string | null; story: string | null }>({ listening: null, story: null });
  useEffect(() => {
    const offListening = subscribeAudiobookListening((answer) => {
      if (answer.requestId === asked.current.listening) setReads((now) => ({ ...now, listening: answer.listening }));
    });
    const offStory = subscribeStoryExportState((answer) => {
      if (answer.requestId === asked.current.story) setReads((now) => ({ ...now, story: answer.state }));
    });
    return () => { offListening(); offStory(); };
  }, []);
  // Read again whenever what the answers read moves: a chapter, a scene, a take, a take accepted or the routing.
  const stamp = JSON.stringify([production.chapters.map((chapter) => [chapter.id, chapter.version]), production.scenes.map((scene) => [scene.id, scene.version]), production.takes.length, production.selections, production.routing?.version ?? null]);
  useEffect(() => {
    if (connection !== "open") return;
    if (wantsListening) asked.current.listening = openAudiobookListening(worldId, productionId);
    if (wantsStory) asked.current.story = readStoryExport(worldId, productionId);
  }, [connection, worldId, productionId, wantsListening, wantsStory, stamp]);
  return reads;
}

/** A card's readiness (turn 276 rule 6, 276b): Ready and its fact, or Blocked · n, the first blocker and Go to. */
function ReadinessLine({ readiness, goTo, measuring, onMeasure }: { readiness: PublishReadiness | null; goTo: (go: PublishGo) => void; measuring: boolean; onMeasure: (sources: readonly MediaMeasurementSource[]) => void }) {
  if (readiness === null) return <p className="fy-publish-out__state" aria-busy="true">…</p>;
  if (readiness.ready) return <p className="fy-publish-out__state"><i className="fy-publish-out__dot fy-publish-out__dot--ok" aria-hidden="true" /><b>Ready</b><span>{readiness.fact}</span></p>;
  return (
    <>
      <p className="fy-publish-out__state"><i className="fy-publish-out__dot fy-publish-out__dot--held" aria-hidden="true" /><b>Blocked · {readiness.count}</b></p>
      <div className="fy-publish-out__block">
        <TriangleAlert size={14} />
        <span>{readiness.first}</span>
        {readiness.measure !== undefined
          ? <Button size="sm" disabled={measuring} onClick={() => onMeasure(readiness.measure!)}>{measuring ? "Measuring…" : "Measure"}</Button>
          : readiness.go !== undefined && <Button size="sm" onClick={() => goTo(readiness.go!)}>Go to</Button>}
      </div>
    </>
  );
}
