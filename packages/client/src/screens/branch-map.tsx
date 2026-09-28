import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useParams } from "react-router";
import {
  DEFAULT_SHOT_SEC,
  beatPictureShotId,
  deriveCut,
  layoutRouting,
  orderedShots,
  playbackWindow,
  playerBeats,
  productionShape,
  routingFindings,
  sceneBeats,
  type ArtifactSidecar,
  type CutEntry,
  type InteractivePlayerBeat,
  type InteractivePlayerClip,
  type InteractivePlayerOptions,
  type ProductionBundle,
  type RoutingCommand,
  type RoutingFinding,
  type Sheet,
} from "@arke-studio/contracts";
import { ProductionConversation } from "../components/conversation.js";
import { InteractivePlayerView } from "../components/interactive-player.js";
import { useMediaQuery } from "../lib/media-query.js";
import { Expand, EyeOff, Flag, Minus, Play, Plus, Trash, TriangleAlert, X } from "../components/icons.js";
import { EmptyState, Screen } from "../components/layout.js";
import { Button, Input, Select, Switch, cx } from "../components/ui.js";
import {
  choiceIdFor,
  findingCounts,
  findingRows,
  fitScale,
  mapGeometry,
  outPort,
  inPort,
  removalConsequences,
  unwalkedChoices,
  type FindingRow,
  type PlacedNode,
} from "../lib/branch-map.js";
import { mediaUrl } from "../lib/media.js";
import { mediaTakeFor, useProduction } from "../lib/selectors.js";
import {
  exportInteractive,
  listRoutingFindings,
  recordTraversal,
  sendRoutingCommand,
  subscribeInteractiveExports,
  subscribeRoutingFindings,
} from "../lib/store.js";
import { shotFramePath } from "./scene-workspace/boards.js";
import { useProductionVoiceFiles } from "./scene-workspace/table-read.js";

/**
 * The branch map (design turn 157; epic 401, brief §3–§4): Interactive video's structural
 * authority, drawn as a canvas of the routing file. Cards sit where `layoutRouting` puts them —
 * the same graph always draws the same picture, and nothing can be dragged somewhere it will not
 * stay. Choices are curves between them, dashed until someone walks them in preview. The findings
 * are counted in the header and listed only when the count is pressed (turn 122: a decision is
 * made where it is drawn). Every edit is a closed routing command applied to the file on disk.
 */

type Selection =
  | { kind: "findings" }
  | { kind: "scene"; id: string; excluding?: boolean }
  | { kind: "choice"; id: string; removing?: boolean }
  | { kind: "new"; from: string | null; to: string | null }
  | null;

type View = { x: number; y: number; k: number };

function safeShots(scene: ProductionBundle["scenes"][number]) {
  try {
    return orderedShots(scene);
  } catch {
    // A scene whose flow does not read is still a place on the map; it just has no picture.
    return [];
  }
}

function sceneLength(scene: ProductionBundle["scenes"][number], beats = false): string {
  // A visual novel's scene has no running time — it is read — so it counts its beats (turn 174).
  if (beats) {
    let count = 0;
    try { count = sceneBeats(scene).length; } catch { count = 0; }
    return count > 0 ? `${count} beat${count === 1 ? "" : "s"}` : "";
  }
  const total = Math.round(safeShots(scene).reduce((sum, shot) => sum + (shot.durationSec ?? DEFAULT_SHOT_SEC), 0));
  return total > 0 ? `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}` : "";
}

/**
 * The scene's own frame: the first shot that has one, as the rows and the Flow show it. A visual
 * novel's shot shows the picture its beat shows — a kept one is the shot's before, never its own
 * unused frame, which would put art on the map the story never shows (codex round 8).
 */
export function sceneFrame(production: ProductionBundle, artifacts: readonly ArtifactSidecar[], slug: string, scene: ProductionBundle["scenes"][number]) {
  const shots = safeShots(scene);
  const beats = productionShape(production.meta).playsAsBeats;
  for (const shot of shots) {
    const { path } = shotFramePath(production, artifacts, beats ? beatPictureShotId(shots, shot.id) : shot.id);
    if (path !== null) return mediaUrl(slug, path);
  }
  return null;
}

/**
 * A visual novel's scene for the preview (turn 174): its beats, each with its picture (kept from
 * the shot before where the beat asks), its line under its speaker's name, and its voice where the
 * table read has one. The export builds the same beats through the same `playerBeats`.
 */
export function scenePlayerBeats(
  production: ProductionBundle,
  artifacts: readonly ArtifactSidecar[],
  sheets: readonly Pick<Sheet, "id" | "name">[],
  slug: string,
  scene: ProductionBundle["scenes"][number],
  voices: ReadonlyMap<string, string>,
): InteractivePlayerBeat[] {
  try {
    return playerBeats(scene, {
      picture: (shotId) => {
        const { path } = shotFramePath(production, artifacts, shotId);
        return path === null ? undefined : mediaUrl(slug, path);
      },
      audio: (lineId) => {
        const file = voices.get(lineId);
        return file === undefined ? undefined : mediaUrl(slug, file);
      },
      speakerName: (id) => sheets.find((sheet) => sheet.id === id)?.name ?? id,
    });
  } catch {
    // A scene whose flow does not read has no beats; the player shows it as a slate.
    return [];
  }
}

/**
 * A visual novel's preview options (turn 174), from the branch map or from a scene's Preview tab:
 * every scene as beats, the routing's choices and endings, and the author's strip. Built once for
 * both, so the two previews cannot read the production differently.
 */
export function beatPreviewOptions({
  world,
  production,
  voices,
  from,
  at,
  unwalked,
  onChoice,
  onBranchMap,
  onClose,
}: {
  world: { meta: { name: string; slug: string }; artifacts: readonly ArtifactSidecar[]; sheets: readonly Pick<Sheet, "id" | "name">[] };
  production: ProductionBundle;
  voices: ReadonlyMap<string, string>;
  from: string;
  /** The beat of `from` to begin on; its first when absent. */
  at?: number;
  unwalked: readonly string[];
  onChoice: NonNullable<NonNullable<InteractivePlayerOptions["author"]>["onChoice"]>;
  onBranchMap?: () => void;
  onClose: () => void;
}): InteractivePlayerOptions {
  const routing = production.routing;
  return {
    title: production.meta.title,
    eyebrow: world.meta.name,
    // A production not yet routed still previews its scene: the scene is its own start.
    start: routing?.start ?? from,
    from,
    ...(at !== undefined && at > 0 ? { at } : {}),
    autoplay: true,
    scenes: Object.fromEntries(
      production.scenes.map((scene) => [scene.id, { title: scene.title, beats: scenePlayerBeats(production, world.artifacts, world.sheets, world.meta.slug, scene, voices) }]),
    ),
    choices: routing?.choices ?? [],
    endings: routing?.endings ?? [],
    storageKey: null,
    author: { unwalked: [...unwalked], onChoice, ...(onBranchMap ? { onBranchMap } : {}), onClose },
  };
}

/**
 * A scene's cut for the preview: each shot as the cut plays it — a pass segment's range, a trim's
 * in-point, the shot's slot — rather than the whole file its take sits in, which started a trimmed
 * take at zero and, for a pass with one shot replaced, played the replaced footage before the
 * replacement. A shot the cut leaves without media but whose accepted take covers several shots
 * whole (a pass without segments, which the export ships as the scene's one file) plays that file
 * once. The preview plays what there is; a scene with nothing is a slate.
 */
export function sceneClips(
  production: ProductionBundle,
  slug: string,
  scene: ProductionBundle["scenes"][number],
  cut: ReadonlyMap<string, CutEntry>,
): InteractivePlayerClip[] {
  const clips: InteractivePlayerClip[] = [];
  // A covering pass plays once in the scene, even when a replacement sits between shots it still
  // covers: a second time replayed everything, the superseded footage included.
  const whole = new Set<string>();
  for (const shot of safeShots(scene)) {
    const entry = cut.get(shot.id);
    const played = entry ? playbackWindow(entry) : null;
    if (entry?.media && played) {
      clips.push({ src: mediaUrl(slug, entry.media.path), ...played });
      continue;
    }
    // Only a pass accepted whole, over several shots, is outside the cut and plays as it is.
    // Anything else the cut leaves without media — trimmed past its end — plays as a slate, as
    // the export refuses it: resolved back to its file, it played the footage the trim cut.
    const takeId = production.selections[shot.id]?.acceptedTakeId ?? null;
    const take = takeId === null ? undefined : production.takes.find((candidate) => candidate.id === takeId);
    if (take === undefined || take.segment !== undefined || take.coversShots.length < 2) continue;
    const media = mediaTakeFor(production, take);
    if (media === null || media.kind !== "clip" || whole.has(media.id)) continue;
    whole.add(media.id);
    clips.push({ src: mediaUrl(slug, `productions/${production.meta.id}/takes/${media.id}/${media.media}`) });
  }
  return clips;
}

export function BranchMapScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const [served, setServed] = useState<RoutingFinding[] | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  /** The preview running over the window (turn 156g), from the scene it started at. */
  const [preview, setPreview] = useState<{ from: string; at: number } | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set());
  /** The one option the map keeps in the tab order; the arrows move it (brief §3, IV-M2). */
  const [focused, setFocused] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [drawing, setDrawing] = useState<{ from: string; x: number; y: number } | null>(null);
  /** Below 900 wide the map is a list (157i): a canvas that narrow is a sliver to pan about in. */
  const narrow = useMediaQuery("(max-width: 899px)");
  /** A selected choice's arrowhead being dragged to another scene (157d). */
  const [retarget, setRetarget] = useState<{ id: string; x: number; y: number } | null>(null);
  const [startPick, setStartPick] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** The grab cursor, as state: read off the ref, it stayed after a drag until something else rendered. */
  const [panning, setPanning] = useState(false);

  useEffect(() => {
    if (!worldId || !prodId) return;
    // A fresh production starts from nothing: keeping the previous production's findings,
    // export note and preview showed A's state gating B until B's first event arrived.
    setServed(null);
    setExportNote(null);
    setPreview(null);
    setSelection(null);
    setHighlight(new Set());
    fittedRef.current = false;
    const offFindings = subscribeRoutingFindings((event) => {
      if (event.productionId === prodId) setServed(event.findings);
    });
    const offExports = subscribeInteractiveExports((event) => {
      if (event.productionId !== prodId) return;
      setExportNote(
        event.disposition === "exported"
          ? `Exported to ${event.dir} — open player.html anywhere, even from a file.`
          : `Export refused: ${(event.blockers ?? []).join(" · ")}`,
      );
    });
    listRoutingFindings(worldId, prodId);
    return () => {
      offFindings();
      offExports();
    };
  }, [worldId, prodId]);

  const routing = production?.routing ?? null;
  const scenes = useMemo(() => production?.scenes ?? [], [production]);
  /*
   * Served findings describe the routing they were folded from. A routing changed by another way
   * in (world chat's production-routing action refreshes the world, not the findings) would leave
   * the header counting the old graph, so a new version drops them back to the local fold and asks
   * the coordinator again.
   */
  const routingVersion = routing?.version ?? null;
  const seenVersion = useRef<number | null>(null);
  useEffect(() => {
    if (routingVersion === null || !worldId || !prodId) return;
    if (seenVersion.current !== null && seenVersion.current !== routingVersion) {
      setServed(null);
      listRoutingFindings(worldId, prodId);
    }
    seenVersion.current = routingVersion;
  }, [routingVersion, worldId, prodId]);
  // The findings the server folded (traversal evidence included) win; until they arrive, the
  // same pure fold runs here without evidence, so the map never renders beside a blank count.
  const findings = useMemo<RoutingFinding[]>(() => {
    if (served !== null) return served;
    if (!routing) return [];
    return routingFindings(routing, scenes, []);
  }, [served, routing, scenes]);
  const layout = useMemo(() => (routing ? layoutRouting(routing, scenes) : null), [routing, scenes]);
  const geometry = useMemo(() => (routing && layout ? mapGeometry(routing, scenes, layout) : null), [routing, scenes, layout]);

  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !geometry) return;
    const k = fitScale(geometry.width, geometry.height, el.clientWidth, el.clientHeight);
    setView({ k, x: Math.max(16, (el.clientWidth - geometry.width * k) / 2), y: Math.max(16, (el.clientHeight - geometry.height * k) / 2) });
  }, [geometry]);

  // Opens fitted to the window (turn 157), once per production; after that the view is the person's.
  // Only once there is a canvas to fit: opened narrow, the list shows and nothing is fitted, and a
  // window widened afterwards found the map at actual size, mostly off screen.
  useEffect(() => {
    if (fittedRef.current || !geometry || narrow || !viewportRef.current) return;
    fittedRef.current = true;
    fit();
  }, [geometry, fit, narrow]);

  const zoomBy = useCallback((factor: number, about?: { x: number; y: number }) => {
    setView((v) => {
      const k = Math.min(2, Math.max(0.2, v.k * factor));
      const el = viewportRef.current;
      const cx = about?.x ?? (el ? el.clientWidth / 2 : 0);
      const cy = about?.y ?? (el ? el.clientHeight / 2 : 0);
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  }, []);

  // Wheel pans; with Ctrl or Cmd it zooms about the pointer. Native and non-passive, because a
  // passive listener cannot stop Electron zooming the whole window on Ctrl+wheel.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = el.getBoundingClientRect();
        zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      } else {
        setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // `narrow`: the canvas unmounts for the list and remounts after, and a listener left on the
    // viewport that was, or never added to one that was not there yet, made the wheel do nothing.
  }, [zoomBy, geometry !== null, narrow]);

  // A visual novel's preview reads its lines in their voices (turn 174): every scene's prepared
  // voices are asked for as the preview opens, and it mounts once they are in.
  const playsAsBeats = production ? productionShape(production.meta).playsAsBeats : false;
  const previewVoices = useProductionVoiceFiles({
    worldId,
    productionId: prodId,
    sceneIds: playsAsBeats ? scenes.map((scene) => scene.id) : [],
    key: playsAsBeats && preview !== null ? preview.at : null,
  });

  if (!world || !production) {
    return (
      <Screen id="branch-map">
        <EmptyState title="Opening production…" />
      </Screen>
    );
  }
  if (!productionShape(production.meta).isBranching) {
    // A linear season never shows a branch map (turn 78): the address answers with the rule.
    return (
      <Screen id="branch-map">
        <EmptyState title="This production is linear" hint="Boards and explicit order are its structure." />
      </Screen>
    );
  }

  const titleOf = (id: string) => scenes.find((scene) => scene.id === id)?.title ?? id;
  const labelOf = (id: string) => routing?.choices.find((choice) => choice.id === id)?.label ?? id;
  const command = (next: RoutingCommand) => worldId && prodId && sendRoutingCommand(worldId, prodId, next);
  const rows = findingRows(findings, titleOf, labelOf);
  const counts = findingCounts(findings);
  const blockers = findings.filter((finding) => finding.severity === "blocks");
  const frameOf = (id: string) => {
    const scene = scenes.find((candidate) => candidate.id === id);
    return scene ? sceneFrame(production, world.artifacts, world.meta.slug, scene) : null;
  };

  const header = (
    <header className="bm-head">
      <div className="bm-head__title">
        <h1 className="bm-h1">Branch map</h1>
        <div className="bm-head__meta">
          {scenes.length} scene{scenes.length === 1 ? "" : "s"}
          {routing
            ? ` · ${routing.choices.length} choice${routing.choices.length === 1 ? "" : "s"} · ${routing.endings.length} ending${routing.endings.length === 1 ? "" : "s"} · v${routing.version}`
            : " · no routing yet"}
        </div>
      </div>
      {routing && (
        <button
          type="button"
          className={cx("bm-count", selection?.kind === "findings" && "bm-count--on")}
          aria-pressed={selection?.kind === "findings"}
          aria-label={`Findings: ${counts.blocks} block, ${counts.warns} warn`}
          onClick={() => {
            setSelection(selection?.kind === "findings" ? null : { kind: "findings" });
            setHighlight(new Set());
          }}
        >
          {rows.length === 0 ? (
            "No findings"
          ) : (
            <>
              <span className="bm-dot bm-dot--blocks" />
              {counts.blocks} block
              <span className="bm-dot bm-dot--warns" />
              {counts.warns} warn
            </>
          )}
        </button>
      )}
      <Button disabled={!routing} onClick={() => routing && setPreview({ from: routing.start, at: Date.now() })}>
        <Play size={12} />
        Preview
      </Button>
      <Button
        variant="primary"
        disabled={!routing || blockers.length > 0}
        onClick={() => worldId && prodId && exportInteractive(worldId, prodId)}
      >
        {routing && blockers.length > 0 ? `Export blocked · ${blockers.length}` : "Export web package"}
      </Button>
    </header>
  );

  const arke = (
    <ProductionConversation
      worldId={worldId}
      productionId={prodId}
      dock={{ title: "Arke", subject: `${production.meta.title} · branch map` }}
      openingNote="opening…"
      emptyLine="Ask about a route, or have Arke draw one."
      placeholder="Ask Arke about this map…"
    />
  );

  if (scenes.length === 0 || routing === null || geometry === null || layout === null) {
    const picked = scenes.find((scene) => scene.id === startPick) ?? scenes[0];
    return (
      <div className="fy-arkewrap bm" data-screen="branch-map" data-narrow={narrow ? "true" : undefined}>
        <div className="bm-main">
          {header}
          <div className="bm-viewport bm-viewport--empty">
            {scenes.length === 0 ? (
              <EmptyState title="No scenes yet" hint="Write the first scene; the map draws from scenes." />
            ) : (
              <div className="bm-dayone">
                <div className="bm-dayone__title">Draw the first choice from the start scene</div>
                <div className="bm-dayone__ask">Where does it start?</div>
                <div className="bm-dayone__scenes" role="radiogroup" aria-label="Start scene">
                  {scenes.map((scene) => {
                    const frame = sceneFrame(production, world.artifacts, world.meta.slug, scene);
                    const on = scene.id === picked?.id;
                    return (
                      <button
                        key={scene.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        className={cx("bm-dayone__scene", on && "bm-dayone__scene--on")}
                        onClick={() => setStartPick(scene.id)}
                      >
                        <span className="bm-thumb">{frame ? <img src={frame} alt="" /> : <span className="bm-thumb__none">{scene.number}</span>}</span>
                        <span className="bm-dayone__name">{scene.title}</span>
                      </button>
                    );
                  })}
                </div>
                <Button variant="primary" onClick={() => picked && command({ operation: "set-start", sceneId: picked.id })}>
                  Start at {picked?.title}
                </Button>
              </div>
            )}
          </div>
        </div>
        <aside className="bm-side">{arke}</aside>
      </div>
    );
  }

  const endings = new Map(routing.endings.map((entry) => [entry.sceneId, entry.title]));
  const excluded = new Map(routing.excluded.map((entry) => [entry.sceneId, entry.reason]));
  const unwalked = unwalkedChoices(findings);
  const twoWaysIn = new Set(findings.filter((finding) => finding.kind === "reconvergence").flatMap((finding) => finding.sceneIds));
  const unreachable = new Set(findings.filter((finding) => finding.kind === "unreachable").flatMap((finding) => finding.sceneIds));

  // The tray under the map: scenes on no route, placed by the geometry in a row under the cards,
  // so its width is in the map's bounds and a fit holds it.
  const stageWidth = geometry.width;
  const at = new Map([...geometry.nodes, ...geometry.trayNodes].map((node) => [node.id, node]));

  /*
   * The map in one flat order: layers left to right, each layer top to bottom, the tray last —
   * exactly the order the layout draws and the DOM renders, so the keyboard walks the picture
   * rather than a second opinion about it (brief §3, IV-M2).
   */
  const walkOrder = [...layout.layers.flat(), ...geometry.tray];
  /*
   * The keyboard's walk: the cards in that order, then the choices in the order they are drawn
   * (turn 157 — every node and edge reachable in layout order). One tab stop for all of it; a
   * choice's key is `c:` and a scene's `s:`, so the two can share one roving stop.
   */
  const walk = [...walkOrder.map((id) => `s:${id}`), ...geometry.edges.map((edge) => `c:${edge.id}`)];
  // Before anybody has moved, the tab stop is the first option — the start scene's layer. A
  // `focused` that no longer exists (a scene or choice was removed under it) falls back the same way.
  const tabStop = focused !== null && walk.includes(focused) ? focused : walk[0];

  const selectedChoice = selection?.kind === "choice" ? routing.choices.find((choice) => choice.id === selection.id) ?? null : null;
  const consequences =
    selection?.kind === "choice" && selection.removing && selectedChoice
      ? removalConsequences(routing, scenes, selectedChoice.id, titleOf)
      : [];
  const breaking = new Set(
    selection?.kind === "choice" && selection.removing && selectedChoice
      ? routingFindings({ ...routing, choices: routing.choices.filter((choice) => choice.id !== selectedChoice.id) }, scenes)
          .filter((finding) => finding.kind === "unreachable" || finding.kind === "cannot-reach-ending")
          .flatMap((finding) => finding.sceneIds)
          .filter((id) => !findings.some((finding) => (finding.kind === "unreachable" || finding.kind === "cannot-reach-ending") && finding.sceneIds.includes(id)))
      : [],
  );

  const stagePoint = (clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return rect ? { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k } : { x: 0, y: 0 };
  };

  const startDraw = (sceneId: string) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = stagePoint(event.clientX, event.clientY);
    setDrawing({ from: sceneId, ...p });
  };
  const moveDraw = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!drawing) return;
    setDrawing({ ...drawing, ...stagePoint(event.clientX, event.clientY) });
  };
  const endDraw = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!drawing) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-scene]")?.dataset["scene"];
    const from = drawing.from;
    setDrawing(null);
    // Dropped on a card, the new edge asks for its words (157c); dropped anywhere else, it is gone.
    if (target !== undefined && target !== from) setSelection({ kind: "new", from, to: target });
  };

  // The selected choice's arrowhead is a handle (157d): dragged to another card, the choice goes
  // there instead, as one edit-choice; dropped anywhere else, nothing changes. The Inspector's
  // "Goes to" is the same edit without a pointer.
  const startRetarget = (id: string) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setRetarget({ id, ...stagePoint(event.clientX, event.clientY) });
  };
  const moveRetarget = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!retarget) return;
    setRetarget({ ...retarget, ...stagePoint(event.clientX, event.clientY) });
  };
  const endRetarget = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!retarget) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-scene]")?.dataset["scene"];
    const choice = routing?.choices.find((candidate) => candidate.id === retarget.id);
    setRetarget(null);
    if (choice && target !== undefined && target !== choice.to) {
      command({ operation: "edit-choice", choiceId: choice.id, changes: { to: target } });
    }
  };

  const onViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-scene], .bm-label, .bm-zoom, button, input, select")) return;
    panRef.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onViewportPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    setView((v) => ({ ...v, x: pan.vx + event.clientX - pan.x, y: pan.vy + event.clientY - pan.y }));
  };
  const onViewportPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    panRef.current = null;
    setPanning(false);
    // A press on the empty canvas that did not move is a click on nothing: the selection goes.
    if (pan && Math.abs(event.clientX - pan.x) < 3 && Math.abs(event.clientY - pan.y) < 3) {
      setSelection(null);
      setHighlight(new Set());
    }
  };

  const walkKeys = (key: string) => (event: ReactKeyboardEvent<HTMLElement>) => {
    const isChoice = key.startsWith("c:");
    const id = key.slice(2);
    const choice = isChoice ? routing.choices.find((candidate) => candidate.id === id) : undefined;
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    let next: string | undefined;
    if (step !== 0) {
      // Clamped, not wrapped: an arrow at the end of a graph should feel like the end of the graph.
      const index = walk.indexOf(key);
      next = walk[Math.min(walk.length - 1, Math.max(0, index + step))];
    } else if (event.key === "Home") next = walk[0];
    else if (event.key === "End") next = walk[walk.length - 1];
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelection(isChoice ? { kind: "choice", id } : { kind: "scene", id });
      return;
    } else if ((event.key === "Delete" || event.key === "Backspace") && isChoice) {
      // Delete on a focused choice asks first, naming what breaks (157e).
      event.preventDefault();
      setSelection({ kind: "choice", id, removing: true });
      return;
    } else if (event.key === "p" || event.key === "P") {
      event.preventDefault();
      setPreview({ from: choice ? choice.from : id, at: Date.now() });
      return;
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(1.2);
      return;
    } else if (event.key === "-") {
      event.preventDefault();
      zoomBy(1 / 1.2);
      return;
    } else if (event.key === "0") {
      event.preventDefault();
      fit();
      return;
    } else if (event.key === "Escape") {
      setSelection(null);
      return;
    }
    if (next === undefined || next === key) return;
    event.preventDefault();
    setFocused(next);
    const el = viewportRef.current?.querySelector(`[data-walk="${CSS.escape(next)}"]`);
    if (el instanceof HTMLElement) el.focus();
  };

  /** Back from the removal question to the choice it was about, focus included. */
  const cancelRemoval = (id: string) => {
    setSelection({ kind: "choice", id });
    // The choice's label on the canvas, or its row in the narrow list — whichever is showing.
    const label =
      [...(viewportRef.current?.querySelectorAll<HTMLElement>("[data-walk]") ?? [])].find((el) => el.getAttribute("data-walk") === `c:${id}`) ??
      [...(listRef.current?.querySelectorAll<HTMLElement>("[data-choice-row]") ?? [])].find((el) => el.getAttribute("data-choice-row") === id);
    label?.focus();
  };

  const card = (node: PlacedNode, inTray: boolean) => {
    const scene = scenes.find((candidate) => candidate.id === node.id);
    const title = scene?.title ?? node.id;
    const frame = frameOf(node.id);
    const out = routing.choices.filter((choice) => choice.from === node.id).length;
    const isStart = routing.start === node.id;
    const ending = endings.get(node.id);
    const reason = excluded.get(node.id);
    const isSelected = selection?.kind === "scene" && selection.id === node.id;
    const into = routing.choices.filter((choice) => choice.to === node.id).length;
    // Said as the brief asks: the title, its designations, and the choices in and out (§3).
    const spoken = [
      title,
      isStart ? "start" : null,
      ending !== undefined ? `ending, ${ending}` : null,
      reason !== undefined ? `excluded, ${reason}` : null,
      unreachable.has(node.id) && reason === undefined ? "unreachable" : null,
      `${into} choice${into === 1 ? "" : "s"} in`,
      `${out} out`,
    ].filter(Boolean).join(", ");
    const showPort =
      !inTray && (isSelected || drawing?.from === node.id || (selection?.kind === "new" && selection.from === node.id));
    return (
      <div
        key={node.id}
        role="option"
        aria-label={spoken}
        aria-selected={isSelected}
        data-scene={node.id}
        /*
         * One stop for the whole map, and the arrows move within it (IV-M2). Every option carrying
         * tabIndex={0} put a fifty-node graph fifty presses deep in the page's tab order, which is
         * what a listbox exists to avoid: Tab reaches the map, the arrows walk it, Home and End
         * jump to the start and the last.
         */
        data-walk={`s:${node.id}`}
        tabIndex={`s:${node.id}` === tabStop ? 0 : -1}
        onFocus={() => setFocused(`s:${node.id}`)}
        onKeyDown={walkKeys(`s:${node.id}`)}
        onClick={() => {
          setSelection({ kind: "scene", id: node.id });
          setHighlight(new Set());
        }}
        className={cx(
          "bm-node",
          isStart && "bm-node--start",
          isSelected && "bm-node--selected",
          reason !== undefined && "bm-node--excluded",
          unreachable.has(node.id) && "bm-node--bad",
          (highlight.has(node.id) || breaking.has(node.id)) && "bm-node--lit",
          selection?.kind === "new" && selection.to === node.id && "bm-node--target",
        )}
        style={{ left: node.x, top: node.y }}
      >
        {/* Designations are words on the card, drawn as tags (turn 53; IV-M3). */}
        <span className="bm-tags">
          {isStart && <span className="bm-tag bm-tag--solid"><Play size={9} />start</span>}
          {ending !== undefined && <span className="bm-tag"><Flag size={10} />ending</span>}
          {reason !== undefined && <span className="bm-tag"><EyeOff size={10} />excluded</span>}
          {unreachable.has(node.id) && reason === undefined && <span className="bm-tag bm-tag--bad">unreachable</span>}
        </span>
        <span className="bm-thumb">{frame ? <img src={frame} alt="" draggable={false} /> : <span className="bm-thumb__none">{scene?.number ?? ""}</span>}</span>
        <span className="bm-node__body">
          <span className="bm-node__title">{title}</span>
          <span className="bm-node__meta">
            {reason !== undefined ? (
              <i>{reason}</i>
            ) : ending !== undefined ? (
              <>
                <Flag size={11} />
                {ending}
              </>
            ) : (
              [scene ? sceneLength(scene, playsAsBeats) : "", out > 0 ? `${out} out` : unreachable.has(node.id) ? "no way in" : ""].filter(Boolean).join(" · ")
            )}
            {twoWaysIn.has(node.id) && (
              <span className="bm-node__warn" title="Two ways in">
                <TriangleAlert size={11} />
              </span>
            )}
          </span>
        </span>
        {!inTray && (
          <span
            className={cx("bm-port", showPort && "bm-port--on")}
            aria-hidden
            title="Drag to another scene to draw a choice"
            onPointerDown={startDraw(node.id)}
            onPointerMove={moveDraw}
            onPointerUp={endDraw}
            // The click that follows a drag from the port would reach the card and select the
            // scene, closing the New choice panel the drop had just opened.
            onClick={(event) => event.stopPropagation()}
          />
        )}
      </div>
    );
  };

  const pending =
    selection?.kind === "new" && selection.from !== null && selection.to !== null && at.has(selection.from) && at.has(selection.to)
      ? { from: at.get(selection.from)!, to: at.get(selection.to)! }
      : null;

  /*
   * The narrow map (157i): the same data in the same order — layers top to bottom, each scene with
   * its choices as "goes to" rows, dashed where nobody has walked them, then the scenes on no
   * route — with nothing to scroll sideways. A row selects what it names, and the Inspector above
   * the list edits it, the same as on the canvas.
   */
  const list = (
    <div className="bm-list" aria-label="Branch map" ref={listRef}>
      {[...layout.layers, geometry.tray].map((ids, index) =>
        ids.length === 0 ? null : (
          <section key={index} className="bm-list__layer">
            <span className="bm-eyebrow">{index === layout.layers.length ? `Not on a route · ${ids.length}` : `Layer ${index + 1}`}</span>
            {ids.map((id) => (
              <div key={id} className="bm-list__scene">
                <button
                  type="button"
                  className={cx("bm-row", selection?.kind === "scene" && selection.id === id && "bm-row--selected")}
                  onClick={() => setSelection({ kind: "scene", id })}
                >
                  <span className="bm-row__title">{titleOf(id)}</span>
                  {routing.start === id && <span className="bm-tag bm-tag--solid">start</span>}
                  {endings.has(id) && <span className="bm-tag">ending</span>}
                  {excluded.has(id) && <span className="bm-tag">excluded</span>}
                  {unreachable.has(id) && !excluded.has(id) && <span className="bm-tag bm-tag--bad">unreachable</span>}
                </button>
                {routing.choices
                  .filter((choice) => choice.from === id)
                  .map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      data-choice-row={choice.id}
                      className={cx(
                        "bm-goes",
                        unwalked.has(choice.id) && "bm-goes--unwalked",
                        selectedChoice?.id === choice.id && "bm-goes--selected",
                      )}
                      aria-label={`${choice.label}: goes to ${titleOf(choice.to)}${unwalked.has(choice.id) ? ", not walked" : ""}`}
                      onClick={() => setSelection({ kind: "choice", id: choice.id })}
                    >
                      <span className="bm-goes__label">{choice.label}</span>
                      <span className="bm-muted">goes to</span>
                      <span className="bm-goes__to">{titleOf(choice.to)}</span>
                    </button>
                  ))}
              </div>
            ))}
          </section>
        ),
      )}
    </div>
  );

  const canvas = (
    <div
      className={cx("bm-viewport", panning && "bm-viewport--panning")}
      ref={viewportRef}
      onPointerDown={onViewportPointerDown}
      onPointerMove={onViewportPointerMove}
      onPointerUp={onViewportPointerUp}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setSelection(null);
          setDrawing(null);
        }
      }}
    >
      <div
        className="bm-stage"
        style={{ width: stageWidth, height: geometry.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        {geometry.tray.length > 0 && (
          <div className="bm-tray" style={{ top: geometry.trayY, width: stageWidth - 48 }} aria-hidden>
            <span className="bm-eyebrow">Not on a route · {geometry.tray.length}</span>
          </div>
        )}
        <svg className="bm-edges" width={stageWidth} height={geometry.height} aria-hidden>
          <defs>
            <marker id="bm-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" className="bm-arrowhead" />
            </marker>
          </defs>
          {geometry.edges.map((edge) => (
            <path
              key={edge.id}
              d={edge.d}
              markerEnd="url(#bm-arrow)"
              className={cx(
                "bm-edge",
                unwalked.has(edge.id) && "bm-edge--unwalked",
                selectedChoice?.id === edge.id && "bm-edge--selected",
                selection?.kind === "choice" && selection.removing && selectedChoice?.id !== edge.id && breaking.has(edge.from) && "bm-edge--faint",
              )}
            />
          ))}
          {pending && (
            <path
              className="bm-edge bm-edge--new"
              markerEnd="url(#bm-arrow)"
              d={`M${outPort(pending.from).x},${outPort(pending.from).y} C${outPort(pending.from).x + 70},${outPort(pending.from).y} ${inPort(pending.to).x - 70},${inPort(pending.to).y} ${inPort(pending.to).x - 6},${inPort(pending.to).y}`}
            />
          )}
          {drawing && at.has(drawing.from) && (
            <path
              className="bm-edge bm-edge--ghost"
              d={`M${outPort(at.get(drawing.from)!).x},${outPort(at.get(drawing.from)!).y} L${drawing.x},${drawing.y}`}
            />
          )}
          {retarget && selectedChoice && at.has(selectedChoice.from) && (
            <path
              className="bm-edge bm-edge--ghost"
              d={`M${outPort(at.get(selectedChoice.from)!).x},${outPort(at.get(selectedChoice.from)!).y} L${retarget.x},${retarget.y}`}
            />
          )}
        </svg>
        {geometry.edges.map((edge) => (
          <button
            key={edge.id}
            type="button"
            data-walk={`c:${edge.id}`}
            tabIndex={`c:${edge.id}` === tabStop ? 0 : -1}
            onFocus={() => setFocused(`c:${edge.id}`)}
            onKeyDown={walkKeys(`c:${edge.id}`)}
            className={cx(
              "bm-label",
              unwalked.has(edge.id) && "bm-label--unwalked",
              selectedChoice?.id === edge.id && "bm-label--selected",
            )}
            style={{ left: edge.lx, top: edge.ly }}
            aria-label={`${edge.label}: ${titleOf(edge.from)} to ${titleOf(edge.to)}${unwalked.has(edge.id) ? ", not walked" : ""}`}
            onClick={() => {
              setSelection({ kind: "choice", id: edge.id });
              setHighlight(new Set());
            }}
          >
            {edge.label}
          </button>
        ))}
        {selectedChoice && !(selection?.kind === "choice" && selection.removing) && at.has(selectedChoice.to) && (
          <span
            className="bm-handle"
            aria-hidden
            title="Drag to another scene to send this choice there"
            style={{ left: inPort(at.get(selectedChoice.to)!).x - 6, top: inPort(at.get(selectedChoice.to)!).y }}
            onPointerDown={startRetarget(selectedChoice.id)}
            onPointerMove={moveRetarget}
            onPointerUp={endRetarget}
            onClick={(event) => event.stopPropagation()}
          />
        )}
        <div role="listbox" aria-label="Branch map" className="bm-nodes">
          {walkOrder.map((id) => {
            const node = at.get(id);
            return node ? card(node, geometry.tray.includes(id)) : null;
          })}
        </div>
      </div>
      <div className="bm-legend" aria-hidden>
        <span><i className="bm-legend__line" />walked in preview</span>
        <span><i className="bm-legend__line bm-legend__line--dashed" />not walked</span>
      </div>
      <div className="bm-zoom">
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}><Minus size={14} /></button>
        <span className="bm-zoom__pct">{Math.round(view.k * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.2)}><Plus size={14} /></button>
        <button type="button" aria-label="Fit to view" onClick={fit}><Expand size={13} />Fit</button>
      </div>
    </div>
  );

  const sceneOptions = scenes.map((scene) => (
    <option key={scene.id} value={scene.id}>
      {scene.title}
    </option>
  ));

  const inspector = (() => {
    if (selection === null) return null;
    if (selection.kind === "findings") {
      return (
        <Inspector title="Findings" sub={String(counts.blocks + counts.warns)} onClose={() => setSelection(null)}>
          {rows.length === 0 && <div className="bm-muted">Nothing to report — every check passed.</div>}
          {(["blocks", "warns"] as const).map((severity) => {
            const list = rows.filter((row) => row.severity === severity);
            if (list.length === 0) return null;
            return (
              <div key={severity} className="bm-findgroup">
                <span className="bm-eyebrow">{severity === "blocks" ? `Blocks export · ${counts.blocks}` : `Warns · ${counts.warns}`}</span>
                {list.map((row) => (
                  <FindingCard
                    key={row.key}
                    row={row}
                    lit={row.sceneIds.length > 0 && row.sceneIds.every((id) => highlight.has(id))}
                    onPick={() => setHighlight(new Set(row.sceneIds))}
                    actions={findingActions(row)}
                  />
                ))}
              </div>
            );
          })}
        </Inspector>
      );
    }
    if (selection.kind === "new") {
      return (
        <NewChoice
          // One panel for the whole draw: keyed by its ends, picking the To scene remounted it and
          // threw away the words already typed.
          key="new-choice"
          from={selection.from}
          to={selection.to}
          sceneOptions={sceneOptions}
          onChange={(next) => setSelection({ kind: "new", ...next })}
          onCancel={() => setSelection(null)}
          onAdd={(from, label, to) => {
            command({ operation: "add-choice", choice: { id: choiceIdFor(label, routing), from, label, to } });
            setSelection(null);
          }}
        />
      );
    }
    if (selection.kind === "choice") {
      if (!selectedChoice) return null;
      const walked = !unwalked.has(selectedChoice.id);
      return (
        <Inspector title="Choice" sub={selectedChoice.id} onClose={() => setSelection(null)}>
          <CommitField
            key={`${selectedChoice.id}-${selectedChoice.label}`}
            label="Label"
            value={selectedChoice.label}
            onCommit={(label) => command({ operation: "edit-choice", choiceId: selectedChoice.id, changes: { label } })}
          />
          <div className="bm-kv">
            <span className="bm-kv__k">From</span>
            <Select
              label="From scene"
              value={selectedChoice.from}
              onChange={(event) => command({ operation: "edit-choice", choiceId: selectedChoice.id, changes: { from: event.target.value } })}
            >
              {sceneOptions}
            </Select>
          </div>
          <div className="bm-kv">
            <span className="bm-kv__k">To</span>
            <Select
              label="To scene"
              value={selectedChoice.to}
              onChange={(event) => command({ operation: "edit-choice", choiceId: selectedChoice.id, changes: { to: event.target.value } })}
            >
              {sceneOptions}
            </Select>
          </div>
          <div className="bm-kv">
            <span className="bm-kv__k">Preview</span>
            <span className="bm-kv__v">
              {walked ? "walked" : <><span className="bm-dot bm-dot--blocks" />not walked</>}
            </span>
            <Button size="sm" onClick={() => setPreview({ from: selectedChoice.from, at: Date.now() })}>
              <Play size={10} />
              Walk it
            </Button>
          </div>
          <div className="bm-actions">
            <Button size="sm" variant="ghost" className="bm-danger" onClick={() => setSelection({ kind: "choice", id: selectedChoice.id, removing: true })}>
              <Trash size={13} />
              Remove choice
            </Button>
          </div>
          {selection.removing && (
            <div
              className="bm-confirm"
              role="alertdialog"
              aria-label={`Remove ${selectedChoice.label}?`}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                cancelRemoval(selectedChoice.id);
              }}
            >
              <div className="bm-confirm__title">Remove “{selectedChoice.label}”?</div>
              {consequences.length > 0 ? (
                <>
                  <span className="bm-eyebrow">What breaks</span>
                  {consequences.map((line) => (
                    <div key={line} className="bm-confirm__line">
                      <span className="bm-dot bm-dot--blocks" />
                      {line}
                    </div>
                  ))}
                </>
              ) : (
                <div className="bm-muted">Nothing else breaks.</div>
              )}
              <div className="bm-actions bm-actions--end">
                {/* Delete on a focused label opens this; focus comes here, not left on the label,
                    where Enter selected the choice again and closed the question unanswered. */}
                <Button size="sm" autoFocus onClick={() => cancelRemoval(selectedChoice.id)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    command({ operation: "remove-choice", choiceId: selectedChoice.id });
                    setSelection(null);
                  }}
                >
                  Remove choice
                </Button>
              </div>
            </div>
          )}
        </Inspector>
      );
    }
    const scene = scenes.find((candidate) => candidate.id === selection.id);
    if (!scene) return null;
    const frame = frameOf(scene.id);
    const ins = routing.choices.filter((choice) => choice.to === scene.id).length;
    const outs = routing.choices.filter((choice) => choice.from === scene.id);
    const ending = endings.get(scene.id);
    const reason = excluded.get(scene.id);
    const onRoute = geometry.nodes.some((node) => node.id === scene.id);
    return (
      <Inspector title="Scene" sub={scene.id} onClose={() => setSelection(null)}>
        <div className="bm-scenehead">
          <span className="bm-thumb bm-thumb--small">{frame ? <img src={frame} alt="" /> : <span className="bm-thumb__none">{scene.number}</span>}</span>
          <span>
            <span className="bm-scenehead__title">{scene.title}</span>
            <span className="bm-muted">
              {[sceneLength(scene, playsAsBeats), `${ins} way${ins === 1 ? "" : "s"} in`, `${outs.length} way${outs.length === 1 ? "" : "s"} out`].filter(Boolean).join(" · ")}
            </span>
          </span>
        </div>
        <div className="bm-kv">
          <span className="bm-kv__k">Start</span>
          {routing.start === scene.id ? (
            <span className="bm-kv__v">This is the start</span>
          ) : (
            <>
              <span className="bm-kv__v bm-muted">—</span>
              <Button size="sm" onClick={() => command({ operation: "set-start", sceneId: scene.id })}>
                Make this the start
              </Button>
            </>
          )}
        </div>
        <div className="bm-kv">
          <span className="bm-kv__k">Ending</span>
          <Switch
            label="Ending"
            checked={ending !== undefined}
            onChange={(on) =>
              command(on ? { operation: "set-ending", sceneId: scene.id, title: scene.title } : { operation: "clear-ending", sceneId: scene.id })
            }
          />
        </div>
        {ending !== undefined && (
          <CommitField
            key={`${scene.id}-${ending}`}
            label="Ending title"
            value={ending}
            onCommit={(title) => command({ operation: "set-ending", sceneId: scene.id, title })}
          />
        )}
        <div className="bm-kv">
          <span className="bm-kv__k">Route</span>
          {reason !== undefined ? (
            <>
              <span className="bm-kv__v"><i>{reason}</i></span>
              <Button size="sm" onClick={() => command({ operation: "include-scene", sceneId: scene.id })}>
                Include
              </Button>
            </>
          ) : onRoute ? (
            // A scene a route reaches cannot be excluded: the export would ship its choices with
            // nothing to play. Remove or retarget the choices into it first (the coordinator
            // refuses the command too).
            <span className="bm-kv__v bm-muted">on a route</span>
          ) : selection.excluding ? null : (
            <>
              <span className="bm-kv__v bm-muted">no way in</span>
              <Button size="sm" onClick={() => setSelection({ kind: "scene", id: scene.id, excluding: true })}>
                <EyeOff size={11} />
                Exclude…
              </Button>
            </>
          )}
        </div>
        {selection.excluding && reason === undefined && !onRoute && (
          <ExcludeField
            onCancel={() => setSelection({ kind: "scene", id: scene.id })}
            onExclude={(why) => {
              command({ operation: "exclude-scene", sceneId: scene.id, reason: why });
              setSelection({ kind: "scene", id: scene.id });
            }}
          />
        )}
        {outs.length > 0 && (
          <div className="bm-ways">
            <span className="bm-eyebrow">Ways out</span>
            {outs.map((choice) => (
              <button key={choice.id} type="button" className="bm-way" onClick={() => setSelection({ kind: "choice", id: choice.id })}>
                <span>{choice.label}</span>
                <span className="bm-muted">{titleOf(choice.to)}{unwalked.has(choice.id) ? " · not walked" : ""}</span>
              </button>
            ))}
          </div>
        )}
        <div className="bm-actions">
          <Button size="sm" onClick={() => setSelection({ kind: "new", from: scene.id, to: null })}>
            <Plus size={11} />
            Draw a choice from here
          </Button>
          <Button size="sm" onClick={() => setPreview({ from: scene.id, at: Date.now() })}>
            <Play size={10} />
            Preview from here
          </Button>
          <Link className="ui-btn ui-btn--ghost ui-btn--sm" to={`/w/${worldId}/p/${prodId}/scenes/${scene.id}`}>
            Open scene
          </Link>
        </div>
      </Inspector>
    );

    function findingActions(row: FindingRow) {
      // A choice naming a scene that is gone is drawn nowhere — not on the canvas, not in the
      // list — so the finding is the only place it can be reached, and removal is its repair.
      if (row.kind === "invalid-destination") {
        const id = row.choiceIds[0];
        return id !== undefined && routing!.choices.some((choice) => choice.id === id) ? (
          <Button size="sm" variant="ghost" className="bm-danger" onClick={() => command({ operation: "remove-choice", choiceId: id })}>
            <Trash size={13} />
            Remove choice
          </Button>
        ) : null;
      }
      if (row.kind === "unreachable") {
        const id = row.sceneIds[0]!;
        return (
          <>
            <Button size="sm" onClick={() => setSelection({ kind: "new", from: null, to: id })}>
              Draw a choice to it
            </Button>
            <Button size="sm" onClick={() => setSelection({ kind: "scene", id, excluding: true })}>
              Exclude…
            </Button>
          </>
        );
      }
      if (row.kind === "untraversed-edge") {
        return (
          <Button size="sm" onClick={() => setPreview({ from: routing!.start, at: Date.now() })}>
            <Play size={10} />
            Preview from the start
          </Button>
        );
      }
      const id = row.sceneIds[0];
      return id !== undefined && scenes.some((scene) => scene.id === id) ? (
        <Button size="sm" onClick={() => setSelection({ kind: "scene", id })}>
          Select {titleOf(id)}
        </Button>
      ) : null;
    }
  })();

  /*
   * The preview (turn 156g): the exported package's own player, over the whole window, with the
   * author's strip. It plays each scene's cut — its accepted clips in shot order — records walk
   * evidence as choices are pressed, and marks the choices nobody has walked.
   */
  const previewCut = preview === null ? new Map<string, CutEntry>() : new Map(deriveCut(production).entries.map((entry) => [entry.shot.id, entry]));
  const previewOptions: InteractivePlayerOptions | null =
    preview === null
      ? null
      : playsAsBeats
        ? beatPreviewOptions({
            world,
            production,
            voices: previewVoices.files,
            from: preview.from,
            unwalked: [...unwalked],
            onChoice: (choice, walked) => {
              if (worldId && prodId) recordTraversal(worldId, prodId, choice.id, choice.from, choice.to, walked);
            },
            onBranchMap: () => setPreview(null),
            onClose: () => setPreview(null),
          })
        : {
          title: production.meta.title,
          eyebrow: world.meta.name,
          start: routing.start,
          from: preview.from,
          autoplay: true,
          scenes: Object.fromEntries(
            scenes.map((scene) => [scene.id, { title: scene.title, clips: sceneClips(production, world.meta.slug, scene, previewCut) }]),
          ),
          choices: routing.choices,
          endings: routing.endings,
          storageKey: null,
          author: {
            unwalked: [...unwalked],
            onChoice: (choice, walked) => {
              if (worldId && prodId) recordTraversal(worldId, prodId, choice.id, choice.from, choice.to, walked);
            },
            onBranchMap: () => setPreview(null),
            onClose: () => setPreview(null),
          },
        };

  return (
    <div className="fy-arkewrap bm" data-screen="branch-map" data-narrow={narrow ? "true" : undefined}>
      <div className="bm-main">
        {header}
        {exportNote !== null && <div className="bm-note">{exportNote}</div>}
        {narrow && inspector}
        {narrow ? list : canvas}
        {previewOptions !== null && preview !== null && (!playsAsBeats || previewVoices.ready) && (
          <InteractivePlayerView
            key={preview.at}
            className="bm-player"
            label="Preview"
            options={previewOptions}
            unwalked={[...unwalked].sort()}
          />
        )}
      </div>
      <aside className="bm-side">
        {!narrow && inspector}
        {arke}
      </aside>
    </div>
  );
}

function Inspector({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <section className="bm-insp" aria-label={title}>
      <div className="bm-insp__head">
        <b>{title}</b>
        {sub && <span className="bm-muted">{sub}</span>}
        <span className="bm-spacer" />
        <button type="button" className="bm-insp__close" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="bm-insp__body">{children}</div>
    </section>
  );
}

function FindingCard({ row, lit, onPick, actions }: { row: FindingRow; lit: boolean; onPick: () => void; actions: React.ReactNode }) {
  return (
    <div className={cx("bm-find", lit && "bm-find--on")} onClick={onPick}>
      <div className="bm-find__title">
        <span className={cx("bm-dot", row.severity === "blocks" ? "bm-dot--blocks" : "bm-dot--warns")} />
        <span className="bm-find__name">{row.title}</span>
        {row.note && <span className="bm-muted">{row.note}</span>}
      </div>
      {row.evidence.length > 0 && <div className="bm-find__evidence">{row.evidence.join(" · ")}</div>}
      {actions && (
        <div className="bm-actions" onClick={(event) => event.stopPropagation()}>
          {actions}
        </div>
      )}
    </div>
  );
}

/** A text field that writes when it is left or Enter is pressed, and only if it changed. */
function CommitField({ label, value, onCommit }: { label: string; value: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  // What the field last wrote, until the routing comes back with it. Enter then a click away
  // otherwise compared the draft with the old value twice and sent the same edit twice.
  const sent = useRef(value);
  useEffect(() => {
    sent.current = value;
  }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (next === "") setDraft(value);
    else if (next !== sent.current) {
      sent.current = next;
      onCommit(next);
    } else if (next !== draft) setDraft(next);
  };
  return (
    <label className="bm-field">
      <span className="bm-field__label">{label}</span>
      <Input
        value={draft}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(value);
        }}
      />
    </label>
  );
}

function ExcludeField({ onCancel, onExclude }: { onCancel: () => void; onExclude: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="bm-field">
      <span className="bm-field__label">Why it is off the map</span>
      <Input
        autoFocus
        value={reason}
        aria-label="Reason for excluding"
        placeholder="held for a later season"
        onChange={(event) => setReason(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && reason.trim() !== "") onExclude(reason.trim());
          if (event.key === "Escape") onCancel();
        }}
      />
      <div className="bm-actions">
        <Button size="sm" variant="primary" disabled={reason.trim() === ""} onClick={() => onExclude(reason.trim())}>
          Exclude
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function NewChoice({
  from,
  to,
  sceneOptions,
  onChange,
  onCancel,
  onAdd,
}: {
  from: string | null;
  to: string | null;
  sceneOptions: React.ReactNode;
  onChange: (next: { from: string | null; to: string | null }) => void;
  onCancel: () => void;
  onAdd: (from: string, label: string, to: string) => void;
}) {
  const [label, setLabel] = useState("");
  const ready = from !== null && to !== null && label.trim() !== "";
  const add = () => ready && onAdd(from, label.trim(), to);
  return (
    <Inspector title="New choice" onClose={onCancel}>
      <label className="bm-field">
        <span className="bm-field__label">Label</span>
        <Input
          autoFocus
          value={label}
          aria-label="Choice label"
          placeholder="the words the viewer reads"
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
            if (event.key === "Escape") onCancel();
          }}
        />
      </label>
      <div className="bm-kv">
        <span className="bm-kv__k">From</span>
        <Select label="From scene" value={from ?? ""} onChange={(event) => onChange({ from: event.target.value || null, to })}>
          <option value="">choose…</option>
          {sceneOptions}
        </Select>
      </div>
      <div className="bm-kv">
        <span className="bm-kv__k">To</span>
        <Select label="To scene" value={to ?? ""} onChange={(event) => onChange({ from, to: event.target.value || null })}>
          <option value="">choose…</option>
          {sceneOptions}
        </Select>
      </div>
      <div className="bm-actions">
        <Button size="sm" variant="primary" disabled={!ready} onClick={add}>
          Add choice
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="bm-spacer" />
        <span className="bm-muted">Enter · Esc</span>
      </div>
    </Inspector>
  );
}
