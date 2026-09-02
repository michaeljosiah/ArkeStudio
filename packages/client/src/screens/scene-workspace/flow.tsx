import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_SHOT_SEC,
  effectiveFraming,
  linearizeSceneFlow,
  resolveCast,
  stagingMoveWord,
  type ArtifactSidecar,
  type ClientMessage,
  type ProductionBundle,
  type SceneRecord,
  type SceneSequenceShot,
  type Sheet,
} from "@arke-studio/contracts";
import { Divider, Expand, Info, More, Move, PlaySolid, Plus } from "../../components/icons.js";
import { Button } from "../../components/ui.js";
import { sheetPortraitPath } from "../../components/portrait.js";
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
 * coordinates out of v1): dragging arranges your view of the scene, and `Arrange` puts it back.
 */

/** Context box sizes follow the prototype; compact terminals complete SPEC-029's sequence. */
const NODE = {
  entry: { w: 112, h: 52 },
  ref: { w: 156, h: 178 },
  shot: { w: 232, h: 96 },
  board: { w: 196, h: 86 },
  clip: { w: 208, h: 152 },
  /** The Stage's staging of a shot: a soft input like a reference, sized as the prototype draws it. */
  block: { w: 152, h: 92 },
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
  /** A shot's title: the line between its name and its camera. */
  title?: string;
  /** Length as the card prints it — a shot's or clip's seconds, a board's against its cap. */
  duration?: string;
  thumb?: string;
  shotId?: string;
  memberShotIds?: string[];
  /** Whether the clip a board renders to exists yet: the card's meta and its run label. */
  rendered?: boolean;
  staged: boolean;
}

interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  act: () => void;
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
const MENU_WIDTH = 196;
const EMPTY_MOVED: Record<string, { x: number; y: number }> = {};

export function SceneFlow({
  scene,
  production,
  sheets,
  artifacts,
  slug,
  boardPack,
  capSec,
  stagedShotIds,
  newShotIds,
  stagedBoards,
  locked,
  generatorPending,
  onCommand,
  onOpenShotInGenerator,
  onOpenStage,
  onRenderBoard,
  onTalkToArke,
  onEditShot,
  onViewBoardSheet,
  onShowBoards,
}: {
  scene: SceneRecord;
  production: ProductionBundle;
  sheets: readonly Sheet[];
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
  boardPack: WorkspaceBoardPack;
  /** The clip limit a board is packed against; a board card prints its seconds beside it. */
  capSec?: number;
  stagedShotIds: ReadonlySet<string>;
  newShotIds: ReadonlySet<string>;
  stagedBoards: boolean;
  locked: boolean;
  generatorPending: boolean;
  onCommand: (command: Command) => boolean;
  onOpenShotInGenerator: (shotId: string) => void;
  /** The Stage: a staging node, the shot menu's entry and the board's all lead there. */
  onOpenStage?: (shotId: string) => void;
  onRenderBoard: (memberShotIds: string[]) => void;
  onTalkToArke: () => void;
  /*
   * The menu and toolbar entries below exist only when the workspace wires them: an entry that
   * did nothing would be a lie, and each leads to a surface this canvas does not own.
   */
  onEditShot?: (shotId: string) => void;
  onViewBoardSheet?: (memberShotIds: string[], trigger: HTMLElement | null) => void;
  onShowBoards?: () => void;
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
  const menuPanel = useRef<HTMLDivElement | null>(null);
  const liveShotIds = useRef(new Set<string>());
  const [pan, setPan] = useState({ x: 24, y: 20 });
  const [zoom, setZoom] = useState(1);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const [linkSource, setLinkSource] = useState<string | null>(null);
  // Where the pointer is, in layer coordinates, while a link is being chosen: the dashed wire.
  const [linkPointer, setLinkPointer] = useState<{ x: number; y: number } | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [deleteShotId, setDeleteShotId] = useState<string | null>(null);
  // One menu at a time: the ground's when nodeId is null, otherwise the node's. Canvas pixels.
  const [menu, setMenu] = useState<{ nodeId: string | null; left: number; top: number } | null>(null);

  const sequenceShots = useMemo(() => sequence.kind === "linear" ? sequence.shots : [], [sequence]);
  const shots = useMemo(() => sequenceShots.map((pair) => pair.shot), [sequenceShots]);
  const compact = canvasSize !== null && canvasSize.width < 700;
  const arrangedGraph = useMemo(
    () => sequence.kind === "linear"
      ? buildGraph({ sequence, scene, production, sheets, artifacts, slug, capSec, moved: EMPTY_MOVED, boardPack, stagedShotIds, newShotIds, stagedBoards, compact })
      : { nodes: [], edges: [] },
    [sequence, scene, production, sheets, artifacts, slug, capSec, boardPack, stagedShotIds, newShotIds, stagedBoards, compact],
  );
  const graph = useMemo(
    () => Object.keys(moved).length === 0 || sequence.kind === "invalid"
      ? arrangedGraph
      : buildGraph({ sequence, scene, production, sheets, artifacts, slug, capSec, moved, boardPack, stagedShotIds, newShotIds, stagedBoards, compact }),
    [arrangedGraph, sequence, scene, production, sheets, artifacts, slug, capSec, moved, boardPack, stagedShotIds, newShotIds, stagedBoards, compact],
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

  const restoreNodeFocus = useCallback((nodeId: string | null) => {
    requestAnimationFrame(() => {
      const preferred = nodeId === null ? undefined : nodeControls.current.get(nodeId);
      if (preferred?.isConnected) preferred.focus();
      else canvas.current?.querySelector<HTMLElement>('.fy-swnode[tabindex="0"]')?.focus();
    });
  }, []);
  const closeDelete = useCallback((restoreFocus: boolean) => {
    setDeleteShotId(null);
    if (restoreFocus) restoreNodeFocus(deleteReturnNode.current);
  }, [restoreNodeFocus]);
  const closeMenu = useCallback((restoreFocus: boolean) => {
    if (restoreFocus && menu !== null) restoreNodeFocus(menu.nodeId);
    setMenu(null);
  }, [menu, restoreNodeFocus]);
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
      restoreNodeFocus(deleteReturnNode.current);
    }
  }, [deleteShotId, restoreNodeFocus, shots]);

  useEffect(() => {
    if (linkSource === null) setLinkPointer(null);
  }, [linkSource]);

  // A menu outlives neither its node nor a click anywhere else; Escape hands focus back.
  const menuNode = menu === null || menu.nodeId === null ? undefined : graph.nodes.find((node) => node.id === menu.nodeId);
  useEffect(() => {
    if (menu !== null && menu.nodeId !== null && (menuNode === undefined || menuNode.staged)) setMenu(null);
  }, [menu, menuNode]);
  useLayoutEffect(() => {
    if (menu === null) return;
    menuPanel.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menu]);
  useEffect(() => {
    if (menu === null) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && menuPanel.current?.contains(event.target)) return;
      setMenu(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener("mousedown", outside, true);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", outside, true);
      window.removeEventListener("keydown", key);
    };
  }, [closeMenu, menu]);

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

  // A press on the ground or a node dismisses the menu here as well as at the document, because a
  // node's press stops propagating before the document ever sees it.
  const panFrom = (event: React.MouseEvent) => {
    if (deleteOpen || event.button !== 0) return;
    setMenu(null);
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
    setMenu(null);
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
  const trackLinkPointer = (event: React.MouseEvent<HTMLDivElement>) => {
    if (linkSource === null) return;
    const box = event.currentTarget.getBoundingClientRect();
    setLinkPointer({ x: (event.clientX - box.left - pan.x) / zoom, y: (event.clientY - box.top - pan.y) / zoom });
  };
  const linkFrom = linkSource === null ? undefined : graph.nodes.find((node) => node.shotId === linkSource);

  /*
   * The context menu (the prototype's §11.6). Shots, boards and clips have one; references,
   * Entry and Exit let a right-click fall through to the ground's. The ground offers `Add shot`
   * at the end rather than "here": positions are session state (§1.16), so a click point is
   * nothing the record could keep. Reference attach and detach are the storyboard's, not this
   * surface's, and are not offered.
   */
  const hasMenu = (node: FlowNode) => !node.staged && (node.kind === "shot" || node.kind === "board" || node.kind === "clip");
  const menuItemsFor = (node: FlowNode | undefined): MenuItem[] => {
    if (node === undefined) {
      const last = shots.at(-1);
      return [
        {
          label: "Add shot",
          disabled: locked,
          act: () => {
            closeMenu(false);
            onCommand({
              kind: "insert-shot",
              at: last === undefined ? { atStart: true } : { after: last.id },
              shot: { title: "Untitled shot", description: "" },
            });
          },
        },
        { label: "Arrange", act: () => { closeMenu(true); setMoved({}); fitNodes(arrangedGraph.nodes); } },
      ];
    }
    if (node.kind === "shot" && node.shotId !== undefined) {
      const shotId = node.shotId;
      return [
        { label: "Open in generator", disabled: locked || generatorPending, act: () => { closeMenu(false); onOpenShotInGenerator(shotId); } },
        ...(onOpenStage === undefined ? [] : [{ label: "Stage this shot", act: () => { closeMenu(false); onOpenStage(shotId); } }]),
        ...(onEditShot === undefined ? [] : [{ label: "Advanced", disabled: locked, act: () => { closeMenu(false); onEditShot(shotId); } }]),
        { label: "Duplicate", disabled: locked, act: () => { closeMenu(true); onCommand({ kind: "duplicate-shot", shotId }); } },
        {
          label: "Delete",
          danger: true,
          disabled: locked,
          // The confirmation takes focus itself and returns it to the node when it closes.
          act: () => { closeMenu(false); deleteReturnNode.current = node.id; setDeleteShotId(shotId); },
        },
      ];
    }
    if ((node.kind === "board" || node.kind === "clip") && node.memberShotIds !== undefined) {
      const members = [...node.memberShotIds];
      return [
        ...(onOpenStage === undefined ? [] : [{ label: "Stage this board", act: () => { closeMenu(false); onOpenStage(members[0]!); } }]),
        { label: "Render board", disabled: locked || generatorPending, act: () => { closeMenu(false); onRenderBoard(members); } },
        ...(onViewBoardSheet === undefined
          ? []
          : [{ label: "View board sheet", act: () => { closeMenu(false); onViewBoardSheet(members, nodeControls.current.get(node.id) ?? null); } }]),
        ...(onShowBoards === undefined ? [] : [{ label: "Show boards", act: () => { closeMenu(false); onShowBoards(); } }]),
      ];
    }
    return [];
  };
  /** The prototype's fitMenu: the menu sits in a clipping box, so it slides in from the edges. */
  const openMenu = (nodeId: string | null, x: number, y: number) => {
    const node = nodeId === null ? undefined : graph.nodes.find((candidate) => candidate.id === nodeId);
    const box = canvas.current?.getBoundingClientRect();
    const width = box !== undefined && box.width > 0 ? box.width : 900;
    const height = box !== undefined && box.height > 0 ? box.height : 600;
    const pad = 8;
    const tall = 44 + menuItemsFor(node).length * 30;
    setMenu({
      nodeId,
      left: Math.max(pad, Math.min(Number.isFinite(x) ? x : 0, width - MENU_WIDTH - 10 - pad)),
      top: Math.max(pad, Math.min(Number.isFinite(y) ? y : 0, height - tall - pad)),
    });
  };
  const openNodeMenu = (node: FlowNode, clientX: number, clientY: number) => {
    setActiveNodeId(node.id);
    select(subjectForNode(node));
    const box = canvas.current?.getBoundingClientRect();
    openMenu(node.id, clientX - (box?.left ?? 0), clientY - (box?.top ?? 0));
  };
  const openNodeMenuFrom = (node: FlowNode, trigger: HTMLElement) => {
    const anchor = trigger.getBoundingClientRect();
    openNodeMenu(node, anchor.left, anchor.bottom + 4);
  };
  const menuItems = menu === null ? [] : menuItemsFor(menuNode);
  const menuTitle = menuNode?.name ?? "canvas";
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
      onMouseMove={trackLinkPointer}
      onDragOver={trackLinkPointer}
      onContextMenu={(event) => {
        event.preventDefault();
        if (deleteOpen) return;
        const box = event.currentTarget.getBoundingClientRect();
        openMenu(null, event.clientX - box.left, event.clientY - box.top);
      }}
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
          {linkFrom === undefined || linkPointer === null ? null : (
            <path
              data-testid="flow-link-wire"
              d={`M${linkFrom.x + NODE.shot.w},${linkFrom.y + NODE.shot.h / 2} L${linkPointer.x},${linkPointer.y}`}
              fill="none"
              stroke="var(--foreground)"
              strokeWidth={1.5}
              strokeDasharray="3 3"
              style={{ pointerEvents: "none" }}
            />
          )}
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
            onContextMenu={(event) => {
              if (deleteOpen || !hasMenu(node)) return;
              event.preventDefault();
              event.stopPropagation();
              openNodeMenu(node, event.clientX, event.clientY);
            }}
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
              // Keys typed on a toolbar button or the run button are that control's, not the node's.
              if (deleteOpen || node.staged || event.target !== event.currentTarget) return;
              if (
                ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                moveFocus(node.id, event.key);
                return;
              }
              if ((event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) && hasMenu(node)) {
                event.preventDefault();
                openNodeMenuFrom(node, event.currentTarget);
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
              if (event.key === "Enter" && node.kind === "block" && node.shotId !== undefined) {
                onOpenStage?.(node.shotId);
              } else if (event.key === "Enter" && node.kind === "shot" && node.shotId !== undefined && !locked && !generatorPending) {
                onOpenShotInGenerator(node.shotId);
              }
            }}
          >
            {nodeTools(node)}
            {nodeBody(node)}
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
                style={{ left: node.x - 7, top: node.y + NODE[node.kind].h / 2 - 7 }}
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
                style={{ left: node.x + NODE.entry.w - 7, top: node.y + NODE.entry.h / 2 - 7 }}
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
                  style={{ left: node.x + NODE.shot.w - 7, top: node.y + NODE.shot.h / 2 - 7 }}
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
      </div>

      <span className="fy-swcanvas__hint" aria-hidden="true">right-click for actions</span>

      {menu === null ? null : (
        <div
          ref={menuPanel}
          className="fy-swcanvas__menu"
          role="menu"
          aria-label={`Actions for ${menuTitle}`}
          style={{ left: menu.left, top: menu.top }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onKeyDown={(event) => {
            const items = [...(menuPanel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            let next: number | null = null;
            if (event.key === "ArrowDown") next = (current + 1) % items.length;
            else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = items.length - 1;
            else if (event.key === "Tab") {
              event.preventDefault();
              closeMenu(true);
              return;
            }
            const item = next === null ? undefined : items[next];
            if (item === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            item.focus();
          }}
        >
          <div className="fy-swcanvas__menu-title">{menuTitle}</div>
          {menuItems.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? "fy-swcanvas__danger" : undefined}
              disabled={item.disabled}
              onClick={item.act}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {shots.length === 0 ? (
        // The design's empty scene, drawn over the canvas so Entry → Exit stays reachable (R-29).
        <div className="fy-sw__empty fy-swflow__empty" onMouseDown={(event) => event.stopPropagation()}>
          <div>
            <h2>Build this scene</h2>
            <p>Tell Arke what happens, or start adding shots yourself. Nothing here needs the assistant.</p>
            <div>
              <Button
                variant="primary"
                size="sm"
                disabled={deleteOpen}
                onClick={() => {
                  select({ kind: "scene" });
                  onTalkToArke();
                }}
              >
                Talk to Arke
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={deleteOpen || locked}
                onClick={() => onCommand({
                  kind: "insert-shot",
                  at: { atStart: true },
                  shot: { title: "Untitled shot", description: "" },
                })}
              >
                Add first shot
              </Button>
            </div>
          </div>
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
        <button type="button" aria-label="Zoom out" title="Zoom out" disabled={deleteOpen || zoom <= ZOOM_MIN} onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - 0.1) * 10) / 10))}>
          <Divider size={13} />
        </button>
        <span className="fy-swzoom__label">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" title="Zoom in" disabled={deleteOpen} onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z + 0.1) * 10) / 10)))}>
          <Plus size={13} />
        </button>
        <span className="fy-swzoom__divider" aria-hidden="true" />
        <button type="button" className="fy-swzoom__fit" title="Reset the layout" disabled={deleteOpen} onClick={() => { setMoved({}); fitNodes(arrangedGraph.nodes); }}>
          Arrange
        </button>
      </div>
    </div>
  );

  /*
   * The hover toolbar (§11.5): a drag handle, then details, open larger and the menu, each only
   * when the node has somewhere for it to go. It hangs above the card and is shown by CSS on
   * hover or focus-within, so the buttons are real tab stops after the node itself.
   */
  function nodeTools(node: FlowNode): ReactNode {
    if (node.staged) return null;
    const members = node.memberShotIds;
    const sheetOpener = (node.kind === "board" || node.kind === "clip") && members !== undefined && onViewBoardSheet !== undefined
      ? (trigger: HTMLElement) => onViewBoardSheet([...members], trigger)
      : null;
    const details = node.kind === "shot" && node.shotId !== undefined && onEditShot !== undefined
      ? { disabled: deleteOpen || locked, act: () => onEditShot(node.shotId!) }
      : node.kind === "block" && node.shotId !== undefined && onOpenStage !== undefined
        ? { disabled: deleteOpen, act: () => onOpenStage(node.shotId!) }
        : sheetOpener === null
          ? null
          : { disabled: deleteOpen, act: sheetOpener };
    return (
      <span className="fy-swnode__tools" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        <span className="fy-swnode__tool fy-swnode__tool--move" title="Drag to move" aria-hidden="true" onMouseDown={(event) => dragNode(node, event)}>
          <Move size={12} />
        </span>
        {details === null ? null : (
          <button
            type="button"
            className="fy-swnode__tool"
            title="Details"
            aria-label={`Details of ${node.name}`}
            disabled={details.disabled}
            onClick={(event) => details.act(event.currentTarget)}
          >
            <Info size={12} />
          </button>
        )}
        {sheetOpener === null ? null : (
          <button
            type="button"
            className="fy-swnode__tool"
            title="Open larger"
            aria-label={`Open ${node.name} larger`}
            disabled={deleteOpen}
            onClick={(event) => sheetOpener(event.currentTarget)}
          >
            <Expand size={12} />
          </button>
        )}
        {hasMenu(node) ? (
          <button
            type="button"
            className="fy-swnode__tool"
            title="More"
            aria-label={`More actions for ${node.name}`}
            aria-haspopup="menu"
            aria-expanded={menu?.nodeId === node.id}
            disabled={deleteOpen}
            onClick={(event) => openNodeMenuFrom(node, event.currentTarget)}
          >
            <More size={12} />
          </button>
        ) : null}
      </span>
    );
  }

  /** The card by kind — the prototype's shot strip, board summary and clip reel (§11.1). */
  function nodeBody(node: FlowNode): ReactNode {
    const staged = node.staged ? <span className="fy-swnode__staged">staged</span> : null;
    const runs = node.kind === "shot" ? node.shotId !== undefined : node.memberShotIds !== undefined;
    const runLabel = node.kind === "shot"
      ? node.thumb === undefined ? "Generate" : "Regenerate"
      : node.kind === "board"
        ? "Render"
        : node.rendered === true ? "Re-render" : "Render clip";
    const run = !runs ? null : (
      <button
        type="button"
        className="fy-swnode__run"
        disabled={deleteOpen || locked || node.staged || generatorPending}
        aria-label={`${runLabel} for ${node.name}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (node.kind === "shot") onOpenShotInGenerator(node.shotId!);
          else onRenderBoard([...node.memberShotIds!]);
        }}
      >
        {generatorPending ? "Opening…" : runLabel}
      </button>
    );
    if (node.kind === "shot") {
      return (
        <>
          <span className="fy-swnode__strip" data-empty={node.thumb === undefined ? "true" : undefined}>
            {node.thumb === undefined ? null : (
              <span className="fy-swnode__frame" role="img" aria-label={node.title ?? node.name} style={{ backgroundImage: `url(${node.thumb})` }} />
            )}
          </span>
          <span className="fy-swnode__text">
            <span className="fy-swnode__head">
              <span className="fy-swnode__name">{node.name}</span>
              <span className="fy-swnode__dur">{node.duration}</span>
            </span>
            <span className="fy-swnode__title">{node.title}</span>
            <span className="fy-swnode__foot">
              <span className="fy-swnode__meta">{node.meta}</span>
              {run}
            </span>
            {staged}
          </span>
        </>
      );
    }
    // The Stage's staging of a shot: the prototype's three figures on a floor, and the way in.
    if (node.kind === "block" && node.shotId !== undefined) {
      const shotId = node.shotId;
      return (
        <>
          <span className="fy-swnode__figures" aria-hidden="true"><i /><i /><i /></span>
          <span className="fy-swnode__foot">
            <span className="fy-swnode__text">
              <span className="fy-swnode__name">{node.name}</span>
              <span className="fy-swnode__meta">{node.meta}</span>
              {staged}
            </span>
            <button
              type="button"
              className="fy-swnode__run"
              disabled={deleteOpen || node.staged || onOpenStage === undefined}
              aria-label={`Open the staging of ${node.name}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onOpenStage?.(shotId);
              }}
            >
              Stage
            </button>
          </span>
        </>
      );
    }
    if (node.kind === "clip") {
      return (
        <>
          <span className="fy-swnode__reel">
            {node.thumb === undefined
              ? <span className="fy-swnode__noframes">no frames yet</span>
              : <span className="fy-swnode__frame" role="img" aria-label={node.name} style={{ backgroundImage: `url(${node.thumb})` }} />}
            <span className="fy-swnode__play" aria-hidden="true"><span><PlaySolid size={12} /></span></span>
            <span className="fy-swnode__corner">{node.duration}</span>
          </span>
          <span className="fy-swnode__foot">
            <span className="fy-swnode__text">
              <span className="fy-swnode__name">{node.name}</span>
              <span className="fy-swnode__meta">{node.meta}</span>
              {staged}
            </span>
            {run}
          </span>
        </>
      );
    }
    return (
      <>
        {node.thumb === undefined ? null : (
          <span className="fy-swnode__thumb" style={{ backgroundImage: `url(${node.thumb})` }} role="img" aria-label={node.name} />
        )}
        <span className="fy-swnode__name">{node.name}</span>
        <span className="fy-swnode__meta">{node.meta}</span>
        {node.duration === undefined ? null : <span className="fy-swnode__dur">{node.duration}</span>}
        {run}
        {staged}
      </>
    );
  }
}

/** What a node announces: its kind, what it is, and how it is joined (R-63). */
function ariaFor(node: FlowNode, joins: { incoming: number; outgoing: number } | undefined): string {
  const said = [node.name, node.kind, node.title, node.meta, node.duration]
    .filter((part): part is string => part !== undefined && part !== "");
  return `${said.join(", ")}, ${joins?.incoming ?? 0} in, ${joins?.outgoing ?? 0} out`;
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
  scene: SceneRecord;
  production: ProductionBundle;
  sheets: readonly Sheet[];
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
  capSec: number | undefined;
  boardPack: WorkspaceBoardPack;
  moved: Record<string, { x: number; y: number }>;
  stagedShotIds: ReadonlySet<string>;
  newShotIds: ReadonlySet<string>;
  stagedBoards: boolean;
  compact: boolean;
}): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const { sequence, scene, production, sheets, artifacts, slug, capSec, moved, boardPack, stagedShotIds, newShotIds, stagedBoards, compact } = input;
  const shots = sequence.shots.map((pair) => pair.shot);
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const at = (id: string, x: number, y: number) => moved[id] ?? { x, y };
  const shotX = compact ? 20 : 400;
  // The prototype's pitch: the hover toolbar overlaps its card, so it needs no lane of its own.
  // The start offset is ours, clearing Entry, which the prototype does not draw.
  const shotStartY = 104;
  const shotPitch = 118;

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
      // The portrait every other screen shows for a sheet; a sheet without one keeps the well.
      ...(slug === undefined ? {} : { thumb: mediaUrl(slug, sheetPortraitPath(sheet.id)) }),
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
  const shotFrame = new Map<string, string>();
  sequence.shots.forEach(({ nodeId, shot }, index) => {
    const point = at(nodeId, shotX, shotStartY + index * shotPitch);
    shotAt.set(shot.id, point);
    const artifactId = production.selections[shot.id]?.startFrameArtifactId ?? null;
    const artifact = artifactId === null ? undefined : artifacts.find((candidate) => candidate.id === artifactId);
    const frame = !newShotIds.has(shot.id) && artifact !== undefined && slug !== undefined
      ? mediaUrl(slug, `artifacts/${artifact.file}`)
      : undefined;
    if (frame !== undefined) shotFrame.set(shot.id, frame);
    const framing = effectiveFraming(scene, shot);
    nodes.push({
      id: nodeId,
      kind: "shot",
      x: point.x,
      y: point.y,
      name: `Shot ${shot.number}`,
      title: shot.title,
      // Size and lens, as the prototype's card says it: the two camera facts a strip this small
      // can carry, and nothing when neither is set — an absent lens is not "default lens".
      meta: [framing.size, framing.lens].filter((value) => value !== undefined && value.trim() !== "").join(" · "),
      duration: `${(shot.durationSec ?? DEFAULT_SHOT_SEC).toFixed(1)}s`,
      shotId: shot.id,
      staged: stagedShotIds.has(shot.id),
      ...(frame === undefined ? {} : { thumb: frame }),
    });
  });
  // A staged shot's blocking, drawn where a reference would go next: it is an input to the shot
  // the way a sheet is, and the reference grid already keeps things clear of one another.
  let contextSlot = cited.length;
  sequence.shots.forEach(({ nodeId, shot }) => {
    if (shot.staging === undefined) return;
    const slot = contextSlot;
    contextSlot += 1;
    const point = at(
      `k:${shot.id}`,
      compact ? 280 : 20 + (slot % 2) * 172,
      compact ? 24 + slot * 196 : 24 + Math.floor(slot / 2) * 196,
    );
    nodes.push({
      id: `k:${shot.id}`,
      kind: "block",
      x: point.x,
      y: point.y,
      name: `Staging · shot ${shot.number}`,
      meta: `${shot.staging.keys.length} keys · ${stagingMoveWord(shot.staging.keys)} · ${shot.staging.playblast === undefined ? "not exported" : "playblast filed"}`,
      shotId: shot.id,
      staged: stagedShotIds.has(shot.id),
    });
    edges.push({
      id: `e:k:${shot.id}`,
      fromNodeId: `k:${shot.id}`,
      toNodeId: nodeId,
      from: point,
      fromKind: "block",
      to: shotAt.get(shot.id)!,
      toKind: "shot",
      soft: true,
      label: `The staging of shot ${shot.number} guides shot ${shot.number}`,
      fromShotId: null,
      toShotId: shot.id,
      staged: stagedShotIds.has(shot.id),
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
      const numbers = board.memberShotIds.flatMap((shotId) => {
        const number = shots.find((shot) => shot.id === shotId)?.number;
        return number === undefined ? [] : [number];
      });
      const range = numbers.length > 1 ? `shots ${numbers[0]}–${numbers.at(-1)}` : `shot ${numbers[0] ?? "?"}`;
      const seconds = `${board.durationSec.toFixed(1)}s`;
      nodes.push({
        id: boardId,
        kind: "board",
        x: point.x,
        y: point.y,
        name: `Board ${board.letter}`,
        meta: `${range} · ${board.memberShotIds.length} cells`,
        duration: capSec === undefined ? seconds : `${seconds} / ${capSec}s`,
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
      // The first member frame stands for the clip, the way the prototype's reel opens on it.
      const frame = board.memberShotIds.map((shotId) => shotFrame.get(shotId)).find((url) => url !== undefined);
      nodes.push({
        id: clipId,
        kind: "clip",
        x: clipPoint.x,
        y: clipPoint.y,
        name: `Clip ${board.letter}`,
        meta: `${rendered ? "rendered" : "not rendered"} · ${seconds}`,
        duration: seconds,
        rendered,
        memberShotIds: [...board.memberShotIds],
        staged: stagedBoards || board.memberShotIds.some((shotId) => stagedShotIds.has(shotId)),
        ...(frame === undefined ? {} : { thumb: frame }),
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
