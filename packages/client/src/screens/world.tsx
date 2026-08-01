import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router";
import type { CanonEntry, Sheet } from "@arke-studio/contracts";
import { DegradedBanner, EmptyState, PageHeader, Screen, Section } from "../components/layout.js";
import { Badge, Button, Callout, Card, Input, Textarea, cx } from "../components/ui.js";
import { CanonEntryRow, ReferenceTile, SheetCard } from "../domain/domain.js";
import { ConnectedProposalPanel } from "../domain/connected.js";
import { shortDateTime } from "../lib/format.js";
import { useOpenWorldGuard, useSheet } from "../lib/selectors.js";
import {
  askCanon,
  draftWithStudio,
  openThread as openThreadMsg,
  reconcileExternalEdit,
  reloadWorld,
  replyToPermission,
  requestCanonRefs,
  retireEntity,
  searchCanonList,
  settleThread,
  stageCanonAmendment as stageAmendmentMsg,
  stageCanonEntry as stageEntryMsg,
  stageSheetEdit,
  useAskResults,
  useCanonRefs,
  useCanonSearches,
  usePermissions,
  useStore,
  useWorld,
} from "../lib/store.js";
import { HealthDot } from "./shell.js";

/** World screens (§2.9): the world is the home, productions are lenses over it. */

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

/** Staleness, closed-world edits, parse failures and permission backstops — stated, never silent. */
function WorldConditionBanners() {
  const { worldId } = useParams();
  const world = useWorld();
  const permissions = usePermissions();
  if (!world || world.meta.worldId !== worldId) return null;
  const permissionEntries = Object.entries(permissions);
  const hasConditions =
    world.stale || world.externalEdits.length > 0 || world.problems.length > 0 || permissionEntries.length > 0;
  if (!hasConditions) return null;
  return (
    <div style={{ display: "grid", gap: "var(--space-3)", padding: "var(--space-4) var(--gutter) 0" }}>
      {permissionEntries.map(([id, p]) => (
        <Callout key={id} tone="warning" title="The drafting agent is asking permission">
          {p.description}. This is the backstop, not the gate — nothing lands in the world without
          your accept either way.
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <Button variant="primary" onClick={() => replyToPermission(id, "once")}>
              Allow once
            </Button>
            <Button onClick={() => replyToPermission(id, "always")}>Always allow</Button>
            <Button variant="ghost" onClick={() => replyToPermission(id, "reject")}>
              Reject
            </Button>
          </div>
        </Callout>
      ))}
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
            <ConnectedProposalPanel key={p.proposal.id} staged={p} />
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
        <ConnectedProposalPanel key={p.proposal.id} staged={p} />
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
  const navigate = useNavigate();
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [stagedAt, setStagedAt] = useState<number | null>(null);
  const [instruction, setInstruction] = useState("");
  const { state } = useStore();
  const harnessReady = state?.app.health.harness.status === "healthy";

  const sections = (sheet?.sections ?? []).map((s) => ({
    heading: s.heading,
    body: edited[s.heading] ?? s.body,
  }));
  const dirty = sections.some((s, i) => s.body !== sheet?.sections[i]?.body);

  return (
    <Screen id="character-edit">
      <PageHeader
        title={sheet ? `Edit — ${sheet.name}` : "Edit"}
        meta={sheet && <span>editing against v{sheet.version} · accepting cuts v{sheet.version + 1}</span>}
      />
      <div className="scr-form">
        {sections.map((s) => (
          <div key={s.heading} className="scr-field">
            <label className="scr-field__label">{s.heading}</label>
            <Textarea
              value={s.body}
              onChange={(e) => setEdited((prev) => ({ ...prev, [s.heading]: e.target.value }))}
            />
          </div>
        ))}
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button
            variant="primary"
            disabled={!sheet || !worldId || !dirty || stagedAt !== null}
            title={dirty ? undefined : "Nothing changed yet"}
            onClick={() => {
              if (!sheet || !worldId) return;
              const dir = sheet.type === "character" ? "characters" : `${sheet.type}s`;
              stageSheetEdit(worldId, `${dir}/${sheet.id}.md`, `Edit ${sheet.name}`, sections);
              setStagedAt(Date.now());
              const base = sheet.type === "character" ? "cast" : `${sheet.type}s`;
              navigate(`/w/${worldId}/${base}/${sheet.id}`);
            }}
          >
            {stagedAt ? "Staging…" : "Stage proposal"}
          </Button>
          <Button variant="ghost" onClick={() => setEdited({})} disabled={!dirty}>
            Reset
          </Button>
        </div>
        <Callout title="Edits go through the gate">
          Staging opens a proposal with its computed ripples — reference tiles that age,
          productions that pick the change up — and nothing lands until you accept it on the
          sheet page.
        </Callout>
        <div className="scr-field">
          <label className="scr-field__label">Or tell the studio what to change</label>
          <Textarea
            placeholder="Give her a scar from the night the verse rose early — appearance and relationships should both feel it."
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <span className="scr-field__hint">
            The agent drafts inside a proposal — its own copy of this sheet — and reads the rest
            of the world through canon search, never the folder. You accept or discard the result.
          </span>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button
            disabled={!harnessReady || !sheet || !worldId || instruction.trim().length === 0}
            title={harnessReady ? undefined : "Authoring needs OpenCode running — see the sidebar"}
            onClick={() => {
              if (!sheet || !worldId) return;
              const dir = sheet.type === "character" ? "characters" : `${sheet.type}s`;
              draftWithStudio(
                worldId,
                `${dir}/${sheet.id}.md`,
                instruction.trim(),
                `Studio draft: ${sheet.name}`,
              );
              const base = sheet.type === "character" ? "cast" : `${sheet.type}s`;
              navigate(`/w/${worldId}/${base}/${sheet.id}`);
            }}
          >
            Draft with the studio
          </Button>
        </div>
        <DegradedBanner component="harness" />
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

/** A grounded answer or a refusal with receipts (SPEC-006 §2.6–§2.7). */
function AskOutcome({ worldId, question, result }: { worldId: string; question: string; result: import("@arke-studio/contracts").AskResult }) {
  const navigate = useNavigate();
  const world = useWorld();
  const openAsThread = () => {
    const title = question.length > 80 ? `${question.slice(0, 77)}…` : question;
    openThreadMsg(worldId, title, question, result.outcome !== "answer" ? result.closest.map((c) => c.entryId) : []);
    navigate(`/w/${worldId}/canon`);
  };
  if (result.outcome === "answer") {
    return (
      <Card className="scr-answer">
        <Badge tone="success">answered from canon</Badge>
        {result.claims.map((claim, i) => (
          <div key={i} className="scr-answer__claim">
            <div className="scr-prose">{claim.text}</div>
            <button
              type="button"
              className="scr-answer__cite"
              onClick={() => navigate(`/w/${worldId}/canon/${claim.entryId}`)}
            >
              <span className="mono">{claim.entryId}</span>
              <span className="scr-answer__excerpt">“{claim.excerpt}”</span>
            </button>
          </div>
        ))}
        <div className="scr-answer__foot">
          Every quoted span was verified against its entry. Searched {result.searched} entries.
        </div>
      </Card>
    );
  }
  if (result.outcome === "unavailable") {
    return (
      <Callout tone="warning" title="Canon cannot be asked right now">
        {result.reason}. {result.closest.length > 0 && "The closest entries by search:"}
        <ClosestList worldId={worldId} closest={result.closest} />
      </Callout>
    );
  }
  const isNothing = result.cause === "nothing-retrieved";
  return (
    <Card className="scr-answer scr-answer--refusal">
      <Badge tone="warning">{isNothing ? "canon has not touched this" : "canon has not decided this"}</Badge>
      <div className="scr-prose">
        {isNothing
          ? `Searched all ${result.searched} entries — nothing comes close to this question.`
          : `Searched all ${result.searched} entries. The closest describe the area without deciding the fact${result.detail ? ` — ${result.detail}` : ""}.`}
      </div>
      {result.closest.length > 0 && (
        <div>
          <div className="scr-field__label">Closest, by rank</div>
          <ClosestList worldId={worldId} closest={result.closest} />
        </div>
      )}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button variant="primary" onClick={openAsThread}>
          Open as a thread
        </Button>
        <Button
          onClick={() => {
            navigate(`/w/${worldId}/canon/new`, { state: { seed: question } });
          }}
        >
          Draft an answer in context
        </Button>
      </div>
      {world && world.meta.nextCanonId > 0 && (
        <span className="scr-field__hint">
          A thread takes CANON-{String(world.meta.nextCanonId).padStart(3, "0")} now and is citable
          before it settles.
        </span>
      )}
    </Card>
  );
}

function ClosestList({ worldId, closest }: { worldId: string; closest: Array<{ entryId: string; title: string }> }) {
  const navigate = useNavigate();
  return (
    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-2)" }}>
      {closest.map((c) => (
        <Button key={c.entryId} variant="secondary" onClick={() => navigate(`/w/${worldId}/canon/${c.entryId}`)}>
          <span className="mono">{c.entryId}</span>&nbsp;{c.title}
        </Button>
      ))}
    </div>
  );
}

export function CanonScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const { state } = useStore();
  const askResults = useAskResults();
  const searches = useCanonSearches();
  const [query, setQuery] = useState("");
  const [askId, setAskId] = useState<string | null>(null);
  const [askedQuestion, setAskedQuestion] = useState("");
  const [searchId, setSearchId] = useState<string | null>(null);
  const harnessReady = state?.app.health.harness.status === "healthy";

  const serverSearch = searchId ? searches[searchId] : undefined;
  const entries = useMemo(() => {
    const all = world?.canon ?? [];
    if (serverSearch) {
      const ranked = new Map(serverSearch.candidates.map((c, i) => [c.entryId, i]));
      return all
        .filter((c) => ranked.has(c.id))
        .sort((a, b) => (ranked.get(a.id) ?? 99) - (ranked.get(b.id) ?? 99));
    }
    return [...all].sort(
      (a, b) => (a.status === "open" ? -1 : 0) - (b.status === "open" ? -1 : 0) || a.id.localeCompare(b.id),
    );
  }, [world, serverSearch]);

  const ask = () => {
    if (!worldId || query.trim().length === 0) return;
    const id = `ask_${Date.now().toString(36)}`;
    setAskId(id);
    setAskedQuestion(query.trim());
    askCanon(worldId, id, query.trim());
  };
  const runSearch = (value: string) => {
    setQuery(value);
    if (!worldId) return;
    if (value.trim().length === 0) {
      setSearchId(null);
      return;
    }
    const id = `search_${Date.now().toString(36)}`;
    setSearchId(id);
    searchCanonList(worldId, id, value.trim());
  };

  const result = askId ? askResults[askId] : undefined;

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
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Input
            placeholder="Ask the canon — “can Maren call a tide she has not stood in?”"
            value={query}
            onChange={(e) => runSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") ask();
            }}
          />
          <Button
            variant="primary"
            onClick={ask}
            disabled={!harnessReady || query.trim().length === 0}
            title={harnessReady ? undefined : "Asking needs OpenCode running; search still works"}
          >
            Ask
          </Button>
        </div>
        <span className="scr-field__hint">
          Answers come only from entries, with verified quotes. When canon has not decided, it says
          so and shows what it searched.
        </span>
      </div>
      {askId && !result && <Callout title="Asking canon…">Retrieval first, then a grounded read of the candidates.</Callout>}
      {result && worldId && <AskOutcome worldId={worldId} question={askedQuestion} result={result} />}
      {serverSearch && (
        <span className="scr-field__hint">
          {serverSearch.candidates.length} match{serverSearch.candidates.length === 1 ? "" : "es"} across{" "}
          {serverSearch.searched} searchable entries (open threads and retired entries are not
          searched).
        </span>
      )}
      <div className="scr-sectionlist">
        {entries.map((entry) => (
          <CanonEntryRow key={entry.id} entry={entry} onOpen={() => navigate(`/w/${worldId}/canon/${entry.id}`)} />
        ))}
        {entries.length === 0 && <EmptyState title="No matches" hint="The closest entries appear in the ask refusal above." />}
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
  const world = useWorld();
  const refs = useCanonRefs();
  const [amending, setAmending] = useState(false);
  const [statement, setStatement] = useState("");

  useEffect(() => {
    if (worldId && entry) requestCanonRefs(worldId, entry.id);
  }, [worldId, entry?.id]);

  if (!entry) {
    return (
      <Screen id="canon-entry">
        <EmptyState title="Opening entry…" />
      </Screen>
    );
  }
  const detail = refs[entry.id];
  const history = (world?.changes ?? []).filter((c) => c.entity === `canon/${entry.id}`);
  return (
    <Screen id="canon-entry">
      <PageHeader
        title={entry.title}
        meta={
          <>
            <span className="mono">{entry.id}</span>
            <Badge tone="outline">{entry.type}</Badge>
            {entry.retired && <Badge tone="danger">retired</Badge>}
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
            <>
              <Button
                variant="ghost"
                disabled={entry.retired === true}
                onClick={() => {
                  if (worldId) retireEntity(worldId, `canon/${entry.id}.md`);
                }}
                title="Stays resolvable for existing citations; drops out of retrieval"
              >
                Retire
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setStatement(entry.body);
                  setAmending(true);
                }}
              >
                Propose amendment
              </Button>
            </>
          )
        }
      />
      <Card>
        <div className="scr-prose">{entry.body}</div>
      </Card>
      {amending && worldId && (
        <Card className="scr-form">
          <div className="scr-field">
            <label className="scr-field__label">Amended statement</label>
            <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              variant="primary"
              disabled={statement.trim().length === 0 || statement.trim() === entry.body.trim()}
              onClick={() => {
                stageAmendmentMsg(worldId, entry.id, statement.trim());
                setAmending(false);
              }}
            >
              Stage amendment
            </Button>
            <Button variant="ghost" onClick={() => setAmending(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
      {detail && (detail.citedBy.sheets.length > 0 || detail.citedBy.entries.length > 0) && (
        <Section title="Cited by" aside={<span>from the index, at the versions cited</span>}>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {detail.citedBy.sheets.map((s) => (
              <Badge key={s.id} tone="outline">
                {s.id}
                {s.atVersion !== null ? ` @ v${s.atVersion}` : ""}
              </Badge>
            ))}
            {detail.citedBy.entries.map((id) => (
              <Button key={id} variant="secondary" onClick={() => navigate(`/w/${worldId}/canon/${id}`)}>
                {id}
              </Button>
            ))}
          </div>
        </Section>
      )}
      {detail && detail.ripples.length > 0 && (
        <Section title="Changing this ripples" aside={<span>computed speculatively for display</span>}>
          <ul className="dom-ripples">
            {detail.ripples.map((r, i) => (
              <li key={i} className="dom-ripples__item">
                <Badge tone="outline">{r.kind}</Badge>
                <span>{r.summary}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="History" aside={<span>keyed by canon revision</span>}>
        {history.length === 0 ? (
          <EmptyState title="No recorded changes yet" />
        ) : (
          <div className="scr-sectionlist scr-changelist">
            {[...history].reverse().map((c, i) => (
              <div key={i} className="scr-change">
                <span className="scr-change__entity mono">v{String(c.canonRevisionAfter ?? c.toVersion ?? "?")}</span>
                <span>
                  {c.fieldsChanged ? c.fieldsChanged.join(", ") : "changed"} · {c.source}
                </span>
                <span className="scr-change__when">{shortDateTime(c.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </Screen>
  );
}

const SETTLE_TYPES = ["rule", "lore", "location", "faction", "timeline", "tone"] as const;

export function CanonThreadScreen() {
  const { entry, worldId } = useCanonEntry();
  const navigate = useNavigate();
  const [resolvedType, setResolvedType] = useState<(typeof SETTLE_TYPES)[number]>("lore");
  const [statement, setStatement] = useState("");
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
      {entry && (
        <Card>
          <div className="scr-prose">{entry.body}</div>
        </Card>
      )}
      <Section title="Settle it" aside={<span>the answer becomes the entry; the number stays</span>}>
        <div className="scr-form">
          <div className="scr-field">
            <label className="scr-field__label">What it turned out to be</label>
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
              {SETTLE_TYPES.map((t) => (
                <Button key={t} variant={t === resolvedType ? "primary" : "secondary"} onClick={() => setResolvedType(t)}>
                  {t}
                </Button>
              ))}
            </div>
          </div>
          <div className="scr-field">
            <label className="scr-field__label">The settled statement</label>
            <Textarea
              placeholder="The Chorister was taught by the god itself, in the winter it walked in…"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
            />
          </div>
          <div>
            <Button
              variant="primary"
              disabled={!entry || !worldId || statement.trim().length === 0}
              onClick={() => {
                if (!entry || !worldId) return;
                settleThread(worldId, entry.id, resolvedType, statement.trim());
                navigate(`/w/${worldId}/canon/${entry.id}`);
              }}
            >
              Stage settlement
            </Button>
          </div>
          <Callout title="Settling is an ordinary accept">
            The staged proposal shows its ripples; accepting settles the entry, closes the thread
            and moves the canon revision once.
          </Callout>
        </div>
      </Section>
    </Screen>
  );
}

export function NewCanonScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const [entryType, setEntryType] = useState<(typeof SETTLE_TYPES)[number]>("rule");
  const [title, setTitle] = useState("");
  const [statement, setStatement] = useState("");
  const nextId = world ? `CANON-${String(world.meta.nextCanonId).padStart(3, "0")}` : "CANON-…";
  return (
    <Screen id="new-canon">
      <PageHeader title="New canon entry" meta={<span>takes {nextId} at staging, and keeps it</span>} />
      <div className="scr-form">
        <div className="scr-field">
          <label className="scr-field__label">Type</label>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {SETTLE_TYPES.map((t) => (
              <Button key={t} variant={t === entryType ? "primary" : "secondary"} onClick={() => setEntryType(t)}>
                {t}
              </Button>
            ))}
          </div>
        </div>
        <div className="scr-field">
          <label className="scr-field__label">Title</label>
          <Input placeholder="Tide-calling" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="scr-field">
          <label className="scr-field__label">Statement</label>
          <Textarea
            placeholder="A caller cannot move a tide she has not stood in…"
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
          />
        </div>
        <div>
          <Button
            variant="primary"
            disabled={!worldId || title.trim().length === 0 || statement.trim().length === 0}
            onClick={() => {
              if (!worldId) return;
              stageEntryMsg(worldId, entryType, title.trim(), statement.trim());
              navigate(`/w/${worldId}/canon`);
            }}
          >
            Stage entry
          </Button>
        </div>
        <Callout title="Ids are permanent">
          The entry reserves the next CANON number at staging and keeps it forever — retired ids
          are never reused, so citations never drift. Contradiction candidates appear on the
          proposal as an aid; nothing blocks.
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
