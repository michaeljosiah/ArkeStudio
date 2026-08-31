import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { orderedShots,
  layoutRouting,
  productionShape,
  routingFindings,
  type Routing,
  type RoutingFinding,
} from "@arke-studio/contracts";
import { EmptyState, Screen } from "../components/layout.js";
import { Badge, Button, Callout } from "../components/ui.js";
import { mediaTakeFor, useProduction } from "../lib/selectors.js";
import {
  exportInteractive,
  listRoutingFindings,
  recordTraversal,
  saveRouting,
  subscribeInteractiveExports,
  subscribeRoutingFindings,
} from "../lib/store.js";
import { mediaUrl } from "../lib/media.js";

/**
 * The branch map (epic 401; brief §3; design turn 84): Interactive video's structural authority
 * and nobody else's. Deterministic layered layout — the same graph always draws the same
 * picture — with the named findings beside it (never a score), route preview that records
 * traversal evidence, and the self-hostable export behind the findings gate.
 */

const EMPTY_ROUTING = (start: string): Routing => ({
  version: 1,
  start,
  choices: [],
  endings: [],
  excluded: [],
  groups: [],
});

export function BranchMapScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const [served, setServed] = useState<RoutingFinding[] | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ sceneId: string; route: string[] } | null>(null);
  const [draft, setDraft] = useState({ from: "", label: "", to: "" });
  /** The one option the map keeps in the tab order; the arrows move it (brief §3, IV-M2). */
  const [focused, setFocused] = useState<string | null>(null);

  useEffect(() => {
    if (!worldId || !prodId) return;
    // A fresh production starts from nothing: keeping the previous production's findings,
    // export note and preview showed A's state gating B until B's first event arrived.
    setServed(null);
    setExportNote(null);
    setPreview(null);
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
  // The findings the server folded (traversal evidence included) win; until they arrive, the
  // same pure fold runs here without evidence, so the map never renders beside a blank panel.
  const findings = useMemo<RoutingFinding[]>(() => {
    if (served !== null) return served;
    if (!routing || !production) return [];
    return routingFindings(routing, production.scenes, []);
  }, [served, routing, production]);
  const layout = useMemo(
    () => (routing && production ? layoutRouting(routing, production.scenes) : null),
    [routing, production],
  );

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
  const scenes = production.scenes;
  if (routing === null || scenes.length === 0) {
    return (
      <div className="fy-prodmain" data-screen="branch-map">
        <div className="fy-h1row">
          <h1 className="fy-h1">Branch map</h1>
        </div>
        {scenes.length === 0 ? (
          <EmptyState title="No scenes yet" hint="Write the first scene; the map draws from scenes." />
        ) : (
          <Callout title="Draw the first choice from the start scene">
            <Button
              variant="primary"
              onClick={() => worldId && prodId && saveRouting(worldId, prodId, EMPTY_ROUTING(scenes[0]!.id))}
            >
              Start at {scenes[0]!.title}
            </Button>
          </Callout>
        )}
      </div>
    );
  }

  const endings = new Set(routing.endings.map((entry) => entry.sceneId));
  const excluded = new Map(routing.excluded.map((entry) => [entry.sceneId, entry.reason]));
  const sceneTitle = (id: string) => scenes.find((scene) => scene.id === id)?.title ?? id;
  const commit = (next: Routing) => worldId && prodId && saveRouting(worldId, prodId, next);
  const blockers = findings.filter((finding) => finding.severity === "blocks");

  /*
   * The map in one flat order: layers left to right, each layer top to bottom, unplaced last —
   * exactly the order the layout draws and the DOM renders, so the keyboard walks the picture
   * rather than a second opinion about it (brief §3, IV-M2).
   */
  const walkOrder = [...layout!.layers, layout!.unplaced].flat();
  // Before anybody has moved, the tab stop is the first option — the start scene's layer. A
  // `focused` that no longer exists (an edge was removed under it) falls back the same way.
  const tabStop = focused !== null && walkOrder.includes(focused) ? focused : walkOrder[0];

  const previewScene = preview !== null ? scenes.find((scene) => scene.id === preview.sceneId) : null;
  const previewMedia = (() => {
    if (!previewScene) return null;
    const takeId = orderedShots(previewScene)
      .map((shot) => production.selections[shot.id]?.acceptedTakeId ?? null)
      .find((id) => id !== null);
    const take = takeId != null ? production.takes.find((t) => t.id === takeId) : undefined;
    const mediaTake = take === undefined ? null : mediaTakeFor(production, take);
    return mediaTake !== null
      ? mediaUrl(world.meta.slug, `productions/${production.meta.id}/takes/${mediaTake.id}/${mediaTake.media}`)
      : null;
  })();

  return (
    <div className="fy-prodmain" data-screen="branch-map">
      <div className="fy-h1row">
        <h1 className="fy-h1">Branch map</h1>
        <span className="fy-h1row__meta">
          {routing.choices.length} choice{routing.choices.length === 1 ? "" : "s"} · {routing.endings.length} ending
          {routing.endings.length === 1 ? "" : "s"} · v{routing.version}
        </span>
        <span className="fy-h1row__push" />
        <Button
          variant="primary"
          disabled={blockers.length > 0}
          onClick={() => worldId && prodId && exportInteractive(worldId, prodId)}
        >
          {blockers.length > 0 ? `Export blocked · ${blockers.length}` : "Export web package"}
        </Button>
      </div>
      {exportNote !== null && <div className="fy-mono">{exportNote}</div>}

      {/* The map: layers left to right, a listbox to the keyboard (brief §3). */}
      <div role="listbox" aria-label="Branch map" style={{ display: "flex", gap: 18, overflowX: "auto", padding: "10px 0" }}>
        {[...layout!.layers, layout!.unplaced].map(
          (layer, layerIndex) =>
            layer.length > 0 && (
              <div key={layerIndex} style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 220 }}>
                {layer.map((sceneId) => (
                  <div
                    key={sceneId}
                    role="option"
                    aria-selected={preview?.sceneId === sceneId}
                    data-scene={sceneId}
                    /*
                     * One stop for the whole map, and the arrows move within it (IV-M2). Every
                     * option carrying tabIndex={0} put a fifty-node graph fifty presses deep in
                     * the page's tab order, which is what a listbox exists to avoid: Tab reaches
                     * the map, the arrows walk it, Home and End jump to the start and the last.
                     */
                    tabIndex={sceneId === tabStop ? 0 : -1}
                    onFocus={() => setFocused(sceneId)}
                    onKeyDown={(event) => {
                      const step =
                        event.key === "ArrowDown" || event.key === "ArrowRight"
                          ? 1
                          : event.key === "ArrowUp" || event.key === "ArrowLeft"
                            ? -1
                            : 0;
                      let next: string | undefined;
                      if (step !== 0) {
                        // Clamped, not wrapped: an arrow at the end of a graph should feel like
                        // the end of the graph.
                        const at = walkOrder.indexOf(sceneId);
                        next = walkOrder[Math.min(walkOrder.length - 1, Math.max(0, at + step))];
                      } else if (event.key === "Home") next = walkOrder[0];
                      else if (event.key === "End") next = walkOrder[walkOrder.length - 1];
                      else if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setPreview({ sceneId, route: [] });
                        return;
                      }
                      if (next === undefined || next === sceneId) return;
                      event.preventDefault();
                      setFocused(next);
                      const el = event.currentTarget.closest('[role="listbox"]')?.querySelector(
                        `[role="option"][data-scene="${CSS.escape(next)}"]`,
                      );
                      if (el instanceof HTMLElement) el.focus();
                    }}
                    className="fy-boardcard"
                    style={{
                      opacity: excluded.has(sceneId) ? 0.5 : 1,
                      outline: routing.start === sceneId ? "2px solid var(--foreground)" : undefined,
                    }}
                  >
                    <div className="fy-boardcard__head">
                      {sceneTitle(sceneId)}
                      {routing.start === sceneId && <Badge tone="outline">start</Badge>}
                      {endings.has(sceneId) && <Badge tone="outline">ending</Badge>}
                      {excluded.has(sceneId) && <Badge tone="outline">excluded</Badge>}
                    </div>
                    {excluded.has(sceneId) && <div className="fy-boardcard__mono">{excluded.get(sceneId)}</div>}
                    <div className="fy-boardcard__mono">
                      {routing.choices
                        .filter((choice) => choice.from === sceneId)
                        .map((choice) => (
                          <span key={choice.id}>
                            → {choice.label} → {sceneTitle(choice.to)}{" "}
                            <button
                              type="button"
                              className="fy-linkbtn"
                              onClick={() =>
                                commit({ ...routing, choices: routing.choices.filter((c) => c.id !== choice.id) })
                              }
                            >
                              remove
                            </button>
                            {"\n"}
                          </span>
                        ))}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Button variant="ghost" onClick={() => setPreview({ sceneId, route: [] })}>
                        Preview from here
                      </Button>
                      {!endings.has(sceneId) ? (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            commit({
                              ...routing,
                              endings: [...routing.endings, { sceneId, title: sceneTitle(sceneId) }],
                            })
                          }
                        >
                          Mark ending
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            commit({ ...routing, endings: routing.endings.filter((e) => e.sceneId !== sceneId) })
                          }
                        >
                          Unmark ending
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ),
        )}
      </div>

      {/* Draw a choice: from, the words, to — a routing.json commit through the gate. */}
      <div className="fy-listhead">New choice</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select aria-label="From scene" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })}>
          <option value="">from…</option>
          {scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>
              {scene.title}
            </option>
          ))}
        </select>
        <input
          aria-label="Choice label"
          placeholder="the words the player reads"
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
        <select aria-label="To scene" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })}>
          <option value="">to…</option>
          {scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>
              {scene.title}
            </option>
          ))}
        </select>
        <Button
          disabled={draft.from === "" || draft.to === "" || draft.label.trim() === ""}
          onClick={() => {
            const slug = draft.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "choice";
            // Unique by suffix, not by count: after a removal, length+1 repeats an id already
            // in use, and the per-edge "remove" then deletes both edges at once.
            const taken = new Set(routing.choices.map((choice) => choice.id));
            let id = `ch_${slug}`;
            for (let n = 2; taken.has(id); n++) id = `ch_${slug}-${n}`;
            commit({
              ...routing,
              choices: [...routing.choices, { id, from: draft.from, label: draft.label.trim(), to: draft.to }],
            });
            setDraft({ from: "", label: "", to: "" });
          }}
        >
          Add choice
        </Button>
      </div>

      {/* Named findings (brief §4): evidence, severity, never a number. */}
      <div className="fy-listhead">Findings</div>
      {findings.length === 0 ? (
        <div className="fy-mono">Nothing to report — every check passed.</div>
      ) : (
        findings.map((finding, index) => (
          <div key={`${finding.kind}-${index}`} className="fy-listrow">
            <Badge tone={finding.severity === "blocks" ? "danger" : "outline"}>
              {finding.severity === "blocks" ? "blocks publication" : "warns"}
            </Badge>
            <span className="fy-listrow__text">{finding.detail}</span>
          </div>
        ))
      )}

      {/* Route preview (brief §5): plays footage, offers choices, records evidence. */}
      {preview !== null && (
        <>
          <div className="fy-listhead">
            Preview · {sceneTitle(preview.sceneId)}
            {preview.route.length > 0 && <span className="fy-mono"> · route {preview.route.join(" → ")}</span>}
          </div>
          {previewMedia !== null ? (
            <video key={previewMedia} src={previewMedia} controls style={{ maxWidth: 640, background: "var(--foreground)" }} />
          ) : (
            <div className="fy-mono">No accepted footage for this scene yet — the choices still walk.</div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {routing.choices
              .filter((choice) => choice.from === preview.sceneId)
              .map((choice) => (
                <Button
                  key={choice.id}
                  onClick={() => {
                    // The route is SCENE ids — the evidence schema's vocabulary. Accumulating
                    // choice ids here made the second click send a frame the wire refused.
                    const walked = [...preview.route, preview.sceneId];
                    if (worldId && prodId) {
                      recordTraversal(worldId, prodId, choice.id, choice.from, choice.to, walked);
                    }
                    setPreview({ sceneId: choice.to, route: walked });
                  }}
                >
                  {choice.label}
                </Button>
              ))}
            {routing.choices.every((choice) => choice.from !== preview.sceneId) && (
              <span className="fy-mono">{endings.has(preview.sceneId) ? "An ending." : "No choices from here."}</span>
            )}
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Close preview
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
