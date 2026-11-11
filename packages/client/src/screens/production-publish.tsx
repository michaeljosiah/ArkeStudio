import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { comicBook, productionShape, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { AudiobookExportSheet } from "../components/audiobook-export.js";
import { EmptyState, Screen } from "../components/layout.js";
import { StoryExportSheet } from "../components/story-export.js";
import { StoryPublishSheet } from "../components/story-publish.js";
import { Button } from "../components/ui.js";
import { useProduction } from "../lib/selectors.js";
import { ComicExport } from "./comic-pages.js";
import { ManuscriptExportSheet } from "./production-story.js";

/** The sheets this page opens over itself; the rest live on the screen whose work they export. */
type Sheet = "edition" | "audiobook" | "player-book" | "manuscript" | "comic-files" | "comic-player" | "story-player" | "story-web";

/** One thing a production can be published as: a card on the page (design turn 276, rule 4). */
export interface PublishOutput {
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
  const player = (opens: PublishOutput["opens"], formats = "package"): PublishOutput => ({ name: "Arke Player", formats, plate: "player", press: "Make package", opens });
  const edition: PublishOutput = { name: "Edition", formats: "EPUB · PDF · M4B", plate: "edition", press: "Create edition", opens: { sheet: "edition" } };
  if (shape.isMusic) return [player({ to: `${base}?export=1` })];
  if (shape.isAudioDrama) return [{ name: "Edition", formats: "MP3 · WAV · transcript · script", plate: "drama", press: "Create edition", opens: { to: `${base}?publish=1` } }];
  if (shape.hasPages) {
    // A graphic novel whose chapters hold prose can still make the book's edition of them.
    const prose = production.chapters.some((chapter) => !chapter.retired && (chapter.words ?? 0) > 0);
    return [
      { name: "Comic files", formats: "CBZ · PDF · EPUB", plate: "comic", press: "Export", opens: { sheet: "comic-files" } },
      player({ sheet: "comic-player" }),
      ...(prose ? [edition] : []),
    ];
  }
  if (shape.hasChapters) return [
    edition,
    { name: "Audiobook", formats: "player · MP3 · video", plate: "audiobook", press: "Export", opens: { sheet: "audiobook" } },
    player({ sheet: "player-book" }, "package · part"),
    { name: "Manuscript", formats: "Word · EPUB", plate: "manuscript", press: "Export", opens: { sheet: "manuscript" } },
  ];
  const film: PublishOutput = { name: "Film", formats: "H.264 · MP4", plate: "film", press: "Export", opens: { to: `${base}/cut?export=1` } };
  if (shape.isBranching) return [
    player({ sheet: "story-player" }, "story · offline"),
    { name: "Web package", formats: "player.html", plate: "web", press: "Export", opens: { sheet: "story-web" } },
    ...(shape.playsAsBeats ? [] : [film]),
  ];
  // A playable edition is made in the desktop app only (publication-export.tsx); elsewhere it is not offered.
  return [film, ...(desktop ? [{ name: "Playable edition", formats: "MP4 · subtitles", plate: "playable" as const, press: "Create edition", opens: { to: `${base}/cut?export=1` } }] : [])];
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
  const open = (output: PublishOutput) => ("sheet" in output.opens ? setSheet(output.opens.sheet) : navigate(output.opens.to));
  // Go to from the comic's sheet: the page's chapter on Pages, where it is cleared.
  const book = sheet === "comic-files" || sheet === "comic-player" ? comicBook(production) : [];
  const pageOf = (id: string) => {
    const chapter = book.find((entry) => entry.id === id)?.chapter;
    navigate(`${base}/story/pages${chapter === undefined ? "" : `?chapter=${encodeURIComponent(chapter)}`}`);
  };
  return (
    <div className="fy-prodmain" data-screen="production-publish">
      <div className="fy-h1row">
        <h1 className="fy-h1">Publish</h1>
        <span className="fy-h1row__meta">{outputs.length} output{outputs.length === 1 ? "" : "s"}</span>
      </div>
      <div className="fy-publish-outs">
        {outputs.map((output) => (
          <section key={output.name} className="fy-publish-out" data-testid={`publish-${output.plate}`}>
            <img className="fy-publish-out__plate" src={`./publish/${output.plate}.webp`} alt="" />
            <div className="fy-publish-out__copy">
              <h2 className="fy-publish-out__name">{output.name}</h2>
              <p className="fy-publish-out__formats">{output.formats}</p>
            </div>
            <Button size="sm" variant={output.plate === "player" ? "primary" : "secondary"} onClick={() => open(output)}>{output.press}</Button>
          </section>
        ))}
      </div>
      {sheet === "edition" && <StoryPublishSheet worldId={worldId} production={production} onClose={close} />}
      {(sheet === "audiobook" || sheet === "player-book") && (
        <AudiobookExportSheet worldId={worldId} production={production} initialKind={sheet === "player-book" ? "arke" : "player"} onClose={close}
          onReviewChapters={() => { close(); navigate(`${base}/story/chapters`); }} />
      )}
      <ManuscriptExportSheet open={sheet === "manuscript"} onClose={close} worldId={worldId} prodId={production.meta.id} production={production} chapters={production.chapters.filter((chapter) => !chapter.retired)} />
      {(sheet === "comic-files" || sheet === "comic-player") && (
        <ComicExport world={world} production={production} initial={sheet === "comic-player" ? { formats: [], player: true } : { formats: ["cbz", "pdf"], player: false }} onClose={close} goTo={pageOf} />
      )}
      {(sheet === "story-player" || sheet === "story-web") && (
        <StoryExportSheet worldId={worldId} production={production} initialKind={sheet === "story-web" ? "web" : "arke"} onClose={close}
          onGoTo={(sceneId) => navigate(`${base}/scenes/${sceneId}`)} />
      )}
    </div>
  );
}
