import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import {
  compilationIsStale,
  deriveCut,
  designatedCompilation,
  formatMicroUsd,
  headGate,
  PROVIDERS,
  tileIsStale,
  type CanonEntry,
  type Sheet,
} from "@arke-studio/contracts";
import { DegradedBanner, EmptyState, PageHeader, Screen, Section } from "../components/layout.js";
import { Badge, Button, Callout, Card, Input, Textarea, cx } from "../components/ui.js";
import { CanonEntryRow, ReferenceTile } from "../domain/domain.js";
import { ActivityIcon, ChevronRight, Play, Plus, Search, Sliders } from "../components/icons.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { Composer } from "../components/composer.js";
import { ExtractionOffer } from "../components/extraction-offer.js";
import { ConnectedProposalPanel } from "../domain/connected.js";
import { Wave } from "./production.js";
import { shortDateTime } from "../lib/format.js";
import { useOpenWorldGuard, useSheet } from "../lib/selectors.js";
import {
  askCanon,
  assignVoice,
  chooseAnchor as chooseAnchorMsg,
  compileGrid as compileGridMsg,
  createProduction,
  createSheetFromSentence,
  attachFiles,
  stopExtraction,
  useReading,
  attachHostFiles,
  discardWorldImage,
  generateWorldImage,
  useWorldImage,
  attachHostText,
  hostCanAttach,
  designateCompilation,
  continueStudio,
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
  useAuthoring,
  useCanonRefs,
  useCanonSearches,
  useDictation,
  usePermissions,
  useSheetRefs,
  useStore,
  useTranscripts,
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
/**
 * The world's key image: generate it from the logline, then keep or discard what comes back.
 *
 * This is what the disabled button on the new-world screen always promised and never did. It
 * lives here rather than there because an image job needs a world folder to land in, and on
 * the new-world screen there is no world yet — which is exactly what that button's tooltip
 * said, pointing at a hub that had nothing on it.
 */
function WorldKeyArt({ worldId, slug, hasLogline }: { worldId: string; slug: string; hasLogline: boolean }) {
  const { state } = useStore();
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const configured = new Set((state?.app.providers ?? []).filter((p) => p.configured).map((p) => p.id));
  const routed = state?.app.routing.defaults["image"];
  const model =
    state?.app.manifest?.models.find((m) => m.id === routed && m.capability === "image") ??
    state?.app.manifest?.models.find((m) => m.capability === "image");
  const usable = model !== undefined && (configured.has(model.provider) || PROVIDERS[model.provider].local === true);

  const mine = (state?.app.jobs ?? []).filter((j) => j.worldId === worldId && j.target.kind === "world-image");
  const running = mine.find((j) => j.status !== "succeeded" && j.status !== "failed" && j.status !== "cancelled");
  // Whether there is something to answer comes from the world itself, not from the job that
  // made it. A finished job stays in the queue log for good, so asking it "did you land a
  // file" answered yes on every visit — long after that file had been used or discarded.
  const waiting = state?.world?.keyArtCandidate ?? null;
  // The prompt is written by the harness before the job exists, so for a few seconds after the
  // click there is nothing in the queue to show. Without this the button looks like it missed.
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (asking && mine.length > 0) setAsking(false);
  }, [asking, mine.length]);
  const candidate = waiting !== null && !dismissed.includes(waiting) ? waiting : null;

  // A job that failed used to leave the button back at rest with nothing said — which is
  // exactly what "I clicked it and cannot see anything" looks like from the outside.
  const newest = [...mine].reverse()[0];
  const failed = newest?.status === "failed" && !dismissed.includes(newest.id) ? newest : undefined;
  if (failed && !candidate) {
    return (
      <div className="fy-keyart">
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>The key art did not come back — {failed.error ?? "the provider refused it"}</span>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            setDismissed((prev) => [...prev, failed.id]);
            generateWorldImage(worldId);
          }}
        >
          Try again
        </Button>
        <button type="button" className="fy-set__link" onClick={() => setDismissed((prev) => [...prev, failed.id])}>
          Dismiss
        </button>
      </div>
    );
  }

  if (candidate) {
    return (
      <div className="fy-keyart">
        <div className="fy-keyart__shot">
          <Portrait worldSlug={slug} path={candidate} label="Key art, just made" radius={8} />
        </div>
        <div className="fy-keyart__ask">
          <span>Keep this as the world's key image?</span>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button
              onClick={() => {
                useWorldImage(worldId);
                setDismissed((prev) => [...prev, candidate]);
              }}
            >
              Use this
            </Button>
            <button
              type="button"
              className="fy-set__link"
              onClick={() => {
                discardWorldImage(worldId);
                setDismissed((prev) => [...prev, candidate]);
              }}
            >
              Discard
            </button>
          </span>
        </div>
      </div>
    );
  }

  // Both reasons name the thing to go and fix, rather than greying out in silence.
  const reason = !hasLogline
    ? "Give the world a logline first — it is what the image is made from"
    : !usable
      ? "Frames & stills has no provider with a key — set one in Settings"
      : undefined;
  return (
    <div className="fy-keyart">
      <Button
        variant="ghost"
        disabled={asking || running !== undefined || reason !== undefined}
        {...(reason ? { title: reason } : {})}
        onClick={() => {
          setAsking(true);
          generateWorldImage(worldId);
        }}
      >
        {asking ? "Writing the prompt…" : running ? "Making the key art…" : "Generate key art from the logline"}
      </Button>
      <span className="fy-keyart__note">
        {reason ??
          (model ? `${PROVIDERS[model.provider].displayName} · ${model.displayName} · comes back for a yes` : "")}
      </span>
    </div>
  );
}

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
        <WorldKeyArt worldId={worldId!} slug={world.meta.slug} hasLogline={Boolean(world.meta.logline)} />
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

/** First sentence of a sheet's first section — the card sub-line. */
function sheetLede(sheet: { sections: Array<{ body: string }> }): string {
  const body = sheet.sections[0]?.body ?? "";
  const stop = body.indexOf(". ");
  return stop > 0 && stop < 120 ? body.slice(0, stop + 1) : body.slice(0, 120);
}

export function LocationsScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const places = (world?.sheets ?? []).filter((s) => s.type === "location" && !s.retired);
  return (
    <div data-screen="locations">
      <div className="fy-corner">
        <Button variant="primary" onClick={() => navigate(`/w/${worldId}/locations/new`)}>
          New location
        </Button>
      </div>
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">
          {world?.meta.name} · {places.length} place{places.length === 1 ? "" : "s"}
        </div>
        <h1 className="fy-hero__title" style={{ fontSize: 52 }}>
          Locations
        </h1>
        <p className="fy-hero__lede" style={{ fontSize: 15, maxWidth: 480 }}>
          Every place is a sheet, look, sound, customs. Scenes inherit them; generations cite them.
        </p>
      </div>
      <div className="fy-cardgrid" style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(places.length, 2), 4)}, minmax(0, 1fr))` }}>
        {places.map((s) => (
          <button key={s.id} type="button" className="fy-gridcard fy-gridcard--media" onClick={() => navigate(`/w/${worldId}/locations/${s.id}`)}>
            <div className="fy-gridcard__frame" style={{ height: 270 }}>
              <Portrait worldSlug={world?.meta.slug} path={sheetPortraitPath(s.id)} label={`${s.name}: establishing view`} />
            </div>
            <div className="fy-gridcard__pad">
              <div className="fy-gridcard__title" style={{ margin: "12px 0 0" }}>
                {s.name}
                <span className={`fy-dot fy-dot--${s.status === "locked" ? "ok" : "sketch"}`} style={{ width: 6, height: 6 }} />
              </div>
              <div className="fy-gridcard__body" style={{ fontSize: 12, marginTop: 3 }}>{sheetLede(s)}</div>
              <div className="fy-gridcard__foot" style={{ marginTop: 9 }}>
                {s.status === "locked" ? `locked · v${s.version}` : `sketch · v${s.version}`}
                {s.canonRules.length > 0 ? ` · ${s.canonRules.join(", ")}` : ""}
              </div>
            </div>
          </button>
        ))}
        {places.length === 0 && <EmptyState title="No locations yet" hint="Where the world happens — look, sound, customs." />}
      </div>
    </div>
  );
}

export function FactionsScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const factions = (world?.sheets ?? []).filter((s) => s.type === "faction" && !s.retired);
  const facet = (s: (typeof factions)[number], heading: string) =>
    s.sections.find((x) => x.heading.toLowerCase().includes(heading))?.body ?? null;
  return (
    <div data-screen="factions">
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">
          {world?.meta.name} · {factions.length} faction{factions.length === 1 ? "" : "s"}
        </div>
        <h1 className="fy-hero__title" style={{ fontSize: 52 }}>
          Factions
        </h1>
        <p className="fy-hero__lede" style={{ fontSize: 15, maxWidth: 460 }}>
          Who wants what, and what they'd never admit. Scenes borrow their pressure.
        </p>
      </div>
      <div className="fy-cardgrid" style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(factions.length, 2), 3)}, minmax(0, 1fr))`, padding: "32px 150px 46px" }}>
        {factions.map((s) => {
          const wants = facet(s, "want");
          const fears = facet(s, "fear");
          return (
            <button key={s.id} type="button" className="fy-gridcard fy-gridcard--media" onClick={() => navigate(`/w/${worldId}/factions/${s.id}`)}>
              <div className="fy-gridcard__frame" style={{ height: 210 }}>
                <Portrait worldSlug={world?.meta.slug} path={sheetPortraitPath(s.id)} label={`${s.name}: emblem or scene`} />
              </div>
              <div className="fy-gridcard__pad" style={{ padding: "2px 8px 0" }}>
                <div className="fy-gridcard__title" style={{ margin: "13px 0 0", fontSize: 16 }}>
                  {s.name}
                  <span className={`fy-dot fy-dot--${s.status === "locked" ? "ok" : "sketch"}`} style={{ width: 6, height: 6 }} />
                </div>
                <div className="fy-gridcard__body" style={{ marginTop: 4 }}>{sheetLede(s)}</div>
                {(wants || fears) && (
                  <div className="fy-wants">
                    {wants && (
                      <>
                        <b>wants:</b> {wants.split(". ")[0]}
                        <br />
                      </>
                    )}
                    {fears && (
                      <>
                        <b>fears:</b> {fears.split(". ")[0]}
                      </>
                    )}
                  </div>
                )}
                {s.links.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                    {s.links.slice(0, 3).map((l) => (
                      <span key={l} className="fy-pill" style={{ padding: "2px 10px", fontSize: 11 }}>
                        {l}
                      </span>
                    ))}
                  </div>
                )}
                <div className="fy-gridcard__foot" style={{ marginTop: 10 }}>
                  {s.status === "locked" ? "locked" : "sketch"} · v{s.version}
                </div>
              </div>
            </button>
          );
        })}
        {factions.length === 0 && <EmptyState title="No factions yet" hint="Groups with wants and fears." />}
      </div>
    </div>
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
  const side = isCharacter ? (
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
  ) : null;
  const main = (
      <div className={isCharacter ? "fy-sheet__main" : undefined} style={isCharacter ? undefined : { display: "grid", gap: "var(--space-4)", alignContent: "start" }}>
        <div>
          <div className="fy-sheet__eyebrow">
            {sheet.type}
            {sheet.role ? ` · ${sheet.role}` : ""}
          </div>
          <h1 className={isCharacter ? "fy-sheet__name" : "fy-locdetail__name"} style={isCharacter ? undefined : { marginTop: 10 }}>
            {sheet.name}
          </h1>
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
      <div className="fy-sheet__grid" style={isCharacter ? undefined : { gridTemplateColumns: "1fr", gap: 14 }}>
        {sheet.sections.map((s) => (
          <div key={s.heading}>
            <div className="fy-sheet__sechead" style={isCharacter ? undefined : { display: "flex", alignItems: "center", gap: 8 }}>
              {s.heading}
              {!isCharacter && (
                <span className={`fy-dot fy-dot--${sheet.status === "locked" ? "ok" : "sketch"}`} style={{ width: 5, height: 5 }} />
              )}
            </div>
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
  );
  if (isCharacter) {
    return (
      <div className="fy-sheet" data-screen={screenId}>
        {side}
        {main}
      </div>
    );
  }
  // Locations and factions (prototype 23b): full-height establishing view, facts to the right.
  return (
    <div className="fy-locdetail" data-screen={screenId}>
      <div className="fy-locdetail__hero">
        <div style={{ width: "100%", height: "100%" }}>
          <Portrait worldSlug={slug} path={sheetPortraitPath(sheet.id)} label={`${sheet.name}: establishing view`} radius={12} />
        </div>
      </div>
      <div className="fy-locdetail__side">{main}</div>
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
  const changed = sections.filter((s, i) => s.body !== sheet?.sections[i]?.body);
  const [mode, setMode] = useState<"form" | "chat">("form");
  const world = useOpenWorldGuard(worldId);
  const worldSlug = world?.meta.slug;

  // The sheet's open studio conversation, if one is staged — sends continue it.
  const sheetDir = sheet ? (sheet.type === "character" ? "characters" : `${sheet.type}s`) : "characters";
  const chatPath = sheet ? `${sheetDir}/${sheet.id}.md` : null;
  const chatProposal =
    chatPath === null
      ? null
      : (world?.proposals.find((p) => p.proposal.targets.some((t) => t.path === chatPath)) ?? null);
  const transcript = useTranscripts()[chatProposal?.proposal.id ?? ""] ?? [];
  const chatActivity = useAuthoring()[chatProposal?.proposal.id ?? ""];
  const chatRunning = chatActivity?.status === "running";
  const sendToStudio = () => {
    if (!sheet || !worldId || !chatPath || instruction.trim().length === 0) return;
    if (chatProposal) {
      continueStudio(worldId, chatPath, chatProposal.proposal.id, instruction.trim());
    } else {
      draftWithStudio(worldId, chatPath, instruction.trim(), `Studio draft: ${sheet.name}`);
    }
    setInstruction("");
  };

  return (
    <div className="fy-gate" data-screen="character-edit">
      <div className="fy-gate__main">
        <div className="fy-gate__head">
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="fy-eyebrow-sm">EDIT SHEET{sheet ? ` · v${sheet.version}` : ""}</span>
              {sheet && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span className={`fy-dot fy-dot--${sheet.status === "locked" ? "ok" : "sketch"}`} style={{ width: 6, height: 6 }} />
                  <span className="fy-mono">
                    {sheet.status === "locked" ? "canon locked, edits are proposed" : "sketch — still yours to shape"}
                  </span>
                </span>
              )}
            </div>
            <h1 className="fy-story__h1">
              {mode === "chat" ? `What has changed about ${sheet ? sheet.name.split(" ")[0] : "them"}?` : "The sheet, field by field."}
            </h1>
          </div>
          <span className="fy-seg" style={{ marginTop: 4 }}>
            <button type="button" className={cx("fy-seg__item", mode === "chat" && "fy-seg__item--active")} onClick={() => setMode("chat")}>
              Chat
            </button>
            <button type="button" className={cx("fy-seg__item", mode === "form" && "fy-seg__item--active")} onClick={() => setMode("form")}>
              Form
            </button>
          </span>
        </div>
        <div className="fy-gate__body" style={{ gap: 14 }}>
          {mode === "form" ? (
            sections.map((s, i) => {
              const isChanged = s.body !== sheet?.sections[i]?.body;
              return (
                <div key={s.heading}>
                  <div className="fy-fieldlabel">
                    {s.heading}
                    {isChanged && <span className="fy-changedtag">· changed</span>}
                  </div>
                  <Textarea value={s.body} onChange={(e) => setEdited((prev) => ({ ...prev, [s.heading]: e.target.value }))} />
                </div>
              );
            })
          ) : (
            <>
              {transcript.length === 0 && (
                <div className="fy-bubble--gate">
                  Tell the studio what has changed. It drafts inside a proposal — its own copy of this sheet — and
                  reads the rest of the world through canon search, never the folder.
                  <div className="fy-bubble__note">you accept or discard the result · nothing lands until then</div>
                </div>
              )}
              {transcript.map((turn, i) => (
                <div key={i} className={turn.role === "user" ? "fy-bubble--user" : "fy-bubble--gate"} style={{ whiteSpace: "pre-wrap" }}>
                  {turn.text}
                </div>
              ))}
              {chatRunning && (
                <div className="fy-bubble--gate" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="fy-dot fy-dot--live" />
                  <span className="fy-mono">
                    {chatActivity?.lines[chatActivity.lines.length - 1] ?? "drafting inside the proposal…"}
                  </span>
                </div>
              )}
              <div style={{ marginTop: "auto" }}>
                <Textarea
                  placeholder={
                    chatProposal
                      ? "Keep shaping her — the draft on this proposal follows the conversation."
                      : "Give her a scar from the night the verse rose early — appearance and relationships should both feel it."
                  }
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && harnessReady && !chatRunning) {
                      e.preventDefault();
                      sendToStudio();
                    }
                  }}
                  style={{ minHeight: 110 }}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                  <DictationButton onText={(text) => setInstruction((prev) => (prev ? `${prev} ${text}` : text))} />
                  {chatProposal && (
                    <span className="fy-mono">
                      conversation on proposal {chatProposal.proposal.id.slice(0, 10)}… · accept or discard it on the
                      sheet page
                    </span>
                  )}
                  <span className="fy-h1row__push" />
                  <Button
                    variant="primary"
                    disabled={!harnessReady || !sheet || !worldId || instruction.trim().length === 0 || chatRunning}
                    title={harnessReady ? undefined : "Authoring needs OpenCode running"}
                    onClick={sendToStudio}
                  >
                    {chatRunning ? "Drafting…" : chatProposal ? "Send" : "Draft with the studio"}
                  </Button>
                </div>
              </div>
            </>
          )}
          <DegradedBanner component="harness" />
        </div>
      </div>
      <div className="fy-gate__side">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ font: "600 15px var(--font-sans)" }}>Proposed sheet</div>
          <span className="fy-mono" style={{ color: dirty ? "var(--warning)" : undefined }}>
            {sheet ? `v${sheet.version + 1} draft · ${changed.length} field${changed.length === 1 ? "" : "s"} changed` : ""}
          </span>
        </div>
        <div className="fy-draftcard">
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <span style={{ width: 38, height: 44, borderRadius: 6, overflow: "hidden", flex: "none" }}>
              <Portrait worldSlug={worldSlug} path={sheet ? sheetPortraitPath(sheet.id) : ""} label="" radius={6} />
            </span>
            <div>
              <div style={{ font: "600 15px var(--font-sans)" }}>{sheet?.name}</div>
              <div className="fy-mono" style={{ marginTop: 2 }}>
                {sheet ? `v${sheet.version} → v${sheet.version + 1}${changed.length > 0 ? ` · ${changed.map((c) => c.heading.toLowerCase()).join(", ")}` : ""}` : ""}
              </div>
            </div>
          </div>
          {changed.slice(0, 3).map((c) => (
            <div key={c.heading} style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ font: "600 12.5px var(--font-sans)" }}>{c.heading}</span>
                <span className="fy-changedtag">changed</span>
              </div>
              <div style={{ font: "400 12px/1.6 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 3 }}>
                {c.body.length > 160 ? `${c.body.slice(0, 157)}…` : c.body}
              </div>
            </div>
          ))}
          {changed.length === 0 && (
            <div className="fy-mono" style={{ marginTop: 12 }}>
              nothing changed yet — edits preview here before they stage
            </div>
          )}
        </div>
        <div className="fy-draftcard">
          <div style={{ font: "600 13px var(--font-sans)" }}>Ripples</div>
          <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
            <span className="fy-ripplerow">
              <span className="fy-dot fy-dot--warn" />
              reference tiles made against v{sheet?.version ?? "…"} will age
            </span>
            <span className="fy-ripplerow">
              <span className="fy-dot fy-dot--sketch" />
              productions pick the change up on their next dispatch
            </span>
          </div>
          <div className="fy-mono" style={{ marginTop: 10 }}>
            computed precisely on the staged proposal · nothing lands until you accept
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 16 }} />
        <div style={{ display: "grid", gap: 8 }}>
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
            {stagedAt ? "Staging…" : `Stage proposal · the sheet becomes v${(sheet?.version ?? 0) + 1}`}
          </Button>
          <Button variant="ghost" onClick={() => setEdited({})} disabled={!dirty}>
            Discard edits · v{sheet?.version ?? "…"} stands
          </Button>
        </div>
      </div>
    </div>
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
  const compilation = [...(kit?.compilations ?? [])].reverse().find((c) => c.accepted) ?? null;
  const slug = world?.meta.slug;
  const tileBlock = (tile: (NonNullable<typeof kit>["tiles"])[number], i: number) => (
    <div key={`${tile.angle}-${i}`} className="fy-tile" style={{ width: "auto" }}>
      <ReferenceTile tile={tile} worldSlug={slug} sheetId={sheetId} />
      {tile.status === "generated" && (
        <div style={{ marginTop: 6 }}>
          <Button
            onClick={() => {
              if (worldId && sheetId) lockTileMsg(worldId, sheetId, tile.angle);
            }}
          >
            Lock
          </Button>
        </div>
      )}
    </div>
  );
  return (
    <div data-screen="reference-kit">
      <div className="fy-kithead">
        <span className="fy-kithead__avatar">
          <Portrait worldSlug={slug} path={sheetId ? sheetPortraitPath(sheetId) : ""} label="" radius={99} />
        </span>
        <div>
          <h1 className="fy-kithead__name">{sheet?.name ?? "Reference kit"}</h1>
          <div className="fy-mono" style={{ marginTop: 2 }}>
            reference kit · design v{sheet?.version ?? "…"} ·{" "}
            {hasAnchor ? "anchor set — every generation carries it" : "no anchor yet — establish a look first"}
          </div>
        </div>
        <span className="fy-h1row__push" />
        <span className="fy-seg">
          <button type="button" className="fy-seg__item" onClick={() => navigate(`/w/${worldId}/cast/${sheetId}`)}>
            Overview
          </button>
          <span className="fy-seg__item fy-seg__item--active">Reference</span>
          <button type="button" className="fy-seg__item" onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/voice`)}>
            Voice
          </button>
        </span>
      </div>
      <div className="fy-kit">
        <div className="fy-kit__main">
          {staleTiles.length > 0 && sheet && (
            <Callout tone="warning" title={`${staleTiles.length} tile${staleTiles.length === 1 ? "" : "s"} predate v${sheet.version}`}>
              Made against an older sheet — regenerate looks to catch up. They still reference; the gap is named, not
              enforced.
            </Callout>
          )}
          {!hasAnchor && (
            <div>
              <div className="fy-listhead" style={{ marginBottom: 10 }}>
                Establish a look
                <span className="fy-mono">candidates from the sentence and the world's tone</span>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (worldId && sheetId) establishLook(worldId, sheetId, 4);
                  }}
                >
                  Generate first looks ×4
                </Button>
                <span className="fy-mono">pick one and it becomes the face everything inherits</span>
              </div>
              {candidates.length > 0 && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                  {candidates.map((file) => (
                    <Button
                      key={file}
                      onClick={() => {
                        if (worldId && sheetId) chooseAnchorMsg(worldId, sheetId, file.replace(`references/${sheetId}/`, ""));
                      }}
                    >
                      Choose {file.split("/").pop()}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div>
            <div className="fy-listhead" style={{ marginBottom: 10 }}>
              Head · turnaround
              <span className={gate.ready ? "fy-mono" : "fy-mono"} style={gate.ready ? { color: "var(--success)" } : undefined}>
                {gate.ready ? "complete — body unlocked" : `${4 - gate.outstanding.length} of 4 locked · outstanding: ${gate.outstanding.join(", ")}`}
              </span>
            </div>
            <div className="fy-tilerow">{(kit?.tiles ?? []).filter((t) => t.angle.startsWith("head")).map(tileBlock)}</div>
            <div style={{ marginTop: 10 }}>
              <Button
                variant="ghost"
                disabled={!hasAnchor}
                onClick={() => {
                  if (worldId && sheetId) generateMissingTiles(worldId, sheetId, "head");
                }}
              >
                Generate missing head angles
              </Button>
            </div>
          </div>
          <div>
            <div className="fy-listhead" style={{ marginBottom: 10 }}>
              Full body · turnaround
              <span className="fy-mono">{gate.ready ? "unlocked" : "waiting on head lock — a body without a locked face is a different person"}</span>
            </div>
            <div className="fy-tilerow">{(kit?.tiles ?? []).filter((t) => t.angle.startsWith("body")).map(tileBlock)}</div>
            <div style={{ marginTop: 10 }}>
              <Button
                variant="ghost"
                disabled={!gate.ready}
                title={gate.ready ? undefined : `outstanding: ${gate.outstanding.join(", ")}`}
                onClick={() => {
                  if (worldId && sheetId) generateMissingTiles(worldId, sheetId, "body");
                }}
              >
                {gate.ready
                  ? "Generate missing body angles"
                  : `Body blocked · ${gate.outstanding.length} head angle${gate.outstanding.length === 1 ? "" : "s"} outstanding`}
              </Button>
            </div>
          </div>
        </div>
        <div className="fy-kit__rail">
          <div className="fy-boardcard fy-boardcard--quiet">
            <div style={{ font: "600 14px var(--font-sans)" }}>How this stays consistent</div>
            <div className="fy-boardcard__body">
              Locked angles ride along as reference with every generation. New angles are judged against them · drift
              gets flagged, not filed.
            </div>
          </div>
          <div className="fy-boardcard">
            <div className="fy-boardcard__head">
              Model sheet
              {staleTiles.length > 0 && <span className="fy-boardcard__state" style={{ color: "var(--warning)" }}>tiles newer than last sheet</span>}
            </div>
            <div style={{ marginTop: 8, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "var(--background)" }}>
              <div style={{ height: 196 }}>
                <Portrait
                  worldSlug={slug}
                  path={compilation && sheetId ? `references/${sheetId}/${compilation.file}` : ""}
                  label={`${sheet?.name ?? "sheet"}: compiled model sheet`}
                  radius={0}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 9px", borderTop: "1px solid var(--border)" }}>
                <span style={{ font: "500 8px var(--font-mono)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{sheet?.name}</span>
                <span style={{ font: "400 8px var(--font-mono)", color: "var(--neutral-400)" }}>
                  SHEET v{sheet?.version} · {world?.meta.name?.toUpperCase()}
                </span>
              </div>
            </div>
            <div className="fy-boardcard__mono">
              the single reference where a model takes only one · generated from the sheet + locked tiles · lands here
              on accept
            </div>
            <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
              <Button variant="primary" onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/model-sheet`)}>
                Generate sheet…
              </Button>
            </div>
          </div>
          <div className="fy-boardcard">
            <div className="fy-boardcard__head">Rendering style</div>
            <div className="fy-boardcard__body">Override travels with this sheet only — canon doesn't change.</div>
            <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
              <Input placeholder="inherits the world's art direction" value={styleValue} onChange={(e) => setStyle(e.target.value)} />
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
          </div>
        </div>
      </div>
    </div>
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
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const sheet = useSheet(worldId, sheetId);
  const [provider, setProvider] = useState("elevenlabs");
  const [voiceId, setVoiceId] = useState("");
  const [label, setLabel] = useState("");
  const [manual, setManual] = useState(false);
  const sheetPath = sheet ? `characters/${sheet.id}.md` : null;
  return (
    <div className="fy-app" data-screen="voice-picker" style={{ minHeight: "calc(100vh - 44px)" }}>
      <div className="fy-scrim">
        {sheet && (
          <div className="fy-scrim__art">
            <Portrait worldSlug={world?.meta.slug} path={sheetPortraitPath(sheet.id)} label="" radius={0} />
          </div>
        )}
        <div className="fy-scrim__wash" />
        <div className="fy-scrim__center">
          <div className="fy-dialog" style={{ maxWidth: 660 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ width: 34, height: 34, borderRadius: 99, overflow: "hidden", flex: "none" }}>
                <Portrait worldSlug={world?.meta.slug} path={sheet ? sheetPortraitPath(sheet.id) : ""} label="" radius={99} />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ font: "650 20px var(--font-sans)", letterSpacing: "-0.02em" }}>
                  {sheet ? `Choose ${sheet.name.split(" ")[0]}'s voice` : "Choose a voice"}
                </div>
                <div style={{ font: "400 12px var(--font-sans)", color: "var(--muted-foreground)", marginTop: 2 }}>
                  Previews read their own lines from the canon, not a stock sentence.
                </div>
              </div>
              {sheet?.voice && (
                <span className="fy-mono">
                  current · {sheet.voice.label ?? sheet.voice.voiceId} ({sheet.voice.provider}) at v{sheet.voice.assignedAtVersion}
                </span>
              )}
            </div>
            <DegradedBanner component="voice" />
            <VoiceCandidatesPanel worldId={worldId} sheetId={sheetId} sheetPath={sheetPath} />
            <div>
              <button
                type="button"
                className="fy-mono"
                style={{ border: "none", background: "transparent", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}
                onClick={() => setManual((m) => !m)}
              >
                {manual ? "Hide direct assignment" : "Assign directly · provider + voice id"}
              </button>
              {manual && (
                <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                  <div className="fy-choicerow">
                    {["elevenlabs", "openai", "voxa"].map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={cx("fy-filterchip", p === provider && "fy-filterchip--active")}
                        style={{ border: p === provider ? "none" : "1px solid var(--border)" }}
                        onClick={() => setProvider(p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Input placeholder="Voice id · v_8Kq2" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} />
                    <Input placeholder="Label · Low tide" value={label} onChange={(e) => setLabel(e.target.value)} />
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
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <span className="fy-mono">a gated sheet change — it versions and ripples · assigning updates every production</span>
              <span style={{ flex: 1 }} />
              {sheet?.voice && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (worldId && sheetPath) assignVoice(worldId, sheetPath, null);
                  }}
                >
                  Clear voice
                </Button>
              )}
              <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/cast/${sheetId}`)}>
                Back to the sheet
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
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
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Button
          variant="primary"
          onClick={() => {
            if (worldId && sheetId) requestVoiceCandidates(worldId, sheetId);
          }}
        >
          Match against the written voice
        </Button>
        {candidates && (
          <span className="fy-mono">
            matched to: {candidates.extracted.join(" · ") || "nothing extractable"} · previews read{" "}
            {candidates.previewLine.source === "own-line"
              ? "their own line"
              : candidates.previewLine.source === "drafted"
                ? "a line drafted from the sheet"
                : "a stock sentence"}
          </span>
        )}
      </div>
      {candidates && (
        <div style={{ display: "grid", gap: 8 }}>
          {candidates.ranked.slice(0, 6).map(({ candidate, matched, overlap }, idx) => {
            const key = `${candidate.provider}/${candidate.voiceId}`;
            const preview = previews[key];
            return (
              <div key={key} className={cx("fy-voicerow", idx === 0 && "fy-voicerow--selected")} style={{ cursor: "default" }}>
                <span className="fy-voicerow__icon" aria-hidden>
                  <Play size={12} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fy-voicerow__name">{candidate.label}</div>
                  <div className="fy-voicerow__sub">
                    {candidate.provider}
                    {candidate.local ? " · local — fixed catalogue, cannot be cloned" : candidate.canClone ? " · cloning available" : ""}
                    {matched.length > 0 ? ` · matched to: ${matched.join(", ")}` : ""}
                  </div>
                </div>
                <span className="fy-mono" style={{ whiteSpace: "nowrap" }}>
                  {Math.round(overlap * 100)}% match
                </span>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (worldId && sheetId) requestVoicePreview(worldId, sheetId, candidate.provider, candidate.voiceId);
                  }}
                >
                  {preview?.file
                    ? "Replay · free"
                    : candidate.local
                      ? "Preview · free"
                      : `Preview${candidates.cloudPreviewMicroUsd !== null ? ` · ${formatMicroUsd(candidates.cloudPreviewMicroUsd)}` : ""}`}
                </Button>
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
                {preview?.error && <span className="fy-mono">{preview.error}</span>}
              </div>
            );
          })}
        </div>
      )}
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
  const [tab, setTab] = useState<"sentence" | "image" | "duplicate">("sentence");
  const [copyName, setCopyName] = useState("");
  const [copySource, setCopySource] = useState<string | null>(null);
  const harnessReady = state?.app.health.harness.status === "healthy";
  const characters = world?.sheets.filter((s) => s.type === "character" && !s.retired) ?? [];
  const listPath = sheetType === "character" ? "cast" : `${sheetType}s`;
  const contextPills = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <span className="fy-mono">drafts with:</span>
      <span className="fy-pill">
        {world?.meta.name} · canon v{world?.meta.canonRevision}
      </span>
      {world?.meta.tone && <span className="fy-pill">Tone · {world.meta.tone}</span>}
      <span className="fy-pill">
        {characters.length} existing character{characters.length === 1 ? "" : "s"}
      </span>
    </div>
  );
  const draftCta = (
    <Button
      variant="primary"
      disabled={!worldId || name.trim().length === 0 || sentence.trim().length === 0}
      onClick={() => {
        if (!worldId) return;
        createSheetFromSentence(worldId, sheetType, name.trim(), sentence.trim());
        navigate(`/w/${worldId}/${listPath}`);
      }}
    >
      {harnessReady ? "Draft the sheet" : "Create as sketch"}
    </Button>
  );

  if (sheetType === "character") {
    // Prototype 5b: the cast-join dialog over the world's key art.
    return (
      <div className="fy-app" data-screen={screenId} style={{ minHeight: "calc(100vh - 44px)" }}>
        <div className="fy-scrim">
          <div className="fy-scrim__art">
            <Portrait worldSlug={world?.meta.slug} path="world-art.png" label="" radius={0} />
          </div>
          <div className="fy-scrim__wash" />
          <div className="fy-scrim__center">
            <div className="fy-dialog" style={{ maxWidth: 620 }}>
              <div>
                <div style={{ font: "650 22px var(--font-sans)", letterSpacing: "-0.02em" }}>Who's joining the cast?</div>
                <div style={{ font: "400 13px/1.55 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 6 }}>
                  Start with a sentence. The sheet gets drafted from it, inside the canon, alongside the{" "}
                  {characters.length} who already live here.
                </div>
              </div>
              <span className="fy-seg" style={{ width: "fit-content" }}>
                {(
                  [
                    ["sentence", "From a sentence"],
                    ["image", "From an image"],
                    ["duplicate", "Duplicate a sheet"],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} type="button" className={cx("fy-seg__item", tab === id && "fy-seg__item--active")} onClick={() => setTab(id)}>
                    {label}
                  </button>
                ))}
              </span>
              {tab === "sentence" && (
                <>
                  <Input placeholder="Their name" value={name} onChange={(e) => setName(e.target.value)} />
                  <Textarea
                    placeholder="A ferryman who refuses payment in coin, only in secrets."
                    value={sentence}
                    onChange={(e) => setSentence(e.target.value)}
                    style={{ minHeight: 96, font: "400 15px/1.6 var(--font-sans)" }}
                  />
                  {contextPills}
                </>
              )}
              {tab === "image" && (
                <div className="fy-notecard" style={{ marginTop: 0 }}>
                  <span className="fy-dot fy-dot--sketch" />
                  Drafting from an image arrives later. Meanwhile: file the image under Artifacts, then draft from a
                  sentence — appearance can cite it.
                </div>
              )}
              {tab === "duplicate" && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    {characters.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="fy-minisheet"
                        style={copySource === s.id ? { border: "1.5px solid var(--foreground)", background: "var(--neutral-50)" } : undefined}
                        onClick={() => setCopySource(s.id)}
                      >
                        <span className="fy-minisheet__thumb">
                          <Portrait worldSlug={world?.meta.slug} path={sheetPortraitPath(s.id)} label="" radius={5} />
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <span className="fy-minisheet__name" style={{ display: "block" }}>
                            {s.name}
                          </span>
                          <span className="fy-minisheet__sub">
                            sheet v{s.version} · {s.status}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                    <Input placeholder="Name the copy · e.g. Bray's brother" value={copyName} onChange={(e) => setCopyName(e.target.value)} />
                    <span className="fy-mono" style={{ flex: "none" }}>
                      copies as a new sketch · links to the source · the source is untouched
                    </span>
                  </div>
                </>
              )}
              <DegradedBanner component="harness" />
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <span style={{ font: "400 11.5px/1.5 var(--font-sans)", color: "var(--muted-foreground)" }}>
                  Lands as a sketch. Nothing is canon until you lock it.
                </span>
                <span style={{ flex: 1 }} />
                <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/${listPath}`)}>
                  Cancel
                </Button>
                {tab === "duplicate" ? (
                  <Button
                    variant="primary"
                    disabled={!worldId || copySource === null || copyName.trim().length === 0}
                    onClick={() => {
                      if (!worldId || !copySource) return;
                      duplicateSheet(worldId, `characters/${copySource}.md`, copyName.trim());
                      navigate(`/w/${worldId}/${listPath}`);
                    }}
                  >
                    Duplicate as sketch
                  </Button>
                ) : (
                  draftCta
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Prototype 10a: the location form beside its live draft preview.
  return (
    <div className="fy-gate" data-screen={screenId}>
      <div className="fy-gate__main">
        <div className="fy-gate__head">
          <div style={{ flex: 1 }}>
            <div className="fy-eyebrow-sm">{title.toUpperCase()}</div>
            <h1 className="fy-story__h1">Just the fields.</h1>
          </div>
        </div>
        <div className="fy-gate__body">
          <div>
            <div className="fy-fieldlabel">Name</div>
            <Input placeholder="The Bell Market" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <div className="fy-fieldlabel">One sentence to draft from</div>
            <Textarea
              placeholder="A church that forgot it was one — stalls in the nave, the great bell still hanging."
              value={sentence}
              onChange={(e) => setSentence(e.target.value)}
            />
            <span className="fy-mono" style={{ display: "block", marginTop: 6 }}>
              {harnessReady
                ? "the studio drafts look, sound and customs from this, against canon and tone"
                : "without OpenCode running, the sentence seeds the sheet as-is — still a sketch through the gate"}
            </span>
          </div>
          {contextPills}
          <DegradedBanner component="harness" />
        </div>
      </div>
      <div className="fy-gate__side">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ font: "600 15px var(--font-sans)" }}>{title} draft</div>
          <span className="fy-mono" style={{ color: "var(--warning)" }}>
            proposed
          </span>
        </div>
        <div className="fy-draftcard" style={{ padding: 14 }}>
          <div style={{ width: "100%", height: 130 }}>
            <Portrait worldSlug={world?.meta.slug} path="" label="Establishing view: drop or generate" />
          </div>
          <div style={{ padding: "12px 4px 2px" }}>
            <div style={{ font: "600 16px var(--font-sans)", letterSpacing: "-0.01em" }}>{name.trim() || "Unnamed"}</div>
            <div style={{ font: "400 12px/1.55 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 8 }}>
              {sentence.trim() || "The sheet drafts from your sentence — look, sound and customs land here."}
            </div>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 16 }} />
        <div style={{ display: "grid", gap: 8 }}>
          {draftCta}
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/${listPath}`)}>
            Discard · nothing saved
          </Button>
          <div style={{ font: "400 11px/1.5 var(--font-sans)", color: "var(--muted-foreground)", textAlign: "center" }}>
            Lands as a sketch. Lock it when the look settles.
          </div>
        </div>
      </div>
    </div>
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
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const typeCounts = new Map<string, number>();
  for (const c of world?.canon ?? []) typeCounts.set(c.type, (typeCounts.get(c.type) ?? 0) + 1);
  const shown = entries.filter((e) => typeFilter === null || e.type === typeFilter);

  return (
    <div data-screen="canon">
      <div className="fy-corner">
        <Button variant="primary" onClick={() => navigate(`/w/${worldId}/canon/new`)}>
          New entry
        </Button>
      </div>
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">
          {world?.meta.name} · {world?.canon.length ?? 0} entries · v{world?.meta.canonRevision}
        </div>
        <h1 className="fy-hero__title" style={{ fontSize: 52 }}>
          Canon
        </h1>
        <div className="fy-askbar">
          <Search size={15} />
          <input
            placeholder="Ask the world anything: “who rings the bells?”"
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
        <div className="fy-mono" style={{ marginTop: 8 }}>
          answers come only from entries, with verified quotes · when canon has not decided, it says so
        </div>
        <div className="fy-filterrow">
          <button type="button" className={cx("fy-filterchip", typeFilter === null && "fy-filterchip--active")} onClick={() => setTypeFilter(null)}>
            All {world?.canon.length ?? 0}
          </button>
          {[...typeCounts.entries()].map(([t, n]) => (
            <button key={t} type="button" className={cx("fy-filterchip", typeFilter === t && "fy-filterchip--active")} onClick={() => setTypeFilter(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)} {n}
            </button>
          ))}
        </div>
      </div>
      {(result || (askId && !result) || serverSearch) && (
        <div style={{ maxWidth: 720, margin: "20px auto 0", padding: "0 24px", display: "grid", gap: 10 }}>
          {askId && !result && <Callout title="Asking canon…">Retrieval first, then a grounded read of the candidates.</Callout>}
          {result && worldId && <AskOutcome worldId={worldId} question={askedQuestion} result={result} />}
          {serverSearch && (
            <span className="fy-mono">
              {serverSearch.candidates.length} match{serverSearch.candidates.length === 1 ? "" : "es"} across{" "}
              {serverSearch.searched} searchable entries · open threads and retired entries are not searched
            </span>
          )}
        </div>
      )}
      <div className="fy-cardgrid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        {shown.map((entry) =>
          entry.status === "open" ? (
            <div key={entry.id} className="fy-gridcard fy-gridcard--quiet">
              <div className="fy-gridcard__id" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span className="fy-dot fy-dot--warn" style={{ width: 7, height: 7 }} />
                {entry.id} · open thread
              </div>
              <div className="fy-gridcard__title">{entry.title}</div>
              <div className="fy-gridcard__body">{entry.body.length > 150 ? `${entry.body.slice(0, 147)}…` : entry.body}</div>
              <div style={{ marginTop: 12 }}>
                <Button onClick={() => navigate(`/w/${worldId}/canon/${entry.id}/thread`)}>Draft in context</Button>
              </div>
            </div>
          ) : (
            <button key={entry.id} type="button" className="fy-gridcard" onClick={() => navigate(`/w/${worldId}/canon/${entry.id}`)}>
              <div className="fy-gridcard__id">
                {entry.id} · {entry.type}
                {entry.retired ? " · retired" : ""}
              </div>
              <div className="fy-gridcard__title">{entry.title}</div>
              <div className="fy-gridcard__body">{entry.body.length > 150 ? `${entry.body.slice(0, 147)}…` : entry.body}</div>
              <div className="fy-gridcard__foot">
                written v{entry.introducedAt}
                {entry.settledAt !== undefined ? ` · settled v${entry.settledAt}` : ""}
                {entry.amendedAt !== undefined ? ` · amended v${entry.amendedAt}` : ""}
              </div>
            </button>
          ),
        )}
        {shown.length === 0 && <EmptyState title="No matches" hint="The closest entries appear in the ask refusal above." />}
      </div>
    </div>
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
    <div className="fy-entry" data-screen="canon-entry">
      <div className="fy-entry__main">
        <div style={{ animation: "fy-fade-up 0.6s var(--ease-out) both" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="fy-mono">
              {entry.id} · {entry.type}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span className={`fy-dot fy-dot--${entry.status === "open" ? "warn" : "ok"}`} style={{ width: 6, height: 6 }} />
              <span className="fy-mono">{entry.status === "open" ? "open thread" : "settled"}</span>
            </span>
            {entry.retired && <Badge tone="danger">retired</Badge>}
          </div>
          <h1 className="fy-entry__title">{entry.title}</h1>
          <div className="fy-entry__body">{entry.body}</div>
          <div className="fy-mono" style={{ marginTop: 14 }}>
            written v{entry.introducedAt}
            {entry.settledAt !== undefined && ` · settled v${entry.settledAt}`}
            {entry.amendedAt !== undefined && ` · last amended v${entry.amendedAt}`}
          </div>
          {detail && (detail.citedBy.sheets.length > 0 || detail.citedBy.entries.length > 0) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 16 }}>
              {detail.citedBy.sheets.map((s) => (
                <span key={s.id} className="fy-pill">
                  <span className="fy-pill__avatar">
                    <Portrait worldSlug={world?.meta.slug} path={sheetPortraitPath(s.id)} label="" radius={99} />
                  </span>
                  {s.id}
                  {s.atVersion !== null ? ` · v${s.atVersion}` : ""}
                </span>
              ))}
              {detail.citedBy.entries.map((id) => (
                <span key={id} className="fy-pill" style={{ cursor: "pointer" }} onClick={() => navigate(`/w/${worldId}/canon/${id}`)}>
                  {id}
                </span>
              ))}
            </div>
          )}
        </div>
        {detail && (detail.citedBy.sheets.length > 0 || detail.citedBy.entries.length > 0) && (
          <div style={{ marginTop: 30, animation: "fy-fade-up 0.7s var(--ease-out) 0.15s both" }}>
            <div style={{ font: "600 13px var(--font-sans)", marginBottom: 4 }}>Cited by</div>
            {detail.citedBy.sheets.map((s) => (
              <div key={s.id} className="fy-citerow">
                <span style={{ flex: 1 }}>
                  {s.id}
                  {s.atVersion !== null ? `, sheet v${s.atVersion}` : ""}
                </span>
                <span className="fy-mono">from the index, at the version cited</span>
                <ChevronRight size={13} />
              </div>
            ))}
            {detail.citedBy.entries.map((id) => (
              <div key={id} className="fy-citerow" style={{ cursor: "pointer" }} onClick={() => navigate(`/w/${worldId}/canon/${id}`)}>
                <span style={{ flex: 1 }}>{id}</span>
                <span className="fy-mono">canon cross-reference</span>
                <ChevronRight size={13} />
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="fy-entry__side">
        <div style={{ font: "600 13px var(--font-sans)" }}>History</div>
        <div style={{ marginTop: 4 }}>
          {history.length === 0 && <div className="fy-mono" style={{ padding: "9px 0" }}>no recorded changes yet</div>}
          {[...history].reverse().map((c, i) => (
            <div key={i} className="fy-historyrow">
              <span className="fy-historyrow__v" style={i === 0 ? { color: "var(--foreground)" } : undefined}>
                v{String(c.canonRevisionAfter ?? c.toVersion ?? "?")}
              </span>
              <div className="fy-historyrow__text">
                <div style={i === 0 ? { color: "var(--foreground)" } : undefined}>
                  {c.fieldsChanged ? c.fieldsChanged.join(", ") : "changed"}
                </div>
                <div className="fy-historyrow__when">
                  {shortDateTime(c.ts)} · {c.source}
                </div>
              </div>
            </div>
          ))}
        </div>
        {detail && detail.ripples.length > 0 && (
          <div className="fy-draftcard">
            <div style={{ font: "600 13px var(--font-sans)" }}>Changing this ripples</div>
            <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
              {detail.ripples.map((r, i) => (
                <span key={i} className="fy-ripplerow">
                  <span className="fy-dot fy-dot--warn" />
                  {r.kind} · {r.summary}
                </span>
              ))}
            </div>
            <div className="fy-mono" style={{ marginTop: 10 }}>
              a change is proposed, ripple-checked, then versioned · same gate as everything else
            </div>
          </div>
        )}
        {amending && worldId && (
          <div className="fy-draftcard">
            <div className="fy-fieldlabel">Amended statement</div>
            <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
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
          </div>
        )}
        <div style={{ flex: 1, minHeight: 16 }} />
        <div style={{ display: "grid", gap: 8 }}>
          {entry.status === "open" ? (
            <Button variant="primary" onClick={() => navigate(`/w/${worldId}/canon/${entry.id}/thread`)}>
              Open thread
            </Button>
          ) : (
            <>
              <Button
                variant="primary"
                onClick={() => {
                  setStatement(entry.body);
                  setAmending(true);
                }}
              >
                Propose a change
              </Button>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const SETTLE_TYPES = ["rule", "lore", "location", "faction", "timeline", "tone"] as const;

export function CanonThreadScreen() {
  const { entry, worldId } = useCanonEntry();
  const world = useWorld();
  const navigate = useNavigate();
  const { state } = useStore();
  const [resolvedType, setResolvedType] = useState<(typeof SETTLE_TYPES)[number]>("lore");
  const [statement, setStatement] = useState("");
  const [message, setMessage] = useState("");
  const harnessReady = state?.app.health.harness.status === "healthy";
  // What has been attached here this session. Dismissing a chip stops the conversation
  // referring to it; the artifact stays filed in the world, because filing is the point.
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const attached = useStore()
    .attached.filter((a) => a.worldId === worldId && !dismissed.includes(a.artifactId))
    .map(({ artifactId, file, kind }) => ({ artifactId, file, kind }));
  // Refusals are news, not a list: only what the world turned away since this screen opened
  // shows on a chip here. The Artifacts screen keeps the fuller account.
  const notices = useArtifactNotices();
  const noticesAtOpen = useRef(notices.length);
  const refusals = notices.slice(noticesAtOpen.current).map((n) => ({
    name: n.sourcePath.split(/[\\/]/).pop() || "that file",
    reason: n.reason,
  }));

  // The offer to read a document, for the most recent one attached here. Only documents: an
  // image or a recording has nothing to quote from, so they file with no offer at all. One at a
  // time — a strip per attachment would be a queue of decisions nobody asked for.
  const reading = useReading();
  const [offerDone, setOfferDone] = useState<readonly string[]>([]);
  const offerable = [...attached]
    .reverse()
    .find((a) => a.kind === "document" && !offerDone.includes(a.artifactId));
  const offer = offerable
    ? {
        artifactId: offerable.artifactId,
        file: offerable.file,
        state: reading[offerable.artifactId]?.state,
        found: reading[offerable.artifactId]?.found ?? 0,
        dropped: reading[offerable.artifactId]?.dropped ?? 0,
        reason: reading[offerable.artifactId]?.reason,
      }
    : null;

  // Draft-in-context (18a): the thread's conversation runs on a proposal over the entry file.
  const chatPath = entry ? `canon/${entry.id}.md` : null;
  const chatProposal =
    chatPath === null ? null : (world?.proposals.find((p) => p.proposal.targets.some((t) => t.path === chatPath)) ?? null);
  const transcript = useTranscripts()[chatProposal?.proposal.id ?? ""] ?? [];
  const chatActivity = useAuthoring()[chatProposal?.proposal.id ?? ""];
  const chatRunning = chatActivity?.status === "running";
  const sendToStudio = () => {
    if (!entry || !worldId || !chatPath || message.trim().length === 0) return;
    if (chatProposal) {
      continueStudio(worldId, chatPath, chatProposal.proposal.id, message.trim());
    } else {
      draftWithStudio(worldId, chatPath, message.trim(), `Draft in context: ${entry.title}`);
    }
    setMessage("");
  };

  return (
    <div className="fy-gate" data-screen="canon-thread">
      <div className="fy-gate__main">
        <div className="fy-gate__head">
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="fy-dot fy-dot--warn" style={{ width: 7, height: 7 }} />
              <span className="fy-eyebrow-sm">OPEN THREAD{entry ? ` · ${entry.id} · since v${entry.introducedAt}` : ""}</span>
            </div>
            <h1 className="fy-story__h1">{entry ? entry.title : "Thread"}</h1>
          </div>
        </div>
        <div className="fy-gate__body" style={{ gap: 14 }}>
          {entry && <div className="fy-bubble--gate">{entry.body}</div>}
          {transcript.length === 0 && (
            <div className="fy-bubble--gate">
              Talk it through — the studio drafts the answer on a proposal over this entry, checked against the canon.
              Or settle it directly below.
              <div className="fy-bubble__note">settling is an ordinary accept — the staged proposal shows its ripples first</div>
            </div>
          )}
          {transcript.map((turn, i) => (
            <div key={i} className={turn.role === "user" ? "fy-bubble--user" : "fy-bubble--gate"} style={{ whiteSpace: "pre-wrap" }}>
              {turn.text}
            </div>
          ))}
          {chatRunning && (
            <div className="fy-bubble--gate" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="fy-dot fy-dot--live" />
              <span className="fy-mono">
                {chatActivity?.lines[chatActivity.lines.length - 1] ?? "drafting against the canon…"}
              </span>
            </div>
          )}
          <div style={{ marginTop: 2 }}>
            <Composer
              value={message}
              onChange={setMessage}
              onSubmit={sendToStudio}
              placeholder="Keep shaping the entry…"
              agentLabel="canon author"
              busy={chatRunning}
              busyLabel="drafting against the canon…"
              {...(worldId === undefined ? {} : { onAttach: () => attachFiles(worldId) })}
              {...(worldId !== undefined && hostCanAttach()
                ? {
                    onAttachFiles: (files: readonly File[]) =>
                      attachHostFiles({ kind: "file-artifact", worldId }, files),
                    onAttachText: (text: string) =>
                      attachHostText({ kind: "file-artifact", worldId }, text, "pasted-note.txt"),
                  }
                : {})}
              attachments={attached}
              refusals={refusals}
              onRemoveAttachment={(id) => setDismissed((prev) => [...prev, id])}
              {...(harnessReady
                ? {}
                : { disabledReason: "Chat needs OpenCode running — the form below still settles it." })}
            />
            {offer && worldId !== undefined && (
              <ExtractionOffer
                file={offer.file}
                {...(offer.state !== undefined ? { state: offer.state } : {})}
                found={offer.found}
                dropped={offer.dropped}
                {...(offer.reason !== undefined ? { reason: offer.reason } : {})}
                onRead={() => extractArtifact(worldId, offer.artifactId)}
                onStop={() => stopExtraction(worldId, offer.artifactId)}
                onReview={() => navigate(`/w/${worldId}/artifacts`)}
                onDismiss={() => setOfferDone((prev) => [...prev, offer.artifactId])}
              />
            )}
          </div>
          <div style={{ marginTop: "auto" }}>
            <div className="fy-fieldlabel">What it turned out to be</div>
            <div className="fy-choicerow">
              {SETTLE_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={cx("fy-filterchip", t === resolvedType && "fy-filterchip--active")}
                  style={{ border: t === resolvedType ? "none" : "1px solid var(--border)" }}
                  onClick={() => setResolvedType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="fy-fieldlabel" style={{ marginTop: 15 }}>
              The settled statement
            </div>
            <Textarea
              placeholder="The Chorister was taught by the god itself, in the winter it walked in…"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
            />
          </div>
        </div>
      </div>
      <div className="fy-gate__side">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ font: "600 15px var(--font-sans)" }}>Proposed entry</div>
          <span className="fy-mono" style={{ color: "var(--warning)" }}>
            settles the thread
          </span>
        </div>
        <div className="fy-draftcard">
          <div className="fy-gridcard__id">
            {entry?.id ?? "CANON-…"} · {resolvedType}
          </div>
          <div style={{ font: "600 16px var(--font-sans)", letterSpacing: "-0.01em", marginTop: 7 }}>{entry?.title}</div>
          <div style={{ font: "400 12.5px/1.65 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 8, whiteSpace: "pre-wrap" }}>
            {statement.trim() || "The settled statement appears here as you write it."}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 16 }} />
        <div style={{ display: "grid", gap: 8 }}>
          <Button
            variant="primary"
            disabled={!entry || !worldId || statement.trim().length === 0}
            onClick={() => {
              if (!entry || !worldId) return;
              settleThread(worldId, entry.id, resolvedType, statement.trim());
              navigate(`/w/${worldId}/canon/${entry.id}`);
            }}
          >
            Stage settlement · close the thread
          </Button>
          <div style={{ font: "400 11px/1.5 var(--font-sans)", color: "var(--muted-foreground)", textAlign: "center" }}>
            Nothing changes until you accept the staged proposal. Then the canon revision moves once.
          </div>
        </div>
      </div>
    </div>
  );
}

export function NewCanonScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const location = useLocation();
  const seed = (location.state as { seed?: string } | null)?.seed;
  const [entryType, setEntryType] = useState<(typeof SETTLE_TYPES)[number]>("rule");
  const [title, setTitle] = useState("");
  const [statement, setStatement] = useState(seed ?? "");
  const nextId = world ? `CANON-${String(world.meta.nextCanonId).padStart(3, "0")}` : "CANON-…";
  return (
    <div className="fy-gate" data-screen="new-canon">
      <div className="fy-gate__main">
        <div className="fy-gate__head">
          <div style={{ flex: 1 }}>
            <div className="fy-eyebrow-sm">NEW CANON ENTRY · WILL BE {nextId}</div>
            <h1 className="fy-story__h1">The entry, field by field.</h1>
          </div>
        </div>
        <div className="fy-gate__body">
          <div>
            <div className="fy-fieldlabel">Type</div>
            <div className="fy-choicerow">
              {SETTLE_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={cx("fy-filterchip", t === entryType && "fy-filterchip--active")}
                  style={{ border: t === entryType ? "none" : "1px solid var(--border)" }}
                  onClick={() => setEntryType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="fy-fieldlabel">Title</div>
            <Input placeholder="Tide-calling" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <div className="fy-fieldlabel">Statement</div>
            <Textarea
              placeholder="A caller cannot move a tide she has not stood in…"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
            />
          </div>
          <div className="fy-mono">
            ids are permanent — the entry reserves {nextId} at staging and keeps it forever · retired ids are never
            reused, so citations never drift
          </div>
        </div>
      </div>
      <div className="fy-gate__side">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ font: "600 15px var(--font-sans)" }}>Proposed entry</div>
          <span className="fy-mono" style={{ color: "var(--warning)" }}>
            draft · enters as proposed
          </span>
        </div>
        <div className="fy-draftcard">
          <div className="fy-gridcard__id">
            {nextId} · {entryType}
          </div>
          <div style={{ font: "600 16px var(--font-sans)", letterSpacing: "-0.01em", marginTop: 7 }}>
            {title.trim() || "Untitled"}
          </div>
          <div style={{ font: "400 12.5px/1.65 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 8, whiteSpace: "pre-wrap" }}>
            {statement.trim() || "The statement appears here as you write it."}
          </div>
        </div>
        <div className="fy-draftcard">
          <div style={{ font: "600 13px var(--font-sans)" }}>Ripples</div>
          <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
            <span className="fy-ripplerow">
              <span className="fy-dot fy-dot--sketch" />
              contradiction candidates appear on the proposal as an aid · nothing blocks
            </span>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 16 }} />
        <div style={{ display: "grid", gap: 8 }}>
          <Button
            variant="primary"
            disabled={!worldId || title.trim().length === 0 || statement.trim().length === 0}
            onClick={() => {
              if (!worldId) return;
              stageEntryMsg(worldId, entryType, title.trim(), statement.trim());
              navigate(`/w/${worldId}/canon`);
            }}
          >
            Add as proposed · {nextId}
          </Button>
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/canon`)}>
            Discard · nothing saved
          </Button>
        </div>
      </div>
    </div>
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
    <div data-screen="artifacts">
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">
          {world?.meta.name} · {visible.length} file{visible.length === 1 ? "" : "s"}
          {superseded.size > 0 ? ` · ${superseded.size} superseded — history keeps them` : ""}
        </div>
        <h1 className="fy-hero__title" style={{ fontSize: 52 }}>
          Artifacts
        </h1>
        <p className="fy-hero__lede" style={{ fontSize: 15, maxWidth: 500 }}>
          Recordings, documents and references: filed against the world, attachable to any generation.
        </p>
        <div className="fy-filterrow">
          <button type="button" className={cx("fy-filterchip", kindFilter === null && "fy-filterchip--active")} onClick={() => setKindFilter(null)}>
            All {artifacts.filter((a) => !superseded.has(a.id)).length}
          </button>
          {kinds.map((k) => (
            <button key={k} type="button" className={cx("fy-filterchip", kindFilter === k && "fy-filterchip--active")} onClick={() => setKindFilter(k)}>
              {k.charAt(0).toUpperCase() + k.slice(1)} {artifacts.filter((a) => a.kind === k && !superseded.has(a.id)).length}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 16 }}>
          <Input
            // A JSX attribute string is literal — no escapes — so backslashes doubled for a JS
            // string rendered on screen as they were written. The braces make it a JS string.
            placeholder={"C:\\path\\to\\your\\notes"}
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
      </div>
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "12px 24px 0", display: "grid", gap: 10 }}>
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
      </div>
      <div className="fy-cardgrid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", paddingTop: 24 }}>
        {visible.map((a) => {
          const name = a.file.split("/").pop() ?? a.file;
          const isImage = a.kind === "image" || /\.(png|jpe?g|webp|gif)$/i.test(a.file);
          const meta = [
            name.includes(".") ? name.split(".").pop() : a.kind,
            a.origin.by === "user" ? "filed by you" : `produced by ${a.origin.producedBy}`,
            ...(a.links.length > 0 ? [`linked: ${a.links.slice(0, 2).join(", ")}`] : []),
          ].join(" · ");
          return (
            <div key={a.id} className="fy-gridcard" style={isImage ? { padding: "10px 10px 14px" } : { padding: 16 }}>
              {isImage ? (
                <div style={{ width: "100%", height: 110 }}>
                  <Portrait worldSlug={world?.meta.slug} path={`artifacts/${a.file}`} label={name} />
                </div>
              ) : a.kind === "audio" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="fy-audiorow__play" aria-hidden>
                    <Play size={11} />
                  </span>
                  <span style={{ color: "var(--neutral-400)", overflow: "hidden" }}>
                    <Wave seed={a.file} width={120} height={18} />
                  </span>
                </div>
              ) : (
                <div className="fy-doclines">
                  <span style={{ width: "80%" }} />
                  <span style={{ width: "95%" }} />
                  <span style={{ width: "60%" }} />
                </div>
              )}
              <div style={isImage ? { padding: "0 6px" } : undefined}>
                <div style={{ font: "600 14px var(--font-sans)", margin: "12px 0 3px" }}>{name}</div>
                <div className="fy-mono">{meta}</div>
                {a.supersedes !== undefined && <div className="fy-mono">supersedes {a.supersedes.slice(0, 10)}…</div>}
                {a.kind === "document" && (
                  <div style={{ marginTop: 10 }}>
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
              </div>
            </div>
          );
        })}
        <div
          className="fy-gridcard fy-gridcard--quiet"
          style={{ gridColumn: "span 2", border: "1.5px dashed var(--neutral-300)", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", gap: 14, minHeight: 120, boxShadow: "none" }}
        >
          <span className="fy-newprodcard__ring" style={{ width: 40, height: 40 }}>
            <Plus size={18} />
          </span>
          <div style={{ maxWidth: 320 }}>
            <div style={{ font: "600 14px var(--font-sans)" }}>Drop anything</div>
            <div style={{ font: "400 12px/1.5 var(--font-sans)", color: "var(--muted-foreground)" }}>
              Audio, documents, boards, stems: filed here via Import folder above, linkable to characters, canon and
              shots.
            </div>
          </div>
        </div>
        {artifacts.length === 0 && (
          <EmptyState title="Nothing filed yet" hint="Drop recordings, documents, boards or images to file them against the world." />
        )}
      </div>
    </div>
  );
}

// ---- Productions -----------------------------------------------------------

const PRODUCTION_TILT = [
  { rotate: -1.6, top: 0, drift: "7.6s" },
  { rotate: 1.2, top: -8, drift: "8.3s" },
  { rotate: -1, top: 0, drift: "7.9s" },
] as const;

export function ProductionsScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const productions = world?.productions ?? [];
  const artOf = (p: (typeof productions)[number]): string => {
    const board = p.scenes.find((s) => s.board)?.board;
    if (board) return `productions/${p.meta.id}/${board.image}`;
    const take = p.takes.find((t) => t.media);
    if (take) return `productions/${p.meta.id}/takes/${take.id}/${take.media}`;
    return "world-art.png";
  };
  return (
    <div data-screen="productions">
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">
          {world?.meta.name} · shared cast, shared canon
        </div>
        <h1 className="fy-hero__title" style={{ fontSize: 52 }}>
          Productions
        </h1>
        <p className="fy-hero__lede" style={{ fontSize: 16, maxWidth: 480 }}>
          {productions.length === 1 ? "One lens" : `${productions.length || "New"} lenses`} over one world. Change a
          character once and it lands in all of them.
        </p>
      </div>
      <div className="fy-prodcards">
        {productions.map((p, i) => {
          const tilt = PRODUCTION_TILT[i % PRODUCTION_TILT.length]!;
          const shots = p.scenes.flatMap((s) => s.shots);
          const covered = shots.filter((s) => p.selections[s.id]?.acceptedTakeId).length;
          const active = p.meta.status !== "complete" && shots.length > 0 && covered < shots.length;
          return (
            <div key={p.meta.id} style={{ animation: `fy-drift ${tilt.drift} ease-in-out infinite alternate`, marginTop: tilt.top }}>
              <div
                className={cx("fy-prodcard", active && "fy-prodcard--active")}
                style={{ transform: `rotate(${tilt.rotate}deg)` }}
                onClick={() => navigate(`/w/${worldId}/p/${p.meta.id}`)}
              >
                <div className="fy-prodcard__frame">
                  <Portrait worldSlug={world?.meta.slug} path={artOf(p)} label={`${p.meta.title}: frame`} radius={0} />
                </div>
                <div className="fy-prodcard__body">
                  <div className="fy-prodcard__meta">
                    <Badge tone="outline">{p.meta.format}</Badge>
                    {active && <span className="fy-dot fy-dot--warn" />}
                    <span style={{ marginLeft: "auto" }} className="fy-mono">
                      {shots.length > 0 ? `${covered} of ${shots.length} shots` : `${p.takes.length} takes`}
                    </span>
                  </div>
                  <div className="fy-prodcard__name">{p.meta.title}</div>
                  <div className="fy-prodcard__sub">{p.meta.logline ?? p.meta.status}</div>
                  <div className="fy-progress">
                    <div className="fy-progress__fill" style={{ width: `${shots.length > 0 ? Math.round((covered / shots.length) * 100) : 0}%` }} />
                  </div>
                  <div style={{ marginTop: 14 }}>
                    <Button variant={active ? "primary" : "secondary"}>Open the workspace</Button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <button type="button" className="fy-newprodcard" onClick={() => navigate(`/w/${worldId}/productions/new`)}>
          <span className="fy-newprodcard__ring">
            <Plus size={18} />
          </span>
          <span style={{ font: "600 14px var(--font-sans)" }}>New production</span>
          <span style={{ font: "400 12px/1.5 var(--font-sans)", color: "var(--muted-foreground)", textAlign: "center", maxWidth: 140 }}>
            Same cast. Any format: film, stills, book.
          </span>
        </button>
      </div>
    </div>
  );
}

const FORMAT_CHOICES = [
  {
    id: "story",
    label: "Story",
    body: "Prose and scripts, drafted inside the canon with the world as editor.",
    kinds: "novel · script · serial",
  },
  {
    id: "video",
    label: "Video",
    body: "Boards and shots, dispatched to video models with references attached.",
    kinds: "short film · music video · series",
  },
  {
    id: "stills",
    label: "Stills",
    body: "Frames judged as a set — a visual album, key art, a lookbook.",
    kinds: "visual album · key art",
  },
] as const;

export function NewProductionScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const [format, setFormat] = useState<"story" | "video" | "stills">("video");
  const [title, setTitle] = useState("");
  const characters = world?.sheets.filter((s) => s.type === "character").length ?? 0;
  return (
    <div className="fy-dialogwrap" data-screen="new-production">
      <div className="fy-dialog" style={{ maxWidth: 780 }}>
        <div>
          <div style={{ font: "650 22px var(--font-sans)", letterSpacing: "-0.02em" }}>New production</div>
          <div style={{ font: "400 13px/1.55 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 6 }}>
            Pick a format. Whichever you choose, it draws from the same world: cast, canon and tone come along
            automatically.
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14 }}>
          {FORMAT_CHOICES.map((f) => (
            <button
              key={f.id}
              type="button"
              className={cx("fy-radio", format === f.id && "fy-radio--on")}
              onClick={() => setFormat(f.id)}
            >
              <div className="fy-radio__head">
                <span className="fy-radio__dot" />
                {f.label}
              </div>
              <div style={{ font: "400 12px/1.55 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 7 }}>{f.body}</div>
              <div className="fy-mono" style={{ marginTop: 14 }}>
                {f.kinds}
              </div>
            </button>
          ))}
        </div>
        <Input placeholder="Name it · working titles are fine" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span className="fy-mono">
            joins {world?.meta.name ?? "the world"} · shares all {characters} characters, every location and the whole
            canon
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/productions`)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={title.trim().length === 0}
            onClick={() => {
              if (worldId) {
                createProduction(worldId, title.trim(), format);
                navigate(`/w/${worldId}/productions`);
              }
            }}
          >
            Create production
          </Button>
        </div>
      </div>
    </div>
  );
}
