import { useEffect, useMemo, useRef, useState } from "react";
import {
  AmbientLight,
  BoxGeometry,
  CameraHelper,
  Color,
  CylinderGeometry,
  DirectionalLight,
  GridHelper,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  DEFAULT_SHOT_SEC,
  effectiveFraming,
  framingClause,
  orderedShots,
  resolveCast,
  type SceneRecord,
  type Sheet,
  type Shot,
} from "@arke-studio/contracts";
import { selectedShotId, useWorkspaceSelection } from "./selection.js";
import { Play, X } from "../../components/icons.js";

function aspectNumber(aspect: string): number {
  const [wide, high] = aspect.split(":").map(Number);
  return Number.isFinite(wide) && Number.isFinite(high) && high! > 0 ? wide! / high! : 16 / 9;
}

function lensFov(shot: Shot): number {
  const lens = shot.framing?.lens ?? shot.camera ?? "";
  const millimetres = Number.parseFloat(/([\d.]+)\s*mm/i.exec(lens)?.[1] ?? "");
  if (!Number.isFinite(millimetres) || millimetres <= 0) return 46;
  return Math.max(18, Math.min(82, 2 * Math.atan(18 / millimetres) * 180 / Math.PI));
}

function cameraDistance(shot: Shot): number {
  const words = `${shot.framing?.size ?? ""} ${shot.camera ?? ""}`.toLowerCase();
  if (words.includes("extreme close") || words.includes("ecu")) return 1.7;
  if (words.includes("close") || words.includes("mcu") || words.includes("cu")) return 2.8;
  if (words.includes("wide") || words.includes("ws")) return 7;
  return 4.5;
}

function addStandIn(scene: Scene, index: number, total: number): void {
  const group = new Group();
  const spacing = 1.35;
  group.position.set((index - (total - 1) / 2) * spacing, 0, index % 2 === 0 ? 0 : -0.45);
  const material = new MeshStandardMaterial({ color: index % 2 === 0 ? 0xc9a66b : 0x7e9ba8, roughness: 0.86 });
  const body = new Mesh(new CylinderGeometry(0.25, 0.34, 1.25, 20), material);
  body.position.y = 0.72;
  body.castShadow = true;
  const head = new Mesh(new SphereGeometry(0.24, 20, 14), material);
  head.position.y = 1.56;
  head.castShadow = true;
  group.add(body, head);
  scene.add(group);
}

function movementPosition(shot: Shot, elapsed: number, distance: number): [number, number, number] {
  const movement = `${shot.framing?.movement ?? ""} ${shot.camera ?? ""}`.toLowerCase();
  if (movement.includes("push") || movement.includes("dolly in")) return [0, 1.55, distance - elapsed * Math.min(1.5, distance * 0.28)];
  if (movement.includes("pull") || movement.includes("dolly out")) return [0, 1.55, distance + elapsed * 1.5];
  if (movement.includes("pan") || movement.includes("truck")) return [-1.2 + elapsed * 2.4, 1.55, distance];
  if (movement.includes("crane") || movement.includes("tilt")) return [0, 1.25 + elapsed * 1.5, distance];
  return [0, 1.55, distance];
}

/**
 * A derived technical previs, never a second owner for shot framing. The authored camera and cast
 * determine the block; orbiting and playing it are inspection gestures and write nothing.
 */
export function SceneStage({
  scene,
  sheets,
  aspect,
}: {
  scene: SceneRecord;
  sheets: readonly Sheet[];
  aspect: string;
}) {
  const shots = orderedShots(scene);
  const { subject, select } = useWorkspaceSelection();
  const selected = selectedShotId(subject);
  const shot = shots.find((candidate) => candidate.id === selected) ?? shots[0] ?? null;
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const progress = useRef<HTMLSpanElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [viewRevision, setViewRevision] = useState(0);
  const framing = shot === null ? {} : effectiveFraming(scene, shot);
  const framingText = shot === null ? "No shot selected" : framingClause(framing) || shot.camera || "Camera not blocked yet";
  const references = useMemo(
    () => shot === null ? [] : resolveCast(shot.description, [...sheets]).cast,
    [shot, sheets],
  );
  const cast = references.filter((entry) => entry.sheet.type === "character");
  const castKey = cast.map((entry) => entry.sheet.id).join("\u0000");

  useEffect(() => {
    const target = canvas.current;
    if (target === null || shot === null || typeof target.getContext !== "function") return;
    let context: WebGL2RenderingContext | WebGLRenderingContext | null = null;
    try {
      context = target.getContext("webgl2") ?? target.getContext("webgl");
    } catch {
      return;
    }
    if (context === null) return;

    const renderer = new WebGLRenderer({ canvas: target, context, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    const world = new Scene();
    world.background = new Color(0x15171a);
    world.add(new AmbientLight(0xf5ead7, 1.3));
    const key = new DirectionalLight(0xffe0ab, 3.2);
    key.position.set(4, 7, 5);
    key.castShadow = true;
    world.add(key);

    const floor = new Mesh(
      new PlaneGeometry(18, 18),
      new MeshStandardMaterial({ color: 0x26292d, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    world.add(floor);
    const grid = new GridHelper(18, 18, 0x59616a, 0x34383d);
    grid.position.y = 0.005;
    world.add(grid);

    const locationMaterial = new MeshStandardMaterial({ color: 0x4a5056, roughness: 0.95 });
    for (const [x, z, width, depth, height] of [
      [-2.8, -1.7, 1.8, 0.45, 1.1],
      [2.8, -1.4, 1.4, 0.6, 1.8],
      [0, 2.2, 5.8, 0.3, 0.65],
    ] as const) {
      const block = new Mesh(new BoxGeometry(width, height, depth), locationMaterial);
      block.position.set(x, height / 2, z);
      block.castShadow = true;
      block.receiveShadow = true;
      world.add(block);
    }
    const standIns = Math.max(1, cast.length);
    for (let index = 0; index < standIns; index += 1) addStandIn(world, index, standIns);

    const ratio = aspectNumber(aspect);
    const distance = cameraDistance(shot);
    const shotCamera = new PerspectiveCamera(lensFov(shot), ratio, 0.1, 100);
    shotCamera.position.set(0, 1.55, distance);
    shotCamera.lookAt(0, 0.95, 0);
    const helper = new CameraHelper(shotCamera);
    helper.visible = !playing;
    world.add(helper);

    const blockingCamera = new PerspectiveCamera(42, 1, 0.1, 100);
    blockingCamera.position.set(7.2, 5.4, 8.4);
    blockingCamera.lookAt(0, 0.8, 0);
    const controls = new OrbitControls(blockingCamera, target);
    controls.target.set(0, 0.8, 0);
    controls.enabled = !playing;

    const size = () => {
      const width = Math.max(320, target.clientWidth || target.parentElement?.clientWidth || 720);
      const height = Math.max(240, target.clientHeight || target.parentElement?.clientHeight || 440);
      renderer.setSize(width, height, false);
      blockingCamera.aspect = width / height;
      blockingCamera.updateProjectionMatrix();
      renderer.render(world, playing ? shotCamera : blockingCamera);
    };
    size();
    window.addEventListener("resize", size);

    let frame = 0;
    let started = 0;
    const durationMs = Math.max(500, (shot.durationSec ?? DEFAULT_SHOT_SEC) * 1000);
    const render = (now: number) => {
      if (playing) {
        if (started === 0) started = now;
        const elapsed = Math.min(1, (now - started) / durationMs);
        const [x, y, z] = movementPosition(shot, elapsed, distance);
        shotCamera.position.set(x, y, z);
        shotCamera.lookAt(0, 0.95, 0);
        if (progress.current !== null) progress.current.style.width = `${elapsed * 100}%`;
        renderer.render(world, shotCamera);
        if (elapsed >= 1) {
          setPlaying(false);
          return;
        }
      }
      if (playing) frame = requestAnimationFrame(render);
    };
    const renderBlocking = () => renderer.render(world, blockingCamera);
    controls.addEventListener("change", renderBlocking);
    if (playing) frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", size);
      controls.removeEventListener("change", renderBlocking);
      controls.dispose();
      world.traverse((object) => {
        const mesh = object as Mesh;
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material === undefined ? [] : [mesh.material];
        for (const material of materials) material.dispose();
      });
      renderer.dispose();
    };
  }, [aspect, castKey, playing, shot, viewRevision]);

  useEffect(() => {
    setPlaying(false);
    if (progress.current !== null) progress.current.style.width = "0%";
  }, [shot?.id]);

  if (shot === null) {
    return <div className="fy-swstage fy-swstage--empty" data-testid="workspace-stage">Add a shot to begin blocking.</div>;
  }

  return (
    <section className="fy-swstage" data-testid="workspace-stage" aria-label="Scene blocking stage">
      <header className="fy-swstage__head">
        <div>
          <h2>Blocking stage</h2>
          <span>derived preview · framing stays on the shot</span>
        </div>
        <button type="button" className="fy-swstage__reset" disabled={playing} onClick={() => setViewRevision((revision) => revision + 1)}>
          Reset view
        </button>
        <button type="button" className="fy-swstage__play" onClick={() => setPlaying((current) => !current)}>
          {playing ? <X size={13} /> : <Play size={13} />}
          {playing ? "Stop" : "Playblast"}
        </button>
      </header>
      <div className="fy-swstage__work">
        <div className="fy-swstage__viewport" data-playing={playing ? "true" : undefined}>
          <canvas ref={canvas} aria-label={`Three-dimensional blocking preview for shot ${shot.number}`} />
          <span className="fy-swstage__shot">shot {shot.number}</span>
          <span className="fy-swstage__mode">{playing ? "camera · playblast" : "blocking · orbit"}</span>
          <span className="fy-swstage__progress" aria-hidden="true"><span ref={progress} /></span>
        </div>
        <aside className="fy-swstage__inspector">
          <span className="fy-swstage__eyebrow">Current shot</span>
          <h3>{shot.number} · {shot.title}</h3>
          <p>{framingText}</p>
          <dl>
            <div><dt>Duration</dt><dd>{(shot.durationSec ?? DEFAULT_SHOT_SEC).toFixed(1)}s</dd></div>
            <div><dt>Aspect</dt><dd>{aspect}</dd></div>
            <div><dt>Stand-ins</dt><dd>{Math.max(1, cast.length)}</dd></div>
          </dl>
          <span className="fy-swstage__eyebrow">On stage</span>
          <div className="fy-swstage__cast">
            {cast.length === 0 ? <span>unassigned stand-in</span> : cast.map((entry) => <span key={entry.sheet.id}>{entry.sheet.name}</span>)}
          </div>
          <p className="fy-swstage__hint">Drag to orbit · wheel to move · Playblast uses the authored camera move.</p>
        </aside>
      </div>
      <div className="fy-swstage__shots" aria-label="Shots on stage">
        {shots.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            data-current={candidate.id === shot.id ? "true" : undefined}
            onClick={() => select({ kind: "shot", shotId: candidate.id })}
          >
            <span>{candidate.number}</span>
            <strong>{candidate.title}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}
