import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { orderedShots, propSlug, parseMentions, type Prop, type PropState, type Take, type WorldBundle } from "@arke-studio/contracts";
import { Portrait } from "../components/portrait.js";
import { Button, Callout } from "../components/ui.js";
import { useOpenWorldGuard } from "../lib/selectors.js";
import { acceptPropState, addPropState, createProp, importPropStateCandidate } from "../lib/store.js";

/**
 * Props (design turn 105, Option C; issue 537): a name and ordered states, each with the one
 * accepted reference dispatch reads for it. Attaching reuses the location kit's idiom — the
 * picture lands as a pending take, and accepting it onto a state that already has one says what
 * becomes superseded before it does.
 */

/** The picker belongs to the host, so in the browser there is nothing to open. */
function canPickFiles(): boolean {
  return typeof window !== "undefined" && window.arke !== undefined;
}

/** Where a prop's state is cited: by the shot's own control, or by mention with no state chosen. */
function citations(world: WorldBundle, prop: Prop): Array<{ sceneNumber: number; shotNumber: number; stateId: string | null }> {
  const slug = propSlug(prop.name);
  const out: Array<{ sceneNumber: number; shotNumber: number; stateId: string | null }> = [];
  for (const production of world.productions) {
    for (const scene of production.scenes) {
      for (const shot of orderedShots(scene)) {
        const entry = shot.propStates?.find((candidate) => candidate.propId === prop.id);
        if (entry === undefined && !parseMentions(shot.description).includes(slug)) continue;
        out.push({ sceneNumber: scene.number, shotNumber: shot.number, stateId: entry?.stateId ?? null });
      }
    }
  }
  return out;
}

export function PropsScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const props = world?.props ?? [];
  return (
    <div data-screen="props">
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">
          {world?.meta.name} · {props.length} prop{props.length === 1 ? "" : "s"}
        </div>
        <h1 className="fy-hero__title" style={{ fontSize: 52 }}>
          Props
        </h1>
        <p className="fy-hero__lede" style={{ fontSize: 15, maxWidth: 480 }}>
          A name and its states. Each shot says which state it is in; nothing carries over.
        </p>
      </div>
      <div className="fy-sheetsec">
        <div className="fy-sheetlabel">New prop</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            aria-label="Prop name"
            placeholder="Polaroid"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            variant="primary"
            disabled={name.trim() === "" || !worldId}
            onClick={() => {
              if (worldId) createProp(worldId, name.trim());
              setName("");
            }}
          >
            Create prop
          </Button>
        </div>
      </div>
      <div className="fy-sheetsec">
        <div className="fy-sheetrefs">
          {props.map((prop) => {
            const cited = citations(world!, prop);
            return (
              <button
                key={prop.id}
                type="button"
                className="fy-sheetref"
                onClick={() => navigate(`/w/${worldId}/props/${prop.id}`)}
              >
                <span style={{ flex: 1, minWidth: 0, font: "500 11.5px var(--font-sans)" }}>{prop.name}</span>
                <span className="fy-mono">
                  {prop.states.length} state{prop.states.length === 1 ? "" : "s"} · cited in {cited.length} shot
                  {cited.length === 1 ? "" : "s"}
                </span>
              </button>
            );
          })}
          {props.length === 0 ? <p className="fy-mono">No props yet.</p> : null}
        </div>
      </div>
    </div>
  );
}

function referencePath(prop: Prop, state: PropState): string | null {
  return state.reference === undefined ? null : `references/${prop.id}/${state.reference.file}`;
}

export function PropDetailScreen() {
  const { worldId, propId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const [stateName, setStateName] = useState("");
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const prop = world?.props.find((candidate) => candidate.id === propId) ?? null;
  if (!world || !worldId || !prop) return <p className="fy-mono">No such prop.</p>;
  const cited = citations(world, prop);
  const scenes = new Set(cited.map((c) => c.sceneNumber)).size;
  const reviewed = new Set(world.referenceReviews.map((review) => review.takeId));
  const pending: Take[] = world.referenceTakes.filter(
    (take) => take.kind === "prop-state" && take.prop?.propId === prop.id && !reviewed.has(take.id) && !skipped.has(take.id),
  );
  return (
    <div data-screen="prop-detail">
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">
          <button type="button" className="fy-sblink" onClick={() => navigate(`/w/${worldId}/props`)}>
            props
          </button>{" "}
          / {prop.name}
        </div>
        <h1 className="fy-hero__title" style={{ fontSize: 44 }}>
          {prop.name}
        </h1>
        <p className="fy-hero__lede fy-mono">
          {prop.states.length} state{prop.states.length === 1 ? "" : "s"} · cited in {scenes} scene{scenes === 1 ? "" : "s"}
        </p>
      </div>

      {pending.map((take) => {
        const state = prop.states.find((candidate) => candidate.id === take.prop?.stateId);
        if (state === undefined || take.media === undefined) return null;
        return (
          <Callout key={take.id} tone="warning" title={`${prop.name} · ${state.name} reference`}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span className="fy-sbref__thumb" style={{ width: 72, height: 72 }}>
                <Portrait worldSlug={world.meta.slug} path={`references/${prop.id}/takes/${take.id}/${take.media}`} label="" radius={6} />
              </span>
              <span style={{ flex: 1 }}>
                <p className="fy-mono">
                  {state.reference === undefined
                    ? `no reference yet for ${state.name} · nothing is superseded`
                    : `Currently ${state.name} · accepted ${state.reference.acceptedAt.slice(0, 10)} · ${state.reference.sourceTakeId ?? state.reference.id} becomes superseded`}
                </p>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      acceptPropState(worldId, prop.id, state.id, { source: "take", takeId: take.id }, state.reference !== undefined)
                    }
                  >
                    Accept this
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSkipped(new Set([...skipped, take.id]))}>
                    Skip
                  </Button>
                </div>
              </span>
            </div>
          </Callout>
        );
      })}

      <div className="fy-sheetsec">
        <div className="fy-sheetlabel">
          States <span className="fy-mono">ordered, that's all</span>
        </div>
        <div className="fy-sheetrefs">
          {prop.states.map((state) => {
            const path = referencePath(prop, state);
            const uses = cited.filter((c) => c.stateId === state.id);
            return (
              <div key={state.id} className="fy-sheetref" data-testid={`prop-state-${state.id}`}>
                <span className="fy-sbref__thumb" style={{ width: 40, height: 40 }}>
                  {path === null ? (
                    <span className="fy-mono">NO REF</span>
                  ) : (
                    <Portrait worldSlug={world.meta.slug} path={path} label={state.name} radius={6} />
                  )}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", font: "500 11.5px var(--font-sans)" }}>{state.name}</span>
                  <span className="fy-mono">
                    {uses.length === 0
                      ? "not used yet"
                      : `used by shot ${uses[0]!.shotNumber}, scene ${uses[0]!.sceneNumber}${uses.length > 1 ? ` +${uses.length - 1}` : ""}`}
                    {state.reference === undefined ? "" : ` · ${state.reference.sourceTakeId ?? state.reference.id}`}
                  </span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canPickFiles()}
                  title={canPickFiles() ? undefined : "Upload is available in the desktop app"}
                  onClick={() => importPropStateCandidate(worldId, prop.id, state.id)}
                >
                  {state.reference === undefined ? "Attach" : "Replace"}
                </Button>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              aria-label="New state name"
              placeholder="on-fridge"
              value={stateName}
              onChange={(e) => setStateName(e.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={stateName.trim() === ""}
              onClick={() => {
                addPropState(worldId, prop.id, stateName.trim());
                setStateName("");
              }}
            >
              + Add a state
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
