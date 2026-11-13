// A world's productions: the list and a new production (issue 2816).
import {
  type ProductionBundle, type WorldBundle, productionShape, orderedShots, beatPictureShotId,
  sortScenes, AUDIO_DRAMA_KIND, GRAPHIC_NOVEL_KIND, type FrameRate, adaptableStories, newId,
} from "@arke-studio/contracts";
import { shotHasFrame } from "./scene-workspace/boards.js";
import { usePhone } from "../lib/media-query.js";
import { useParams, useNavigate, useLocation } from "react-router";
import { useOpenWorldGuard } from "../lib/selectors.js";
import { episodeThumbnailPath } from "./production-episode-picker.js";
import { takeMediaPath } from "../lib/take-presentation.js";
import { Button, cx, Badge, Input, Select, Callout } from "../components/ui.js";
import { Plus } from "../components/icons.js";
import { Portrait } from "../components/portrait.js";
import { productionPlate } from "../lib/production-plate.js";
import { HeldBar } from "../components/held-bar.js";
import { useState, useEffect, type ReactNode } from "react";
import { type ComicStyleDraft, draftFromStyle, styleFromDraft } from "../lib/comic-styles.js";
import { subscribeProductionCreateResults, setComicSettings, createProduction } from "../lib/store.js";
import { ComicStylePicker } from "../components/comic-style-picker.js";
import { mediaUrl } from "../lib/media.js";

// ---- Productions -----------------------------------------------------------

/** Use the same picture source as the workspace, including a beat that keeps the prior picture. */
export function coveredProductionShots(production: ProductionBundle, artifacts: WorldBundle["artifacts"]): number {
  const pictures = productionShape(production.meta).playsAsBeats;
  return production.scenes.reduce((count, scene) => {
    const shots = orderedShots(scene);
    return count + shots.filter(shot => pictures
      ? shotHasFrame(production, artifacts, beatPictureShotId(shots, shot.id))
      : Boolean(production.selections[shot.id]?.acceptedTakeId)).length;
  }, 0);
}

export function ProductionsScreen() {
  const phone = usePhone();
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const productions = world?.productions ?? [];
  const artOf = (p: (typeof productions)[number]): string => {
    const accepted = episodeThumbnailPath(p, { scenes: sortScenes(p.scenes).map((scene) => scene.id) });
    if (accepted) return accepted;
    const board = p.scenes.find((s) => s.board)?.board;
    if (board) return `productions/${p.meta.id}/${board.image}`;
    const take = p.takes.find((t) => t.media);
    if (take) return takeMediaPath(p, take) ?? world?.keyArt ?? "";
    return world?.keyArt ?? "";
  };
  return (
    <div data-screen="productions">
      {!phone && <div className="fy-corner"><Button variant="primary" onClick={() => navigate(`/w/${worldId}/productions/new`)}>New production</Button></div>}
      <div className="fy-hero fy-productions-head">
        <div><div className="fy-hero__eyebrow">{world?.meta.name} · shared cast, shared canon</div>
        <h1 className="fy-hero__title">Productions</h1></div>
        {phone && <Button variant="primary" onClick={() => navigate(`/w/${worldId}/productions/new`)}><Plus size={16} />New</Button>}
      </div>
      {world?.conversations.some(conversation => conversation.entryContext?.kind === "production-setup") && (
        <section aria-label="Production setups" className="fy-production-resumes">
          <h2>In development</h2>
          {world.conversations.filter(conversation => conversation.entryContext?.kind === "production-setup").map(conversation => (
            <Button key={conversation.id} variant="outline" onClick={() => navigate(`/w/${worldId}/productions/setup/${conversation.id}`)}>
              Resume {conversation.title}{conversation.setupStatus === "creating" ? " · resolving creation" : ""}
            </Button>
          ))}
        </section>
      )}
      <div className="fy-prodcards">
        {productions.map((p, i) => {
          const chapters = p.chapters.filter(chapter => !chapter.retired);
          const drafted = chapters.filter(chapter => (chapter.words ?? 0) > 0).length;
          const shape = productionShape(p.meta);
          const story = shape.hasChapters;
          const tracks = p.music?.tracks.length ?? 0;
          const shots = p.scenes.flatMap((s) => orderedShots(s));
          const covered = coveredProductionShots(p, world?.artifacts ?? []);
          const active = p.meta.status !== "complete" && shots.length > 0 && covered < shots.length;
          const progress = (<div className="fy-progress">
                    <div
                      className="fy-progress__fill"
                      style={{
                        width: `${story ? (chapters.length ? Math.round(drafted / chapters.length * 100) : 0) : shots.length > 0 ? Math.round((covered / shots.length) * 100) : 0}%`,
                      }}
                    />
                  </div>);
          return (
            <div
              key={p.meta.id}
              className={`fy-prodcard-slot fy-prodcard-slot--${i % 3}`}
            >
              <div
                className={cx("fy-prodcard", active && "fy-prodcard--active")}
                role={phone ? "link" : undefined}
                tabIndex={phone ? 0 : undefined}
                aria-label={phone ? `Open ${p.meta.title}` : undefined}
                onKeyDown={event => { if (event.target === event.currentTarget && event.key === "Enter") navigate(`/w/${worldId}/p/${p.meta.id}`); }}
                onClick={() => navigate(`/w/${worldId}/p/${p.meta.id}`)}
              >
                <div className="fy-prodcard__frame">
                  <Portrait
                    worldSlug={world?.meta.slug}
                    path={artOf(p)}
                    label={`${p.meta.title}: frame`}
                    fallbackSrc={productionPlate(p.meta)}
                    radius={0}
                  />
                </div>
                <div className="fy-prodcard__body">
                  <div className="fy-prodcard__meta">
                    <Badge tone="outline">{productionShape(p.meta).displayLabel}</Badge>
                    {active && <span className="fy-dot fy-dot--warn" />}
                    <span style={{ marginLeft: "auto" }} className="fy-mono">
                      {shape.hasPages ? `${chapters.length} chapter${chapters.length === 1 ? "" : "s"}` : story ? (chapters.length > 0 ? `${drafted} of ${chapters.length} chapters` : "") : p.audioDrama ? `${p.audioDrama.plan.episodes} episodes` : shape.isMusic ? `${tracks} track${tracks === 1 ? "" : "s"}` : shots.length > 0 ? `${covered} of ${shots.length} ${shape.playsAsBeats ? "pictures" : "shots"}` : p.takes.length > 0 ? `${p.takes.length} takes` : ""}
                    </span>
                  </div>
                  <div className="fy-prodcard__name">{p.meta.title}</div>
                  {p.meta.logline && <div className="fy-prodcard__sub">{p.meta.logline}</div>}
                  {!phone && progress}
                  {!phone && <div style={{ marginTop: 14 }}>
                    <Button variant={active ? "primary" : "secondary"} onClick={event => { event.stopPropagation(); navigate(`/w/${worldId}/p/${p.meta.id}`); }}>Open the workspace</Button>
                  </div>}
                </div>
                {phone && progress}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          className="fy-newprodcard"
          onClick={() => navigate(`/w/${worldId}/productions/new`)}
        >
          <span className="fy-newprodcard__ring">
            <Plus size={18} />
          </span>
          <span style={{ font: "600 14px var(--font-sans)" }}>New production</span>
        </button>
      </div>
    </div>
  );
}

/**
 * The door (turn 113). Three pictures, and what each one is offering is what the audience does
 * with the thing — read it, watch it, decide it — rather than which record the app writes.
 *
 * `CHOOSE` is here by turn 113a, which amends turn 100's last sentence and leaves its first
 * standing: interactive video is still a kind of video and not a medium, so this card writes the
 * same production the step-two radio used to write — `medium: video`, `productionKind:
 * interactive`. Nothing about scenes, shots, takes or the cut differs, and no medium was added
 * to the contracts. What changed is only where it is offered, because step one is a set of
 * intentions now and branching is one a person arrives holding.
 *
 * The audiobook rides under `WRITE`, and so does the audio drama, a kind of story rather than a
 * door of its own (design turn 230 revision 2, SPEC-057 R-1): the work is writing first. Music is
 * the fourth card, `LISTEN` (design turn 238a, SPEC-060 R-2), because its work is the songs.
 */
export const DOOR_CHOICES = [
  {
    id: "write",
    eyebrow: "WRITE",
    label: "Tell a story",
    body: "Novel, novella, episodic fiction, graphic novel, audio drama or audiobook",
    affordance: "Begin with words",
    medium: "story",
  },
  {
    id: "watch",
    eyebrow: "WATCH",
    label: "Make a film",
    body: "Short film or micro-drama",
    affordance: "Begin with a screen",
    medium: "video",
  },
  {
    id: "choose",
    eyebrow: "CHOOSE",
    label: "Make it interactive",
    body: "Branching movie, playable story or mixed experience",
    affordance: "Begin with a choice",
    medium: "video",
    productionKind: "interactive",
  },
  {
    id: "listen",
    eyebrow: "LISTEN",
    label: "Make music",
    body: "Album, single or soundtrack",
    affordance: "Begin with a song",
    medium: "music",
  },
] as const;

type DoorId = (typeof DOOR_CHOICES)[number]["id"];
// The doors that reach step two. Watch has gone straight to the conversational setup since
// 8 September 2026 (c890258b2), so it has no kind row, length or series to ask here.
type StepDoorId = Exclude<DoorId, "watch">;

/**
 * What `CHOOSE` asks (turn 174): which of the two interactive kinds. Each is named for what the
 * viewer does — watch, or read — because the first names drawn for them ("Moving pictures",
 * "Illustrated") said neither, and "Illustrated" already names an art direction an interactive
 * movie can wear. Both write the video medium and route by choice; a visual novel reads its
 * scenes as beats of picture, text and voice instead of playing them as clips.
 */
export const INTERACTIVE_KIND_CHOICES = [
  {
    id: "interactive",
    label: "Interactive movie",
    body: "Scenes play as video. Choose at the end of each.",
    aspect: "16:9",
  },
  {
    id: "visual-novel",
    label: "Visual novel",
    body: "Pictures, text and voices. Read at your own pace, then choose.",
    aspect: "16:9",
  },
] as const;

/**
 * What `WRITE` asks (design turn 230b, SPEC-057 R-1): which kind of story. A novel is the story
 * medium's plain default, and Other is nothing assumed, so neither writes a kind down; an audio
 * drama is a story told in episodes for the ear, and does. None of them has a frame to deliver in.
 */
export const STORY_KIND_CHOICES = [
  { id: "book", label: "Novel", body: "Chapters, to read." },
  { id: AUDIO_DRAMA_KIND, label: "Audio drama", body: "Episodes, for the ear." },
  // A graphic novel (SPEC-064 R-3): chapters of pages, each page a picture made from its script.
  { id: GRAPHIC_NOVEL_KIND, label: "Graphic novel", body: "Pages, to look at." },
  { id: "other", label: "Other", body: "Nothing assumed." },
] as const;

/**
 * What `LISTEN` asks (design turn 238b, SPEC-060 R-3): which kind of music. Each is written down,
 * so a production says what it is; a soundtrack then asks which production it is for.
 */
export const MUSIC_KIND_CHOICES = [
  { id: "album", label: "Album", body: "Tracks, in order." },
  { id: "single", label: "Single", body: "One song." },
  { id: "soundtrack", label: "Soundtrack", body: "For a production." },
] as const;

type KindChoice = { id: string; label: string; body: string; aspect?: string };

/**
 * The kinds that write themselves down. The rest are the medium's plain default (SPEC-023 R-2).
 * `interactive` is still one of them and still reads back the same way — it just arrives from
 * the door now rather than from the kind row (turn 113a).
 */
const STORED_KINDS = new Set(["interactive", "visual-novel", AUDIO_DRAMA_KIND, GRAPHIC_NOVEL_KIND, "album", "single", "soundtrack"]);

/*
 * The kinds with a plate in `public/video-kinds`. Other is deliberately absent: an image of
 * "nothing assumed" would be a picture of something, and the empty box saying so is the truer
 * one. A kind added without a plate falls back to that same empty box rather than breaking.
 */
export const KIND_PLATES = new Set(["interactive", "visual-novel", "book", AUDIO_DRAMA_KIND, GRAPHIC_NOVEL_KIND, "album", "single", "soundtrack", "other"]);

/**
 * What each card has left to ask. Step two always renders now (turn 113): it is the screen that
 * holds the name, so a card with nothing else to ask shows the name alone rather than sending
 * the person through a dialog the other cards do not get. `choose` has had kinds of its own since
 * turn 174 — an interactive movie or a visual novel — and `write` since turn 230: a novel, an
 * audio drama or neither.
 */
export const KINDS_BY_DOOR: Record<StepDoorId, readonly KindChoice[]> = {
  write: STORY_KIND_CHOICES,
  choose: INTERACTIVE_KIND_CHOICES,
  listen: MUSIC_KIND_CHOICES,
};

/** The kind each door's row starts on, and so what an untouched step two creates. */
const DEFAULT_KIND_BY_DOOR: Record<StepDoorId, string> = {
  write: "book",
  choose: "interactive",
  listen: "album",
};

/** The question step two asks above a door's kind row. */
const KIND_QUESTION: Record<StepDoorId, string> = {
  write: "What kind of story?",
  choose: "What kind of interactive?",
  listen: "What kind of music?",
};

export const FRAME_RATE_CHOICES = [24, 25, 30] as const satisfies readonly FrameRate[];

export function NewProductionScreen() {
  const phone = usePhone();
  const Footer = phone ? HeldBar : "div";
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  // A story's ⋯ → Adapt… arrives holding that story (SPEC-057 R-3): step two, an audio drama,
  // with Adapt from already set. The door's question has been answered by where it came from.
  const adapting = (useLocation().state as { adapt?: { productionId?: unknown } } | null)?.adapt?.productionId;
  const adaptFrom = typeof adapting === "string" ? adapting : null;
  // Null until a card is pressed: the door is step one, and which card was pressed is the whole
  // of what step one produces. There is no default — a preselected card would answer the
  // question the screen is asking.
  const [door, setDoor] = useState<StepDoorId | null>(adaptFrom ? "write" : null);
  // The kind the row has selected, for whichever door was pressed; seeded from the door.
  const [videoKind, setVideoKind] = useState<string>(adaptFrom ? AUDIO_DRAMA_KIND : "film");
  const [title, setTitle] = useState("");
  // Whether the name is still the one this step filled in. It follows the chosen story until the
  // author types, so choosing A and then B never leaves B's drama named after A (codex on PR 1866).
  const [titleFollows, setTitleFollows] = useState(true);
  // The story an audio drama adapts (design turn 230b): empty is an original drama.
  const [source, setSource] = useState(adaptFrom ?? "");
  // The production a soundtrack is for (design turn 238b): none until it is chosen.
  const [soundtrackFor, setSoundtrackFor] = useState("");
  // A graphic novel's style (design turn 248): World look until a card is chosen.
  const [comicStyle, setComicStyle] = useState<ComicStyleDraft>(() => draftFromStyle(undefined));
  const isGraphicNovel = door === "write" && videoKind === GRAPHIC_NOVEL_KIND;
  // Seeded from the kind and re-seeded whenever the kind changes: a default the kind can answer
  // is the kind's to answer (turn 99), and a film that silently kept a micro drama's 9:16 would
  // be the exact failure the grouping is meant to prevent.
  const [aspect, setAspect] = useState<string>("16:9");
  const [frameRate, setFrameRate] = useState<FrameRate>(24);
  // Pending until the correlated result arrives (issue 384): success opens the created production
  // at its own workspace — never back to the list — and failure names itself in place, with
  // everything entered still here.
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingRequest) return;
    return subscribeProductionCreateResults((result) => {
      if (result.requestId !== pendingRequest) return;
      if (result.disposition === "created" && result.slug) {
        // The style is the book's setting, written once the book exists; World look writes nothing.
        const style = isGraphicNovel ? styleFromDraft(comicStyle) : null;
        if (worldId && style) setComicSettings(worldId, result.slug, { style });
        // Start empty opens its one chapter (turn 272), where a page can be started.
        navigate(`/w/${worldId}/p/${result.slug}${isGraphicNovel ? "/story/pages" : ""}`);
      } else {
        setPendingRequest(null);
        setFailure(result.reason ?? "The production could not be created.");
      }
    });
  }, [pendingRequest, worldId, navigate, isGraphicNovel, comicStyle]);
  const characters =world?.sheets.filter((s) => s.type === "character").length ?? 0;
  const chosen = door === null ? null : DOOR_CHOICES.find((d) => d.id === door)!;
  const kinds = door === null ? [] : KINDS_BY_DOOR[door];
  const question = door === null ? null : KIND_QUESTION[door];
  const isAudioDrama = door === "write" && videoKind === AUDIO_DRAMA_KIND;
  const isSoundtrack = door === "listen" && videoKind === "soundtrack";
  // What a soundtrack can be for: the world's productions that are not music, each with its kind and length.
  const scored = (world?.productions ?? []).filter((entry) => !productionShape(entry.meta).isMusic);
  const stories = adaptableStories(world?.productions ?? []);
  // An audio drama and a graphic novel both adapt a story through setup (SPEC-057 R-2, SPEC-064 R-3).
  const adapts = isAudioDrama || isGraphicNovel;
  const story = adapts && source ? stories.find((s) => s.id === source) ?? null : null;
  // A name the author has not typed follows the story it adapts, so a drama of Low Water starts
  // as Low Water, and an original drama starts unnamed; anything typed is never replaced.
  useEffect(() => {
    if (titleFollows) setTitle(story?.title ?? "");
    // Only a newly chosen story names it: the flag is read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  /*
   * An audio drama that adapts a story is planned with Arke (SPEC-057 R-3): setup reads the story
   * first, so its number of episodes is never a guess made here. The seed carries the answers
   * this step already has; setup checks the source exactly as if it had been chosen there.
   */
  const planWithArke = () => {
    // An original graphic novel is planned with Arke too (turn 272): setup asks what happens in it.
    if (!worldId || (!story && !isGraphicNovel)) return;
    navigate(`/w/${worldId}/productions/setup/${newId("cv")}`, {
      state: { seed: {
        kind: isGraphicNovel ? GRAPHIC_NOVEL_KIND : AUDIO_DRAMA_KIND, ...(story ? { source: { productionId: story.id } } : {}), ...(title.trim() ? { title: title.trim() } : {}),
        // The style chosen on the cards rides into setup (turns 248a, 249b); World look sends none.
        ...(isGraphicNovel && styleFromDraft(comicStyle) ? { comicStyle: styleFromDraft(comicStyle)! } : {}),
      } },
    });
  };

  const create = () => {
    if (!worldId || pendingRequest || !chosen) return;
    setFailure(null);
    setPendingRequest(
      createProduction(worldId, {
        // A book started empty has no one to name it, so it starts with a name the author can change.
        title: title.trim() || (isGraphicNovel ? "Untitled graphic novel" : ""),
        medium: chosen.medium,
        /*
         * The kind row answers where the card has one — `CHOOSE` has offered an interactive movie
         * or a visual novel since turn 174 — and a card's own kind stands in where it has no row,
         * which is how `CHOOSE` wrote `interactive` from turn 113a until then.
         */
        ...(kinds.length > 0 && STORED_KINDS.has(videoKind)
          ? { productionKind: videoKind }
          : "productionKind" in chosen
            ? { productionKind: chosen.productionKind }
            : {}),
        // The frame a video delivers in is answerable for every kind, so it travels for every
        // kind (turn 99): before this, a film could not be made vertical until after it existed.
        ...(chosen.medium === "video" ? { aspect } : {}),
        ...(chosen.medium === "video" ? { frameRate } : {}),
        ...(isSoundtrack && soundtrackFor !== "" ? { soundtrackFor } : {}),
        ...(isGraphicNovel ? { startEmpty: true as const } : {}),
      }),
    );
  };

  /*
   * Step two (turn 53a, rebuilt by turn 113): its own screen, with the step said out loud. The
   * kinds carry a plate because the choice is meant to be made by looking rather than by reading
   * — three lit vertical panels or one wide horizon say what you are starting faster than
   * "Episodes, vertical." does, and the sentence underneath then confirms rather than teaches.
   *
   * It always renders now, because it is the screen that holds the name. A card with no kinds
   * left to ask shows the name alone rather than sending that person through a dialog the other
   * cards do not get — thin, and honestly so, until branching and prose have kinds of their own.
   */
  if (chosen) {
    return (
      <div className="fy-dialogwrap fy-production-step" data-screen="new-production">
        <ProductionDialogBackdrop world={world} />
        <div
          className={cx("fy-dialog fy-production-step__panel", kinds.length > 0 && "fy-production-step__panel--kinds", kinds.length === 3 && "fy-production-step__panel--three")}
        >
          <div className="fy-production-step__head">
            {kinds.length > 0 ? (
              <div style={{ font: "650 22px var(--font-sans)", letterSpacing: "-0.02em" }}>
                {question}
              </div>
            ) : (
              // The eyebrow names the card that was pressed. Without a kind row there is nothing
              // else on this screen to say which door you came through.
              <div className="fy-mono">{chosen.label.toUpperCase()}</div>
            )}
            <span style={{ flex: 1 }} />
            <span className="fy-mono">step 2 of 2</span>
          </div>
          {kinds.length === 0 && (
            <div style={{ font: "650 22px var(--font-sans)", letterSpacing: "-0.02em" }}>
              Name it
            </div>
          )}
          {kinds.length > 0 && (
          <div className={cx("fy-production-kinds", kinds.length === 3 && "fy-production-kinds--three")}>
            {kinds.map((k) => (
              <button
                key={k.id}
                type="button"
                className={cx("fy-radio", videoKind === k.id && "fy-radio--on")}
                onClick={() => {
                  setVideoKind(k.id);
                  if (k.aspect) setAspect(k.aspect);
                }}
              >
                <div aria-hidden="true" className="fy-production-kind__plate">
                  {KIND_PLATES.has(k.id) ? (
                    // Relative, not absolute: the packaged app loads from file://, where a
                    // leading slash resolves to the filesystem root and every plate 404s (the
                    // same lesson as the art-style previews and the setup reel).
                    <img
                      src={k.id === GRAPHIC_NOVEL_KIND ? "./comic-styles/clean-line.jpg" : `./video-kinds/${k.id}.webp`}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    />
                  ) : null}
                </div>
                <div className="fy-radio__head">
                  <span className="fy-radio__dot" />
                  {k.label}
                </div>
                <div
                  style={{
                    font: "400 12px/1.55 var(--font-sans)",
                    color: "var(--muted-foreground)",
                    marginTop: 7,
                  }}
                >
                  {k.body}
                </div>
              </button>
            ))}
          </div>
          )}
          {/*
            The name, asked once, on the screen that creates (turn 113). It used to sit under the
            media on step one, and a micro drama was then asked for a SERIES name here as well —
            two fields for one thing, since the second already defaulted to the first.
          */}
          {phone && <label className="fy-production-step__name" htmlFor="production-name">Name</label>}
          <Input
            id="production-name"
            aria-label="Name"
            placeholder={isGraphicNovel ? "Arke can name it" : "Name it · working titles are fine"}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              // Emptied, the field is the step's to fill again.
              setTitleFollows(e.target.value === "");
            }}
          />
          {/* Adapt from (design turn 230b, SPEC-057 R-2): an audio drama's one other question.
              A novel or Other has none, and a video asks it in setup. */}
          {adapts && (stories.length > 0 || source !== "") && (
            <label className="fy-production-step__adapt">
              <span className="fy-production-step__label">Adapt from</span>
              <Select label="Adapt from" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">{isGraphicNovel ? "Nothing · an original book" : "Nothing · an original drama"}</option>
                {stories.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} · {s.kind} · {s.chapters} chapter{s.chapters === 1 ? "" : "s"} · {s.words.toLocaleString("en-GB")} words
                  </option>
                ))}
                {source !== "" && !story && <option value={source}>{source} · no longer here</option>}
              </Select>
            </label>
          )}
          {/* Style (design turn 248a, SPEC-064 R-21a): a graphic novel's one other question, asked by
              showing the same page drawn each way. */}
          {isGraphicNovel && (
            <div className="fy-production-step__adapt">
              <span className="fy-production-step__label">Style</span>
              <ComicStylePicker
                draft={comicStyle}
                onChange={setComicStyle}
                worldPicture={world?.keyArt ? mediaUrl(world.meta.slug, world.keyArt) : null}
              />
            </div>
          )}
          {/* For (design turn 238b, SPEC-060 R-3): the one other question a soundtrack asks. */}
          {isSoundtrack && (
            <label className="fy-production-step__adapt">
              <span className="fy-production-step__label">For</span>
              <Select label="For" value={soundtrackFor} onChange={(e) => setSoundtrackFor(e.target.value)}>
                <option value="">Choose a production</option>
                {scored.map((entry) => (
                  <option key={entry.meta.id} value={entry.meta.id}>
                    {entry.meta.title} · {productionLength(entry)}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {/*
            Everything the kind can answer, under one label that says what it is (turn 99). What
            is not here is ENDING: it sat in this row as though how a season ends were a setting,
            asked of somebody who had not written a line. The test for the door — if the kind can
            answer it, it is a default; if only the story can, it is not asked here.
          */}
          {/* Only a video has any of these to answer. A story showing an empty DEFAULTS label
              would promise settings that are not there. */}
          {chosen.medium === "video" && (
          <div style={{ display: "grid", gap: 8 }}>
            <div className="fy-mono">DEFAULTS · CHANGE LATER</div>
            {/* Four stable slots keep frame and rate compact while leaving room for episodic defaults. */}
            <div className="fy-production-defaults">
              <DefaultSelect label="FRAME" value={aspect} onChange={setAspect}>
                <option value="9:16">9:16 vertical</option>
                <option value="16:9">16:9 landscape</option>
              </DefaultSelect>
              {/* A visual novel plays pictures, not frames: a rate would be a setting nothing
                  reads. It still travels at its default, so an export to film has one. */}
              {videoKind !== "visual-novel" && (
                <DefaultSelect
                  label="RATE"
                  value={String(frameRate)}
                  onChange={(value) => setFrameRate(Number(value) as FrameRate)}
                >
                  {FRAME_RATE_CHOICES.map((rate) => (
                    <option key={rate} value={String(rate)}>{rate} fps</option>
                  ))}
                </DefaultSelect>
              )}
            </div>
          </div>
          )}
          {failure && (
            <Callout tone="danger" title="Not created">
              {failure}
            </Callout>
          )}
          {/* The narrow screen has no room to run this beside the buttons — it wrapped to two
              lines and crowded them — so there it takes a row of its own. */}
          {(phone || kinds.length === 0) && (
            <span className="fy-mono fy-production-step__joins">
              joins {world?.meta.name ?? "the world"} · {phone ? "cast, locations, canon" : `${characters} character${characters === 1 ? "" : "s"}, every location, the whole canon`}
            </span>
          )}
          <Footer className={cx("fy-production-step__foot", isGraphicNovel && "fy-production-step__foot--held")}>
            {!phone && kinds.length > 0 && (
              <span className="fy-mono">
                joins {world?.meta.name ?? "the world"} · {characters} character{characters === 1 ? "" : "s"}, every location, the whole canon
              </span>
            )}
            <span style={{ flex: 1 }} />
            {/* Back to the door, and nothing was created on the way here. */}
            <Button variant="ghost" onClick={() => { setDoor(null); setSource(""); setSoundtrackFor(""); }}>
              Back
            </Button>
            {isGraphicNovel && !story && (
              <Button disabled={pendingRequest !== null || source !== ""} onClick={create}>
                {pendingRequest ? "Creating…" : "Start empty"}
              </Button>
            )}
            {story || isGraphicNovel ? (
              // Nothing is created here: setup reads the story, asks one question and proposes
              // the plan, and its Create is the one that writes (SPEC-057 R-3..R-9).
              <Button variant="primary" disabled={!story && source !== ""} onClick={planWithArke}>
                Plan with Arke
              </Button>
            ) : (
            <Button
              variant="primary"
              disabled={title.trim().length === 0 || pendingRequest !== null || (adapts && source !== "") || (isSoundtrack && soundtrackFor === "")}
              onClick={create}
            >
              {pendingRequest
                ? "Creating…"
                : isAudioDrama
                    ? "Create"
                    : chosen.medium === "music"
                      ? "Create production"
                    : chosen.medium === "story"
                      ? "Create"
                      : "Create"}
            </Button>
            )}
          </Footer>
        </div>
      </div>
    );
  }

  /*
   * The door (turn 113). Three pictures on the world, and no panel around them: this was a
   * dialog holding three radio cards and a name field, which asked a person to read three
   * paragraphs to answer a question about what they want to make.
   *
   * Nothing is decided here but which card — the name moved to step two, beside the button that
   * uses it, so nothing typed is ever stranded behind a Back.
   */
  return (
    /*
     * A page, and dressed like every other page in the world (the eyebrow/title/lede hero, the
     * page background). It briefly wore the creation DIALOG's treatment — the world's key art
     * blurred behind a panel — which on a full page read as a grey band that stopped partway
     * down instead of a backdrop. The blurred art belongs to step two, which is still a dialog.
     */
    <div data-screen="new-production" className="fy-production-door">
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">Create something new</div>
        <h1 className="fy-hero__title">
          What should this world become next?
        </h1>
        {/* Wide enough to hold the sentence on one line: broken over two it reads as a paragraph
            of instructions rather than the one aside it is. */}
        <p className="fy-hero__lede" style={{ fontSize: 16, maxWidth: 640 }}>
          Choose a card that feels closest. The format can become more specific afterwards.
        </p>
      </div>
      <div className="fy-production-doors">
          {DOOR_CHOICES.map((d, i) => (
            <button
              key={d.id}
              type="button"
              className={`fy-door fy-door--${i}`}
              onClick={() => {
                if (d.id === "watch") {
                  navigate(`/w/${worldId}/productions/setup/${newId("cv")}`);
                  return;
                }
                setDoor(d.id);
                // The row starts on the door's first kind, and the frame is that kind's: a card
                // that carries no kind still delivers in a frame, and the kind row it is about to
                // see (or not see) is what would otherwise have seeded this.
                const startKind = DEFAULT_KIND_BY_DOOR[d.id];
                setVideoKind(startKind);
                if (d.medium === "video") {
                  setAspect(KINDS_BY_DOOR[d.id].find((k) => k.id === startKind)?.aspect ?? "16:9");
                }
              }}
            >
              {/*
                The tilt is on the print, never on the card: the card carries fy-fade-up, and that
                keyframe ends on `transform: none`, which would flatten a rotation on the same
                element the moment the entrance finished.
              */}
              <span className="fy-door__print">
                {/* Relative, not absolute: the packaged app loads from file://, where a leading
                    slash resolves to the filesystem root and every card 404s. */}
                <img src={`./doors/${d.id}.webp`} alt="" aria-hidden="true" />
              </span>
              <span className="fy-door__pad">
                <span className="fy-mono" style={{ letterSpacing: "0.14em" }}>
                  {d.eyebrow}
                </span>
                <span className="fy-door__name">{d.label}</span>
                <span className="fy-door__body">{d.body}</span>
                <span className="fy-door__go">{d.affordance} →</span>
              </span>
            </button>
          ))}
        </div>
      {failure && (
        <div style={{ margin: "24px auto 0", width: "100%", maxWidth: 560 }}>
          <Callout tone="danger" title="Not created">
            {failure}
          </Callout>
        </div>
      )}
      {/* The row is the last thing on the page, so it needs the bottom the hero gives the top —
          .fy-prodcards carries its own 46px and this row is built from scratch. */}
      <div style={{ height: 46 }} />
    </div>
  );
}

/** `Micro drama · 45 episodes`: a production as For names it (design turn 238b). */
function productionLength(entry: { meta: Parameters<typeof productionShape>[0]; chapters: readonly unknown[]; scenes: readonly unknown[]; episodes: readonly unknown[]; audioDrama?: { plan: { episodes: number } } | null }): string {
  const shape = productionShape(entry.meta);
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  if (shape.isAudioDrama) return `${shape.displayLabel} · ${count(entry.audioDrama?.plan.episodes ?? 0, "episode")}`;
  if (shape.hasChapters) return `${shape.displayLabel} · ${count(entry.chapters.length, "chapter")}`;
  if (shape.isEpisodic) return `${shape.displayLabel} · ${count(entry.episodes.length, "episode")}`;
  return `${shape.displayLabel} · ${count(entry.scenes.length, "scene")}`;
}

/**
 * The world behind the decision, blurred back (turns 43a, 53a). Making something *from* a world is
 * a moment worth lifting out of the page it was reached from, and the key art is what says which
 * world it is without a line of text repeating the rail.
 */
function ProductionDialogBackdrop({
  world,
}: {
  world: { meta: { slug: string }; keyArt?: string | null } | null;
}) {
  const art = world?.keyArt;
  if (!art) return null;
  return (
    <div
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}
    >
      <img
        src={mediaUrl(world.meta.slug, art)}
        alt=""
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          filter: "blur(7px) saturate(.8)",
          opacity: 0.4,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "color-mix(in srgb, var(--background) 72%, transparent)",
        }}
      />
    </div>
  );
}

/** One of step two's defaults: a control that looks like the control it is (turn 53). */
function DefaultSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="fy-mono" style={{ display: "grid", gap: 4 }}>
      {label}
      <select
        aria-label={label}
        style={{
          font: "400 13px var(--font-sans)",
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--background)",
          color: "var(--foreground)",
        }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}
