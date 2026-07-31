import { useMemo, useState } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router";
import { DegradedBanner, EmptyState, PageHeader, Screen, Section } from "../components/layout.js";
import { Badge, Button, Callout, Card, TabPanels, Textarea, cx } from "../components/ui.js";
import { CanonEntryRow, ShotCard, TakeStrip } from "../domain/domain.js";
import { seconds, usd } from "../lib/format.js";
import { acceptedTakeId, isDayOne, takeDecisions, takesForShot, useProduction } from "../lib/selectors.js";

/** Production screens (§2.9): dashboard, story, scenes, generate, cut, audio, exports, stills. */

const DISPATCH_NOT_YET = "Dispatch arrives with SPEC-009 — providers, queue and cost live there.";

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
            content: scene.board ? (
              <div className="scr-board">
                <div className="scr-board__image">{scene.board.image}</div>
                <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
                  <span style={{ font: "var(--type-label)", color: "var(--muted-foreground)" }}>
                    compiled {scene.board.compiledAt} · in step with scene v{scene.version}
                  </span>
                  <Button disabled title="Board compilation arrives with SPEC-012">
                    Recompile
                  </Button>
                </div>
              </div>
            ) : (
              <EmptyState title="No board yet" hint="A board compiles from the scene at a point in time (SPEC-012)." />
            ),
          },
        ]}
      />
    </Screen>
  );
}

export function NewSceneScreen() {
  return (
    <Screen id="new-scene">
      <PageHeader title="New scene" />
      <DegradedBanner component="harness" />
      <div className="scr-form">
        <div className="scr-field">
          <label className="scr-field__label">What happens</label>
          <Textarea placeholder="Maren takes the dusk watch alone; the verse rises a season early…" />
          <span className="scr-field__hint">
            Mention cast with @name — shots compute their cast from live references, never guesses.
          </span>
        </div>
        <div>
          <Button variant="primary" disabled title="Scene drafting arrives with SPEC-012">
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
  const { production } = useProduction(worldId, prodId);
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
      <Section title="Prompt" aside={<span>assembled from the world; edits stay on the shot</span>}>
        <Textarea
          defaultValue={takes[takes.length - 1]?.prompt ?? shot?.description ?? ""}
          key={shotId}
        />
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button disabled title={DISPATCH_NOT_YET}>Reset to assembled</Button>
        </div>
      </Section>
    </Screen>
  );
}

export function DispatchDialogScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const scene = production?.scenes[0];
  const total = scene?.shots.reduce((s, x) => s + (x.durationSec ?? 0), 0) ?? 0;
  const perShotEstimate = (scene?.shots.length ?? 0) * 130_000;
  const CAP_SEC = 15;
  const passes = Math.max(1, Math.ceil(total / CAP_SEC));
  return (
    <Screen id="dispatch-dialog">
      <div className="scr-dialogcard">
        <PageHeader
          title="Dispatch"
          meta={scene && <span>{scene.title} · {scene.shots.length} shots · {seconds(total)}</span>}
          actions={<Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>Close</Button>}
        />
        <div className="scr-tradegrid">
          <Card className="scr-worldcard">
            <div className="scr-worldcard__name">Per shot</div>
            <div className="scr-worldcard__logline">
              One clip per shot, each seeded by its own frame. Any shot retries alone; cast stays
              pinned per shot.
            </div>
            <div className="scr-worldcard__counts">
              <span>est. {usd(perShotEstimate)}</span>
            </div>
          </Card>
          <Card className="scr-worldcard">
            <div className="scr-worldcard__name">Whole scene</div>
            <div className="scr-worldcard__logline">
              One pass from the compiled brief — best motion continuity, but a retry re-runs the
              pass.
            </div>
            <div className="scr-worldcard__counts">
              <span>
                {seconds(total)} over the {CAP_SEC}s cap · packs into {passes} passes
              </span>
            </div>
          </Card>
        </div>
        <Callout title="Estimates come from the manifest">
          Pre-dispatch numbers never need a provider round-trip (R-PROV-4). Live dispatch, the
          queue and reconciliation arrive with SPEC-009.
        </Callout>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="primary" disabled title={DISPATCH_NOT_YET}>
            Dispatch
          </Button>
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
            Cancel
          </Button>
        </div>
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
  return (
    <Screen id="exports">
      <PageHeader title="Exports" />
      <EmptyState
        title="Nothing exported yet"
        hint="Master renders, contact sheets and world snapshots — every export is reproducible from the folder (SPEC-013/016)."
      />
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
      <PageHeader title="Stills" meta={<span>{stills.length} frames on the contact sheet</span>} />
      {stills.length === 0 ? (
        <EmptyState title="No stills yet" hint="Frames and stills land here as they are generated." />
      ) : (
        <TakeStrip takes={stills} decisions={decisions} />
      )}
    </Screen>
  );
}
