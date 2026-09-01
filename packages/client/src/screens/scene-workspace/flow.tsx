import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  linearizeSceneFlow,
  resolveCast,
  type ArtifactSidecar,
  type ClientMessage,
  type ProductionBundle,
  type SceneRecord,
  type SceneSequenceShot,
  type Sheet,
} from "@arke-studio/contracts";
import { mediaUrl } from "../../lib/media.js";
import { acceptedTakeId } from "../../lib/selectors.js";
import type { WorkspaceBoardPack } from "./boards.js";
import { subjectMatchesBoard, useWorkspaceSelection, type WorkspaceSubject } from "./selection.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];

/**
 * Flow — the node canvas (SPEC-029 R-24, R-25; the prototype's §11).
 *
 * A real canvas: pan by dragging the ground, zoom between 0.5× and 1.4×, nodes at absolute
 * coordinates that can be dragged, and edges as cubic beziers leaving the right edge of one node
 * and arriving at the left edge of the next. Opening it fits the graph to the viewport.
 *
 * The context-node boxes and columns are the prototype's. Entry, Shot, and Exit are the canonical
 * sequence required by SPEC-029; references, boards, and clips are derived from the scene,
 * selections, and takes, so the canvas cannot disagree with the rows beside it.
 *
 * Positions are session state and are never written to the record (§1.16 keeps manual
 * coordinates out of v1): dragging arranges your view of the scene, and `Fit` puts it back.
 */

/** Context box sizes follow the prototype; compact terminals complete SPEC-029's sequence. */
const NODE = {
  entry: { w: 112, h: 52 },
  ref: { w: 156, h: 178 },
  shot: { w: 232, h: 96 },
  board: { w: 196, h: 86 },
  clip: { w: 208, h: 152 },
  exit: { w: 112, h: 52 },
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
  memberShotIds?: string[];
  staged: boolean;
}

interface FlowEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
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

function subjectForNode(node: FlowNode): WorkspaceSubject {
  if (node.shotId !== undefined) return { kind: "shot", shotId: node.shotId };
  if (node.kind === "board" && node.memberShotIds !== undefined) {
    return { kind: "board", memberShotIds: [...node.memberShotIds] };
  }
  return { kind: "scene" };
}

function subjectSelectsNode(subject: WorkspaceSubject, node: FlowNode, currentShotId: string | null): boolean {
  if (node.shotId !== undefined) return node.shotId === currentShotId;
  return node.kind === "board" &&
    node.memberShotIds !== undefined &&
    subjectMatchesBoard(subject, node.memberShotIds);
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.4;
const FIT_PAD = 26;
const EMPTY_MOVED: Record<string, { x: number; y: number }> = {};

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
  generatorPending,
  onCommand,
  onOpenShotInGenerator,
  onRenderBoard,
  onTalkToArke,
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
  generatorPending: boolean;
  onCommand: (command: Command) => boolean;
  onOpenShotInGenerator: (shotId: string) => void;
  onRenderBoard: (memberShotIds: string[]) => void;
  onTalkToArke: () => void;
}) {
  const sequence = useMemo(() => linearizeSceneFlow(scene), [scene]);
  const { subject, select } = useWorkspaceSelection();
  const canvas = useRef<HTMLDivElement | null>(null);
  const nodeControls = useRef(new Map<string, HTMLDivElement>());
  const flowOwnsFocus = useRef(false);
  const initialFocusPlaced = useRef(false);
  const previousShotIds = useRef<string[]>([]);
  const previousFocusableNodeIds = useRef<string[]>([]);
  const deletePanel = useRef<HTMLDivElement | null>(null);
  const deleteReturnNode = useRef<string | null>(null);
  const liveShotIds = useRef(new Set<string>());
  const [pan, setPan] = useState({ x: 24, y: 20 });
  const [zoom, setZoom] = useState(1);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [deleteShotId, setDeleteShotId] = useState<string | null>(null);

  const sequenceShots = useMemo(() => sequence.kind === "linear" ? sequence.shots : [], [sequence]);
  const shots = useMemo(() => sequenceShots.map((pair) => pair.shot), [sequenceShots]);
  const compact = canvasSize !== null && canvasSize.width < 700;
  const arrangedGraph = useMemo(
    () => sequence.kind === "linear"
      ? buildGraph({ sequence, production, sheets, artifacts, slug, moved: EMPTY_MOVED, boardPack, stagedShotIds, newShotIds, stagedBoards, compact })
      : { nodes: [], edges: [] },
    [sequence, production, sheets, artifacts, slug, boardPack, stagedShotIds, newShotIds, stagedBoards, compact],
  );
  const graph = useMemo(
    () => Object.keys(moved).length === 0 || sequence.kind === "invalid"
      ? arrangedGraph
      : buildGraph({ sequence, production, sheets, artifacts, slug, moved, boardPack, stagedShotIds, newShotIds, stagedBoards, compact }),
    [arrangedGraph, sequence, production, sheets, artifacts, slug, moved, boardPack, stagedShotIds, newShotIds, stagedBoards, compact],
  );
  const joins = useMemo(() => {
    const counts = new Map<string, { incoming: number; outgoing: number }>();
    for (const node of graph.nodes) counts.set(node.id, { incoming: 0, outgoing: 0 });
    for (const edge of graph.edges) {
      const from = counts.get(edge.fromNodeId);
      const to = counts.get(edge.toNodeId);
      if (from !== undefined) from.outgoing += 1;
      if (to !== undefined) to.incoming += 1;
    }
    return counts;
  }, [graph.edges, graph.nodes]);
  const arrangementKey = useMemo(
    () => arrangedGraph.nodes.map((node) => `${node.id}:${node.x}:${node.y}`).join("|"),
    [arrangedGraph.nodes],
  );
  const hasLiveMoved = useMemo(
    () => arrangedGraph.nodes.some((node) => moved[node.id] !== undefined),
    [arrangedGraph.nodes, moved],
  );
  const focusableNodes = useMemo(() => graph.nodes.filter((node) => !node.staged), [graph.nodes]);
  const activeNodeIsLive = activeNodeId !== null && focusableNodes.some((node) => node.id === activeNodeId);
  const subjectNode = subject.kind === "shot"
    ? focusableNodes.find((node) => node.shotId === subject.shotId)
    : subject.kind === "board"
      ? focusableNodes.find((node) =>
          node.kind === "board" &&
          node.memberShotIds !== undefined &&
          subjectMatchesBoard(subject, node.memberShotIds),
        )
      : undefined;
  const defaultNodeId = subjectNode?.id ??
    focusableNodes.find((node) => node.kind === "entry")?.id ??
    focusableNodes[0]?.id ??
    null;
  const rovingNodeId = activeNodeIsLive ? activeNodeId : defaultNodeId;
  liveShotIds.current = new Set(shots.map((shot) => shot.id));
  const deleteOpen = deleteShotId !== null && liveShotIds.current.has(deleteShotId);

  const restoreDeleteFocus = useCallback((nodeId: string | null) => {
    requestAnimationFrame(() => {
      const preferred = nodeId === null ? undefined : nodeControls.current.get(nodeId);
      if (preferred?.isConnected) preferred.focus();
      else canvas.current?.querySelector<HTMLElement>('.fy-swnode[tabindex="0"]')?.focus();
    });
  }, []);
  const closeDelete = useCallback((restoreFocus: boolean) => {
    setDeleteShotId(null);
    if (restoreFocus) restoreDeleteFocus(deleteReturnNode.current);
  }, [restoreDeleteFocus]);
  const blockDeleteBackground = (event: React.SyntheticEvent) => {
    const panel = deletePanel.current;
    if (
      deleteShotId === null ||
      !liveShotIds.current.has(deleteShotId) ||
      panel === null ||
      (event.target instanceof Node && panel.contains(event.target))
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    panel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  };

  /** Fit these nodes to the viewport — opening and Arrange use the same geometry. */
  const fitNodes = useCallback((nodes: readonly FlowNode[]): boolean => {
    const box = canvas.current?.getBoundingClientRect();
    if (nodes.length === 0) {
      setPan({ x: 24, y: 20 });
      setZoom(1);
      return true;
    }
    if (box === undefined || box.width <= 0 || box.height <= 0) return false;
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
    const rw = box.width;
    const rh = box.height;
    const fittedZoom = Math.max(
      Number.EPSILON,
      Math.min(1, Math.min((rw - FIT_PAD * 2) / (x1 - x0), (rh - FIT_PAD * 2) / (y1 - y0))),
    );
    setZoom(fittedZoom);
    setPan({ x: FIT_PAD - x0 * fittedZoom, y: FIT_PAD - y0 * fittedZoom });
    return true;
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      const next = box.width > 0 && box.height > 0 ? { width: box.width, height: box.height } : null;
      setCanvasSize((current) =>
        current?.width === next?.width && current?.height === next?.height ? current : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Fit once per scene and layout. Crossing the compact boundary changes every default position.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    const layout = `${scene.id}:${compact ? "compact" : "wide"}:${arrangementKey}`;
    if (canvasSize === null || fitted.current === layout || arrangedGraph.nodes.length === 0) return;
    if (hasLiveMoved) {
      fitted.current = layout;
      return;
    }
    setMoved({});
    if (fitNodes(arrangedGraph.nodes)) fitted.current = layout;
  }, [arrangedGraph.nodes, arrangementKey, canvasSize, compact, fitNodes, hasLiveMoved, scene.id]);

  useEffect(() => {
    if (sequence.kind === "invalid") {
      setActiveNodeId(null);
      previousShotIds.current = [];
      previousFocusableNodeIds.current = [];
      return;
    }
    if (focusableNodes.length === 0) {
      setActiveNodeId(null);
      previousShotIds.current = sequence.shots.map((pair) => pair.shot.id);
      previousFocusableNodeIds.current = [];
      return;
    }

    let targetNodeId: string;
    let replacementSubject: WorkspaceSubject | null = null;
    const edgeIsLive = subject.kind === "edge" && graph.edges.some((edge) =>
      !edge.staged && edge.fromShotId === subject.fromShotId && edge.toShotId === subject.toShotId,
    );
    if (subjectNode !== undefined) {
      targetNodeId = subjectNode.id;
    } else if (subject.kind === "shot") {
      const previousIndex = previousShotIds.current.indexOf(subject.shotId);
      const from = previousIndex < 0 ? 0 : Math.min(previousIndex, sequence.shots.length);
      const replacement = [
        ...sequence.shots.slice(from),
        ...sequence.shots.slice(0, from).reverse(),
      ].find((pair) => !stagedShotIds.has(pair.shot.id));
      targetNodeId = replacement?.nodeId ?? sequence.entryNodeId;
      replacementSubject = replacement === undefined
        ? { kind: "scene" }
        : { kind: "shot", shotId: replacement.shot.id };
    } else if (activeNodeIsLive) {
      targetNodeId = activeNodeId;
    } else {
      const oldIndex = activeNodeId === null ? -1 : previousFocusableNodeIds.current.indexOf(activeNodeId);
      const currentIds = new Set(focusableNodes.map((node) => node.id));
      const neighbour = oldIndex < 0
        ? undefined
        : [
            ...previousFocusableNodeIds.current.slice(oldIndex + 1),
            ...previousFocusableNodeIds.current.slice(0, oldIndex).reverse(),
          ].find((nodeId) => currentIds.has(nodeId));
      targetNodeId = neighbour ?? defaultNodeId ?? focusableNodes[0]!.id;
    }
    if ((subject.kind === "board" && subjectNode === undefined) || (subject.kind === "edge" && !edgeIsLive)) {
      replacementSubject = subjectForNode(focusableNodes.find((node) => node.id === targetNodeId)!);
    }

    const targetChanged = activeNodeId !== targetNodeId;
    if (targetChanged) setActiveNodeId(targetNodeId);
    if (replacementSubject !== null) select(replacementSubject);
    if (!initialFocusPlaced.current || (flowOwnsFocus.current && targetChanged)) {
      requestAnimationFrame(() => nodeControls.current.get(targetNodeId)?.focus());
    }
    initialFocusPlaced.current = true;
    previousShotIds.current = sequence.shots.map((pair) => pair.shot.id);
    previousFocusableNodeIds.current = focusableNodes.map((node) => node.id);
  }, [activeNodeId, activeNodeIsLive, defaultNodeId, focusableNodes, graph.edges, select, sequence, stagedShotIds, subject, subjectNode]);

  useEffect(() => {
    if (deleteShotId === null) return;
    if (!liveShotIds.current.has(deleteShotId)) {
      setDeleteShotId(null);
      restoreDeleteFocus(deleteReturnNode.current);
    }
  }, [deleteShotId, restoreDeleteFocus, shots]);

  useEffect(() => {
    if (deleteShotId === null || !liveShotIds.current.has(deleteShotId)) return;
    const panel = deletePanel.current;
    if (panel === null) return;
    const buttons = () => [...panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const focusFirst = () => buttons()[0]?.focus();
    const isInside = (target: EventTarget | null) => target instanceof Node && panel.contains(target);
    const inerted: Array<{ element: HTMLElement; wasInert: boolean }> = [];
    let modalBranch: HTMLElement = panel;
    while (modalBranch.parentElement !== null) {
      const parent = modalBranch.parentElement;
      for (const sibling of parent.children) {
        if (sibling === modalBranch || !(sibling instanceof HTMLElement)) continue;
        inerted.push({ element: sibling, wasInert: sibling.inert });
        sibling.inert = true;
      }
      modalBranch = parent;
    }
    const containFocus = (event: FocusEvent) => {
      if (isInside(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      focusFirst();
    };
    const blockOutsidePointer = (event: Event) => {
      if (isInside(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      focusFirst();
    };
    const containKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeDelete(true);
        return;
      }
      if (event.key === "Tab") {
        const controls = buttons();
        if (controls.length === 0) return;
        const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
        const next = currentIndex < 0
          ? event.shiftKey ? controls.at(-1) : controls[0]
          : event.shiftKey
            ? controls[(currentIndex - 1 + controls.length) % controls.length]
            : controls[(currentIndex + 1) % controls.length];
        event.preventDefault();
        event.stopImmediatePropagation();
        next?.focus();
        return;
      }
      if (isInside(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      focusFirst();
    };

    focusFirst();
    document.addEventListener("focusin", containFocus, true);
    document.addEventListener("pointerdown", blockOutsidePointer, true);
    document.addEventListener("mousedown", blockOutsidePointer, true);
    document.addEventListener("click", blockOutsidePointer, true);
    document.addEventListener("keydown", containKeys, true);
    return () => {
      document.removeEventListener("focusin", containFocus, true);
      document.removeEventListener("pointerdown", blockOutsidePointer, true);
      document.removeEventListener("mousedown", blockOutsidePointer, true);
      document.removeEventListener("click", blockOutsidePointer, true);
      document.removeEventListener("keydown", containKeys, true);
      for (const { element, wasInert } of inerted) element.inert = wasInert;
    };
  }, [closeDelete, deleteShotId, shots]);

  const panFrom = (event: React.MouseEvent) => {
    if (deleteOpen || event.button !== 0) return;
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
    if (deleteOpen || event.button !== 0) return;
    event.stopPropagation();
    setActiveNodeId(node.id);
    select(subjectForNode(node));
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
  const focusNode = (nodeId: string) => {
    const node = focusableNodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) return;
    setActiveNodeId(node.id);
    select(subjectForNode(node));
    requestAnimationFrame(() => nodeControls.current.get(node.id)?.focus());
  };
  const moveFocus = (fromNodeId: string, key: string) => {
    const index = focusableNodes.findIndex((node) => node.id === fromNodeId);
    const next =
      key === "Home"
        ? focusableNodes.find((node) => node.kind === "entry") ?? focusableNodes[0]
        : key === "End"
          ? focusableNodes.find((node) => node.kind === "exit") ?? focusableNodes.at(-1)
          : key === "ArrowUp" || key === "ArrowLeft"
            ? focusableNodes[Math.max(0, index - 1)]
            : focusableNodes[Math.min(focusableNodes.length - 1, index + 1)];
    if (next !== undefined) focusNode(next.id);
  };
  const reconnect = (targetShotId: string | null) => {
    if (linkSource === null || linkSource === targetShotId || locked || stagedShotIds.has(linkSource)) return;
    onCommand({ kind: "move-shot", shotId: linkSource, to: targetShotId === null ? { atStart: true } : { after: targetShotId } });
    setLinkSource(null);
  };
  return (
    <div
      className="fy-swcanvas"
      data-testid="workspace-flow"
      data-layout={compact ? "compact" : "wide"}
      ref={canvas}
      onPointerDownCapture={blockDeleteBackground}
      onMouseDownCapture={blockDeleteBackground}
      onClickCapture={blockDeleteBackground}
      onMouseDown={panFrom}
      onFocusCapture={() => { flowOwnsFocus.current = true; }}
      onBlurCapture={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        if (event.relatedTarget !== null) flowOwnsFocus.current = false;
      }}
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
              if (element === null) nodeControls.current.delete(node.id);
              else nodeControls.current.set(node.id, element);
            }}
            className="fy-swnode"
            data-kind={node.kind}
            data-shot-id={node.shotId}
            data-testid={`flow-node-${node.id}`}
            data-selected={subjectSelectsNode(subject, node, current) ? "true" : undefined}
            data-staged={node.staged ? "true" : undefined}
            style={{ left: node.x, top: node.y, width: NODE[node.kind].w, height: NODE[node.kind].h }}
            role="button"
            tabIndex={
              node.staged || deleteOpen
                ? -1
                : rovingNodeId === node.id
                  ? 0
                  : -1
            }
            aria-label={ariaFor(node, joins.get(node.id))}
            aria-disabled={node.staged ? "true" : undefined}
            aria-current={subjectSelectsNode(subject, node, current) ? "true" : undefined}
            onMouseDown={(event) => !node.staged && dragNode(node, event)}
            onDragOver={(event) => {
              if ((node.kind === "entry" || node.shotId !== undefined) && linkSource !== null) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (node.kind === "entry" || node.shotId !== undefined) reconnect(node.shotId ?? null);
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (deleteOpen || node.staged || locked) return;
              if ((node.kind === "entry" || node.shotId !== undefined) && linkSource !== null) {
                reconnect(node.shotId ?? null);
                return;
              }
              focusNode(node.id);
            }}
            onKeyDown={(event) => {
              if (deleteOpen || node.staged) return;
              if (
                ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                moveFocus(node.id, event.key);
                return;
              }
              if (node.shotId !== undefined && event.key === "Delete") {
                event.preventDefault();
                deleteReturnNode.current = node.id;
                setDeleteShotId(node.shotId);
                return;
              }
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if ((node.kind === "entry" || node.shotId !== undefined) && linkSource !== null) {
                reconnect(node.shotId ?? null);
                return;
              }
              select(subjectForNode(node));
              if (event.key === "Enter" && node.kind === "shot" && node.shotId !== undefined && !locked && !generatorPending) {
                onOpenShotInGenerator(node.shotId);
              }
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
        {graph.nodes.flatMap((node) => {
          const sockets: ReactNode[] = [];
          if (node.kind === "shot" || node.kind === "exit") {
            sockets.push(
              <span
                key={`in:${node.id}`}
                className="fy-swnode__socket"
                data-port="in"
                style={{ left: node.x - 6, top: node.y + NODE[node.kind].h / 2 - 6 }}
                aria-hidden="true"
              />,
            );
          }
          if (node.kind === "entry") {
            sockets.push(
              <span
                key={`out:${node.id}`}
                className="fy-swnode__socket"
                data-port="out"
                style={{ left: node.x + NODE.entry.w - 6, top: node.y + NODE.entry.h / 2 - 6 }}
                aria-hidden="true"
              />,
            );
          }
          return sockets;
        })}
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
                  disabled={deleteOpen || locked || node.staged}
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
        {graph.nodes.flatMap((node) => {
          const opensShot = node.kind === "shot" && node.shotId !== undefined;
          const rendersBoard = node.kind === "board" && node.memberShotIds !== undefined;
          if (!opensShot && !rendersBoard) return [];
          const label = opensShot ? "Open in generator" : "Render board";
          return [
            <button
              key={`generate:${node.id}`}
              type="button"
              className="fy-swnode__generate"
              style={{ left: node.x, top: node.y - 27 }}
              disabled={deleteOpen || locked || node.staged || generatorPending}
              aria-label={`${label} for ${node.name}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (opensShot) onOpenShotInGenerator(node.shotId!);
                else onRenderBoard([...node.memberShotIds!]);
              }}
            >
              {generatorPending ? "Opening…" : label}
            </button>,
          ];
        })}
      </div>

      {shots.length === 0 ? (
        <div className="fy-swflow__empty" onMouseDown={(event) => event.stopPropagation()}>
          <span>Entry goes straight to Exit.</span>
          <button
            type="button"
            disabled={deleteOpen || locked}
            onClick={() => onCommand({
              kind: "insert-shot",
              at: { atStart: true },
              shot: { title: "Untitled shot", description: "" },
            })}
          >
            Add first shot
          </button>
          <button
            type="button"
            disabled={deleteOpen}
            onClick={() => {
              select({ kind: "scene" });
              onTalkToArke();
            }}
          >
            Talk to Arke
          </button>
        </div>
      ) : null}

      {linkSource === null ? null : (
        <div className="fy-swlinkhint" role="status">
          Move shot {shots.find((shot) => shot.id === linkSource)?.number} after… choose Entry or a shot
          <button type="button" disabled={deleteOpen} onClick={() => setLinkSource(null)}>Cancel</button>
        </div>
      )}
      {deleteShotId === null || !liveShotIds.current.has(deleteShotId) ? null : (
        <div
          ref={deletePanel}
          className="fy-swlinkhint"
          role="alertdialog"
          aria-modal="true"
          aria-label={`Delete shot ${shots.find((shot) => shot.id === deleteShotId)?.number}?`}
        >
          Delete shot {shots.find((shot) => shot.id === deleteShotId)?.number}?
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              if (!liveShotIds.current.has(deleteShotId)) {
                closeDelete(true);
                return;
              }
              onCommand({ kind: "delete-shot", shotId: deleteShotId });
              closeDelete(true);
            }}
          >
            Delete
          </button>
          <button type="button" onClick={() => closeDelete(true)}>Cancel</button>
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
              disabled={deleteOpen || edge.staged}
              onClick={() => !edge.staged && select({ kind: "edge", fromShotId: edge.fromShotId, toShotId: edge.toShotId })}
            >
              {edge.label}
            </button>
          </li>
        ))}
      </ul>

      {/* The zoom control, bottom-left, swallowing its own mousedown so it never pans. */}
      <div className="fy-swzoom" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" aria-label="Zoom out" disabled={deleteOpen || zoom <= ZOOM_MIN} onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - 0.1) * 10) / 10))}>
          −
        </button>
        <span className="fy-swzoom__label">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" disabled={deleteOpen} onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z + 0.1) * 10) / 10)))}>
          +
        </button>
        <button type="button" className="fy-swzoom__fit" disabled={deleteOpen} onClick={() => { setMoved({}); fitNodes(arrangedGraph.nodes); }}>
          Fit
        </button>
      </div>
    </div>
  );
}

/** What a node announces: its kind, what it is, and how it is joined (R-63). */
function ariaFor(node: FlowNode, joins: { incoming: number; outgoing: number } | undefined): string {
  return `${node.name}, ${node.kind}, ${node.meta}, ${joins?.incoming ?? 0} in, ${joins?.outgoing ?? 0} out`;
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
  sequence: { entryNodeId: string; exitNodeId: string; shots: readonly SceneSequenceShot[] };
  production: ProductionBundle;
  sheets: readonly Sheet[];
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
  boardPack: WorkspaceBoardPack;
  moved: Record<string, { x: number; y: number }>;
  stagedShotIds: ReadonlySet<string>;
  newShotIds: ReadonlySet<string>;
  stagedBoards: boolean;
  compact: boolean;
}): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const { sequence, production, sheets, artifacts, slug, moved, boardPack, stagedShotIds, newShotIds, stagedBoards, compact } = input;
  const shots = sequence.shots.map((pair) => pair.shot);
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const at = (id: string, x: number, y: number) => moved[id] ?? { x, y };
  const shotX = compact ? 20 : 400;
  // The generator control occupies the lane above each Shot; these gaps keep it clear of Entry
  // and of the preceding node instead of placing an interactive control over another target.
  const shotStartY = 104;
  const shotPitch = 138;

  // References use the prototype's two-column lane wide and one compact context lane narrow.
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
    const point = at(
      `r:${sheetId}`,
      compact ? 280 : 20 + (index % 2) * 172,
      compact ? 24 + index * 196 : 24 + Math.floor(index / 2) * 196,
    );
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

  // The canonical sequence, terminals included. Legacy scenes receive the same deterministic IDs
  // that migration will write, so the projection does not care which storage arm it read.
  const entryPoint = at(sequence.entryNodeId, shotX, 14);
  nodes.push({
    id: sequence.entryNodeId,
    kind: "entry",
    x: entryPoint.x,
    y: entryPoint.y,
    name: "Entry",
    meta: "scene begins",
    staged: false,
  });
  const shotAt = new Map<string, { x: number; y: number }>();
  sequence.shots.forEach(({ nodeId, shot }, index) => {
    const point = at(nodeId, shotX, shotStartY + index * shotPitch);
    shotAt.set(shot.id, point);
    const artifactId = production.selections[shot.id]?.startFrameArtifactId ?? null;
    const artifact = artifactId === null ? undefined : artifacts.find((candidate) => candidate.id === artifactId);
    nodes.push({
      id: nodeId,
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
  const exitPoint = at(sequence.exitNodeId, shotX, shotStartY + shots.length * shotPitch);
  nodes.push({
    id: sequence.exitNodeId,
    kind: "exit",
    x: exitPoint.x,
    y: exitPoint.y,
    name: "Exit",
    meta: "scene ends",
    staged: false,
  });
  const first = shots[0];
  edges.push({
    id: `seq:${sequence.entryNodeId}:${first?.id ?? sequence.exitNodeId}`,
    fromNodeId: sequence.entryNodeId,
    toNodeId: first === undefined ? sequence.exitNodeId : sequence.shots[0]!.nodeId,
    from: entryPoint,
    fromKind: "entry",
    to: first === undefined ? exitPoint : shotAt.get(first.id)!,
    toKind: first === undefined ? "exit" : "shot",
    soft: false,
    label: first === undefined ? "Entry goes to Exit" : `Entry goes to shot ${first.number}`,
    fromShotId: null,
    toShotId: first?.id ?? null,
    staged: first !== undefined && stagedShotIds.has(first.id),
  });
  for (let index = 1; index < shots.length; index += 1) {
    const before = shots[index - 1]!;
    const after = shots[index]!;
    edges.push({
      id: `seq:${before.id}:${after.id}`,
      fromNodeId: sequence.shots[index - 1]!.nodeId,
      toNodeId: sequence.shots[index]!.nodeId,
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
  const last = shots.at(-1);
  if (last !== undefined) {
    edges.push({
      id: `seq:${last.id}:${sequence.exitNodeId}`,
      fromNodeId: sequence.shots.at(-1)!.nodeId,
      toNodeId: sequence.exitNodeId,
      from: shotAt.get(last.id)!,
      fromKind: "shot",
      to: exitPoint,
      toKind: "exit",
      soft: false,
      label: `Shot ${last.number} goes to Exit`,
      fromShotId: last.id,
      toShotId: null,
      staged: stagedShotIds.has(last.id),
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
        fromNodeId: `r:${sheetId}`,
        toNodeId: sequence.shots.find((pair) => pair.shot.id === shotId)!.nodeId,
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
    const contextFloor = compact ? 60 + cited.length * 196 : 0;
    for (const [boardIndex, board] of boardPack.boards.entries()) {
      const members = board.memberShotIds.flatMap((shotId: string) => {
        const point = shotAt.get(shotId);
        return point === undefined ? [] : [{ shotId, point }];
      });
      if (members.length === 0) continue;
      // Letters describe the current layout. Membership is the content identity that survives
      // another board being inserted before this one without lending it a dragged position.
      const memberKey = board.memberShotIds.join(":");
      const boardId = `b:${memberKey}`;
      const clipId = `c:${memberKey}`;
      const mid = members.reduce((sum: number, member: { point: { y: number } }) => sum + member.point.y, 0) / members.length;
      const point = at(
        boardId,
        compact ? 280 : 700,
        compact ? contextFloor + boardIndex * 296 : mid + 4,
      );
      nodes.push({
        id: boardId,
        kind: "board",
        x: point.x,
        y: point.y,
        name: `Board ${board.letter}`,
        meta: `${board.memberShotIds.length} cells`,
        memberShotIds: [...board.memberShotIds],
        staged: stagedBoards || board.memberShotIds.some((shotId) => stagedShotIds.has(shotId)),
      });
      for (const member of members) {
        edges.push({
          id: `e:${member.shotId}:${boardId}`,
          fromNodeId: sequence.shots.find((pair) => pair.shot.id === member.shotId)!.nodeId,
          toNodeId: boardId,
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
      const clipPoint = at(clipId, compact ? 280 : 960, compact ? point.y + 102 : point.y + 6);
      nodes.push({
        id: clipId,
        kind: "clip",
        x: clipPoint.x,
        y: clipPoint.y,
        name: `Clip ${board.letter}`,
        meta: rendered ? "rendered" : "not rendered",
        staged: stagedBoards || board.memberShotIds.some((shotId) => stagedShotIds.has(shotId)),
      });
      edges.push({
        id: `e:${boardId}:${clipId}`,
        fromNodeId: boardId,
        toNodeId: clipId,
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
