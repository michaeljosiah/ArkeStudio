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

/** Turn 208: a separate clip choice always keeps its source picture. */
export function AudiobookMotionControl({
  worldId,
  productionId,
  chapterFile,
  block,
  picture,
  slug,
}: {
  worldId: string;
  productionId: string;
  chapterFile: string;
  block: string;
  picture: AudiobookPicture;
  slug: string;
}) {
  const store = useStore();
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
          setReason(null);
        }
        if (answer.state === "making") setState("making");
        if (answer.state === "review") setState("review");
        if (answer.state === "chosen") {
          setOpen(false);
          setState("edit");
        }
        if (answer.state === "failed") {
          setReason(answer.reason ?? "The clip could not be made");
          setState("edit");
        }
      }),
    [],
  );
  useEffect(() => {
    if (!open || review || state === "making") return;
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
  }, [open, model?.id, duration, quality, prompt, picture.file, picture.at, review, state]);
  const choose = (choice: "candidate" | "still" | "behavior", next = behavior) => {
    asked.current = ulid();
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
  return (
    <>
      <div className="fy-abmotion-actions">
        {chosen !== undefined && (
          <>
            <span className="fy-mono">Clip · {chosen.seconds}s · muted</span>
            <select
              aria-label="Clip playback"
              value={chosen.behavior}
              onChange={(e) => choose("behavior", e.target.value as "repeat" | "hold")}
            >
              <option value="repeat">Repeat</option>
              <option value="hold">Hold last frame</option>
            </select>
            <Button variant="outline" onClick={() => choose("still")}>
              Use still
            </Button>
          </>
        )}
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
            setReason(null);
          }}
        >
          {candidate !== undefined ? "Review clip" : state === "making" ? "Making clip…" : "Animate"}
        </Button>
      </div>
      {!open && reason !== null && (
        <p role="alert" className="fy-abv-warn">
          {reason}
        </p>
      )}
      <EditorDialog
        open={open}
        onClose={() => {
          setOpen(false);
          setReading(false);
        }}
        title={state === "making" ? "Making your clip" : review ? "Review clip" : "Animate picture"}
        subtitle="Your original picture stays saved"
        width={800}
        panelClassName="fy-abmotion"
      >
        {open && reading && candidate !== undefined ? (
          <MotionReadingPreview
            worldId={worldId}
            productionId={productionId}
            chapterId={
              store.state?.world?.productions
                .find((p) => p.meta.id === productionId)
                ?.chapters.find((c) => c.file === chapterFile || c.id === chapterFile)?.id ?? chapterFile
            }
            block={block}
            picture={{ ...picture, motion: { ...candidate, active: true, behavior } }}
            slug={slug}
            onClose={() => setReading(false)}
          />
        ) : (
          <>
            <div className="fy-abmotion-body">
              <div className="fy-abmotion-preview">
                {review ? (
                  <video
                    key={candidate.artifactId}
                    src={mediaUrl(slug, candidate.file)}
                    poster={mediaUrl(slug, picture.file)}
                    controls
                    muted
                    onVolumeChange={(event) => {
                      if (!event.currentTarget.muted) event.currentTarget.muted = true;
                    }}
                    playsInline
                    loop={behavior === "repeat"}
                  />
                ) : (
                  <img src={mediaUrl(slug, picture.file)} alt="The starting picture" />
                )}
                <p className="fy-mono">
                  {review
                    ? `${candidate.seconds}s · ${candidate.width} × ${candidate.height} · muted`
                    : "Starting picture · first frame"}
                </p>
                {review && (
                  <Button variant="outline" onClick={() => setReading(true)}>
                    Preview with reading
                  </Button>
                )}
              </div>
              <div className="fy-abmotion-fields">
                {state === "making" ? (
                  <>
                    <p role="status">
                      Generating one clip. The current picture stays in the audiobook until you choose Use
                      clip.
                    </p>
                    <p>Closing this sheet keeps the job running. A completed clip is kept in Library.</p>
                  </>
                ) : review ? (
                  <>
                    <h3>Keep the motion?</h3>
                    <p>The clip is muted. Your narration remains the only voice.</p>
                    <label>
                      After the clip ends
                      <select
                        value={behavior}
                        onChange={(e) => setBehavior(e.target.value as "repeat" | "hold")}
                      >
                        <option value="repeat">Repeat</option>
                        <option value="hold">Hold last frame</option>
                      </select>
                    </label>
                    <p>It continues until the next picture or the end of the chapter.</p>
                  </>
                ) : (
                  <>
                    <label>
                      Motion
                      <textarea
                        value={prompt}
                        maxLength={10000}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={5}
                      />
                    </label>
                    <label>
                      Model
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
                      <label>
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
                        <label>
                          Resolution
                          <select value={quality} onChange={(e) => setResolution(e.target.value)}>
                            {resolutions.map((r) => (
                              <option key={r}>{r}</option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                    <p>Fits the export frame. Upscaling is not included.</p>
                    <p className="fy-abmotion-price">
                      {quote === null
                        ? "Getting price…"
                        : quote.estimatedMicroUsd === 0
                          ? model?.pricing.kind === "included-plan" ? "Included in your plan" : "No API charge"
                          : `${formatMicroUsd(quote.estimatedMicroUsd)} at most`}{" "}
                      {quote?.typicalRunSec !== undefined
                        ? `· about ${Math.ceil(quote.typicalRunSec / 60)} min on the reference machine`
                        : "· time not measured"}
                    </p>
                  </>
                )}
                {reason !== null && (
                  <p role="alert" className="fy-abv-warn">
                    {reason}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
        <div className="fy-abmotion-foot">
          <Button variant="outline" onClick={() => (review ? choose("still") : setOpen(false))}>
            {review ? "Keep still" : "Close"}
          </Button>
          <span />
          {state === "making" ? (
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
              Generate clip
            </Button>
          )}
        </div>
      </EditorDialog>
    </>
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
