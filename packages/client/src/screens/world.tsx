import { useMemo, useState } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router";
import type { CanonEntry, Sheet } from "@arke-studio/contracts";
import { DegradedBanner, EmptyState, PageHeader, Screen, Section } from "../components/layout.js";
import { Badge, Button, Callout, Card, Input, Textarea, cx } from "../components/ui.js";
import { CanonEntryRow, ProposalPanel, ReferenceTile, SheetCard } from "../domain/domain.js";
import { shortDateTime } from "../lib/format.js";
import { useOpenWorldGuard, useSheet } from "../lib/selectors.js";
import { reconcileExternalEdit, reloadWorld, useStore, useWorld } from "../lib/store.js";
import { HealthDot } from "./shell.js";

/** World screens (§2.9): the world is the home, productions are lenses over it. */

const GATE_NOT_YET = "The accept gate arrives with SPEC-004; until then the world is read-only here.";

export function WorldLayout() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const { state } = useStore();
  const nav = [
    ["", "Overview"],
    ["cast", "Cast"],
    ["locations", "Locations"],
    ["factions", "Factions"],
    ["canon", "Canon"],
    ["artifacts", "Artifacts"],
    ["productions", "Productions"],
  ] as const;
  return (
    <div className="scr-frame">
      <aside className="scr-sidebar">
        <div className="scr-sidebar__world">
          <span className="scr-sidebar__worldname">{world?.meta.name ?? "…"}</span>
          <span className="scr-sidebar__worldmeta">
            {world ? `canon v${world.meta.canonRevision} · ${world.meta.tone ?? ""}` : "opening world"}
          </span>
        </div>
        <nav className="scr-sidebar__group">
          {nav.map(([slug, label]) => (
            <NavLink
              key={slug}
              to={`/w/${worldId}${slug ? `/${slug}` : ""}`}
              end={slug === ""}
              className={({ isActive }) => cx("scr-navlink", isActive && "scr-navlink--active")}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="scr-sidebar__group">
          <span className="scr-sidebar__grouplabel">Studio</span>
          <NavLink to="/activity" className={({ isActive }) => cx("scr-navlink", isActive && "scr-navlink--active")}>
            Activity
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => cx("scr-navlink", isActive && "scr-navlink--active")}>
            Settings
          </NavLink>
          <NavLink to="/worlds" className={({ isActive }) => cx("scr-navlink", isActive && "scr-navlink--active")}>
            Switch world
          </NavLink>
        </div>
        <div className="scr-sidebar__foot">
          <HealthDot label="Authoring" health={state?.app.health.harness} />
          <HealthDot label="Voice" health={state?.app.health.voice} />
        </div>
      </aside>
      <div className="scr-frame__content">
        <WorldConditionBanners />
        <Outlet />
      </div>
    </div>
  );
}

/** Staleness, closed-world edits and per-file parse failures — stated, never silent (R-2, R-23, R-28). */
function WorldConditionBanners() {
  const { worldId } = useParams();
  const world = useWorld();
  if (!world || world.meta.worldId !== worldId) return null;
  const hasConditions = world.stale || world.externalEdits.length > 0 || world.problems.length > 0;
  if (!hasConditions) return null;
  return (
    <div style={{ display: "grid", gap: "var(--space-3)", padding: "var(--space-4) var(--gutter) 0" }}>
      {world.stale && (
        <Callout tone="warning" title="This world changed outside Arke Studio">
          Another program wrote to the world folder while it was open. Reload to pick the changes
          up — nothing is merged silently.
          <div style={{ marginTop: "var(--space-2)" }}>
            <Button variant="primary" onClick={() => reloadWorld(world.meta.worldId)}>
              Reload world
            </Button>
          </div>
        </Callout>
      )}
      {world.externalEdits.length > 0 && (
        <Callout tone="warning" title={`${world.externalEdits.length} file(s) changed while the world was closed`}>
          Adopting an edit snapshots the prior version, bumps the entity version and records the
          change as external — so the history still explains itself.
          <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            {world.externalEdits.map((e) => (
              <div key={e.path} style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
                <span className="mono" style={{ fontSize: "var(--text-xs)" }}>
                  {e.path} · {e.kind}
                </span>
                <Button onClick={() => reconcileExternalEdit(world.meta.worldId, e.path)}>Adopt</Button>
              </div>
            ))}
          </div>
        </Callout>
      )}
      {world.problems.length > 0 && (
        <Callout tone="danger" title={`${world.problems.length} file(s) could not be read`}>
          The rest of the world is open and usable; these files are skipped until fixed:
          <div style={{ display: "grid", gap: "var(--space-1)", marginTop: "var(--space-2)" }}>
            {world.problems.map((p) => (
              <span key={p.path} className="mono" style={{ fontSize: "var(--text-xs)" }}>
                {p.path} — {p.message}
              </span>
            ))}
          </div>
        </Callout>
      )}
    </div>
  );
}

// ---- Overview --------------------------------------------------------------

export function WorldOverviewScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  if (!world) {
    return (
      <Screen id="world-overview">
        <EmptyState title="Opening world…" />
      </Screen>
    );
  }
  const characters = world.sheets.filter((s) => s.type === "character");
  const threads = world.canon.filter((c) => c.status === "open");
  const proposals = world.proposals;
  return (
    <Screen id="world-overview">
      <PageHeader
        title={world.meta.name}
        meta={
          <>
            <span>{world.meta.logline}</span>
            <Badge tone="outline">canon v{world.meta.canonRevision}</Badge>
          </>
        }
      />
      <div className="lay-stats">
        {[
          [characters.length, "characters", "cast"],
          [world.sheets.filter((s) => s.type === "location").length, "locations", "locations"],
          [world.canon.length, "canon entries", "canon"],
          [world.artifacts.length, "artifacts", "artifacts"],
          [world.productions.length, "productions", "productions"],
        ].map(([value, label, slug]) => (
          <button
            key={String(label)}
            type="button"
            className="lay-stats__item"
            style={{ cursor: "pointer", textAlign: "left" }}
            onClick={() => navigate(`/w/${worldId}/${slug}`)}
          >
            <div className="lay-stats__value">{value}</div>
            <div className="lay-stats__label">{label}</div>
          </button>
        ))}
      </div>
      {proposals.length > 0 && (
        <Section title="Needs you" aside={<span>{proposals.length} awaiting a decision</span>}>
          {proposals.map((p) => (
            <ProposalPanel key={p.proposal.id} staged={p} disabledReason={GATE_NOT_YET} />
          ))}
        </Section>
      )}
      {threads.length > 0 && (
        <Section title="Open threads" aside={<span>unsettled canon, waiting to be pulled</span>}>
          <div className="scr-sectionlist">
            {threads.map((t) => (
              <CanonEntryRow key={t.id} entry={t} onOpen={() => navigate(`/w/${worldId}/canon/${t.id}/thread`)} />
            ))}
          </div>
        </Section>
      )}
      <Section title="Recent changes">
        <div className="scr-sectionlist scr-changelist">
          {[...world.changes].reverse().slice(0, 8).map((c, i) => (
            <div key={i} className="scr-change">
              <span className="scr-change__entity">{c.entity}</span>
              <span>
                {c.fromVersion != null
                  ? `v${c.fromVersion} → v${c.toVersion}`
                  : c.toVersion !== undefined
                    ? `created v${c.toVersion}`
                    : "created"}
                {c.fieldsChanged ? ` · ${c.fieldsChanged.join(", ")}` : ""}
              </span>
              <span className="scr-change__when">{shortDateTime(c.ts)}</span>
            </div>
          ))}
        </div>
      </Section>
    </Screen>
  );
}

// ---- Sheet list screens ----------------------------------------------------

function SheetGrid({ kind, screenId, newPath, detailPath, title, hint }: {
  kind: Sheet["type"];
  screenId: string;
  newPath: string;
  detailPath: (id: string) => string;
  title: string;
  hint: string;
}) {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const sheets = world?.sheets.filter((s) => s.type === kind) ?? [];
  return (
    <Screen id={screenId}>
      <PageHeader
        title={title}
        meta={<span>{sheets.length} {kind === "character" ? "in the cast" : "on the map"}</span>}
        actions={
          <Button variant="primary" onClick={() => navigate(newPath)}>
            New {kind}
          </Button>
        }
      />
      {sheets.length === 0 ? (
        <EmptyState title={`No ${kind}s yet`} hint={hint} />
      ) : (
        <div className="lay-cardgrid">
          {sheets.map((sheet) => (
            <SheetCard key={sheet.id} sheet={sheet} onOpen={() => navigate(detailPath(sheet.id))} />
          ))}
        </div>
      )}
    </Screen>
  );
}

export function CastScreen() {
  const { worldId } = useParams();
  return (
    <SheetGrid
      kind="character"
      screenId="cast"
      title="Cast"
      hint="Characters carry essence, appearance, relationships and a voice."
      newPath={`/w/${worldId}/cast/new`}
      detailPath={(id) => `/w/${worldId}/cast/${id}`}
    />
  );
}

export function LocationsScreen() {
  const { worldId } = useParams();
  return (
    <SheetGrid
      kind="location"
      screenId="locations"
      title="Locations"
      hint="Where the world happens — look, sound, customs."
      newPath={`/w/${worldId}/locations/new`}
      detailPath={(id) => `/w/${worldId}/locations/${id}`}
    />
  );
}

export function FactionsScreen() {
  const { worldId } = useParams();
  return (
    <SheetGrid
      kind="faction"
      screenId="factions"
      title="Factions"
      hint="Groups with wants and fears."
      newPath={`/w/${worldId}/factions/new`}
      detailPath={(id) => `/w/${worldId}/factions/${id}`}
    />
  );
}

// ---- Sheet detail ----------------------------------------------------------

function SheetDetail({ screenId, kindLabel }: { screenId: string; kindLabel: string }) {
  const { worldId, sheetId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const navigate = useNavigate();
  if (!world || !sheet) {
    return (
      <Screen id={screenId}>
        <EmptyState title={`Opening ${kindLabel}…`} />
      </Screen>
    );
  }
  const rules = world.canon.filter((c) => sheet.canonRules.includes(c.id));
  const staged = world.proposals.filter((p) =>
    p.proposal.targets.some((t) => t.path.endsWith(`/${sheet.id}.md`)),
  );
  const kit = world.referenceKits.find((k) => k.sheetId === sheet.id);
  return (
    <Screen id={screenId}>
      <PageHeader
        title={sheet.name}
        meta={
          <>
            {sheet.role && <span>{sheet.role}</span>}
            <Badge tone={sheet.status === "sketch" ? "outline" : "neutral"}>
              {sheet.status === "sketch" ? "sketch" : `v${sheet.version} · locked`}
            </Badge>
            {sheet.voice && <Badge tone="outline">voice · {sheet.voice.label ?? sheet.voice.provider}</Badge>}
          </>
        }
        actions={
          <>
            {sheet.type === "character" && (
              <>
                <Button onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}/kit`)}>Reference kit{kit ? ` · ${kit.tiles.filter((t) => t.status !== "empty").length}` : ""}</Button>
                <Button onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}/voice`)}>Voice</Button>
              </>
            )}
            <Button variant="primary" onClick={() => navigate(`/w/${worldId}/${sheet.type === "character" ? "cast" : `${sheet.type}s`}/${sheet.id}/edit`)}>
              Edit
            </Button>
          </>
        }
      />
      {staged.map((p) => (
        <ProposalPanel key={p.proposal.id} staged={p} disabledReason={GATE_NOT_YET} />
      ))}
      <div className="scr-sectionlist">
        {sheet.sections.map((s) => (
          <div key={s.heading} className="scr-sheetsection">
            <div className="scr-sheetsection__head">{s.heading}</div>
            <div className="scr-prose">{s.body}</div>
          </div>
        ))}
      </div>
      {rules.length > 0 && (
        <Section title="Canon rules" aside={<span>owned by canon — edit in canon, not here</span>}>
          {rules.map((rule) => (
            <div key={rule.id} className="scr-canonrule">
              <span className="mono" style={{ color: "var(--muted-foreground)" }}>{rule.id}</span>
              <span className="scr-prose">{rule.body}</span>
              <span className="scr-canonrule__note">
                <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/canon/${rule.id}`)}>
                  Edit in canon →
                </Button>
              </span>
            </div>
          ))}
        </Section>
      )}
      {sheet.links.length > 0 && (
        <Section title="Linked">
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {sheet.links.map((link) => {
              const other = world.sheets.find((s) => s.id === link);
              if (!other) return <Badge key={link} tone="outline">{link}</Badge>;
              const base = other.type === "character" ? "cast" : `${other.type}s`;
              return (
                <Button key={link} variant="secondary" onClick={() => navigate(`/w/${worldId}/${base}/${link}`)}>
                  {other.name}
                </Button>
              );
            })}
          </div>
        </Section>
      )}
    </Screen>
  );
}

export const CharacterDetailScreen = () => <SheetDetail screenId="character-detail" kindLabel="character" />;
export const LocationDetailScreen = () => <SheetDetail screenId="location-detail" kindLabel="location" />;

// ---- Sheet edit ------------------------------------------------------------

export function CharacterEditScreen() {
  const { worldId, sheetId } = useParams();
  const sheet = useSheet(worldId, sheetId);
  return (
    <Screen id="character-edit">
      <PageHeader
        title={sheet ? `Edit — ${sheet.name}` : "Edit"}
        meta={sheet && <span>editing against v{sheet.version} · accepting cuts v{sheet.version + 1}</span>}
      />
      <DegradedBanner component="harness" />
      <div className="scr-form">
        {(sheet?.sections ?? []).map((s) => (
          <div key={s.heading} className="scr-field">
            <label className="scr-field__label">{s.heading}</label>
            <Textarea defaultValue={s.body} />
          </div>
        ))}
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="primary" disabled title={GATE_NOT_YET}>
            Stage proposal
          </Button>
          <Button variant="ghost" disabled title={GATE_NOT_YET}>
            Discard
          </Button>
        </div>
        <Callout title="Edits go through the gate">
          A save stages a proposal with its ripples — reference tiles that age, productions that
          pick the change up — and nothing lands until you accept (SPEC-004).
        </Callout>
      </div>
    </Screen>
  );
}

// ---- Reference kit / model sheet / voice ----------------------------------

export function ReferenceKitScreen() {
  const { worldId, sheetId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const navigate = useNavigate();
  const kit = world?.referenceKits.find((k) => k.sheetId === sheetId);
  return (
    <Screen id="reference-kit">
      <PageHeader
        title={sheet ? `Reference kit — ${sheet.name}` : "Reference kit"}
        meta={
          kit?.modelSheet ? (
            <span>
              model sheet compiled from {kit.modelSheet.tiles.length} tiles · sheet v{kit.modelSheet.sheetVersion}
            </span>
          ) : (
            <span>no model sheet compiled yet</span>
          )
        }
        actions={
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/model-sheet`)}>
            Generate model sheet
          </Button>
        }
      />
      {sheet && kit && sheet.version > (kit.modelSheet?.sheetVersion ?? sheet.version) && (
        <Callout tone="warning" title="References predate the sheet">
          Tiles were made against an older sheet version — regenerate looks to catch up.
        </Callout>
      )}
      {kit ? (
        <div className="lay-cardgrid">
          {kit.tiles.map((tile) => (
            <ReferenceTile key={tile.angle} tile={tile} />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No reference kit yet"
          hint="Establish an anchor image, then fill the angles from it (SPEC-010)."
        />
      )}
    </Screen>
  );
}

export function ModelSheetScreen() {
  const { sheetId, worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const kit = world?.referenceKits.find((k) => k.sheetId === sheetId);
  const locked = kit?.tiles.filter((t) => t.status === "locked") ?? [];
  return (
    <Screen id="model-sheet-generate">
      <PageHeader
        title="Generate model sheet"
        meta={<span>{locked.length} locked tiles available to compile</span>}
      />
      <Callout title="Head before body">
        Compilation insists on locked head angles before body work — identity first, wardrobe
        second (SPEC-010).
      </Callout>
      <div className="lay-cardgrid">
        {locked.map((tile) => (
          <ReferenceTile key={tile.angle} tile={tile} />
        ))}
      </div>
      <div>
        <Button variant="primary" disabled title="Model-sheet generation arrives with SPEC-010">
          Compile model sheet
        </Button>
      </div>
    </Screen>
  );
}

export function VoicePickerScreen() {
  const { worldId, sheetId } = useParams();
  const sheet = useSheet(worldId, sheetId);
  return (
    <Screen id="voice-picker">
      <PageHeader
        title={sheet ? `Voice — ${sheet.name}` : "Voice"}
        meta={
          sheet?.voice ? (
            <span>
              assigned · {sheet.voice.label ?? sheet.voice.voiceId} ({sheet.voice.provider}) at sheet v
              {sheet.voice.assignedAtVersion}
            </span>
          ) : (
            <span>no voice assigned</span>
          )
        }
      />
      <DegradedBanner component="voice" />
      <Section title="Local voices" aside={<span>Voxa · Kokoro — free, on this machine</span>}>
        <EmptyState
          title="Local catalogue loads from the sidecar"
          hint="Kokoro ships a fixed voice set; matching is by honest attribute overlap, never a fake clone (SPEC-011)."
        />
      </Section>
      <Section title="Cloud voices" aside={<span>ElevenLabs · OpenAI — need a key</span>}>
        <EmptyState title="Add a provider key in Settings" hint="Cloud catalogues and cloning arrive with SPEC-008/SPEC-011." />
      </Section>
    </Screen>
  );
}

// ---- New sheet screens -----------------------------------------------------

function NewSheetScreen({ screenId, title, fields }: { screenId: string; title: string; fields: string[] }) {
  return (
    <Screen id={screenId}>
      <PageHeader title={title} />
      <DegradedBanner component="harness" />
      <div className="scr-form">
        <div className="scr-field">
          <label className="scr-field__label">Name</label>
          <Input placeholder="Name" />
        </div>
        {fields.map((f) => (
          <div key={f} className="scr-field">
            <label className="scr-field__label">{f}</label>
            <Textarea placeholder={`${f}…`} />
          </div>
        ))}
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="primary" disabled title="Sheet creation arrives with SPEC-007">
            Create as sketch
          </Button>
          <Button variant="ghost" disabled title="Chat-first drafting arrives with SPEC-005/SPEC-007">
            Draft with the studio
          </Button>
        </div>
        <Callout title="Sketch first, lock later">
          A new sheet starts as a sketch — enough to be cast in a scene. Locking it makes it citable
          by dispatches (SPEC-007).
        </Callout>
      </div>
    </Screen>
  );
}

export const NewCharacterScreen = () => (
  <NewSheetScreen screenId="new-character" title="New character" fields={["Essence", "Appearance"]} />
);
export const NewLocationScreen = () => (
  <NewSheetScreen screenId="new-location" title="New location" fields={["Look", "Sound", "Customs"]} />
);

// ---- Canon -----------------------------------------------------------------

export function CanonScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const entries = useMemo(() => {
    const all = world?.canon ?? [];
    const q = query.trim().toLowerCase();
    const hit = q
      ? all.filter((c) => c.title.toLowerCase().includes(q) || c.body.toLowerCase().includes(q))
      : all;
    return [...hit].sort((a, b) => (a.status === "open" ? -1 : 0) - (b.status === "open" ? -1 : 0) || a.id.localeCompare(b.id));
  }, [world, query]);
  return (
    <Screen id="canon">
      <PageHeader
        title="Canon"
        meta={world && <span>revision v{world.meta.canonRevision} · {world.canon.length} entries</span>}
        actions={
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/canon/new`)}>
            New entry
          </Button>
        }
      />
      <div className="scr-form">
        <Input
          placeholder="Ask the canon, or search it — “can Maren call a tide she has not stood in?”"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="scr-field__hint">
          Search is lexical here; grounded ask-with-citations (and its honest refusals) arrives with
          SPEC-006.
        </span>
      </div>
      <div className="scr-sectionlist">
        {entries.map((entry) => (
          <CanonEntryRow key={entry.id} entry={entry} onOpen={() => navigate(`/w/${worldId}/canon/${entry.id}`)} />
        ))}
        {entries.length === 0 && <EmptyState title="No matches" hint="Closest-match suggestions arrive with the index (SPEC-003)." />}
      </div>
    </Screen>
  );
}

function useCanonEntry(): { entry: CanonEntry | null; worldId: string | undefined } {
  const { worldId, entryId } = useParams();
  const world = useOpenWorldGuard(worldId);
  return { entry: world?.canon.find((c) => c.id === entryId) ?? null, worldId };
}

export function CanonEntryScreen() {
  const { entry, worldId } = useCanonEntry();
  const navigate = useNavigate();
  if (!entry) {
    return (
      <Screen id="canon-entry">
        <EmptyState title="Opening entry…" />
      </Screen>
    );
  }
  return (
    <Screen id="canon-entry">
      <PageHeader
        title={entry.title}
        meta={
          <>
            <span className="mono">{entry.id}</span>
            <Badge tone="outline">{entry.type}</Badge>
            <span>
              written v{entry.introducedAt}
              {entry.settledAt !== undefined && ` · settled v${entry.settledAt}`}
              {entry.amendedAt !== undefined && ` · amended v${entry.amendedAt}`}
            </span>
          </>
        }
        actions={
          entry.status === "open" ? (
            <Button variant="primary" onClick={() => navigate(`/w/${worldId}/canon/${entry.id}/thread`)}>
              Open thread
            </Button>
          ) : (
            <Button disabled title="Amendments go through the gate (SPEC-006)">
              Propose amendment
            </Button>
          )
        }
      />
      <Card>
        <div className="scr-prose">{entry.body}</div>
      </Card>
      <Section title="History" aside={<span>full snapshots per revision, from .history/ (SPEC-002)</span>}>
        <EmptyState title="Version history renders once the world is on disk" />
      </Section>
    </Screen>
  );
}

export function CanonThreadScreen() {
  const { entry } = useCanonEntry();
  return (
    <Screen id="canon-thread">
      <PageHeader
        title={entry ? entry.title : "Thread"}
        meta={entry && (
          <>
            <span className="mono">{entry.id}</span>
            <Badge tone="warning">open since v{entry.introducedAt}</Badge>
          </>
        )}
      />
      <DegradedBanner component="harness" />
      {entry && (
        <Card>
          <div className="scr-prose">{entry.body}</div>
        </Card>
      )}
      <Section title="Conversation">
        <EmptyState
          title="Pull the thread"
          hint="Talking a thread toward settlement — and settling it into canon — arrives with SPEC-006."
        />
      </Section>
      <div>
        <Button variant="primary" disabled title="Settling arrives with SPEC-006">
          Settle into canon
        </Button>
      </div>
    </Screen>
  );
}

export function NewCanonScreen() {
  return (
    <Screen id="new-canon">
      <PageHeader title="New canon entry" />
      <div className="scr-form">
        <div className="scr-field">
          <label className="scr-field__label">Type</label>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {["rule", "lore", "location", "faction", "timeline", "tone", "thread"].map((t) => (
              <Badge key={t} tone="outline">{t}</Badge>
            ))}
          </div>
        </div>
        <div className="scr-field">
          <label className="scr-field__label">Title</label>
          <Input placeholder="Tide-calling" />
        </div>
        <div className="scr-field">
          <label className="scr-field__label">Statement</label>
          <Textarea placeholder="A caller cannot move a tide she has not stood in…" />
        </div>
        <div>
          <Button variant="primary" disabled title="Canon writes go through the gate (SPEC-006)">
            Propose entry
          </Button>
        </div>
        <Callout title="Ids are permanent">
          The entry reserves the next CANON number at proposal time and keeps it forever — retired
          ids are never reused, so citations never drift (R-CANON-4).
        </Callout>
      </div>
    </Screen>
  );
}

// ---- Artifacts -------------------------------------------------------------

export function ArtifactsScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const artifacts = world?.artifacts ?? [];
  return (
    <Screen id="artifacts">
      <PageHeader
        title="Artifacts"
        meta={<span>{artifacts.length} filed against the world</span>}
        actions={
          <Button variant="primary" disabled title="Filing and folder import arrive with SPEC-015">
            Import a folder
          </Button>
        }
      />
      {artifacts.length === 0 ? (
        <EmptyState title="Nothing filed yet" hint="Drop recordings, documents, boards or images to file them against the world." />
      ) : (
        <div className="lay-cardgrid">
          {artifacts.map((a) => (
            <Card key={a.id} className="scr-worldcard">
              <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                <Badge tone="outline">{a.kind}</Badge>
                <span className="mono" style={{ fontSize: "var(--text-xs)" }}>{a.file}</span>
              </div>
              <div className="scr-worldcard__counts">
                <span>{a.origin.by === "user" ? "filed by you" : `produced by ${a.origin.producedBy}`}</span>
                {a.links.length > 0 && <span>links {a.links.join(", ")}</span>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </Screen>
  );
}

// ---- Productions -----------------------------------------------------------

export function ProductionsScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const productions = world?.productions ?? [];
  return (
    <Screen id="productions">
      <PageHeader
        title="Productions"
        meta={<span>lenses over the world — each inherits the whole cast and canon</span>}
        actions={
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/productions/new`)}>
            New production
          </Button>
        }
      />
      {productions.length === 0 ? (
        <EmptyState title="No productions yet" hint="A production joins the world and shares everything it knows." />
      ) : (
        <div className="lay-cardgrid">
          {productions.map((p) => (
            <Card key={p.meta.id} className="scr-worldcard" onClick={() => navigate(`/w/${worldId}/p/${p.meta.id}`)}>
              <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                <span className="scr-worldcard__name">{p.meta.title}</span>
                <Badge tone="outline">{p.meta.format}</Badge>
              </div>
              {p.meta.logline && <div className="scr-worldcard__logline">{p.meta.logline}</div>}
              <div className="scr-worldcard__counts">
                <span>{p.meta.status}</span>
                <span>{p.scenes.length} scenes</span>
                <span>{p.takes.length} takes</span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Screen>
  );
}

export function NewProductionScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const characters = world?.sheets.filter((s) => s.type === "character").length ?? 0;
  return (
    <Screen id="new-production">
      <PageHeader
        title="New production"
        meta={world && <span>joins {world.meta.name} · shares all {characters} characters, every location and the whole canon</span>}
      />
      <div className="lay-cardgrid">
        {(
          [
            ["story", "Story", "novel · script · serial"],
            ["video", "Video", "short film · music video · series"],
            ["stills", "Stills", "visual album · key art"],
          ] as const
        ).map(([id, label, kinds]) => (
          <Card key={id} className="scr-worldcard">
            <div className="scr-worldcard__name">{label}</div>
            <div className="scr-worldcard__logline">{kinds}</div>
          </Card>
        ))}
      </div>
      <div>
        <Button variant="primary" disabled title="Production creation arrives with SPEC-012">
          Create production
        </Button>
      </div>
    </Screen>
  );
}
