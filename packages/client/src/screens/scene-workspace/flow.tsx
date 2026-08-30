import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  linearizeSceneFlow,
  resolveCast,
  type ArtifactSidecar,
  type ClientMessage,
  type ProductionBundle,
  type SceneRecord,
  type Sheet,
  type Shot,
} from "@arke-studio/contracts";
import { mediaUrl } from "../../lib/media.js";
import { acceptedTakeId } from "../../lib/selectors.js";
import type { WorkspaceBoardPack } from "./boards.js";
import { useWorkspaceSelection } from "./selection.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];

/**
 * Flow — the node canvas (SPEC-029 R-24, R-25; the prototype's §11).
 *
 * A real canvas: pan by dragging the ground, zoom between 0.5× and 1.4×, nodes at absolute
 * coordinates that can be dragged, and edges as cubic beziers leaving the right edge of one node
 * and arriving at the left edge of the next. Opening it fits the graph to the viewport.
 *
 * The five node kinds and their boxes are the prototype's, and so is the column layout: the
 * references a shot cites on the left, the shots down the middle, the boards they pack into, and
 * the clips those render to. Nothing here is authored — every node is derived from the scene,
 * the selections and the takes, so the canvas cannot disagree with the rows beside it.
 *
 * Positions are session state and are never written to the record (§1.16 keeps manual
 * coordinates out of v1): dragging arranges your view of the scene, and `Fit` puts it back.
 */

/** Box sizes, per kind — the prototype's `NODE` table, unchanged. */
const NODE = {
  ref: { w: 156, h: 178 },
  shot: { w: 232, h: 96 },
  board: { w: 196, h: 86 },
  clip: { w: 208, h: 152 },
} as const;

type NodeKind = keyof typeof NODE;

interface FlowNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  name: string;
  meta: string;
  thumb?: string;
  shotId?: string;
  staged: boolean;
}

interface FlowEdge {
  id: string;
  from: { x: number; y: number };
  fromKind: NodeKind;
  to: { x: number; y: number };
  toKind: NodeKind;
  /** A citation, drawn dashed: advisory, and the only kind the surface offers to cut. */
  soft: boolean;
  /** What the edge says in words, for the list a screen reader reads instead of the drawing. */
  label: string;
  fromShotId: string | null;
  toShotId: string | null;
  staged: boolean;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.4;
const FIT_PAD = 26;

export function SceneFlow({
  scene,
  production,
  sheets,
  artifacts,
  slug,
  boardPack,
  stagedShotIds,
  newShotIds,
  stagedBoards,
  locked,
  onCommand,
}: {
  scene: SceneRecord;
  production: ProductionBundle;
  sheets: readonly Sheet[];
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
  boardPack: WorkspaceBoardPack;
  stagedShotIds: ReadonlySet<string>;
  newShotIds: ReadonlySet<string>;
  stagedBoards: boolean;
  locked: boolean;
  onCommand: (command: Command) => boolean;
}) {
  const sequence = linearizeSceneFlow(scene);
  const { subject, select } = useWorkspaceSelection();
  const canvas = useRef<HTMLDivElement | null>(null);
  const nodeControls = useRef(new Map<string, HTMLDivElement>());
  const [pan, setPan] = useState({ x: 24, y: 20 });
  const [zoom, setZoom] = useState(1);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [activeShotId, setActiveShotId] = useState<string | null>(
    subject.kind === "shot" ? subject.shotId : null,
  );
  const [deleteShotId, setDeleteShotId] = useState<string | null>(null);

  const shots = useMemo(
    () => sequence.kind === "linear" ? sequence.shots.map((pair) => pair.shot) : [],
    [scene],
  );
  const graph = useMemo(
    () => buildGraph({ shots, production, sheets, artifacts, slug, moved, boardPack, stagedShotIds, newShotIds, stagedBoards }),
    [shots, production, sheets, artifacts, slug, moved, boardPack, stagedShotIds, newShotIds, stagedBoards],
  );

  /** Fit the graph to the viewport — what opening Flow does, and what `Fit` returns to. */
  const fit = useCallback(() => {
    const box = canvas.current?.getBoundingClientRect();
    const nodes = graph.nodes;
    if (nodes.length === 0) {
      setMoved({});
      setPan({ x: 24, y: 20 });
      setZoom(1);
      return;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const node of nodes) {
      const size = NODE[node.kind];
      x0 = Math.min(x0, node.x);
      // The hover toolbar sits 30px above a node, so the fit has to leave room for it.
      y0 = Math.min(y0, node.y - 30);
      x1 = Math.max(x1, node.x + size.w);
      y1 = Math.max(y1, node.y + size.h);
    }
    const rw = box?.width ?? 900;
    const rh = box?.height ?? 560;
    const next = Math.max(
      ZOOM_MIN,
      Math.min(1, Math.min((rw - FIT_PAD * 2) / (x1 - x0), (rh - FIT_PAD * 2) / (y1 - y0))),
    );
    setZoom(Math.round(next * 100) / 100);
    setPan({ x: FIT_PAD - x0 * next, y: FIT_PAD - y0 * next });
  }, [graph.nodes]);

  // Opening Flow fits to content, once — a later fit is the button's job, not the render's.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || graph.nodes.length === 0) return;
    fitted.current = true;
    fit();
  }, [fit, graph.nodes.length]);

  const panFrom = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const origin = { ...pan };
    const sx = event.clientX;
    const sy = event.clientY;
    const move = (ev: MouseEvent) => setPan({ x: origin.x + (ev.clientX - sx), y: origin.y + (ev.clientY - sy) });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const dragNode = (node: FlowNode, event: React.MouseEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    select(node.shotId === undefined ? { kind: "scene" } : { kind: "shot", shotId: node.shotId });
    const sx = event.clientX;
    const sy = event.clientY;
    const origin = { x: node.x, y: node.y };
    const move = (ev: MouseEvent) =>
      setMoved((held) => ({
        ...held,
        // Divided by the zoom, or the node outruns the cursor at anything but 100%.
        [node.id]: { x: origin.x + (ev.clientX - sx) / zoom, y: origin.y + (ev.clientY - sy) / zoom },
      }));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  if (sequence.kind === "invalid") {
    /*
     * An invalid graph shows what can be recovered and says why the order cannot be trusted —
     * it never invents edges (R-29, R-59). No score and no summary: a number would hide the
     * sentence somebody can act on.
     */
    return (
      <div className="fy-swflow fy-swflow--invalid" data-testid="workspace-flow-invalid">
        <p className="fy-swflow__why">This scene has no order that can be trusted.</p>
        <ul className="fy-swflow__findings">
          {sequence.findings.map((finding) => (
            <li key={`${finding.kind}:${finding.about}`}>{finding.message}</li>
          ))}
        </ul>
      </div>
    );
  }

  const current = subject.kind === "shot" ? subject.shotId : null;
  useEffect(() => {
    if (activeShotId !== null && shots.some((shot) => shot.id === activeShotId)) return;
    setActiveShotId(shots[0]?.id ?? null);
  }, [activeShotId, shots]);
  const focusShot = (shotId: string) => {
    setActiveShotId(shotId);
    select({ kind: "shot", shotId });
    requestAnimationFrame(() => nodeControls.current.get(shotId)?.focus());
  };
  const moveFocus = (fromShotId: string, key: string) => {
    const index = shots.findIndex((shot) => shot.id === fromShotId);
    const next =
      key === "Home"
        ? shots[0]
        : key === "End"
          ? shots.at(-1)
          : key === "ArrowUp" || key === "ArrowLeft"
            ? shots[Math.max(0, index - 1)]
            : shots[Math.min(shots.length - 1, index + 1)];
    if (next !== undefined) focusShot(next.id);
  };
  const reconnect = (targetShotId: string) => {
    if (linkSource === null || linkSource === targetShotId || locked || stagedShotIds.has(linkSource)) return;
    onCommand({ kind: "move-shot", shotId: linkSource, to: { after: targetShotId } });
    setLinkSource(null);
  };

  return (
    <div
      className="fy-swcanvas"
      data-testid="workspace-flow"
      ref={canvas}
      onMouseDown={panFrom}
      role="application"
      aria-label={`Flow of scene ${scene.number}`}
    >
      <div
        className="fy-swlayer"
        data-testid="workspace-flow-layer"
        style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}
      >
        <svg width={1400} height={1000} className="fy-swedges">
          {graph.edges.map((edge) => (
            <path
              key={edge.id}
              d={pathFor(edge)}
              fill="none"
              stroke={edge.soft ? "var(--neutral-300)" : "var(--neutral-400)"}
              strokeWidth={edge.soft ? 1.25 : 1.5}
              strokeDasharray={edge.soft ? "4 4" : undefined}
              data-staged={edge.staged ? "true" : undefined}
            />
          ))}
        </svg>
        {/*
          A div carries the drag, but every node is a real control besides: focusable, named, and
          activated by Enter or Space. R-63 asks the canvas to be reachable without a mouse, and
          a node you can only reach by dragging is one some people cannot reach at all.
        */}
        {graph.nodes.map((node) => (
          <div
            key={node.id}
            ref={(element) => {
              if (node.shotId === undefined) return;
              if (element === null) nodeControls.current.delete(node.shotId);
              else nodeControls.current.set(node.shotId, element);
            }}
            className="fy-swnode"
            data-kind={node.kind}
            data-testid={`flow-node-${node.id}`}
            data-selected={node.shotId !== undefined && node.shotId === current ? "true" : undefined}
            data-staged={node.staged ? "true" : undefined}
            style={{ left: node.x, top: node.y, width: NODE[node.kind].w, height: NODE[node.kind].h }}
            role="button"
            tabIndex={
              node.staged
                ? -1
                : node.kind !== "shot"
                  ? 0
                  : activeShotId === node.shotId || (activeShotId === null && node.shotId === shots[0]?.id)
                  ? 0
                  : -1
            }
            aria-label={ariaFor(node)}
            aria-disabled={node.staged ? "true" : undefined}
            aria-current={node.shotId !== undefined && node.shotId === current ? "true" : undefined}
            onMouseDown={(event) => !node.staged && dragNode(node, event)}
            onDragOver={(event) => {
              if (node.shotId !== undefined && linkSource !== null) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (node.shotId !== undefined) reconnect(node.shotId);
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (node.staged || locked) return;
              if (node.shotId !== undefined && linkSource !== null) {
                reconnect(node.shotId);
                return;
              }
              if (node.shotId === undefined) select({ kind: "scene" });
              else focusShot(node.shotId);
            }}
            onKeyDown={(event) => {
              if (node.staged) return;
              if (
                node.shotId !== undefined &&
                ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                moveFocus(node.shotId, event.key);
                return;
              }
              if (node.shotId !== undefined && event.key === "Delete") {
                event.preventDefault();
                setDeleteShotId(node.shotId);
                return;
              }
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (node.shotId !== undefined && linkSource !== null) {
                reconnect(node.shotId);
                return;
              }
              select(node.shotId === undefined ? { kind: "scene" } : { kind: "shot", shotId: node.shotId });
            }}
          >
            {node.thumb === undefined ? null : (
              <span className="fy-swnode__thumb" style={{ backgroundImage: `url(${node.thumb})` }} role="img" aria-label={node.name} />
            )}
            <span className="fy-swnode__name">{node.name}</span>
            <span className="fy-swnode__meta">{node.meta}</span>
            {node.staged ? <span className="fy-swnode__staged">staged</span> : null}
          </div>
        ))}
        {graph.nodes.flatMap((node) =>
          node.kind !== "shot" || node.shotId === undefined
            ? []
            : [
                <button
                  key={`port:${node.id}`}
                  type="button"
                  className="fy-swnode__port"
                  style={{ left: node.x + NODE.shot.w - 8, top: node.y + NODE.shot.h / 2 - 8 }}
                  draggable={!locked && !node.staged}
                  disabled={locked || node.staged}
                  aria-pressed={linkSource === node.shotId}
                  aria-label={`Connect shot ${shots.find((shot) => shot.id === node.shotId)?.number ?? node.shotId} after another shot`}
                  onMouseDown={(event) => event.stopPropagation()}
                  onDragStart={() => setLinkSource(node.shotId!)}
                  onDragEnd={() => setLinkSource(null)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setLinkSource((held) => held === node.shotId ? null : node.shotId!);
                  }}
                />,
              ],
        )}
      </div>

      {linkSource === null ? null : (
        <div className="fy-swlinkhint" role="status">
          Connect shot {shots.find((shot) => shot.id === linkSource)?.number} after… choose a shot
          <button type="button" onClick={() => setLinkSource(null)}>Cancel</button>
        </div>
      )}
      {deleteShotId === null ? null : (
        <div className="fy-swlinkhint" role="alert">
          Delete shot {shots.find((shot) => shot.id === deleteShotId)?.number}?
          <button type="button" disabled={locked} onClick={() => { onCommand({ kind: "delete-shot", shotId: deleteShotId }); setDeleteShotId(null); }}>
            Delete
          </button>
          <button type="button" onClick={() => setDeleteShotId(null)}>Cancel</button>
        </div>
      )}

      {/*
        The same graph as a list, for assistive technology and the keyboard (R-63, R-64).
        Off-screen rather than absent: a canvas conveys "what follows what" by drawing it, and
        drawing is exactly what a screen reader cannot see — so the edges say it in words, each
        naming its source and destination. Visually identical to the prototype; the canvas above
        is untouched.
      */}
      <ul className="fy-swalt" data-testid="workspace-flow-alt">
        {graph.edges.map((edge) => (
          <li key={`alt:${edge.id}`}>
            <button
              type="button"
              disabled={edge.staged}
              onClick={() => !edge.staged && select({ kind: "edge", fromShotId: edge.fromShotId, toShotId: edge.toShotId })}
            >
              {edge.label}
            </button>
          </li>
        ))}
      </ul>

      {/* The zoom control, bottom-left, swallowing its own mousedown so it never pans. */}
      <div className="fy-swzoom" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - 0.1) * 10) / 10))}>
          −
        </button>
        <span className="fy-swzoom__label">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + 0.1) * 10) / 10))}>
          +
        </button>
        <button type="button" className="fy-swzoom__fit" onClick={() => { setMoved({}); fit(); }}>
          Fit
        </button>
      </div>
    </div>
  );
}

/** What a node announces: its kind, what it is, and how it is joined (R-63). */
function ariaFor(node: FlowNode): string {
  const joins = node.kind === "ref" ? "0 in, 1 out" : node.kind === "clip" ? "1 in, 0 out" : "1 in, 1 out";
  return `${node.name}, ${node.kind}, ${node.meta}, ${joins}`;
}

/** The bezier the prototype draws: out of the right edge, into the left edge, eased by dx. */
function pathFor(edge: FlowEdge): string {
  const a = NODE[edge.fromKind];
  const b = NODE[edge.toKind];
  const x1 = edge.from.x + a.w;
  const y1 = edge.from.y + a.h / 2;
  const x2 = edge.to.x;
  const y2 = edge.to.y + b.h / 2;
  const dx = Math.max(38, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

/**
 * The graph, derived: references cited by the script, the shots, the boards they pack into, and
 * the clips those render to. Columns and spacings are the prototype's, and a dragged node keeps
 * whatever position it was left in.
 */
function buildGraph(input: {
  shots: readonly Shot[];
  production: ProductionBundle;
  sheets: readonly Sheet[];
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
  boardPack: WorkspaceBoardPack;
  moved: Record<string, { x: number; y: number }>;
  stagedShotIds: ReadonlySet<string>;
  newShotIds: ReadonlySet<string>;
  stagedBoards: boolean;
}): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const { shots, production, sheets, artifacts, slug, moved, boardPack, stagedShotIds, newShotIds, stagedBoards } = input;
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const at = (id: string, x: number, y: number) => moved[id] ?? { x, y };

  // References, two to a column on the left, in the order the script first cites them.
  const cited: string[] = [];
  const citedBy = new Map<string, string[]>();
  for (const shot of shots) {
    for (const entry of resolveCast(shot.description, [...sheets]).cast) {
      if (!cited.includes(entry.sheet.id)) cited.push(entry.sheet.id);
      citedBy.set(entry.sheet.id, [...(citedBy.get(entry.sheet.id) ?? []), shot.id]);
    }
  }
  const refAt = new Map<string, { x: number; y: number }>();
  cited.forEach((sheetId, index) => {
    const sheet = sheets.find((candidate) => candidate.id === sheetId)!;
    const point = at(`r:${sheetId}`, 20 + (index % 2) * 172, 24 + Math.floor(index / 2) * 196);
    refAt.set(sheetId, point);
    nodes.push({
      id: `r:${sheetId}`,
      kind: "ref",
      x: point.x,
      y: point.y,
      name: sheet.name,
      meta: sheet.type,
      staged: false,
    });
  });

  // Shots, down the middle.
  const shotAt = new Map<string, { x: number; y: number }>();
  shots.forEach((shot, index) => {
    const point = at(`s:${shot.id}`, 400, 14 + index * 118);
    shotAt.set(shot.id, point);
    const artifactId = production.selections[shot.id]?.startFrameArtifactId ?? null;
    const artifact = artifactId === null ? undefined : artifacts.find((candidate) => candidate.id === artifactId);
    nodes.push({
      id: `s:${shot.id}`,
      kind: "shot",
      x: point.x,
      y: point.y,
      name: `Shot ${shot.number}`,
      meta: shot.title,
      shotId: shot.id,
      staged: stagedShotIds.has(shot.id),
      ...(!newShotIds.has(shot.id) && artifact !== undefined && slug !== undefined
        ? { thumb: mediaUrl(slug, `artifacts/${artifact.file}`) }
        : {}),
    });
  });
  for (let index = 1; index < shots.length; index += 1) {
    const before = shots[index - 1]!;
    const after = shots[index]!;
    edges.push({
      id: `seq:${before.id}:${after.id}`,
      from: shotAt.get(before.id)!,
      fromKind: "shot",
      to: shotAt.get(after.id)!,
      toKind: "shot",
      soft: false,
      label: `Shot ${before.number} goes to shot ${after.number}`,
      fromShotId: before.id,
      toShotId: after.id,
      staged: stagedShotIds.has(before.id) || stagedShotIds.has(after.id),
    });
  }
  for (const [sheetId, shotIds] of citedBy) {
    const from = refAt.get(sheetId);
    if (from === undefined) continue;
    for (const shotId of shotIds) {
      const to = shotAt.get(shotId);
      if (to === undefined) continue;
      const sheet = sheets.find((candidate) => candidate.id === sheetId);
      const shot = shots.find((candidate) => candidate.id === shotId);
      edges.push({
        id: `e:${sheetId}:${shotId}`,
        from,
        fromKind: "ref",
        to,
        toKind: "shot",
        soft: true,
        label: `${sheet?.name ?? sheetId} is cited by shot ${shot?.number ?? shotId}`,
        fromShotId: null,
        toShotId: shotId,
        staged: stagedShotIds.has(shotId),
      });
    }
  }

  // Boards, packed the way the rows pack them, and the clip each renders to.
  if (boardPack.ok) {
    for (const board of boardPack.boards) {
      const members = board.memberShotIds.flatMap((shotId: string) => {
        const point = shotAt.get(shotId);
        return point === undefined ? [] : [{ shotId, point }];
      });
      if (members.length === 0) continue;
      const mid = members.reduce((sum: number, member: { point: { y: number } }) => sum + member.point.y, 0) / members.length;
      const point = at(`b:${board.letter}`, 700, mid + 4);
      nodes.push({
        id: `b:${board.letter}`,
        kind: "board",
        x: point.x,
        y: point.y,
        name: `Board ${board.letter}`,
        meta: `${board.memberShotIds.length} cells`,
        staged: stagedBoards || board.memberShotIds.some((shotId) => stagedShotIds.has(shotId)),
      });
      for (const member of members) {
        edges.push({
          id: `e:${member.shotId}:b${board.letter}`,
          from: member.point,
          fromKind: "shot",
          to: point,
          toKind: "board",
          soft: false,
          label: `Shot ${shots.find((s) => s.id === member.shotId)?.number ?? member.shotId} goes to board ${board.letter}`,
          fromShotId: member.shotId,
          toShotId: null,
          staged: stagedBoards || stagedShotIds.has(member.shotId),
        });
      }
      const rendered = board.memberShotIds.some((shotId: string) => {
        if (newShotIds.has(shotId)) return false;
        const accepted = acceptedTakeId(production, shotId);
        return accepted !== null && production.takes.find((take) => take.id === accepted)?.kind === "clip";
      });
      const clipPoint = at(`c:${board.letter}`, 960, point.y + 6);
      nodes.push({
        id: `c:${board.letter}`,
        kind: "clip",
        x: clipPoint.x,
        y: clipPoint.y,
        name: `Clip ${board.letter}`,
        meta: rendered ? "rendered" : "not rendered",
        staged: stagedBoards || board.memberShotIds.some((shotId) => stagedShotIds.has(shotId)),
      });
      edges.push({
        id: `e:b${board.letter}:c`,
        from: point,
        fromKind: "board",
        to: clipPoint,
        toKind: "clip",
        soft: false,
        label: `Board ${board.letter} goes to clip ${board.letter}`,
        fromShotId: null,
        toShotId: null,
        staged: stagedBoards || board.memberShotIds.some((shotId) => stagedShotIds.has(shotId)),
      });
    }
  }

  return { nodes, edges };
}
