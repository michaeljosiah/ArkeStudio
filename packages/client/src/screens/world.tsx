import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router";
import {
  compilationIsStale,
  deriveCut,
  designatedCompilation,
  formatMicroUsd,
  headGate,
  tileIsStale,
  type CanonEntry,
  type Sheet,
} from "@arke-studio/contracts";
import { DegradedBanner, EmptyState, PageHeader, Screen, Section } from "../components/layout.js";
import { Badge, Button, Callout, Card, Input, Textarea, cx } from "../components/ui.js";
import { CanonEntryRow, ReferenceTile } from "../domain/domain.js";
import { ActivityIcon, ChevronRight, Plus, Sliders } from "../components/icons.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { ConnectedProposalPanel } from "../domain/connected.js";
import { shortDateTime } from "../lib/format.js";
import { useOpenWorldGuard, useSheet } from "../lib/selectors.js";
import {
  askCanon,
  assignVoice,
  chooseAnchor as chooseAnchorMsg,
  compileGrid as compileGridMsg,
  createSheetFromSentence,
  designateCompilation,
  draftWithStudio,
  duplicateSheet,
  establishLook,
  generateMissingTiles,
  lockTile as lockTileMsg,
  openThread as openThreadMsg,
  reconcileExternalEdit,
  reloadWorld,
  renameSheet,
  replyToPermission,
  requestCanonRefs,
  requestSheetRefs,
  retireEntity,
  searchCanonList,
  setSheetStatus,
  setStyleOverride as setStyleOverrideMsg,
  settleThread,
  stageCanonAmendment as stageAmendmentMsg,
  stageCanonEntry as stageEntryMsg,
  stageSheetEdit,
  extractArtifact,
  fileArtifactMsg,
  importFolder,
  requestVoiceCandidates,
  requestVoicePreview,
  resolveExtraction,
  transcribeDictation,
  useArtifactNotices,
  useImportReport,
  useAskResults,
  useCanonRefs,
  useCanonSearches,
  useDictation,
  usePermissions,
  useSheetRefs,
  useStore,
  useVoiceCandidates,
  useVoicePreviews,
  useVoiceSidecar,
  useWorld,
} from "../lib/store.js";

/** World screens (§2.9): the world is the home, productions are lenses over it. */

export function WorldLayout() {
  const { worldId } = useParams();
  useOpenWorldGuard(worldId);
  const { state } = useStore();
  const navigate = useNavigate();
  const attention = (state?.app.jobs.some((j) => j.status === "needs-reconciliation") ?? false) ||
    (state?.app.queues.some((q) => q.paused) ?? false);
  const nav = [
    ["", "Overview"],
    ["cast", "Characters"],
    ["locations", "Locations"],
    ["factions", "Factions"],
    ["canon", "Canon"],
    ["artifacts", "Artifacts"],
    ["productions", "Productions"],
  ] as const;
  return (
    <div className="fy-app">
      <div className="fy-titlebar">
        <div className="fy-titlebar__side">
          <button className="fy-iconbtn" title="Settings" onClick={() => navigate("/settings/providers")}>
            <Sliders size={13} />
          </button>
          <button className="fy-iconbtn" title="Activity" onClick={() => navigate("/activity")}>
            <ActivityIcon size={13} />
            {attention && <span className="fy-iconbtn__dot" />}
          </button>
        </div>
        <div className="fy-titlebar__center">Arke Studio</div>
        <div className="fy-titlebar__side fy-titlebar__side--right">
          <span className="fy-titlebar__mark" onClick={() => navigate("/worlds")}>
            Arke
          </span>
        </div>
      </div>
      <div className="fy-content">
        <nav className="fy-pillnav">
          {nav.map(([slug, label]) => (
            <NavLink
              key={slug}
              to={`/w/${worldId}${slug ? `/${slug}` : ""}`}
              end={slug === ""}
              className={({ isActive }) => cx("fy-pillnav__item", isActive && "fy-pillnav__item--active")}
            >
              {label}
            </NavLink>
          ))}
        </nav>
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

/** The world hub (prototype 1c): hero, the cast fanned like held cards, and two ways in. */
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
  const slug = world.meta.slug;
  const characters = world.sheets.filter((s) => s.type === "character" && s.retired !== true).slice(0, 5);
  const threads = world.canon.filter((c) => c.status === "open");
  const proposals = world.proposals;
  const production = world.productions[0];
  const cut = production ? deriveCut(production) : null;
  // The prototype's fan: per-slot offset, rotation and drift, centre card forward.
  const FAN = [
    { left: -410, top: 30, rotate: -9, z: 1, dur: 7.4, delay: 0 },
    { left: -255, top: 8, rotate: -4, z: 2, dur: 8.1, delay: 0.5 },
    { left: -85, top: 0, rotate: 0, z: 3, dur: 7.8, delay: 1 },
    { left: 85, top: 8, rotate: 4, z: 2, dur: 8.6, delay: 1.4 },
    { left: 240, top: 30, rotate: 9, z: 1, dur: 7.1, delay: 1.8 },
  ];
  return (
    <div data-screen="world-overview">
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">
          A world of yours · canon v{world.meta.canonRevision}
          {proposals.length > 0 ? ` · ${proposals.length} awaiting you` : ""}
        </div>
        <h1 className="fy-hero__title">{world.meta.name}</h1>
        {world.meta.logline && <p className="fy-hero__lede">{world.meta.logline}</p>}
      </div>
      <div className="fy-fan">
        {characters.map((sheet, i) => {
          const slot = FAN[i] ?? FAN[2]!;
          return (
            <div key={sheet.id} className="fy-fan__slot" style={{ marginLeft: slot.left, top: slot.top, zIndex: slot.z }}>
              <div
                className="fy-fan__drift"
                style={{ animationDuration: `${slot.dur}s`, animationDelay: `${slot.delay}s` }}
              >
                <div
                  className="fy-polaroid"
                  style={{ transform: `rotate(${slot.rotate}deg)` }}
                  onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}`)}
                >
                  <div className="fy-polaroid__frame">
                    <Portrait worldSlug={slug} path={sheetPortraitPath(sheet.id)} label={sheet.name} />
                  </div>
                  <div className="fy-polaroid__name">{sheet.name}</div>
                  <div className="fy-polaroid__role">
                    {sheet.role ?? sheet.sections[0]?.body.split(/[.!?]/)[0] ?? ""}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {characters.length === 0 && (
          <div style={{ textAlign: "center", paddingTop: 120 }}>
            <EmptyState title="No one lives here yet" hint="Start with a sentence — a character grows from it." />
          </div>
        )}
      </div>
      <div className="fy-ctas">
        {production && cut && (
          <div className="fy-cta" onClick={() => navigate(`/w/${worldId}/p/${production.meta.id}`)}>
            <div className="fy-cta__frame">
              <Portrait
                worldSlug={slug}
                path={`productions/${production.meta.id}/${production.scenes[0]?.board?.image ?? "board-v2.png"}`}
                label={production.meta.title}
                radius={8}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-cta__title">Continue {production.meta.title}</div>
              <div className="fy-cta__sub">
                {cut.covered} of {cut.entries.length} shots covered
                {cut.gaps > 0 ? ` · ${cut.gaps} gap${cut.gaps === 1 ? "" : "s"} to close.` : " · the boards are ready."}
              </div>
            </div>
            <Button>Open</Button>
          </div>
        )}
        <div className="fy-cta" onClick={() => navigate(`/w/${worldId}/canon`)}>
          <div className="fy-cta__frame">
            <Portrait worldSlug={slug} path={sheetPortraitPath("the-saltmarket")} label="Canon" radius={8} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="fy-cta__title">Grow the canon</div>
            <div className="fy-cta__sub">
              {threads.length > 0
                ? `${threads.length} open thread${threads.length === 1 ? "" : "s"}, waiting to be pulled.`
                : `${world.canon.length} entries hold; nothing is unsettled.`}
            </div>
          </div>
          <Button variant="secondary">Write</Button>
        </div>
      </div>
      {proposals.length > 0 && (
        <div style={{ padding: "0 96px" }}>
          <Section title="Needs you" aside={<span>{proposals.length} awaiting a decision</span>}>
            {proposals.map((p) => (
              <ConnectedProposalPanel key={p.proposal.id} staged={p} />
            ))}
          </Section>
        </div>
      )}
      {threads.length > 0 && (
        <div style={{ padding: "0 96px" }}>
          <Section title="Open threads" aside={<span>unsettled canon, waiting to be pulled</span>}>
            <div className="scr-sectionlist">
              {threads.map((t) => (
                <CanonEntryRow key={t.id} entry={t} onOpen={() => navigate(`/w/${worldId}/canon/${t.id}/thread`)} />
              ))}
            </div>
          </Section>
        </div>
      )}
      <div style={{ padding: "0 96px 40px" }}>
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
      </div>
    </div>
  );
}

// ---- Sheet list screens ----------------------------------------------------

/** The ledger layout (prototype 1d): one featured portrait, the rest as quiet rows. */
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
  const [featuredId, setFeaturedId] = useState<string | null>(null);
  const sheets = world?.sheets.filter((s) => s.type === kind && s.retired !== true) ?? [];
  const retired = world?.sheets.filter((s) => s.type === kind && s.retired === true).length ?? 0;
  const locked = sheets.filter((s) => s.status === "locked").length;
  const sketches = sheets.filter((s) => s.status === "sketch").length;
  const featured = sheets.find((s) => s.id === featuredId) ?? sheets[0] ?? null;
  const slug = world?.meta.slug;
  const roleOf = (sheet: Sheet): string =>
    [sheet.role, sheet.billing].filter(Boolean).join(" · ") ||
    (sheet.sections[0]?.body.split(/[.!?]/)[0] ?? "").slice(0, 60);
  return (
    <div data-screen={screenId}>
      <div className="fy-corner">
        <Button variant="primary" onClick={() => navigate(newPath)}>
          New {kind}
        </Button>
      </div>
      {sheets.length === 0 ? (
        <div style={{ paddingTop: 140 }}>
          <EmptyState title={`No ${kind}s yet`} hint={hint} />
        </div>
      ) : (
        <div className="fy-split">
          {featured && (
            <div className="fy-split__side">
              <div className="fy-feature">
                <div className="fy-feature__frame">
                  <Portrait worldSlug={slug} path={sheetPortraitPath(featured.id)} label={featured.name} radius={9} />
                </div>
                <div className="fy-feature__title">
                  {featured.name}
                  <span className={cx("fy-dot", featured.status === "locked" ? "fy-dot--ok" : "fy-dot--sketch")} />
                  <span className="fy-feature__note">{featured.status === "locked" ? "canon locked" : "sketch"}</span>
                </div>
                <div className="fy-feature__sub">{roleOf(featured)}</div>
                <div className="fy-feature__actions">
                  <Button onClick={() => navigate(detailPath(featured.id))}>Open sheet</Button>
                  {kind === "character" && (
                    <Button variant="secondary" onClick={() => navigate(`/w/${worldId}/cast/${featured.id}/kit`)}>
                      Generate looks
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="fy-split__main">
            <div className="fy-ledgerhead">
              <span className="fy-ledgerhead__label">
                {title} · {sheets.length}
              </span>
              <span className="fy-ledgerhead__meta">
                {locked} canon-locked · {sketches} sketch{sketches === 1 ? "" : "es"}
                {retired > 0 ? ` · ${retired} retired` : ""}
              </span>
            </div>
            <div className="fy-ledger">
              {sheets.map((sheet) => (
                <button
                  key={sheet.id}
                  type="button"
                  className={cx("fy-row", featured?.id === sheet.id && "fy-row--selected")}
                  onClick={() =>
                    featured?.id === sheet.id ? navigate(detailPath(sheet.id)) : setFeaturedId(sheet.id)
                  }
                >
                  <div className="fy-row__thumb">
                    <Portrait worldSlug={slug} path={sheetPortraitPath(sheet.id)} label={sheet.name} radius={6} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="fy-row__name">
                      {sheet.name}
                      <span
                        className={cx("fy-dot", sheet.status === "locked" ? "fy-dot--ok" : "fy-dot--sketch")}
                        style={{ width: 6, height: 6 }}
                      />
                    </div>
                    <div className="fy-row__sub">{roleOf(sheet)}</div>
                  </div>
                  <span className="fy-row__meta">
                    {sheet.status === "locked" ? `v${sheet.version}` : `sketch · v${sheet.version}`}
                    {sheet.voice ? " · voiced" : ""}
                  </span>
                  <span className="fy-row__chev">
                    <ChevronRight />
                  </span>
                </button>
              ))}
            </div>
            <p className="fy-footnote">
              Everything you produce pulls from these sheets: change one here and it changes everywhere.
            </p>
          </div>
        </div>
      )}
    </div>
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
  const sheetRefsMap = useSheetRefs();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);

  useEffect(() => {
    if (worldId && sheetId) requestSheetRefs(worldId, sheetId);
  }, [worldId, sheetId]);

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
  const sheetPath = `${sheet.type === "character" ? "characters" : `${sheet.type}s`}/${sheet.id}.md`;
  const refs = sheetRefsMap[sheet.id];
  const isCharacter = sheet.type === "character";
  const kitTiles = (kit?.tiles ?? []).filter((t) => t.status !== "empty" && t.file !== undefined);
  const nextAngle = (kit?.tiles ?? []).find((t) => t.status === "empty")?.angle;
  const slug = world.meta.slug;
  return (
    <div className="fy-sheet" data-screen={screenId}>
      {isCharacter && (
        <div className="fy-sheet__side">
          <div className="fy-fan__drift">
            <div className="fy-designcard">
              <div className="fy-designcard__frame">
                <Portrait worldSlug={slug} path={sheetPortraitPath(sheet.id)} label={`${sheet.name}: portrait`} radius={8} />
              </div>
              <div className="fy-designcard__caption">
                <span className="fy-designcard__title">Design sheet v{sheet.version}</span>
                <span className={`fy-dot fy-dot--${sheet.status === "locked" ? "ok" : "sketch"}`} />
                <span className="fy-designcard__note">{sheet.status === "locked" ? "canon locked" : "sketch"}</span>
              </div>
            </div>
          </div>
          <div className="fy-turnstrip">
            {kitTiles.slice(0, 2).map((t) => (
              <div
                key={t.angle}
                className="fy-turnstrip__tile"
                onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}/kit`)}
              >
                <Portrait worldSlug={slug} path={`references/${sheet.id}/${t.file!}`} label={t.angle.replace(/-/g, " ")} radius={8} />
              </div>
            ))}
            <button type="button" className="fy-turnstrip__add" onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}/kit`)}>
              <Plus size={16} />
              <span>{nextAngle ? nextAngle.replace(/-/g, " ") : "Kit"}</span>
            </button>
          </div>
        </div>
      )}
      <div className="fy-sheet__main">
        <div>
          <div className="fy-sheet__eyebrow">
            {sheet.type}
            {sheet.role ? ` · ${sheet.role}` : ""}
          </div>
          <h1 className="fy-sheet__name">{sheet.name}</h1>
          <div className="fy-sheet__badges">
            <Badge tone={sheet.status === "sketch" ? "outline" : "neutral"}>
              {sheet.status === "sketch" ? `sketch · v${sheet.version}` : `v${sheet.version} · locked`}
            </Badge>
            {sheet.retired && <Badge tone="danger">retired</Badge>}
            {sheet.origin && (
              <Badge tone="outline">
                from {sheet.origin.sheet} v{sheet.origin.version}
              </Badge>
            )}
          </div>
        </div>
        <div className="fy-sheet__actions">
          {isCharacter && (
            <Button variant="primary" onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}/kit`)}>
              Generate looks{kit ? ` · ${kit.tiles.filter((t) => t.status !== "empty").length}` : ""}
            </Button>
          )}
          <Button onClick={() => navigate(`/w/${worldId}/${sheet.type === "character" ? "cast" : `${sheet.type}s`}/${sheet.id}/edit`)}>
            Edit the sheet
          </Button>
          <Button
            onClick={() => {
              if (!worldId) return;
              setSheetStatus(worldId, sheetPath, sheet.status === "locked" ? "sketch" : "locked");
            }}
            title={
              sheet.status === "locked"
                ? "Unlocking ripples: everything citing this did so as settled"
                : "Locking makes the identity settled — no image required first"
            }
          >
            {sheet.status === "locked" ? "Unlock" : "Lock to canon"}
          </Button>
        </div>
        {isCharacter && (
          <div className="fy-voicecard">
            <div>
              <div className="fy-voicecard__label">{sheet.voice ? (sheet.voice.label ?? sheet.voice.provider) : "No voice assigned"}</div>
              <div className="fy-voicecard__meta">
                {sheet.voice ? `${sheet.voice.provider} · rides with every dialogue render` : "dialogue renders stay silent until one is chosen"}
              </div>
            </div>
            <div className="fy-voicecard__side">
              <Button onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}/voice`)}>
                {sheet.voice ? "Change voice" : "Choose voice"}
              </Button>
            </div>
          </div>
        )}
        <div className="fy-sheet__quiet">
          <Button variant="ghost" onClick={() => setRenaming(renaming === null ? sheet.name : null)}>
            Rename
          </Button>
          <Button variant="ghost" onClick={() => setDuplicating(duplicating === null ? `${sheet.name} (copy)` : null)}>
            Duplicate
          </Button>
          <Button
            variant="ghost"
            disabled={sheet.retired === true}
            onClick={() => worldId && retireEntity(worldId, sheetPath)}
            title="Stays resolvable for existing citations; leaves pickers for new work"
          >
            Retire
          </Button>
        </div>
      {renaming !== null && (
        <Card className="scr-form">
          <div className="scr-field">
            <label className="scr-field__label">New name — the id and every citation stay</label>
            <Input value={renaming} onChange={(e) => setRenaming(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              variant="primary"
              disabled={renaming.trim().length === 0 || renaming.trim() === sheet.name}
              onClick={() => {
                if (worldId) renameSheet(worldId, sheetPath, renaming.trim());
                setRenaming(null);
              }}
            >
              Stage rename
            </Button>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
      {duplicating !== null && (
        <Card className="scr-form">
          <div className="scr-field">
            <label className="scr-field__label">
              Duplicate as — a sketch recording its origin at v{sheet.version}; {sheet.name} is untouched
            </label>
            <Input value={duplicating} onChange={(e) => setDuplicating(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              variant="primary"
              disabled={duplicating.trim().length === 0}
              onClick={() => {
                if (worldId) duplicateSheet(worldId, sheetPath, duplicating.trim());
                setDuplicating(null);
              }}
            >
              Stage duplicate
            </Button>
            <Button variant="ghost" onClick={() => setDuplicating(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
      {staged.map((p) => (
        <ConnectedProposalPanel key={p.proposal.id} staged={p} />
      ))}
      <div className="fy-sheet__grid">
        {sheet.sections.map((s) => (
          <div key={s.heading}>
            <div className="fy-sheet__sechead">{s.heading}</div>
            <div className="fy-sheet__secbody">{s.body}</div>
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
      {(sheet.links.length > 0 || (refs?.incomingLinks.length ?? 0) > 0) && (
        <Section title="Linked" aside={<span>outgoing authored here; incoming from the index</span>}>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {sheet.links.map((link) => {
              const other = world.sheets.find((s) => s.id === link);
              if (!other) return <Badge key={link} tone="outline">{link}</Badge>;
              const base = other.type === "character" ? "cast" : `${other.type}s`;
              return (
                <Button key={link} variant="secondary" onClick={() => navigate(`/w/${worldId}/${base}/${link}`)}>
                  {other.name} →
                </Button>
              );
            })}
            {(refs?.incomingLinks ?? [])
              .filter((id) => !sheet.links.includes(id))
              .map((id) => {
                const other = world.sheets.find((s) => s.id === id);
                const base = other ? (other.type === "character" ? "cast" : `${other.type}s`) : "cast";
                return (
                  <Button key={id} variant="ghost" onClick={() => navigate(`/w/${worldId}/${base}/${id}`)}>
                    ← {other?.name ?? id}
                  </Button>
                );
              })}
          </div>
        </Section>
      )}
      {refs && (
        <Section title="From this sheet" aside={<span>computed from the index, never stored</span>}>
          <div className="lay-stats">
            <div className="lay-stats__item">
              <div className="lay-stats__value">{refs.tiles}</div>
              <div className="lay-stats__label">reference tiles</div>
            </div>
            <div className="lay-stats__item">
              <div className="lay-stats__value">{refs.productions.length}</div>
              <div className="lay-stats__label">productions</div>
            </div>
            <div className="lay-stats__item">
              <div className="lay-stats__value">{refs.artifacts.length}</div>
              <div className="lay-stats__label">artifacts</div>
            </div>
            <div className="lay-stats__item">
              <div className="lay-stats__value">
                {Object.values(refs.takesByVersion).reduce((a, b) => a + b, 0)}
              </div>
              <div className="lay-stats__label">
                takes
                {Object.keys(refs.takesByVersion).length > 1
                  ? ` across v${Object.keys(refs.takesByVersion).sort().join(", v")}`
                  : ""}
              </div>
            </div>
          </div>
        </Section>
      )}
      </div>
    </div>
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
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
            <DictationButton onText={(text) => setInstruction((prev) => (prev ? `${prev} ${text}` : text))} />
            <span className="scr-field__hint">
              The agent drafts inside a proposal — its own copy of this sheet — and reads the rest
              of the world through canon search, never the folder. You accept or discard the result.
            </span>
          </div>
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

/**
 * Push-to-talk dictation (SPEC-011 R-17, R-18): recorded here, transcribed on loopback by
 * whisper.cpp — audio never leaves the machine — and inserted as editable text, never
 * submitted. A mis-transcribed instruction that submits itself is a proposal nobody meant.
 */
export function DictationButton({ onText }: { onText: (text: string) => void }) {
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const sidecar = useVoiceSidecar();
  const dictation = useDictation();
  const result = requestId ? dictation[requestId] : undefined;
  useEffect(() => {
    if (result?.text) {
      onText(result.text);
      setRequestId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.text]);
  const unavailable = sidecar !== null && sidecar.state !== "ready";
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const id = `dict-${Date.now()}`;
        setRequestId(id);
        void new Blob(chunks, { type: rec.mimeType }).arrayBuffer().then((buf) => {
          let binary = "";
          const bytes = new Uint8Array(buf);
          for (const b of bytes) binary += String.fromCharCode(b);
          transcribeDictation(id, btoa(binary), rec.mimeType || "audio/webm");
        });
      };
      rec.start();
      setRecorder(rec);
    } catch {
      /* microphone denied — the button simply does nothing further */
    }
  };
  return (
    <span style={{ display: "inline-flex", gap: "var(--space-2)", alignItems: "center" }}>
      <Button
        variant="ghost"
        disabled={unavailable}
        title={unavailable ? (sidecar?.detail ?? "local voice is off") : "Audio is transcribed locally and never sent to a provider"}
        onClick={() => {
          if (recorder) {
            recorder.stop();
            setRecorder(null);
          } else {
            void start();
          }
        }}
      >
        {recorder ? "Stop · transcribe" : "🎤 Dictate"}
      </Button>
      {requestId && !result && <span className="scr-field__hint">transcribing locally…</span>}
      {result?.error && <span className="scr-field__hint">{result.error}</span>}
    </span>
  );
}

// ---- Reference kit / model sheet / voice ----------------------------------

export function ReferenceKitScreen() {
  const { worldId, sheetId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const { state } = useStore();
  const navigate = useNavigate();
  const kit = world?.referenceKits.find((k) => k.sheetId === sheetId) ?? null;
  const gate = headGate(kit ?? { sheetId: sheetId ?? "x", tiles: [], compilations: [] });
  const hasAnchor = kit?.anchor !== undefined;
  const staleTiles = sheet && kit ? kit.tiles.filter((t) => tileIsStale(t, sheet.version)) : [];
  // Establish candidates land as job artifacts; list them off succeeded candidate jobs (R-5).
  const candidates =
    state?.app.jobs
      .filter(
        (j) =>
          j.status === "succeeded" &&
          j.target.kind === "establish-candidate" &&
          j.target.id?.startsWith(`${sheetId}/`) === true,
      )
      .flatMap((j) => j.landedFiles ?? []) ?? [];
  const [style, setStyle] = useState<string | null>(null);
  const styleValue = style ?? kit?.styleOverride ?? "";
  return (
    <Screen id="reference-kit">
      <PageHeader
        title={sheet ? `Reference kit — ${sheet.name}` : "Reference kit"}
        meta={
          hasAnchor ? (
            <span>anchor set — every generation carries it</span>
          ) : (
            <span>no anchor yet — establish a look first</span>
          )
        }
        actions={
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/model-sheet`)}>
            Model sheet
          </Button>
        }
      />
      {staleTiles.length > 0 && sheet && (
        <Callout tone="warning" title={`${staleTiles.length} tile${staleTiles.length === 1 ? "" : "s"} predate v${sheet.version}`}>
          Made against an older sheet — regenerate looks to catch up. They still reference; the gap is
          named, not enforced.
        </Callout>
      )}
      {!hasAnchor && (
        <Section title="Establish a look" aside={<span>Candidates from the sentence and the world's tone</span>}>
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
            <Button
              variant="primary"
              onClick={() => {
                if (worldId && sheetId) establishLook(worldId, sheetId, 4);
              }}
            >
              Generate first looks ×4
            </Button>
            <span className="scr-field__hint">Pick one and it becomes the face everything inherits.</span>
          </div>
          {candidates.length > 0 && (
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
              {candidates.map((file) => (
                <Button
                  key={file}
                  onClick={() => {
                    if (worldId && sheetId)
                      chooseAnchorMsg(worldId, sheetId, file.replace(`references/${sheetId}/`, ""));
                  }}
                >
                  Choose {file.split("/").pop()}
                </Button>
              ))}
            </div>
          )}
        </Section>
      )}
      <Section
        title="Head turnaround"
        aside={
          gate.ready ? (
            <Badge tone="success">complete — body unlocked</Badge>
          ) : (
            <span>
              {4 - gate.outstanding.length} of 4 locked · outstanding: {gate.outstanding.join(", ")}
            </span>
          )
        }
      >
        <div className="lay-cardgrid">
          {(kit?.tiles ?? []).filter((t) => t.angle.startsWith("head")).map((tile, i) => (
            <div key={`${tile.angle}-${i}`}>
              <ReferenceTile tile={tile} worldSlug={world?.meta.slug} sheetId={sheetId} />
              {tile.status === "generated" && (
                <Button
                  onClick={() => {
                    if (worldId && sheetId) lockTileMsg(worldId, sheetId, tile.angle);
                  }}
                >
                  Lock
                </Button>
              )}
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          disabled={!hasAnchor}
          onClick={() => {
            if (worldId && sheetId) generateMissingTiles(worldId, sheetId, "head");
          }}
        >
          Generate missing head angles
        </Button>
      </Section>
      <Section
        title="Body turnaround"
        aside={!gate.ready ? <span>blocked — a body without a locked face is a different person</span> : undefined}
      >
        <div className="lay-cardgrid">
          {(kit?.tiles ?? []).filter((t) => t.angle.startsWith("body")).map((tile, i) => (
            <div key={`${tile.angle}-${i}`}>
              <ReferenceTile tile={tile} worldSlug={world?.meta.slug} sheetId={sheetId} />
              {tile.status === "generated" && (
                <Button
                  onClick={() => {
                    if (worldId && sheetId) lockTileMsg(worldId, sheetId, tile.angle);
                  }}
                >
                  Lock
                </Button>
              )}
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          disabled={!gate.ready}
          title={gate.ready ? undefined : `outstanding: ${gate.outstanding.join(", ")}`}
          onClick={() => {
            if (worldId && sheetId) generateMissingTiles(worldId, sheetId, "body");
          }}
        >
          {gate.ready ? "Generate missing body angles" : `Body blocked · ${gate.outstanding.length} head angle${gate.outstanding.length === 1 ? "" : "s"} outstanding`}
        </Button>
      </Section>
      <Section title="Rendering style" aside={<span>Override travels with this sheet only — canon doesn't change</span>}>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Input
            placeholder="inherits the world's art direction"
            value={styleValue}
            onChange={(e) => setStyle(e.target.value)}
          />
          <Button
            onClick={() => {
              if (worldId && sheetId) {
                setStyleOverrideMsg(worldId, sheetId, styleValue.trim() === "" ? null : styleValue.trim());
                setStyle(null);
              }
            }}
          >
            Set
          </Button>
        </div>
      </Section>
    </Screen>
  );
}

export function ModelSheetScreen() {
  const { sheetId, worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const kit = world?.referenceKits.find((k) => k.sheetId === sheetId) ?? null;
  const locked = kit?.tiles.filter((t) => t.status === "locked") ?? [];
  const designated = kit ? designatedCompilation(kit) : null;
  return (
    <Screen id="model-sheet-generate">
      <PageHeader
        title="Model sheet"
        meta={<span>{locked.length} locked tiles available to compile</span>}
        actions={
          <Button
            variant="primary"
            disabled={locked.length === 0}
            onClick={() => {
              if (worldId && sheetId) compileGridMsg(worldId, sheetId);
            }}
          >
            Compile classic grid — free, local
          </Button>
        }
      />
      {(kit?.compilations ?? []).length > 0 && sheet && (
        <Section title="Compilations" aside={<span>exactly one rides along with dispatches</span>}>
          <div className="scr-sectionlist">
            {kit!.compilations.map((c) => {
              const stale = compilationIsStale(kit!, c, sheet.version);
              const isDesignated = designated?.file === c.file;
              return (
                <div key={c.file} className="scr-sheetsection">
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <strong style={{ font: "var(--type-ui)" }}>{c.file}</strong>
                    <span style={{ font: "var(--type-label)", color: "var(--muted-foreground)" }}>
                      {c.format} · sheet v{c.sheetVersion} · {c.tiles.length} tiles
                    </span>
                    <span style={{ marginLeft: "auto", display: "flex", gap: "var(--space-2)" }}>
                      {stale && <Badge tone="warning">stale — sheet is at v{sheet.version}</Badge>}
                      {isDesignated ? (
                        <Badge tone="success">rides along</Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (worldId && sheetId) designateCompilation(worldId, sheetId, c.file);
                          }}
                        >
                          Designate
                        </Button>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}
      <Callout title="The grid is deterministic">
        Same tiles in, identical image out — a composite, not a generation. It costs nothing, cannot
        hallucinate, and never touches a provider. Pitch and expression boards arrive as takes with
        SPEC-013's review loop.
      </Callout>
      <div className="lay-cardgrid">
        {locked.map((tile, i) => (
          <ReferenceTile key={`${tile.angle}-${i}`} tile={tile} worldSlug={world?.meta.slug} sheetId={sheetId} />
        ))}
      </div>
    </Screen>
  );
}

export function VoicePickerScreen() {
  const { worldId, sheetId } = useParams();
  const sheet = useSheet(worldId, sheetId);
  const [provider, setProvider] = useState("elevenlabs");
  const [voiceId, setVoiceId] = useState("");
  const [label, setLabel] = useState("");
  const sheetPath = sheet ? `characters/${sheet.id}.md` : null;
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
        actions={
          sheet?.voice && (
            <Button
              variant="ghost"
              onClick={() => {
                if (worldId && sheetPath) assignVoice(worldId, sheetPath, null);
              }}
            >
              Clear voice
            </Button>
          )
        }
      />
      <Section title="Assign directly" aside={<span>a gated sheet change — it versions and ripples</span>}>
        <div className="scr-form">
          <div className="scr-field">
            <label className="scr-field__label">Provider</label>
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
              {["elevenlabs", "openai", "voxa"].map((p) => (
                <Button key={p} variant={p === provider ? "primary" : "secondary"} onClick={() => setProvider(p)}>
                  {p}
                </Button>
              ))}
            </div>
          </div>
          <div className="scr-field">
            <label className="scr-field__label">Voice id</label>
            <Input placeholder="v_8Kq2" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} />
          </div>
          <div className="scr-field">
            <label className="scr-field__label">Label</label>
            <Input placeholder="Low tide" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div>
            <Button
              variant="primary"
              disabled={!worldId || !sheetPath || voiceId.trim().length === 0}
              onClick={() => {
                if (!worldId || !sheetPath) return;
                assignVoice(worldId, sheetPath, {
                  provider,
                  voiceId: voiceId.trim(),
                  ...(label.trim() ? { label: label.trim() } : {}),
                });
              }}
            >
              Stage assignment
            </Button>
          </div>
        </div>
      </Section>
      <DegradedBanner component="voice" />
      <VoiceCandidatesPanel worldId={worldId} sheetId={sheetId} sheetPath={sheetPath} />
    </Screen>
  );
}

function VoiceCandidatesPanel({
  worldId,
  sheetId,
  sheetPath,
}: {
  worldId: string | undefined;
  sheetId: string | undefined;
  sheetPath: string | null;
}) {
  const candidates = useVoiceCandidates()[sheetId ?? ""];
  const previews = useVoicePreviews();
  const sidecar = useVoiceSidecar();
  return (
    <>
      {sidecar && sidecar.state !== "ready" && (
        <Callout tone="warning" title={`Local voice — ${sidecar.state}`}>
          {sidecar.detail}
        </Callout>
      )}
      <Section
        title="Find a voice"
        aside={<span>ranked by attribute overlap with the written voice — not a similarity score</span>}
      >
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <Button
            variant="primary"
            onClick={() => {
              if (worldId && sheetId) requestVoiceCandidates(worldId, sheetId);
            }}
          >
            Match against the written voice
          </Button>
          {candidates && (
            <span className="scr-field__hint">
              matched on: {candidates.extracted.join(" · ") || "nothing extractable"} — previews read{" "}
              {candidates.previewLine.source === "own-line"
                ? "her own line"
                : candidates.previewLine.source === "drafted"
                  ? "a line drafted from the sheet"
                  : "a stock sentence (nothing else exists)"}
            </span>
          )}
        </div>
        {candidates && (
          <div className="scr-sectionlist">
            {candidates.ranked.slice(0, 8).map(({ candidate, matched, overlap }) => {
              const key = `${candidate.provider}/${candidate.voiceId}`;
              const preview = previews[key];
              return (
                <div key={key} className="scr-sheetsection">
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <strong style={{ font: "var(--type-ui)" }}>{candidate.label}</strong>
                    <span style={{ font: "var(--type-label)", color: "var(--muted-foreground)" }}>
                      {candidate.provider}
                      {candidate.local ? " · local — fixed catalogue, cannot be cloned" : ""}
                    </span>
                    <span style={{ marginLeft: "auto" }}>
                      <Badge tone="outline">{Math.round(overlap * 100)}% attribute overlap</Badge>
                    </span>
                  </div>
                  {matched.length > 0 && (
                    <span className="scr-field__hint">matched to: {matched.join(" · ")}</span>
                  )}
                  <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (worldId && sheetId) requestVoicePreview(worldId, sheetId, candidate.provider, candidate.voiceId);
                      }}
                    >
                      {candidate.local
                        ? "Preview — free, local"
                        : `Preview${candidates.cloudPreviewMicroUsd !== null ? ` · ${formatMicroUsd(candidates.cloudPreviewMicroUsd)}` : ""}`}
                    </Button>
                    {preview?.file && <Badge tone="success">ready — replays free</Badge>}
                    {preview?.error && <span className="scr-field__hint">{preview.error}</span>}
                    <Button
                      onClick={() => {
                        if (worldId && sheetPath)
                          assignVoice(worldId, sheetPath, {
                            provider: candidate.provider,
                            voiceId: candidate.voiceId,
                            label: candidate.label,
                          });
                      }}
                    >
                      Assign
                    </Button>
                    {candidate.canClone ? (
                      <span className="scr-field__hint">cloning available — rights to a recorded voice are yours to hold</span>
                    ) : (
                      candidate.local && <span className="scr-field__hint">no cloning — local means presets</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}

// ---- New sheet screens -----------------------------------------------------

function NewSheetScreen({
  screenId,
  title,
  sheetType,
}: {
  screenId: string;
  title: string;
  sheetType: "character" | "location" | "faction";
}) {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const { state } = useStore();
  const [name, setName] = useState("");
  const [sentence, setSentence] = useState("");
  const harnessReady = state?.app.health.harness.status === "healthy";
  const characters = world?.sheets.filter((s) => s.type === "character").length ?? 0;
  const listPath = sheetType === "character" ? "cast" : `${sheetType}s`;

  return (
    <Screen id={screenId}>
      <PageHeader title={title} />
      {world && (
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <Badge tone="outline">{world.meta.name}</Badge>
          <Badge tone="outline">canon v{world.meta.canonRevision}</Badge>
          {world.meta.tone && <Badge tone="outline">tone · {world.meta.tone}</Badge>}
          <Badge tone="outline">{characters} existing characters</Badge>
        </div>
      )}
      <div className="scr-form">
        <div className="scr-field">
          <label className="scr-field__label">Name</label>
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="scr-field">
          <label className="scr-field__label">One sentence to draft from</label>
          <Textarea
            placeholder="A rope-seller who remembers every knot she has ever sold, and who bought it."
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
          />
          <span className="scr-field__hint">
            {harnessReady
              ? "The studio drafts the full sheet from this, against canon, tone and the existing cast; it lands as a sketch you accept."
              : "Without OpenCode running, the sentence seeds the sheet as-is — still a sketch through the gate."}
          </span>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button
            variant="primary"
            disabled={!worldId || name.trim().length === 0 || sentence.trim().length === 0}
            onClick={() => {
              if (!worldId) return;
              createSheetFromSentence(worldId, sheetType, name.trim(), sentence.trim());
              navigate(`/w/${worldId}/${listPath}`);
            }}
          >
            {harnessReady ? "Draft as sketch" : "Create as sketch"}
          </Button>
        </div>
        <Callout title="Sketch first, lock later">
          A new sheet starts as a sketch — citable, visibly provisional. Locking it is its own
          gated change, and needs no image to exist first.
        </Callout>
      </div>
      <DegradedBanner component="harness" />
    </Screen>
  );
}

export const NewCharacterScreen = () => (
  <NewSheetScreen screenId="new-character" title="New character" sheetType="character" />
);
export const NewLocationScreen = () => (
  <NewSheetScreen screenId="new-location" title="New location" sheetType="location" />
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
  const report = useImportReport();
  const notices = useArtifactNotices();
  const [importPath, setImportPath] = useState("");
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  // Superseded artifacts drop out of the listing the way they drop out of pickers (R-5).
  const superseded = new Set(artifacts.map((a) => a.supersedes).filter((s): s is string => s !== undefined));
  const visible = artifacts.filter((a) => !superseded.has(a.id) && (kindFilter === null || a.kind === kindFilter));
  const kinds = [...new Set(artifacts.map((a) => a.kind))];
  const batches = artifacts.filter((a) => (a.extraction?.pending.length ?? 0) > 0);
  return (
    <Screen id="artifacts">
      <PageHeader
        title="Artifacts"
        meta={
          <span>
            {visible.length} filed against the world
            {superseded.size > 0 ? ` · ${superseded.size} superseded (history keeps them)` : ""}
          </span>
        }
        actions={
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Input
              placeholder="C:\\path\\to\\your\\notes"
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
              style={{ minWidth: 280 }}
            />
            <Button
              variant="primary"
              disabled={importPath.trim().length === 0}
              onClick={() => {
                if (worldId) importFolder(worldId, importPath.trim());
              }}
            >
              Import folder
            </Button>
          </div>
        }
      />
      {notices.map((n, i) => (
        <Callout key={`${n.sourcePath}-${i}`} tone="warning" title={n.outcome === "needs-consent" ? "Large file" : "Filing refused"}>
          {n.reason}
          {n.outcome === "needs-consent" && worldId && (
            <>
              {" "}
              <Button onClick={() => fileArtifactMsg(worldId, n.sourcePath, { allowLarge: true })}>
                Copy it anyway
              </Button>
            </>
          )}
        </Callout>
      ))}
      {report && (
        <Callout title={`Imported: ${report.filed.length} filed · ${report.deduplicated.length} already held · ${report.excluded.length} excluded`}>
          {report.excluded.length > 0 && (
            <span>
              excluded: {report.excluded.slice(0, 5).map((e) => `${e.name} (${e.reason})`).join(", ")}
              {report.excluded.length > 5 ? "…" : ""} — reported, never silent.
            </span>
          )}
          {report.needsConsent.length > 0 && (
            <span> {report.needsConsent.length} large file{report.needsConsent.length === 1 ? "" : "s"} await consent above.</span>
          )}
        </Callout>
      )}
      {batches.map((artifact) => (
        <Section
          key={artifact.id}
          title={`Extracted from ${artifact.file}`}
          aside={
            <span>
              {artifact.extraction!.pending.length} candidate{artifact.extraction!.pending.length === 1 ? "" : "s"}
              {artifact.extraction!.droppedCount > 0
                ? ` · ${artifact.extraction!.droppedCount} dropped — quotes did not verify`
                : ""}
            </span>
          }
        >
          <div className="scr-sectionlist">
            {artifact.extraction!.pending.map((candidate) => (
              <div key={candidate.hash} className="scr-sheetsection">
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                  <Badge tone="outline">{candidate.kind}</Badge>
                  <strong style={{ font: "var(--type-ui)" }}>{candidate.name}</strong>
                  {candidate.section && (
                    <span style={{ font: "var(--type-label)", color: "var(--muted-foreground)" }}>→ {candidate.section}</span>
                  )}
                </div>
                <span>{candidate.body}</span>
                <span className="scr-field__hint">
                  “{candidate.quote}”{candidate.line !== undefined ? ` — line ${candidate.line}` : ""} · verified against the source
                </span>
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button
                    onClick={() => {
                      if (worldId) resolveExtraction(worldId, artifact.id, candidate.hash, "accept");
                    }}
                  >
                    Accept — commits on its own
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (worldId) resolveExtraction(worldId, artifact.id, candidate.hash, "reject");
                    }}
                  >
                    Reject — leaves no trace
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      ))}
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <Button variant={kindFilter === null ? "primary" : "ghost"} onClick={() => setKindFilter(null)}>
          all · {artifacts.filter((a) => !superseded.has(a.id)).length}
        </Button>
        {kinds.map((k) => (
          <Button key={k} variant={kindFilter === k ? "primary" : "ghost"} onClick={() => setKindFilter(k)}>
            {k} · {artifacts.filter((a) => a.kind === k && !superseded.has(a.id)).length}
          </Button>
        ))}
      </div>
      {artifacts.length === 0 ? (
        <EmptyState title="Nothing filed yet" hint="Drop recordings, documents, boards or images to file them against the world." />
      ) : (
        <div className="lay-cardgrid">
          {visible.map((a) => (
            <Card key={a.id} className="scr-worldcard">
              <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                <Badge tone="outline">{a.kind}</Badge>
                <span className="mono" style={{ fontSize: "var(--text-xs)" }}>{a.file}</span>
              </div>
              <div className="scr-worldcard__counts">
                <span>{a.origin.by === "user" ? "filed by you" : `produced by ${a.origin.producedBy}`}</span>
                {a.origin.by === "user" && a.origin.importedFrom !== undefined && <span>from {a.origin.importedFrom}</span>}
                {a.links.length > 0 && <span>links {a.links.join(", ")}</span>}
                {a.supersedes !== undefined && <span>supersedes {a.supersedes.slice(0, 10)}…</span>}
              </div>
              {a.kind === "document" && (
                <div>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (worldId) extractArtifact(worldId, a.id);
                    }}
                  >
                    Lift facts — gated, grounded, optional
                  </Button>
                </div>
              )}
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
