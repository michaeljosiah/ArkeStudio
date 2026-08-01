import { useMemo, useState } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router";
import {
  assemblePrompt,
  deriveCut,
  modelCapabilityCopy,
  overrideStaleAgainst,
  planScene,
  PRESETS,
  promptFor,
  type Shot,
} from "@arke-studio/contracts";
import { DegradedBanner, EmptyState, PageHeader, Screen, Section } from "../components/layout.js";
import { Badge, Button, Callout, Card, TabPanels, Textarea, cx } from "../components/ui.js";
import { CanonEntryRow, ShotCard, TakeStrip } from "../domain/domain.js";
import { seconds, usd } from "../lib/format.js";
import { acceptedTakeId, isDayOne, takeDecisions, takesForShot, useProduction } from "../lib/selectors.js";
import {
  acceptTake,
  cancelExport,
  compileSceneBoard,
  dispatchScene,
  draftScene,
  exportCut,
  exportSceneBoard,
  exportWorld,
  rejectTake,
  setPromptOverride,
  useExports,
  useStore,
} from "../lib/store.js";

/** Production screens (§2.9): dashboard, story, scenes, generate, cut, audio, exports, stills. */

export function ProductionLayout() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const nav = [
    ["", "Dashboard"],
    ["story", "Story"],
    ["scenes", "Scenes"],
    ["generate", "Generate"],
    ["cut", "Cut"],
    ["audio", "Audio"],
    ["exports", "Exports"],
    ["stills", "Stills"],
  ] as const;
  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", height: "100%" }}>
      <div className="scr-prodbar">
        <NavLink to={`/w/${worldId}/productions`} className="scr-navlink">
          ← {production ? "Productions" : "…"}
        </NavLink>
        <span className="scr-prodbar__title">{production?.meta.title ?? ""}</span>
        {production && <Badge tone="outline">{production.meta.format}</Badge>}
        <nav className="scr-prodbar__nav">
          {nav.map(([slug, label]) => (
            <NavLink
              key={slug}
              to={`/w/${worldId}/p/${prodId}${slug ? `/${slug}` : ""}`}
              end={slug === ""}
              className={({ isActive }) => cx("scr-navlink", isActive && "scr-navlink--active")}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="scr-frame__content">
        <Outlet />
      </div>
    </div>
  );
}

// ---- Dashboard (day-one and established variants, §8.2) --------------------

export function ProductionDashboardScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  if (!world || !production) {
    return (
      <Screen id="production-dashboard">
        <EmptyState title="Opening production…" />
      </Screen>
    );
  }
  const dayOne = isDayOne(production);
  const decisions = takeDecisions(production);
  const pendingReviews = production.takes.filter((t) => decisions[t.id] === "pending").length;
  const shots = production.scenes.flatMap((s) => s.shots);
  const acceptedShots = shots.filter((s) => acceptedTakeId(production, s.id)).length;
  const threads = world.canon.filter((c) => c.status === "open");

  return (
    <Screen id="production-dashboard">
      <PageHeader
        title={production.meta.title}
        meta={
          <>
            <span>{production.meta.logline}</span>
            <Badge tone="outline">{dayOne ? "day one" : production.meta.status}</Badge>
          </>
        }
      />
      {dayOne ? (
        <>
          <Callout title={`Everything ${world.meta.name} knows is already here`}>
            {world.sheets.length} sheets, {world.canon.length} canon entries and the world's tone
            arrived with the production. Start from a seed below, or go straight to Scenes.
          </Callout>
          <Section title="Seeds" aside={<span>open threads and loose ends worth pulling</span>}>
            <div className="scr-sectionlist">
              {threads.map((t) => (
                <CanonEntryRow key={t.id} entry={t} onOpen={() => navigate(`/w/${worldId}/canon/${t.id}/thread`)} />
              ))}
            </div>
          </Section>
        </>
      ) : (
        <>
          <div className="lay-stats">
            <div className="lay-stats__item">
              <div className="lay-stats__value">{production.scenes.length}</div>
              <div className="lay-stats__label">scenes</div>
            </div>
            <div className="lay-stats__item">
              <div className="lay-stats__value">
                {acceptedShots}/{shots.length}
              </div>
              <div className="lay-stats__label">shots accepted</div>
            </div>
            <div className="lay-stats__item">
              <div className="lay-stats__value">{production.takes.length}</div>
              <div className="lay-stats__label">takes</div>
            </div>
            <div className="lay-stats__item">
              <div className="lay-stats__value">{pendingReviews}</div>
              <div className="lay-stats__label">awaiting review</div>
            </div>
          </div>
          {pendingReviews > 0 && (
            <Section title="Needs you">
              <Card onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
                <div style={{ font: "var(--type-ui)" }}>
                  {pendingReviews} take{pendingReviews === 1 ? "" : "s"} waiting for a decision in the
                  generate workspace.
                </div>
              </Card>
            </Section>
          )}
        </>
      )}
    </Screen>
  );
}

// ---- Story & chapters ------------------------------------------------------

export function StoryScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  return (
    <Screen id="story-overview">
      <PageHeader
        title="Story"
        meta={production?.story && <span>overview v{production.story.version}</span>}
        actions={
          production?.meta.format === "story" && (
            <Button onClick={() => navigate(`/w/${worldId}/p/${prodId}/story/chapters`)}>Chapter tree</Button>
          )
        }
      />
      {production?.story && (
        <Card>
          <div className="scr-prose">
            {production.story.logline}
            {production.story.spine ? `\n\n${production.story.spine}` : ""}
          </div>
        </Card>
      )}
      {production?.treatment ? (
        <Card>
          <div className="scr-prose">{production.treatment}</div>
        </Card>
      ) : (
        !production?.story && (
          <EmptyState
            title="No story yet"
            hint="The overview — spine, acts, gaps — is authored through the chat gate and steers drafting (SPEC-012)."
          />
        )
      )}
    </Screen>
  );
}

export function ChapterTreeScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  return (
    <Screen id="chapter-tree">
      <PageHeader
        title="Chapter tree"
        meta={production && <span>{production.chapters.length} chapters</span>}
      />
      {production && production.chapters.length > 0 ? (
        <div className="scr-sectionlist">
          {production.chapters.map((c) => (
            <div key={c.id} className="scr-sheetsection">
              <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "baseline" }}>
                <span className="mono" style={{ color: "var(--muted-foreground)" }}>{String(c.number).padStart(2, "0")}</span>
                <span style={{ font: "var(--type-ui)" }}>{c.title}</span>
                <Badge tone="outline">v{c.version}</Badge>
                <span style={{ marginLeft: "auto", font: "var(--type-label)", color: "var(--muted-foreground)" }}>
                  {c.words ? `${c.words} words` : c.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title={production?.meta.format === "story" ? "No chapters yet" : "Chapters belong to story productions"}
          hint={
            production?.meta.format === "story"
              ? "Chapters hang beneath the overview and are drafted through the gate."
              : "This is a video production — its structure lives in Scenes."
          }
        />
      )}
    </Screen>
  );
}

// ---- Scenes ----------------------------------------------------------------

export function ScenesScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  return (
    <Screen id="scenes">
      <PageHeader
        title="Scenes"
        meta={production && <span>{production.scenes.length} scenes</span>}
        actions={
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/scenes/new`)}>
            New scene
          </Button>
        }
      />
      {production && production.scenes.length > 0 ? (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {production.scenes.map((scene) => (
            <Card key={scene.id} className="scr-worldcard" onClick={() => navigate(`/w/${worldId}/p/${prodId}/scenes/${scene.id}`)}>
              <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
                <span className="mono" style={{ color: "var(--muted-foreground)" }}>{String(scene.number).padStart(2, "0")}</span>
                <span className="scr-worldcard__name">{scene.title}</span>
                <Badge tone="outline">v{scene.version}</Badge>
                {scene.board && <Badge>board v{scene.board.version}</Badge>}
                <span style={{ marginLeft: "auto" }}>
                  <Badge tone={scene.status === "accepted" ? "success" : "neutral"}>{scene.status}</Badge>
                </span>
              </div>
              <div className="scr-worldcard__counts">
                <span>{scene.shots.length} shots</span>
                <span>{seconds(scene.shots.reduce((s, x) => s + (x.durationSec ?? 0), 0))}</span>
                {scene.inherits?.location && <span>@{scene.inherits.location}</span>}
                {scene.inherits?.timeOfDay && <span>{scene.inherits.timeOfDay}</span>}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState title="No scenes yet" hint="Draft a scene and its shots inherit location, time and tone." />
      )}
    </Screen>
  );
}

export function SceneDetailScreen() {
  const { worldId, prodId, sceneId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const scene = production?.scenes.find((s) => s.id === sceneId);
  if (!production || !scene) {
    return (
      <Screen id="scene-detail">
        <EmptyState title="Opening scene…" />
      </Screen>
    );
  }
  return (
    <Screen id="scene-detail">
      <PageHeader
        title={scene.title}
        meta={
          <>
            <span className="mono">{scene.id}</span>
            <Badge tone="outline">v{scene.version}</Badge>
            {scene.inherits?.location && <span>@{scene.inherits.location}</span>}
            {scene.inherits?.tone && <span>{scene.inherits.tone}</span>}
          </>
        }
        actions={
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
            Generate
          </Button>
        }
      />
      <TabPanels
        tabs={[
          {
            id: "shots",
            label: `Shots · ${scene.shots.length}`,
            content: (
              <div style={{ display: "grid", gap: "var(--space-3)" }}>
                {scene.shots.map((shot) => (
                  <ShotCard
                    key={shot.id}
                    shot={shot}
                    accepted={Boolean(acceptedTakeId(production, shot.id))}
                    takeCount={takesForShot(production, shot.id).length}
                    onOpen={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}
                  />
                ))}
              </div>
            ),
          },
          {
            id: "board",
            label: scene.board ? `Board · v${scene.board.version}` : "Board",
            content: (
              <div className="scr-board">
                {scene.board ? (
                  <>
                    <div className="scr-board__image">{scene.board.image}</div>
                    <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
                      {scene.board.version < scene.version ? (
                        <Badge tone="warning">
                          stale — compiled from v{scene.board.version}, scene is at v{scene.version}
                        </Badge>
                      ) : (
                        <span style={{ font: "var(--type-label)", color: "var(--muted-foreground)" }}>
                          compiled {scene.board.compiledAt} · in step with scene v{scene.version}
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <EmptyState title="No board yet" hint="A board compiles from the scene at a point in time." />
                )}
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button
                    onClick={() => {
                      if (worldId && prodId)
                        compileSceneBoard(worldId, prodId, `${String(scene.number).padStart(2, "0")}-${scene.slug}`);
                    }}
                  >
                    Recompile · free, local
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!scene.board}
                    onClick={() => {
                      if (worldId && prodId)
                        exportSceneBoard(worldId, prodId, `${String(scene.number).padStart(2, "0")}-${scene.slug}`);
                    }}
                  >
                    Export sheet · PNG → artifacts
                  </Button>
                </div>
              </div>
            ),
          },
        ]}
      />
    </Screen>
  );
}

export function NewSceneScreen() {
  const { worldId, prodId } = useParams();
  const navigate = useNavigate();
  const [brief, setBrief] = useState("");
  return (
    <Screen id="new-scene">
      <PageHeader title="New scene" />
      <DegradedBanner component="harness" />
      <div className="scr-form">
        <div className="scr-field">
          <label className="scr-field__label">What happens</label>
          <Textarea
            placeholder="Maren takes the dusk watch alone; the verse rises a season early…"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          <span className="scr-field__hint">
            Mention cast with @name — shots compute their cast from live references, never guesses.
            The draft arrives as a proposal; accepting it creates the shots and dispatches nothing.
          </span>
        </div>
        <div>
          <Button
            variant="primary"
            disabled={brief.trim().length === 0}
            onClick={() => {
              if (worldId && prodId) {
                draftScene(worldId, prodId, brief.trim());
                navigate(`/w/${worldId}/p/${prodId}`);
              }
            }}
          >
            Draft scene
          </Button>
        </div>
      </div>
    </Screen>
  );
}

// ---- Generate workspace + dialogs ------------------------------------------

export function GenerateScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const shots = production?.scenes.flatMap((s) => s.shots) ?? [];
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const shotId = selectedShotId ?? shots[0]?.id ?? null;
  const shot = shots.find((s) => s.id === shotId) ?? null;
  const takes = production && shotId ? takesForShot(production, shotId) : [];
  const decisions = production ? takeDecisions(production) : {};
  const selected = production && shotId ? acceptedTakeId(production, shotId) : null;

  return (
    <Screen id="generate-workspace">
      <PageHeader
        title="Generate"
        meta={production && <span>{production.takes.length} takes so far</span>}
        actions={
          <>
            <Button onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/voice-line`)}>Voice line</Button>
            <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/dispatch`)}>
              Dispatch…
            </Button>
          </>
        }
      />
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {shots.map((s) => (
          <Button
            key={s.id}
            variant={s.id === shotId ? "primary" : "secondary"}
            onClick={() => setSelectedShotId(s.id)}
          >
            {s.id.replace("sh_", "shot ")}
          </Button>
        ))}
      </div>
      {shot && (
        <Card className="scr-worldcard">
          <div className="scr-worldcard__name">{shot.title}</div>
          <div className="scr-worldcard__logline">{shot.description}</div>
          <div className="scr-worldcard__counts">
            {shot.camera && <span>{shot.camera}</span>}
            <span>{seconds(shot.durationSec)}</span>
            {shot.audio?.line && <span>“{shot.audio.line}”</span>}
          </div>
        </Card>
      )}
      <Section title="Takes" aside={<span>what came back, and what you decided</span>}>
        <TakeStrip takes={takes} decisions={decisions} selectedTakeId={selected} />
      </Section>
      {shot && production && world && (
        <PromptPanel world={world} production={production} shot={shot} worldId={worldId!} prodId={prodId!} />
      )}
    </Screen>
  );
}

function PromptPanel({
  world,
  production,
  shot,
  worldId,
  prodId,
}: {
  world: NonNullable<ReturnType<typeof useProduction>["world"]>;
  production: NonNullable<ReturnType<typeof useProduction>["production"]>;
  shot: Shot;
  worldId: string;
  prodId: string;
}) {
  const scene = production.scenes.find((s) => s.shots.some((x) => x.id === shot.id))!;
  const sceneFile = `${String(scene.number).padStart(2, "0")}-${scene.slug}`;
  const assembled = assemblePrompt(world.meta, world.sheets, scene, shot);
  const current = promptFor(world.meta, world.sheets, scene, shot);
  const stale = overrideStaleAgainst(shot, world.sheets);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current.text;
  return (
    <Section
      title="Prompt"
      aside={
        current.overridden ? (
          <Badge tone="warning">overridden — edits stay on this shot; the canon doesn't change</Badge>
        ) : (
          <span>assembled from the world; edits stay on the shot</span>
        )
      }
    >
      {stale.length > 0 && (
        <Callout tone="warning" title="This override no longer reflects the world">
          {stale.map((s) => `${s.sheetId} moved v${s.from} → v${s.to}`).join(" · ")} — the assembled prompt
          would pick that up; this override will not.
        </Callout>
      )}
      <Textarea key={shot.id} value={value} onChange={(e) => setDraft(e.target.value)} />
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button
          disabled={value.trim() === assembled || value.trim().length === 0}
          onClick={() => {
            setPromptOverride(worldId, prodId, sceneFile, shot.id, value.trim());
            setDraft(null);
          }}
        >
          Save as override
        </Button>
        <Button
          variant="ghost"
          disabled={!current.overridden && draft === null}
          onClick={() => {
            setPromptOverride(worldId, prodId, sceneFile, shot.id, null);
            setDraft(null);
          }}
        >
          Reset to assembled
        </Button>
      </div>
    </Section>
  );
}

export function DispatchDialogScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const { state } = useStore();
  const navigate = useNavigate();
  const manifest = state?.app.manifest ?? null;
  const routing = state?.app.routing.defaults ?? {};
  const capability = production?.meta.format === "stills" ? "image" : "video";
  const models = (manifest?.models ?? []).filter((m) => m.capability === capability);
  const [sceneIdx, setSceneIdx] = useState(0);
  const [modelId, setModelId] = useState<string | null>(null);
  const scene = production?.scenes[sceneIdx] ?? null;
  const model = models.find((m) => m.id === (modelId ?? routing[capability])) ?? models[0] ?? null;

  // The whole plan, computed live from the world — the same function the coordinator executes.
  const plans = useMemo(() => {
    if (!world || !production || !scene || !model) return null;
    const input = {
      world: world.meta,
      sheets: world.sheets,
      kits: world.referenceKits,
      scene,
      selections: production.selections,
      model,
    };
    return { perShot: planScene(input, "per-shot"), wholeScene: planScene(input, "whole-scene") };
  }, [world, production, scene, model]);

  const sceneFile = scene ? `${String(scene.number).padStart(2, "0")}-${scene.slug}` : null;
  const warnings = plans?.perShot.warnings ?? null;
  const warningRows: Array<{ key: string; text: string }> = [];
  if (warnings) {
    for (const s of warnings.shotsWithoutFrame) warningRows.push({ key: `nf-${s.shotId}`, text: `shot ${s.number} has no accepted frame` });
    for (const name of warnings.sketchCitations) warningRows.push({ key: `sk-${name}`, text: `${name} is a sketch — dispatch cites an unlocked sheet` });
    for (const d of warnings.droppedReferences) warningRows.push({ key: `dr-${d.sheetId}`, text: `${d.sheetId}'s reference is dropped — over the model's cap` });
    for (const g of warnings.staleModelSheets) warningRows.push({ key: `st-${g}`, text: g });
    for (const name of warnings.retiredCitations) warningRows.push({ key: `re-${name}`, text: `${name} is retired and still cited here` });
    for (const u of warnings.unknownMentions) warningRows.push({ key: `un-${u}`, text: `@${u} resolves to nothing — check the description` });
    for (const o of warnings.overriddenStale)
      warningRows.push({
        key: `ov-${o.shotId}`,
        text: `shot ${o.number}'s prompt is overridden and ${o.against.map((a) => `${a.sheetId} moved v${a.from}→v${a.to}`).join(", ")} — the override will not pick that up`,
      });
  }

  return (
    <Screen id="dispatch-dialog">
      <div className="scr-dialogcard">
        <PageHeader
          title="Dispatch"
          meta={
            scene && (
              <span>
                {scene.title} · {scene.shots.length} shots · {seconds(scene.shots.reduce((s, x) => s + (x.durationSec ?? 4), 0))}
              </span>
            )
          }
          actions={<Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>Close</Button>}
        />
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          {(production?.scenes ?? []).map((s, i) => (
            <Button key={s.id} variant={i === sceneIdx ? "primary" : "secondary"} onClick={() => setSceneIdx(i)}>
              {s.title}
            </Button>
          ))}
          <span style={{ marginLeft: "auto" }} />
          {models.map((m) => (
            <Button key={m.id} variant={m.id === model?.id ? "primary" : "ghost"} onClick={() => setModelId(m.id)}>
              {m.displayName} · {modelCapabilityCopy(m)}
            </Button>
          ))}
        </div>
        {warningRows.length > 0 ? (
          <Callout tone="warning" title={`${warningRows.length} thing${warningRows.length === 1 ? "" : "s"} worth knowing — none blocks`}>
            <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
              {warningRows.map((w) => (
                <li key={w.key}>{w.text}</li>
              ))}
            </ul>
          </Callout>
        ) : (
          plans && <Callout title="Clean dispatch">Every cited sheet is locked and current; every reference rides.</Callout>
        )}
        {plans && (
          <div className="scr-tradegrid">
            <Card className="scr-worldcard">
              <div className="scr-worldcard__name">Per shot</div>
              <div className="scr-worldcard__logline">
                One clip per shot, each seeded by its own frame. Any shot retries alone; cast stays pinned per shot.
              </div>
              <div className="scr-worldcard__counts">
                <span>est. {usd(plans.perShot.totalEstimatedMicroUsd)}</span>
              </div>
              <Button
                variant="primary"
                onClick={() => {
                  if (worldId && prodId && sceneFile && model) {
                    dispatchScene(worldId, prodId, sceneFile, "per-shot", model.id);
                    navigate(`/w/${worldId}/p/${prodId}/generate`);
                  }
                }}
              >
                Dispatch per shot · {usd(plans.perShot.totalEstimatedMicroUsd)}
              </Button>
            </Card>
            <Card className="scr-worldcard">
              <div className="scr-worldcard__name">Whole scene</div>
              <div className="scr-worldcard__logline">
                Best motion continuity — but a retry re-runs its whole pass.
              </div>
              {plans.wholeScene.pack.ok ? (
                <>
                  <div className="scr-worldcard__counts">
                    <span>
                      {plans.wholeScene.pack.passes.length} pass{plans.wholeScene.pack.passes.length === 1 ? "" : "es"} under the {model!.limits.maxDurationSec ?? "∞"}s cap
                    </span>
                  </div>
                  {plans.wholeScene.pack.passes.map((p) => (
                    <div key={p.index} className="scr-worldcard__counts">
                      <span>
                        pass {p.index} · {seconds(p.durationSec)} · shots {p.plan.map((e) => e.number).join(", ")}
                      </span>
                    </div>
                  ))}
                  <Button
                    variant="primary"
                    onClick={() => {
                      if (worldId && prodId && sceneFile && model) {
                        dispatchScene(worldId, prodId, sceneFile, "whole-scene", model.id);
                        navigate(`/w/${worldId}/p/${prodId}/generate`);
                      }
                    }}
                  >
                    Dispatch whole scene · {usd(plans.wholeScene.totalEstimatedMicroUsd)}
                  </Button>
                </>
              ) : (
                <Callout tone="warning" title="Whole-scene unavailable">
                  shot {plans.wholeScene.pack.oversizeShot.number} runs {plans.wholeScene.pack.oversizeShot.durationSec}s —
                  longer than the {plans.wholeScene.pack.oversizeShot.capSec}s cap, and half a shot cannot be reviewed.
                </Callout>
              )}
            </Card>
          </div>
        )}
      </div>
    </Screen>
  );
}

export function VoiceLineDialogScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const shot = production?.scenes.flatMap((s) => s.shots).find((s) => s.audio?.line && s.audio.speaker);
  const speaker = shot?.audio?.speaker ? world?.sheets.find((c) => c.id === shot.audio!.speaker) : undefined;
  return (
    <Screen id="voice-line-dialog">
      <div className="scr-dialogcard">
        <PageHeader
          title="Voice line"
          actions={<Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>Close</Button>}
        />
        <DegradedBanner component="voice" />
        {shot && speaker ? (
          <Card className="scr-worldcard">
            <div className="scr-worldcard__name">{speaker.name}</div>
            <div className="scr-worldcard__logline">“{shot.audio!.line}”</div>
            <div className="scr-worldcard__counts">
              <span>
                voice ·{" "}
                {speaker.voice ? `${speaker.voice.label ?? speaker.voice.voiceId} (${speaker.voice.provider})` : "none assigned"}
              </span>
            </div>
          </Card>
        ) : (
          <EmptyState title="No spoken lines in this production yet" />
        )}
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="primary" disabled title="Voice generation arrives with SPEC-011">
            Generate line
          </Button>
        </div>
      </div>
    </Screen>
  );
}

// ---- Cut / audio / exports / stills ----------------------------------------

export function CutScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const shots = production?.scenes.flatMap((s) => s.shots) ?? [];
  const rows = shots.map((shot) => ({
    shot,
    takeId: production ? acceptedTakeId(production, shot.id) : null,
  }));
  const covered = rows.filter((r) => r.takeId).length;
  const total = rows.reduce((s, r) => s + (r.takeId ? (r.shot.durationSec ?? 0) : 0), 0);
  return (
    <Screen id="cut">
      <PageHeader
        title="Cut"
        meta={
          <span>
            derived from selections — {covered}/{rows.length} shots covered · {seconds(total)}
          </span>
        }
      />
      <div className="scr-sectionlist">
        {rows.map(({ shot, takeId }) => (
          <div key={shot.id} className={cx("scr-cutrow", !takeId && "scr-cutrow--gap")}>
            <span className="mono">{shot.id}</span>
            <span>{shot.title}</span>
            <span className="mono" style={{ fontSize: "var(--text-xs)" }}>
              {takeId ? `${takeId.slice(0, 12)}…` : "gap — nothing accepted"}
            </span>
            <span>{seconds(shot.durationSec)}</span>
          </div>
        ))}
      </div>
      <Callout title="The cut is a projection">
        It recomputes from shot selections; restoring an earlier cut means restoring the selections
        that produced it (§2.4.1). Playback and assembly arrive with SPEC-013.
      </Callout>
    </Screen>
  );
}

export function AudioScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const linked = world?.artifacts.filter((a) => a.kind === "audio") ?? [];
  const voLines = production?.scenes.flatMap((s) => s.shots).filter((s) => s.audio?.kind === "vo" || s.audio?.kind === "dialogue") ?? [];
  return (
    <Screen id="audio">
      <PageHeader title="Audio" meta={<span>{voLines.length} spoken lines · {linked.length} audio artifacts</span>} />
      <Section title="Lines">
        <div className="scr-sectionlist">
          {voLines.map((s) => (
            <div key={s.id} className="scr-cutrow">
              <span className="mono">{s.id}</span>
              <span>“{s.audio?.line}”</span>
              <span style={{ color: "var(--muted-foreground)" }}>{s.audio?.speaker ?? s.audio?.kind}</span>
              <Badge tone="outline">no track yet</Badge>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Beds and stems" aside={<span>from artifacts</span>}>
        {linked.length === 0 ? (
          <EmptyState title="No audio artifacts" />
        ) : (
          linked.map((a) => (
            <Card key={a.id} className="scr-worldcard">
              <span className="mono" style={{ fontSize: "var(--text-xs)" }}>{a.file}</span>
            </Card>
          ))
        )}
      </Section>
      <Callout title="Track laying arrives with SPEC-013">
        Voice tracks land beside the cut; beds come from artifacts; nothing is mixed destructively.
      </Callout>
    </Screen>
  );
}

export function ExportsScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const exportsState = useExports();
  const cut = production ? deriveCut(production) : null;
  const mine = Object.entries(exportsState).filter(([, e]) => e.productionId === prodId);
  return (
    <Screen id="exports">
      <PageHeader
        title="Exports"
        meta={
          cut && (
            <span>
              {cut.covered}/{cut.entries.length} shots covered · {cut.gaps} gap{cut.gaps === 1 ? "" : "s"} export as
              labelled slates
            </span>
          )
        }
      />
      <Section title="Render the cut" aside={<span>local, one encode, no provider call</span>}>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          {(["review-cut", "master", "social-excerpt"] as const).map((preset) => (
            <Button
              key={preset}
              onClick={() => {
                if (worldId && prodId) exportCut(worldId, prodId, preset);
              }}
            >
              {preset} · {PRESETS[preset].width}×{PRESETS[preset].height}
            </Button>
          ))}
        </div>
        {cut && cut.gaps > 0 && (
          <Callout title="An unfinished film still reviews">
            {cut.gaps} shot{cut.gaps === 1 ? "" : "s"} without a selection export as black slates carrying their
            labels and durations — {seconds(cut.uncoveredSec)} of them.
          </Callout>
        )}
      </Section>
      {mine.length > 0 && (
        <Section title="In flight and finished">
          <div className="scr-sectionlist">
            {mine.map(([id, e]) => (
              <div key={id} className="scr-cutrow">
                <span className="mono">{id.slice(0, 10)}…</span>
                <span>
                  {e.status}
                  {e.status === "running" ? ` · ${Math.round(e.percent)}%` : ""}
                </span>
                <span className="mono" style={{ fontSize: "var(--text-xs)" }}>
                  {e.output ?? e.error ?? ""}
                </span>
                {e.status === "running" && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (worldId) cancelExport(worldId, id);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
      <Section title="World export" aside={<span>a folder that reopens identically elsewhere</span>}>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <Button
            variant="ghost"
            onClick={() => {
              if (worldId) exportWorld(worldId);
            }}
          >
            Export world folder
          </Button>
          <span className="scr-field__hint">
            history kept — the version record travels; caches and locks stay behind. Lands under
            ArkeStudio\exports.
          </span>
        </div>
      </Section>
    </Screen>
  );
}

export function StillsScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const stills = useMemo(
    () => production?.takes.filter((t) => t.kind === "frame" || t.kind === "still") ?? [],
    [production],
  );
  const decisions = production ? takeDecisions(production) : {};
  return (
    <Screen id="stills-contact-sheet">
      <PageHeader
        title="Stills"
        meta={<span>{stills.length} frames on the contact sheet — judged as a set, accepted one at a time</span>}
      />
      {stills.length === 0 ? (
        <EmptyState title="No stills yet" hint="Frames and stills land here as they are generated." />
      ) : (
        <div className="lay-cardgrid">
          {stills.map((take) => {
            const decision = decisions[take.id];
            const shotId = take.coversShots[0];
            return (
              <Card key={take.id} className="scr-worldcard">
                <span className="mono" style={{ fontSize: "var(--text-xs)" }}>
                  {take.media ?? take.id}
                </span>
                <div className="scr-worldcard__counts">
                  <span>{shotId ?? "unassigned"}</span>
                  {decision && decision !== "pending" && (
                    <Badge tone={decision === "accepted" ? "success" : "outline"}>{decision}</Badge>
                  )}
                </div>
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button
                    variant={decision === "accepted" ? "primary" : "ghost"}
                    disabled={!shotId}
                    onClick={() => {
                      // Accept = decision + selection in one commit (SPEC-013 R-9).
                      if (worldId && prodId && shotId) acceptTake(worldId, prodId, take.id, shotId);
                    }}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={Object.keys(take.provenance.sheets).length === 0}
                    title="A rejection cites the sheet the take drifted from (R-10)"
                    onClick={() => {
                      const sheet = Object.keys(take.provenance.sheets)[0];
                      if (worldId && prodId && sheet)
                        rejectTake(worldId, prodId, take.id, { sheet, field: "appearance", note: "rejected from the contact sheet" }, shotId);
                    }}
                  >
                    Reject
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </Screen>
  );
}
