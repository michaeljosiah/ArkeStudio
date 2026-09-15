import {
  frameDispatchFor,
  legacySceneView,
  modelCapabilityCopy,
  orderedShots,
  productionAspect,
  type CompiledPass,
} from "@arke-studio/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { productionModel } from "../components/dispatch-bar.js";
import { Play, Plus } from "../components/icons.js";
import { EmptyState } from "../components/layout.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { Button, cx } from "../components/ui.js";
import { seconds, usd } from "../lib/format.js";
import { acceptedTakeId, takeDecisions, takesForShot, useProduction } from "../lib/selectors.js";
import {
  acceptTake,
  rejectTake,
  sendBenchOpenSubject,
  subscribeBenchSubjectOpened,
  useStore,
} from "../lib/store.js";
import { decisionTone, takeMediaPath } from "../lib/take-presentation.js";
import { carriedSubjects } from "./production-cast.js";
import { TakesView } from "./production-takes.js";

export function GenerateScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const { connection, state } = useStore();
  const navigate = useNavigate();
  const ownerKey = `${worldId ?? ""}/${prodId ?? ""}`;
  const currentOwnerKey = useRef(ownerKey);
  currentOwnerKey.current = ownerKey;
  const pendingGenerator = useRef<{ requestId: string; ownerKey: string } | null>(null);
  const [generatorPending, setGeneratorPending] = useState(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  // The workspace's second lens (design 55a): the same frame/still takes, seen as a set.
  // Deep-linkable — the retired /stills address redirects here with the lens on.
  const [searchParams, setSearchParams] = useSearchParams();
  const contactLens = searchParams.get("view") === "stills";
  const shots = production?.scenes.flatMap((s) => orderedShots(s)) ?? [];
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);
  /* The bench honours the address the same way the takes view does (review 2026-08-22). */
  const benchAsked = searchParams.get("shot");
  const shotId =
    selectedShotId ??
    (benchAsked !== null && shots.some((s) => s.id === benchAsked) ? benchAsked : null) ??
    shots[0]?.id ??
    null;
  const shot = shots.find((s) => s.id === shotId) ?? null;
  const found = production?.scenes.find((s) => orderedShots(s).some((x) => x.id === shotId)) ?? null;
  const scene = found === null ? null : legacySceneView(found);
  const takes = production && shotId ? takesForShot(production, shotId) : [];
  const decisions = production ? takeDecisions(production) : {};
  const accepted = production && shotId ? acceptedTakeId(production, shotId) : null;
  const take =
    takes.find((t) => t.id === selectedTakeId) ??
    (accepted ? takes.find((t) => t.id === accepted) : undefined) ??
    takes[takes.length - 1] ??
    null;
  const slug = world?.meta.slug;
  const model =
    (state?.app.manifest?.models ?? []).find(
      (m) => m.id === (productionModel(state, prodId, "video") ?? state?.app.routing.defaults["video"]),
    ) ??
    (state?.app.manifest?.models ?? []).find((m) => m.capability === "video") ??
    null;

  useEffect(
    () =>
      subscribeBenchSubjectOpened((event) => {
        const pending = pendingGenerator.current;
        if (
          pending === null ||
          pending.ownerKey !== currentOwnerKey.current ||
          event.requestId !== pending.requestId ||
          event.worldId !== worldId
        ) {
          return;
        }
        pendingGenerator.current = null;
        setGeneratorPending(false);
        if (event.sessionId === null) {
          setGeneratorError(event.reason ?? "The generator session could not be prepared.");
          return;
        }
        setGeneratorError(null);
        void navigate(`/w/${worldId}/artifacts/bench/${event.sessionId}`);
      }),
    [navigate, worldId],
  );
  useEffect(() => {
    if (connection === "open" || pendingGenerator.current === null) return;
    pendingGenerator.current = null;
    setGeneratorPending(false);
    setGeneratorError("Connection lost - try again.");
  }, [connection]);
  useEffect(() => {
    const pending = pendingGenerator.current;
    if (pending === null || pending.ownerKey === ownerKey) return;
    pendingGenerator.current = null;
    setGeneratorPending(false);
    setGeneratorError(null);
  }, [ownerKey]);
  const openGenerator = (targetShotId: string) => {
    if (!worldId || !prodId || pendingGenerator.current !== null) return;
    const targetScene = production?.scenes.find((candidate) => orderedShots(candidate).some((candidate) => candidate.id === targetShotId));
    if (targetScene === undefined) return;
    const requestId = sendBenchOpenSubject({
      worldId,
      productionId: prodId,
      sceneId: targetScene.id,
      subject: { kind: "shot", shotId: targetShotId },
    });
    if (requestId === null) {
      setGeneratorError("Not connected - try again.");
      return;
    }
    pendingGenerator.current = { requestId, ownerKey };
    setGeneratorPending(true);
    setGeneratorError(null);
  };

  /*
   * Which lens the workspace opens on (turn 102). Takes are the thing here: once something has
   * been generated you are assessing rather than writing, so the takes themselves are the front
   * and the three-column bench — composer, parameters, model picker — is layer three behind
   * Advanced. Deep-linkable, so somebody who wants the bench can live in it.
   */
  const benchLens = searchParams.get("view") === "bench";

  if (contactLens) {
    return (
      <ContactSheet
        production={production}
        worldSlug={world?.meta.slug}
        worldId={worldId}
        prodId={prodId}
        onShotLens={() => setSearchParams({}, { replace: true })}
      />
    );
  }
  if (!benchLens) {
    return (
      <TakesView
        worldId={worldId}
        prodId={prodId}
        askedFor={searchParams.get("shot")}
        generating={generatorPending}
        onGenerate={openGenerator}
        onAdvanced={(targetShotId) => targetShotId !== null && openGenerator(targetShotId)}
        onContact={(shotId) =>
          setSearchParams(shotId ? { view: "stills", shot: shotId } : { view: "stills" }, { replace: true })
        }
      />
    );
  }

  /*
   * Bench-only derivations live below the lens branch (review 2026-08-22): the previous frame,
   * the frame route, the boundary still and the cited sheets are the bench's furniture, and
   * computing them above the branch made every takes-view render pay for a bench nobody was
   * looking at. Plain consts, so they may sit under the returns; the hooks stay above.
   */
  const prevShot = (() => {
    if (!found || !shot) return null;
    const ordered = orderedShots(found);
    const i = ordered.findIndex((s) => s.id === shot.id);
    return i > 0 ? ordered[i - 1]! : null;
  })();
  const prevAccepted =
    prevShot && production
      ? production.takes.find((t) => t.id === acceptedTakeId(production, prevShot.id))
      : null;
  const prevFrame = prevAccepted && production ? takeMediaPath(production, prevAccepted) : null;
  // Strict frame behaviour is promised exactly where the route supports and receives it (issue
  // 154): the model's first-frame route, and the shot's durable boundary still. Anything less is
  // steering, and the copy says so instead of promising what the dispatch cannot send.
  const frameRoute = model ? frameDispatchFor(model, 1) : null;
  const boundaryFrame = (() => {
    if (!shot || !production || !world) return null;
    const id = production.selections[shot.id]?.startFrameArtifactId ?? null;
    return id !== null ? (world.artifacts.find((a) => a.id === id) ?? null) : null;
  })();

  const citedSheets = (() => {
    if (!shot || !world) return [];
    const mentions = [...shot.description.matchAll(/@([A-Za-z0-9-]+)/g)].map((m) => m[1]!.toLowerCase());
    return world.sheets
      .filter((s) => s.type === "character")
      .filter((s) => mentions.some((m) => s.id.includes(m) || s.name.toLowerCase().includes(m)))
      .slice(0, 2);
  })();

  return (
    <div className="fy-gen" data-screen="generate-workspace">
      <div className="fy-gen__left">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="fy-seg">
            <span className="fy-seg__item fy-seg__item--active">Shot</span>
            <button
              type="button"
              className="fy-seg__item"
              onClick={() => setSearchParams({ view: "stills" }, { replace: true })}
            >
              Contact sheet
            </button>
          </span>
          <select
            value={shotId ?? ""}
            disabled={generatorPending}
            onChange={(e) => {
              setSelectedShotId(e.target.value);
              setSelectedTakeId(null);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              font: "500 12px var(--font-sans)",
              padding: "6px 8px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "inherit",
            }}
          >
            {shots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id.replace("sh_", "shot ")} · {s.title}
              </option>
            ))}
          </select>
        </div>
        <div className="fy-gen__label">
          References <span className="fy-mono">sent with every take</span>
        </div>
        <div className="fy-refstrip">
          <div className="fy-refstrip__wide">
            <Portrait
              worldSlug={slug}
              path={scene?.board ? `productions/${production!.meta.id}/${scene.board.image}` : ""}
              label={shot ? `${shot.id.replace("sh_", "Shot ")} frame` : "frame"}
              radius={0}
            />
          </div>
          {citedSheets.map((s) => (
            <div key={s.id} className="fy-refstrip__tile">
              <Portrait worldSlug={slug} path={sheetPortraitPath(s.id)} label={s.name} radius={0} />
            </div>
          ))}
          <button
            type="button"
            className="fy-refstrip__add"
            title="References ride from the kits"
            onClick={() => navigate(`/w/${worldId}/cast`)}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="fy-mono" style={{ marginTop: 6 }}>
          {shot
            ? `${shot.id.replace("sh_", "shot ")}${citedSheets.length > 0 ? ` · ${citedSheets.map((s) => `${s.name} model sheet v${s.version}`).join(" · ")}` : ""}`
            : ""}
        </div>
        <div className="fy-gen__label" style={{ marginTop: 16 }}>
          Frames{" "}
          <span className="fy-mono">
            {frameRoute !== null
              ? "start travels on the first-frame route"
              : "steering only · no frame route on this model"}
          </span>
        </div>
        {world && production && (
          <div className="fy-worldlook-line">
            <span>
              {shot?.promptOverride
                ? "Shot prompt override"
                : production.meta.styleOverride?.trim()
                ? "Production look"
                : `World look · v${world.artDirection.version}`}
            </span>
            <small>
              {shot?.promptOverride ? "edited by you" : production.meta.styleOverride?.trim() || "inherited"} · carries
              as text
            </small>
          </div>
        )}
        <div className="fy-framerow">
          {boundaryFrame ? (
            <div className="fy-frame">
              <Portrait
                worldSlug={slug}
                path={`artifacts/${boundaryFrame.file}`}
                label="Start frame"
                radius={0}
              />
              <span className="fy-frame__tag">
                START · BOUNDARY FRAME{frameRoute !== null ? "" : " (STEERS ONLY)"}
              </span>
            </div>
          ) : prevFrame ? (
            <div className="fy-frame">
              <Portrait worldSlug={slug} path={prevFrame} label="Start frame" radius={0} />
              <span className="fy-frame__tag">
                START · {prevShot!.id.replace("sh_", "SHOT ")}, LAST FRAME (PREVIEW)
              </span>
            </div>
          ) : (
            <div className="fy-frame fy-frame--empty">START · FROM THE BOARD</div>
          )}
          <div className="fy-frame fy-frame--empty">END · OPTIONAL</div>
        </div>
        <div className="fy-paramrow">
          {/* The production's delivery aspect (issue 389), never a hard-coded landscape. */}
          <span className="fy-param">{production ? productionAspect(production.meta) : "16:9"}</span>
          <span className="fy-param">720p</span>
          {shot && <span className="fy-param">{seconds(shot.durationSec)}</span>}
          {frameRoute !== null && boundaryFrame && (
            <span className="fy-param">opens on its boundary frame</span>
          )}
        </div>
        <div className="fy-gen__cta">
          {model && (
            <span className="fy-modelchip">
              {model.displayName}
              <span className="fy-mono">{modelCapabilityCopy(model)}</span>
            </span>
          )}
          <span className="fy-h1row__push" />
          <Button
            variant="primary"
            disabled={generatorPending || shotId === null}
            onClick={() => shotId !== null && openGenerator(shotId)}
          >
            {generatorPending ? "Opening…" : "Open generation session"}
          </Button>
          {generatorError === null ? null : <span role="alert" className="fy-mono">{generatorError}</span>}
        </div>
      </div>
      <div className="fy-gen__center">
        {take ? (
          <>
            <div className="fy-gen__meta">
              <span className="fy-mono">
                take {takes.indexOf(take) + 1} · {take.model} · {seconds(shot?.durationSec)}
                {take.completedAt ? ` · finished ${take.completedAt.slice(11, 16)}` : ""}
              </span>
              {(take.provenance.propStates ?? []).length === 0 ? null : (
                // The five fields frozen at dispatch (design turn 105; issue 536), named rather
                // than by id — what this take was made with, not what the shot says now.
                <span className="fy-mono" data-testid="take-prop-provenance" style={{ display: "block" }}>
                  {take.provenance.propStates!
                    .map((entry) => {
                      const prop = world?.props.find((candidate) => candidate.id === entry.propId);
                      const state = prop?.states.find((candidate) => candidate.id === entry.stateId);
                      return `prop: ${prop?.name ?? entry.propId} · state: ${state?.name ?? entry.stateId ?? "unresolved"} · ref: ${entry.referenceId ?? "none"} · resolved: ${entry.resolutionSource} · override: ${entry.overrideSource ?? "none"}`;
                    })
                    .join("  ")}
                </span>
              )}
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span className={`fy-dot fy-dot--${decisionTone(decisions[take.id])}`} />
                <span className="fy-mono">{decisions[take.id] ?? "pending"}</span>
              </span>
            </div>
            <div className="fy-viewer">
              <Portrait
                worldSlug={slug}
                path={takeMediaPath(production!, take) ?? ""}
                label={`Take: first frame`}
                radius={0}
              />
              <span className="fy-playbtn" aria-hidden style={{ pointerEvents: "none" }}>
                <Play size={22} />
              </span>
            </div>
            <div className="fy-scrub">
              <span className="fy-mono">0:00</span>
              <div className="fy-scrub__bar">
                <div className="fy-scrub__fill" style={{ width: "0%" }} />
              </div>
              <span className="fy-mono">{seconds(shot?.durationSec)}</span>
            </div>
            <div className="fy-gen__verdict">
              <Button
                variant="primary"
                disabled={!shotId || decisions[take.id] === "accepted"}
                onClick={() => worldId && prodId && shotId && acceptTake(worldId, prodId, take.id, shotId)}
              >
                Accept take
              </Button>
              <Button
                disabled={
                  Object.keys(take.provenance.sheets).length === 0 || decisions[take.id] === "rejected"
                }
                title="A rejection cites the sheet the take drifted from"
                onClick={() => {
                  const sheet = Object.keys(take.provenance.sheets)[0];
                  if (worldId && prodId && sheet)
                    rejectTake(
                      worldId,
                      prodId,
                      take.id,
                      { sheet, field: "appearance", note: "rejected in review" },
                      shotId ?? undefined,
                    );
                }}
              >
                Reject · cite the sheet
              </Button>
              <span className="fy-h1row__push" />
            </div>
          </>
        ) : (
          <EmptyState
            title="No takes for this shot yet"
            hint="Dispatch sends the shot out; takes land here for review."
          />
        )}
      </div>
      <div className="fy-gen__takes">
        <div className="fy-eyebrow-sm" style={{ textAlign: "center" }}>
          TAKES
        </div>
        {takes.map((t, i) => (
          <button
            key={t.id}
            type="button"
            className={cx("fy-taketile", take?.id === t.id && "fy-taketile--active")}
            onClick={() => setSelectedTakeId(t.id)}
          >
            <div className="fy-taketile__frame">
              <Portrait
                worldSlug={slug}
                path={takeMediaPath(production!, t) ?? ""}
                label={`take ${i + 1}`}
                radius={0}
              />
            </div>
            <div className="fy-taketile__meta">
              <span>{i + 1}</span>
              <span
                className={`fy-dot fy-dot--${decisionTone(decisions[t.id])}`}
                style={{ width: 5, height: 5 }}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One pass, said as the dispatch it is: route, what rides, length, price.
 *
 * Module-level and pure, so the line can be read back in a test rather than re-spelled there —
 * a second copy of this format would be a second answer to what the dispatch is.
 */
export function passRow(pass: CompiledPass): string {
  const route =
    pass.route.kind === "frame"
      ? "first-frame route"
      : pass.route.kind === "reference"
        ? `reference route · refs ×${pass.references.length} · ${carriedSubjects(pass.references)}`
        : "text route";
  const length = pass.askedSec !== undefined ? ` · ${seconds(pass.askedSec)}` : "";
  return `${route}${length} · ${usd(pass.estimatedMicroUsd)}`;
}

// ---- Stills contact sheet --------------------------------------------------

/**
 * Generate's second lens (design 55a): the frame/still takes as a set, decided one at a time.
 * This was a rail destination of its own; a take is decided where it was made, so the contact
 * sheet now lives inside the workspace and the seg is the way between the lenses.
 */
function ContactSheet({
  production,
  worldSlug,
  worldId,
  prodId,
  onShotLens,
}: {
  production: ReturnType<typeof useProduction>["production"];
  worldSlug: string | undefined;
  worldId: string | undefined;
  prodId: string | undefined;
  onShotLens: () => void;
}) {
  const stills = useMemo(
    () => production?.takes.filter((t) => t.kind === "frame" || t.kind === "still") ?? [],
    [production],
  );
  const decisions = production ? takeDecisions(production) : {};
  return (
    <div className="fy-prodmain" data-screen="stills-contact-sheet">
      <div className="fy-h1row">
        <span className="fy-seg">
          <button type="button" className="fy-seg__item" onClick={onShotLens}>
            Shot
          </button>
          <span className="fy-seg__item fy-seg__item--active">Contact sheet</span>
        </span>
        <span className="fy-h1row__meta">
          {stills.length} frame{stills.length === 1 ? "" : "s"}
        </span>
      </div>
      {stills.length === 0 ? (
        <EmptyState title="No stills yet" />
      ) : (
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}
        >
          {stills.map((take) => {
            const decision = decisions[take.id];
            const shotId = take.coversShots[0];
            const shot = production?.scenes.flatMap(orderedShots).find((candidate) => candidate.id === shotId);
            const title = shot?.title ?? "Unassigned frame";
            return (
              <div key={take.id} className="fy-shotcard">
                <div className="fy-shotcard__frame">
                  <Portrait
                    worldSlug={worldSlug}
                    path={takeMediaPath(production!, take) ?? ""}
                    label={title}
                    radius={0}
                  />
                </div>
                <div className="fy-shotcard__body">
                  <div className="fy-shotcard__head">
                    <span className="fy-shotcard__num">{shotId?.replace("sh_", "") ?? "—"}</span>
                    <span className="fy-shotcard__title" title={take.media ?? take.id}>{title}</span>
                    <span className={`fy-dot fy-dot--${decisionTone(decision)}`} />
                  </div>
                  <span className="fy-mono">
                    {take.model}
                    {decision && decision !== "pending" ? ` · ${decision}` : " · unreviewed"}
                  </span>
                  <div className="fy-shotcard__spacer" />
                  <div className="fy-shotcard__actions">
                    <Button
                      variant={decision === "accepted" ? "primary" : "ghost"}
                      disabled={!shotId || decision === "accepted"}
                      onClick={() => {
                        // Accept = decision + selection in one commit (SPEC-013 R-9).
                        if (worldId && prodId && shotId) acceptTake(worldId, prodId, take.id, shotId);
                      }}
                    >
                      {decision === "accepted" ? "Accepted" : "Accept"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={Object.keys(take.provenance.sheets).length === 0}
                      title="A rejection cites the sheet the take drifted from (R-10)"
                      onClick={() => {
                        const sheet = Object.keys(take.provenance.sheets)[0];
                        if (worldId && prodId && sheet)
                          rejectTake(
                            worldId,
                            prodId,
                            take.id,
                            { sheet, field: "appearance", note: "rejected from the contact sheet" },
                            shotId,
                          );
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
