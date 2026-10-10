import { useEffect, useRef, useState } from "react";
import {
  audiobookMotionDurations,
  audiobookMotionModel,
  mountAudiobookPlayer,
  formatMicroUsd,
  ulid,
  type AudiobookListening,
  type AudiobookMotionQuote,
  type AudiobookPicture,
  type BenchVideoParams,
} from "@arke-studio/contracts";
import { mediaUrl } from "../lib/media.js";
import { useMediaQuery } from "../lib/media-query.js";
import {
  send,
  openAudiobookListening,
  subscribeAudiobookListening,
  subscribeAudiobookMotion,
  useStore,
} from "../lib/store.js";
import { playerChapters } from "./audiobook-player.js";
import { claimRead, releaseRead } from "../lib/reply-reads.js";
import { usableModels } from "./dispatch-bar.js";
import { EditorDialog } from "./editor-dialog.js";
import { Button } from "./ui.js";
import { Seg } from "./audiobook-video.js";

/** Turn 208: a separate clip choice always keeps its source picture. */
export function AudiobookMotionControl({
  worldId,
  productionId,
  chapterFile,
  block,
  picture,
  slug,
  label = "Picture",
  chapterLabel,
  holdLabel,
}: {
  worldId: string;
  productionId: string;
  chapterFile: string;
  block: string;
  picture: AudiobookPicture;
  slug: string;
  label?: string;
  chapterLabel?: string;
  holdLabel?: string;
}) {
  const store = useStore();
  const phone = useMediaQuery("(max-width: 599px)");
  const models = usableModels(store.state, "video").filter(audiobookMotionModel);
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((m) => m.id === modelId) ?? models[0];
  const durations = model === undefined ? [] : audiobookMotionDurations(model);
  const [seconds, setSeconds] = useState(5);
  const [resolution, setResolution] = useState("");
  const [prompt, setPrompt] = useState(
    "Subtle natural movement. Keep the people, clothing, setting and composition of the starting picture. A steady camera.",
  );
  const [quote, setQuote] = useState<AudiobookMotionQuote | null>(null);
  const [state, setState] = useState<"edit" | "making" | "review">("edit");
  const [reason, setReason] = useState<string | null>(null);
  const [behavior, setBehavior] = useState<"repeat" | "hold">("repeat");
  const [reading, setReading] = useState(false);
  const [viewChosen, setViewChosen] = useState(false);
  const viewChosenRef = useRef(viewChosen);
  viewChosenRef.current = viewChosen;
  const asked = useRef<string | null>(null);
  const ids = { worldId, productionId, chapterFile, block };
  const candidate = picture.motionCandidate;
  const chosen = picture.motion?.active === true ? picture.motion : undefined;
  const review = candidate !== undefined && state !== "making";
  const duration = durations.includes(seconds) ? seconds : (durations[0] ?? 5);
  const resolutions = model?.limits.resolutions ?? [];
  const quality = resolutions.includes(resolution) ? resolution : resolutions[0];
  const params: BenchVideoParams = {
    kind: "video",
    durationSec: duration,
    ...(quality !== undefined ? { resolution: quality } : {}),
    ...(model?.limits.soundChoice === true ? { sound: false } : {}),
  };
  useEffect(
    () =>
      subscribeAudiobookMotion((answer) => {
        if (answer.requestId !== asked.current) return;
        if (answer.state === "quoted") {
          setQuote(answer.quote ?? null);
        }
        if (answer.state === "making") setState("making");
        if (answer.state === "review") setState("review");
        if (answer.state === "chosen") {
          setState("edit");
          if (!viewChosenRef.current) setOpen(false);
        }
        if (answer.state === "failed") {
          setReason(answer.reason ?? "The clip could not be made");
          setState("edit");
        }
      }),
    [],
  );
  useEffect(() => {
    if (!open || review || viewChosen || state === "making") return;
    // Invalidate immediately: an old response can arrive during the next debounce.
    asked.current = null;
    setQuote(null);
    if (model === undefined || prompt.trim() === "") return;
    const timer = setTimeout(() => {
      asked.current = ulid();
      send({
        kind: "quote-audiobook-motion",
        ...ids,
        model: model.id,
        params,
        prompt,
        requestId: asked.current,
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [open, model?.id, duration, quality, prompt, picture.file, picture.at, review, state, viewChosen]);
  const choose = (choice: "candidate" | "still" | "behavior", next = behavior) => {
    asked.current = ulid();
    if (choice !== "behavior") {
      setViewChosen(false);
      viewChosenRef.current = false;
    }
    setReason(null);
    if (
      !send({
        kind: "choose-audiobook-motion",
        ...ids,
        choice,
        behavior: next,
        ...((candidate ?? picture.motion) !== undefined
          ? { artifactId: (candidate ?? picture.motion)!.artifactId }
          : {}),
        requestId: asked.current,
      })
    )
      setReason("Reconnect before changing the picture");
  };
  const make = () => {
    if (quote === null) return;
    asked.current = ulid();
    setState("making");
    setReason(null);
    if (!send({ kind: "make-audiobook-motion", ...ids, quote, requestId: asked.current })) {
      setState("edit");
      setReason("Reconnect before generating");
    }
  };
  const showingChosen = viewChosen && chosen !== undefined && !review && state !== "making";
  const shownClip = review ? candidate : showingChosen ? chosen : undefined;
  const generation = store.state?.world?.artifacts.find(
    (artifact) => artifact.id === shownClip?.artifactId,
  )?.generation;
  const clipModel =
    generation === undefined
      ? quote?.model.label
      : (store.state?.app.manifest?.models.find(
          (entry) => entry.id === generation.model && entry.provider === generation.provider,
        )?.displayName ?? generation.model);
  const close = () => {
    setOpen(false);
    setReading(false);
  };
  const sourceCard = (retained = false) => (
    <div className="fy-abmotion-source">
      <img src={mediaUrl(slug, picture.file)} alt="Original picture" />
      <div>
        <b>{retained ? "Original picture" : "Start frame"}</b>
        <p>{retained ? "Kept with this clip" : `${label} · original picture`}</p>
      </div>
      {retained && (
        <Button variant="outline" onClick={() => choose("still")}>
          Use still
        </Button>
      )}
    </div>
  );
  const afterClip = (
    <div className="fy-abmotion-option">
      <b>After the clip</b>
      <Seg
        label="Clip playback"
        value={showingChosen ? chosen!.behavior : behavior}
        options={
          [
            ["repeat", "Repeat"],
            ["hold", "Hold last frame"],
          ] as const
        }
        onChange={(next) => (showingChosen ? choose("behavior", next) : setBehavior(next))}
      />
    </div>
  );
  return (
    <>
      <div className="fy-abmotion-actions">
        <span className="fy-abmotion-meta">{holdLabel}</span>
        <span className="grow" />
        {picture.motion?.active === false && candidate === undefined && (
          <Button variant="outline" onClick={() => choose("candidate", picture.motion!.behavior)}>
            Use clip
          </Button>
        )}
        <Button
          variant="outline"
          disabled={store.connection !== "open"}
          onClick={() => {
            setOpen(true);
            setViewChosen(chosen !== undefined);
            setReason(null);
          }}
        >
          {candidate !== undefined
            ? "Review clip"
            : state === "making"
              ? "Making clip…"
              : chosen !== undefined
                ? "Clip in use"
                : "Animate"}
        </Button>
      </div>
      {!open && reason !== null && (
        <p role="alert" className="fy-abv-warn">
          {reason}
        </p>
      )}
      <EditorDialog
        open={open}
        onClose={close}
        width={showingChosen ? 620 : 720}
        labelledBy="motion-dialog-title"
        panelClassName={`fy-abmotion${showingChosen ? " fy-abmotion--chosen" : ""}`}
      >
        <div className="fy-abmotion-head">
          <div>
            <h3 id="motion-dialog-title">
              {state === "making"
                ? "Generating"
                : review
                  ? "Choose the clip"
                  : showingChosen
                    ? label
                    : "Animate picture"}
            </h3>
            <p>
              {label}
              {chapterLabel !== undefined ? ` · ${chapterLabel}` : ""}
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        {open && reading && shownClip !== undefined ? (
          <MotionReadingPreview
            worldId={worldId}
            productionId={productionId}
            chapterId={
              store.state?.world?.productions
                .find((p) => p.meta.id === productionId)
                ?.chapters.find((c) => c.file === chapterFile || c.id === chapterFile)?.id ?? chapterFile
            }
            block={block}
            picture={{
              ...picture,
              motion: { ...shownClip, active: true, behavior: showingChosen ? chosen!.behavior : behavior },
            }}
            slug={slug}
            onClose={() => setReading(false)}
          />
        ) : (
          <div className="fy-abmotion-body">
            {shownClip !== undefined ? (
              <>
                <ClipPreview
                  key={shownClip.artifactId}
                  file={mediaUrl(slug, shownClip.file)}
                  poster={mediaUrl(slug, picture.file)}
                  seconds={shownClip.seconds}
                  repeat={(showingChosen ? chosen!.behavior : behavior) === "repeat"}
                  onError={() =>
                    setReason(
                      "Clip unavailable · the original picture is showing. Use still or restore the clip before exporting.",
                    )
                  }
                />
                <div className="fy-abmotion-row">
                  <span className="fy-abmotion-meta">
                    {clipModel !== undefined ? `${clipModel} · ` : ""}
                    {shownClip.width} × {shownClip.height} · {shownClip.seconds}s
                  </span>
                  <span className="grow" />
                  {review ? (
                    <Button variant="outline" onClick={() => setReading(true)}>
                      ▶ Preview with reading
                    </Button>
                  ) : (
                    <b>Clip in use</b>
                  )}
                </div>
                {afterClip}
                {review && (
                  <p className="fy-abmotion-meta">
                    {behavior === "repeat" ? "Repeats" : "Holds the last frame"} until the next picture or the
                    end of the chapter. Preview includes the repeat boundary.
                  </p>
                )}
                {sourceCard(showingChosen)}
                {showingChosen && (
                  <div className="fy-abmotion-row">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setViewChosen(false);
                        setState("edit");
                      }}
                    >
                      Make another clip
                    </Button>
                    <a href={`#/w/${encodeURIComponent(worldId)}/artifacts`}>View in Library</a>
                  </div>
                )}
                <p className="fy-abmotion-notice">
                  {showingChosen
                    ? "Slow push applies to stills. The clip keeps its own movement."
                    : `${shownClip.height}p clip · scaled to fill the export. No upscaling has been run.`}
                </p>
              </>
            ) : state === "making" ? (
              <>
                {sourceCard()}
                <p>The picture remains in use</p>
                <progress aria-label="Generating clip" />
                <p className="fy-abmotion-meta">
                  Making 1 clip · closing this sheet keeps the job running. A completed clip is kept in
                  Library.
                </p>
              </>
            ) : (
              <>
                {sourceCard()}
                <label className="fy-abmotion-field">
                  Motion
                  <textarea
                    value={prompt}
                    maxLength={10000}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                  />
                </label>
                <label className="fy-abmotion-option">
                  <b>Model</b>
                  <select value={model?.id ?? ""} onChange={(e) => setModelId(e.target.value)}>
                    {models.map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                {models.length === 0 && (
                  <p role="status">
                    No enabled model can start from this picture. Enable a first-frame video model in
                    Settings.
                  </p>
                )}
                <div className="fy-abmotion-pair">
                  <label className="fy-abmotion-field">
                    Length
                    <select value={duration} onChange={(e) => setSeconds(Number(e.target.value))}>
                      {durations.map((n) => (
                        <option key={n} value={n}>
                          {n} seconds
                        </option>
                      ))}
                    </select>
                  </label>
                  {resolutions.length > 0 && (
                    <label className="fy-abmotion-field">
                      Resolution
                      <select value={quality} onChange={(e) => setResolution(e.target.value)}>
                        {resolutions.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <p className="fy-abmotion-meta fy-abmotion-model-note">
                  Start-frame models only · sound is muted in the audiobook
                </p>
                <div className="fy-abmotion-quote">
                  <div className="fy-abmotion-row">
                    <b>
                      {quote === null
                        ? "Getting price…"
                        : quote.estimatedMicroUsd === 0
                          ? model?.pricing.kind === "included-plan"
                            ? "Included in your plan"
                            : "No API charge"
                          : `${formatMicroUsd(quote.estimatedMicroUsd)} at most`}
                    </b>
                    <span className="grow" />
                    <b>
                      {quote?.typicalRunSec !== undefined
                        ? `~${Math.ceil(quote.typicalRunSec / 60)} min on the reference machine`
                        : "Time not measured"}
                    </b>
                  </div>
                  <p>
                    {quality !== undefined ? `${quality} source · ` : ""}exported at your chosen size.
                    Upscaling is separate.
                  </p>
                </div>
              </>
            )}
            {reason !== null && (
              <p role="alert" className="fy-abv-warn">
                {reason}
                {/library/i.test(reason) && (
                  <>
                    {" "}
                    <a href={`#/w/${encodeURIComponent(worldId)}/artifacts`}>View clip</a>
                  </>
                )}
              </p>
            )}
          </div>
        )}
        <div className="fy-abmotion-foot">
          {showingChosen ? (
            <span className="fy-abmotion-meta">Clip sound is always muted</span>
          ) : (
            <Button variant="outline" onClick={() => (review ? choose("still") : close())}>
              {review ? "Keep still" : "Cancel"}
            </Button>
          )}
          <span className="grow" />
          {showingChosen ? (
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          ) : state === "making" ? (
            <Button
              variant="outline"
              onClick={() => send({ kind: "stop-audiobook-motion", ...ids, requestId: ulid() })}
            >
              Stop
            </Button>
          ) : review ? (
            <Button variant="primary" onClick={() => choose("candidate")}>
              Use clip
            </Button>
          ) : (
            <Button variant="primary" disabled={quote === null || store.connection !== "open"} onClick={make}>
              {quote !== null && quote.estimatedMicroUsd > 0
                ? `Generate · ${formatMicroUsd(quote.estimatedMicroUsd)} at most`
                : phone
                  ? "Generate clip"
                  : `Generate ${duration}-second clip`}
            </Button>
          )}
        </div>
      </EditorDialog>
    </>
  );
}

function ClipPreview({
  file,
  poster,
  seconds,
  repeat,
  onError,
}: {
  file: string;
  poster: string;
  seconds: number;
  repeat: boolean;
  onError: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null),
    [playing, setPlaying] = useState(false);
  return (
    <div className="fy-abmotion-media">
      <video
        ref={video}
        src={file}
        poster={poster}
        muted
        playsInline
        loop={repeat}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={onError}
        onVolumeChange={(event) => {
          if (!event.currentTarget.muted) event.currentTarget.muted = true;
        }}
      />
      <span className="fy-abmotion-badge">Clip · muted</span>
      <button
        type="button"
        className="fy-abmotion-play"
        aria-label={playing ? "Pause clip" : "Play clip"}
        onClick={() => {
          if (playing) video.current?.pause();
          else void video.current?.play().catch(onError);
        }}
      >
        {playing ? "Ⅱ" : "▶"}
      </button>
      <span className="fy-abmotion-duration">{seconds}s</span>
    </div>
  );
}

function MotionReadingPreview({
  worldId,
  productionId,
  chapterId,
  block,
  picture,
  slug,
  onClose,
}: {
  worldId: string;
  productionId: string;
  chapterId: string;
  block: string;
  picture: AudiobookPicture;
  slug: string;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [plan, setPlan] = useState<AudiobookListening | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const request = openAudiobookListening(worldId, productionId);
    return subscribeAudiobookListening((answer) => {
      if (answer.requestId !== request) return;
      if (answer.listening === null) setProblem(answer.refused ?? "The reading could not open");
      else setPlan(answer.listening);
    });
  }, [worldId, productionId]);
  useEffect(() => {
    if (host.current === null || plan === null) return;
    const chapter = plan.chapters.find((c) => c.chapterId === chapterId);
    const shown = chapter?.pictures.find((p) => p.key === block || p.file === picture.file);
    if (chapter === undefined || chapter.blocks.length === 0 || shown === undefined) {
      setProblem("Read this picture’s block before previewing with narration");
      return;
    }
    const preview = {
      ...plan,
      chapters: [
        {
          ...chapter,
          pictures: chapter.pictures.map((p) =>
            p === shown ? { ...p, motion: picture.motion, motionProblem: undefined } : p,
          ),
        },
      ],
    };
    const handle = mountAudiobookPlayer(host.current, {
      title: "Clip preview",
      chapters: playerChapters(preview, (file) => mediaUrl(slug, file)),
      chapterId,
      startAt: shown.at,
      autoplay: true,
      onClose,
      onPlay: () => claimRead("audiobook-motion-preview", () => handle.pause()),
    });
    return () => {
      handle.destroy();
      releaseRead("audiobook-motion-preview");
    };
  }, [plan, chapterId, block, picture.motion?.artifactId, picture.motion?.behavior]);
  return (
    <div style={{ position: "relative", height: 450, minHeight: 300 }}>
      <div ref={host} style={{ position: "absolute", inset: 0 }} />
      {problem !== null ? (
        <p role="status" style={{ padding: 24 }}>
          {problem}
        </p>
      ) : (
        plan === null && <p style={{ padding: 24 }}>Opening the current reading…</p>
      )}
    </div>
  );
}
