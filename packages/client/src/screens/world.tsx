import { useMediaQuery } from "../lib/media-query.js";
import { CharacterHeader } from "./character-reference.js";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import {
  deriveCut, designatedCompilation, mainPhotoFor, referenceKitCounts, pendingSheets,
  pendingWorldSheets, unattendedProposalsOf, productionShape, worldSheets, type ReferenceKit,
  type WorldBundle, orderedShots,
} from "@arke-studio/contracts";
import { EmptyState, Screen } from "../components/layout.js";
import { Button, Callout, cx } from "../components/ui.js";
import { ArrowRight, Plus } from "../components/icons.js";
import { AppChrome } from "../components/chrome.js";
import { Loading } from "../components/loading.js";
import { useWorldOpenRefusal, WorldOpenRefusal } from "../components/world-open-refusal.js";
import { WorldOpening } from "../components/world-opening.js";
import { characterPortraitPath, Portrait } from "../components/portrait.js";
import { productionPlate } from "../lib/production-plate.js";
import { foundingNote } from "../components/queue-note.js";
import { followLink } from "../lib/activity-panel.js";
import { useOpenWorldGuard } from "../lib/selectors.js";
import {
  reconcileExternalEdit, useAuthoring, useClientState, dismissBuildNotice, useWorld, renameWorld,
} from "../lib/store.js";
import { pendingSheetDestination, pendingSheetState, pendingSheetRoute } from "./world-sheets.js";
import { coveredProductionShots } from "./world-productions.js";

/** World screens (§2.9): the world is the home, productions are lenses over it. */

const FEATURE_COPY_LIMIT = 180;

export function limitedFeatureCopy(copy: string): string {
  const characters = Array.from(copy);
  return characters.length > FEATURE_COPY_LIMIT
    ? `${characters
        .slice(0, FEATURE_COPY_LIMIT - 1)
        .join("")
        .trimEnd()}…`
    : copy;
}

export function WorldLayout() {
  const compact = useMediaQuery("(max-width: 1099px)");
  const { worldId } = useParams();
  const location = useLocation();
  /*
   * Every route test on this layout reads this rather than `location.pathname` (codex,
   * 2026-09-09). A bookmarked or typed address may end in a slash — `/w/<id>/chat/` — and the
   * router renders the route either way, so a check anchored on the end of the path quietly
   * says no. That answer decides whether a screen is a fixed frame, and getting it wrong puts
   * the composer, Save or the key art back below the fold (issue 1007).
   */
  const path = location.pathname.replace(/\/+$/, "");
  const world = useOpenWorldGuard(worldId);
  const refusal = useWorldOpenRefusal(worldId);
  // One Cast tab for the world's three kinds of sheet (design 54c). The ledgers keep their
  // addresses — /cast, /locations, /factions — and a chip row on each moves between them, so
  // the tab lights on all three.
  const nav = [
    ["", "Overview"],
    ["art-direction", "Art direction"],
    ["cast", "Cast"],
    // Before Canon, because that is the order the two are written in: what the author thinks the
    // world is, and then what the world has actually settled.
    ["bible", "Bible"],
    ["canon", "Canon"],
    ["chat", "World Chat"],
    ["artifacts", "Artifacts"],
    ["productions", "Productions"],
    // What Arke Player may show of the world (design turn 234): a world page, reused by every export.
    ["guide", "Guide"],
  ] as const;
  const onSheets = /\/(cast|locations|factions|props)(\/|$)/.test(path);
  const characterGeneration = path.endsWith("/main-photo") || path.endsWith("/model-sheet");
  if (
    path.endsWith("/art-direction/propose") ||
    path.endsWith("/main-photo") ||
    path.endsWith("/model-sheet") ||
    // The bench is a fixed workspace with its own breadcrumb chrome (design 68b) — the pill
    // nav and hero scroll of the world pages would sit on top of its three columns.
    path.includes("/artifacts/bench")
  ) {
    return (
      <div className={cx("fy-app", characterGeneration && "fy-worldapp fy-character-generation")}>
        {characterGeneration && world && <div className="fy-character-generation__backdrop">
          <AppChrome back={{ label: "Worlds", to: "/worlds" }} context={{ label: world.meta.name }} />
          <WorldNavigation path={path}>
            {nav.map(([slug, label]) => <Link key={slug} to={`/w/${worldId}${slug ? `/${slug}` : ""}`}
              aria-current={slug === "cast" ? "page" : undefined}
              className={cx("fy-pillnav__item", slug === "cast" && "fy-pillnav__item--active")}>{label}</Link>)}
          </WorldNavigation>
          <CharacterHeader active="reference" />
        </div>}
        <div className="fy-content fy-content--fixed">
          {refusal ? (
            <WorldOpenRefusal worldId={worldId!} reason={refusal.reason} stranded />
          ) : world ? (
            <Outlet />
          ) : (
            <>
              <AppChrome back={{ label: "Worlds", to: "/worlds" }} />
              <WorldOpening worldId={worldId} />
            </>
          )}
        </div>
      </div>
    );
  }
  const onArtDirection = path.endsWith("/art-direction");
  const onCast = path.endsWith("/cast") || (compact && /\/(cast|locations|factions|props)(\/|$)/.test(path));
  /*
   * The world screens that are a fixed frame rather than a page that scrolls: art direction's
   * two picture bands, and the gate screens, whose two columns each scroll inside themselves.
   * They were sized against the viewport minus a constant, which was 28px optimistic even with
   * nothing above them and had no answer at all for a banner that was (issue 1007) — so the
   * edit sheet's Save and World Chat's composer sat below the fold. The column measures the
   * room it actually has and gives the screen the remainder.
   */
  const fixedFrame =
    onArtDirection ||
    /\/(chat|edit)(\/[^/]+)?$/.test(path) ||
    /\/canon\/(new|[^/]+\/thread)$/.test(path);
  return (
    <div className="fy-app fy-worldapp">
      <AppChrome
        back={{ label: "Worlds", to: "/worlds" }}
        context={
          world
            ? { label: onArtDirection ? `${world.meta.name} · art direction` : world.meta.name }
            : undefined
        }
        divided={onArtDirection}
      />
      {/* Art direction is the one world screen laid out as a fixed-height row rather than a
          column that scrolls, so it is the one that has to be told how much room it has. The
          column measures it instead of subtracting a guessed constant from the viewport: the
          nav above it is sticky and therefore in flow, and any condition banner is too. */}
      <div className={cx("fy-content", fixedFrame && "fy-content--fill", onCast && "fy-content--cast", path.includes("/productions/setup/") && "fy-content--setup")}>
        <WorldNavigation path={path}>
          {nav.map(([slug, label]) => (
            slug === "cast" && onSheets ? (
              <Link key={slug} to={`/w/${worldId}/cast`} aria-current="page"
                className="fy-pillnav__item fy-pillnav__item--active">
                {label}
              </Link>
            ) : (
              <NavLink
                key={slug}
                to={`/w/${worldId}${slug ? `/${slug}` : ""}`}
                end={slug === ""}
                className={({ isActive }) =>
                  cx(
                    "fy-pillnav__item",
                    isActive && "fy-pillnav__item--active",
                  )
                }
              >
                {label}
              </NavLink>
            )
          ))}
        </WorldNavigation>
        <WorldConditionBanners />
        {refusal ? <WorldOpenRefusal worldId={worldId!} reason={refusal.reason} /> :
          world ? <Outlet /> : <WorldOpening worldId={worldId} />}
      </div>
    </div>
  );
}

/** The capsule stays put on desktop; a phone scrolls its pills independently of the page. */
function WorldNavigation({ path, children }: { path: string; children: ReactNode }) {
  const sentinel = useRef<HTMLSpanElement>(null);
  const nav = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const marker = sentinel.current!;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry!.isIntersecting), {
      root: marker.closest(".fy-content"),
    });
    observer.observe(marker);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (window.matchMedia?.("(max-width: 599px)").matches) {
      nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }, [path]);
  return <>
    <span ref={sentinel} className="fy-worldnav__sentinel" aria-hidden="true" />
    <div className={cx("fy-worldnav", stuck && "fy-worldnav--stuck")}>
      <nav ref={nav} className="fy-pillnav" aria-label="World">{children}</nav>
    </div>
  </>;
}

/** Staleness, closed-world edits and parse failures — stated, never silent. */
function WorldConditionBanners() {
  const { worldId } = useParams();
  const location = useLocation();
  const world = useWorld();
  const navigate = useNavigate();
  const clientState = useClientState();
  if (!world || world.meta.worldId !== worldId) return null;
  // The completion notice (SPEC-031 R-44..R-47): persists until dismissed or the work it
  // names is no longer outstanding, and its one action opens the screen that can act.
  //
  // On Overview and nowhere else (issue 1007). R-44 raises it on arrival at the world, and
  // Overview is the arrival; drawing it on all nine tabs made it a permanent 110px band on
  // top of nine screens laid out against the window, which is what pushed Save off the foot
  // of the edit sheet, the composer off World Chat and the key art below the fold. It is one
  // row now — title, cause, date, two presses — rather than a callout with a paragraph in it.
  // Trailing slashes stripped, for the reason WorldLayout strips them: `/w/<id>/` is the
  // Overview, and a typed address that ends in one must not be read as some other tab.
  const onOverview = location.pathname.replace(/\/+$/, "") === `/w/${worldId}`;
  const build = clientState?.app.builds.find((candidate) => candidate.worldId === worldId) ?? null;
  const notice = onOverview && build ? foundingNote(build) : null;
  // File problems are not conditions of the screen (design turn 268): a band that stood over every
  // tab made the app read as broken. They arrive once as a notice and stay listed in the Inbox.
  // Outside edits stay, because the world's writes wait on them and Adopt lives here.
  const hasConditions = world.externalEdits.length > 0 || notice !== null;
  if (!hasConditions) return null;
  return (
    <div className="fy-worldconditions">
      {notice && (
        <div className="fy-buildnotice" role="status">
          <span className="fy-buildnotice__dot" aria-hidden="true" />
          <span className="fy-buildnotice__title">{notice.title}</span>
          {notice.reason && <span className="fy-buildnotice__cause">{notice.reason}</span>}
          {notice.meta !== "" && <span className="fy-buildnotice__when">{notice.meta}</span>}
          {/* Activity is a panel over this screen (design turn 136): the notice opens it in place. */}
          <button type="button" className="fy-buildnotice__act" onClick={() => followLink(navigate, notice.action!.to)}>
            {notice.action!.label}
          </button>
          <button type="button" className="fy-buildnotice__act" onClick={() => dismissBuildNotice(worldId!)}>
            Dismiss
          </button>
        </div>
      )}
      {world.externalEdits.length > 0 && (
        <Callout
          tone="warning"
          title={`${world.externalEdits.length} file(s) changed while the world was closed`}
        >
          Adopting records the change as external. Versioned files also snapshot the prior version and advance
          their version, so the history still explains itself.
          <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            {world.externalEdits.map((e) => (
              <div key={e.path} className="fy-worldconditions__edit">
                <span className="mono" style={{ fontSize: "var(--text-xs)" }}>
                  {e.path} · {e.kind}
                </span>
                <Button onClick={() => reconcileExternalEdit(world.meta.worldId, e.path)}>Adopt</Button>
                {e.refusal && <span style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{e.refusal}</span>}
              </div>
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
  // Before the guard: hooks cannot run behind a return.
  const authoring = useAuthoring();
  // Arriving at a world mid-build returns to the building screen, run continuing (SPEC-031
  // R-33). Only the running state redirects — a finished build's world is just a world.
  const clientState = useClientState();
  const runningBuild =
    clientState?.app.builds.find((build) => build.worldId === worldId && build.status === "running") ?? null;
  useEffect(() => {
    if (runningBuild) navigate(`/building/${worldId}`, { replace: true });
  }, [runningBuild !== null, worldId, navigate]);
  /** The title is editable in place; the folder underneath never moves. */
  const [renaming, setRenaming] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  /*
    Arming and focusing are one action (driven 2026-08-22). The click that made the title
    editable left no caret in it, so the title looked ready to type into and swallowed the first
    keystroke; a second click nobody knows to make was the difference between renaming a world
    and thinking the feature was broken. The caret goes to the end, not the start — the name is
    usually being extended or corrected, not replaced from the front.
  */
  useEffect(() => {
    const el = titleRef.current;
    if (!renaming || !el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [renaming]);
  if (!world) {
    return (
      <Screen id="world-overview">
        <WorldOpening worldId={worldId} />
      </Screen>
    );
  }
  const slug = world.meta.slug;
  // The world's own cast, not every sheet on disk: a production's guests live in the same
  // directories and would otherwise crowd the fan with people the world has never met
  // (SPEC-020 R-8).
  const cast = worldSheets(world.sheets).filter((s) => s.type === "character" && s.retired !== true);
  const characters = cast.slice(0, 5);
  // The fan is where "1 awaiting you" and "No one lives here yet" used to sit on screen at the
  // same time, saying opposite things about the same world (issue 228). The one awaiting is a
  // character being drafted, so it takes a card in the fan like any other.
  const pendingCast = pendingWorldSheets(pendingSheets(world.proposals, "character", world.conversations)).slice(
    0,
    Math.max(0, 5 - characters.length),
  );
  const threads = world.canon.filter((c) => c.status === "open");
  const proposals = unattendedProposalsOf(world.proposals, world.conversations);
  // Continue means the one worked on last; the list is in name order (issue 2777).
  const production = world.productions.reduce<(typeof world.productions)[number] | undefined>(
    (latest, candidate) => (latest === undefined || candidate.meta.updated > latest.meta.updated ? candidate : latest),
    undefined,
  );
  const cut = production ? deriveCut(production) : null;
  const hasChapters = production && productionShape(production.meta).hasChapters;
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
      <div className="fy-worldintro">
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">
          A world of yours
          {proposals.length > 0 ? ` · ${proposals.length} awaiting you` : ""}
        </div>
        {/*
          The name is a label, and labels change. It was written once at the door — in the first
          thirty seconds of an idea — and read everywhere after, so a world could be named for
          good by a sentence typed before the story existed. Editing in place, like the scene
          synopsis: the folder underneath never moves.
        */}
        <h1
          ref={titleRef}
          className="fy-hero__title"
          data-testid="world-name"
          role="textbox"
          tabIndex={0}
          title="Rename this world"
          suppressContentEditableWarning
          contentEditable={renaming}
          onClick={() => setRenaming(true)}
          onKeyDown={(e) => {
            if (!renaming && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              setRenaming(true);
              return;
            }
            if (renaming && e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLElement).blur();
            }
            if (renaming && e.key === "Escape") {
              e.currentTarget.textContent = world.meta.name;
              setRenaming(false);
            }
          }}
          onBlur={(e) => {
            setRenaming(false);
            const next = (e.currentTarget.textContent ?? "").replace(/\s+/g, " ").trim();
            if (next === "" || next === world.meta.name) {
              e.currentTarget.textContent = world.meta.name;
              return;
            }
            if (worldId) renameWorld(worldId, next);
          }}
        >
          {world.meta.name}
        </h1>
        {world.meta.logline && <p className="fy-hero__lede">{world.meta.logline}</p>}
        {/*
          Nothing to operate (design 63a). The hero used to end in a key-art row — Generate from
          the logline, Upload an image, a model picker and the keep-or-discard offer — which put
          four controls over an image the hero does not even show, under the world's own title.
        */}
      </div>
      <div className="fy-worldcast__head">
        <span className="fy-hero__eyebrow">Cast · {cast.length}</span>
        <Link to={`/w/${worldId}/cast`}>All <ArrowRight size={14} /></Link>
      </div>
      <div className="fy-fan">
        {characters.map((sheet, i) => {
          const slot = FAN[i] ?? FAN[2]!;
          return (
            <div
              key={sheet.id}
              className="fy-fan__slot"
              style={{ "--fan-x": `${slot.left}px`, "--fan-y": `${slot.top}px`, "--fan-r": `${slot.rotate}deg`, zIndex: slot.z } as CSSProperties}
            >
              <div
                className="fy-fan__drift"
                style={{ animationDuration: `${slot.dur}s`, animationDelay: `${slot.delay}s` }}
              >
                <div
                  className="fy-polaroid"
                  onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}`)}
                >
                  <div className="fy-polaroid__frame">
                    <Portrait
                      worldSlug={slug}
                      path={characterPortraitPath(world, sheet.id)}
                      label={sheet.name}
                    />
                  </div>
                  <div className="fy-polaroid__name">{sheet.name}</div>
                  {/*
                    Role only — never a sentence lifted from the body. Both lines are clipped to
                    one line in CSS so every card in the fan is the same height whatever the
                    sheet says; an unset role leaves the line blank rather than filling it with
                    essence prose, which used to make cards three lines tall and the fan ragged.
                  */}
                  <div className="fy-polaroid__role">{sheet.role ?? ""}</div>
                </div>
              </div>
            </div>
          );
        })}
        {pendingCast.map((sheet, i) => {
          const slot = FAN[characters.length + i] ?? FAN[2]!;
          const destination = pendingSheetDestination(sheet);
          const state = pendingSheetState(authoring[sheet.proposalId], destination, sheet.requiresDraft);
          return (
            <div
              key={sheet.proposalId}
              className="fy-fan__slot"
              style={{ "--fan-x": `${slot.left}px`, "--fan-y": `${slot.top}px`, "--fan-r": `${slot.rotate}deg`, zIndex: slot.z } as CSSProperties}
            >
              <div
                className="fy-fan__drift"
                style={{ animationDuration: `${slot.dur}s`, animationDelay: `${slot.delay}s` }}
              >
                <div
                  className="fy-polaroid fy-polaroid--pending"
                  onClick={() => navigate(pendingSheetRoute(worldId, sheet) ?? `/w/${worldId}/cast`)}
                >
                  <div className="fy-polaroid__frame fy-polaroid__frame--pending">
                    {state.tone === "live" && <Loading size={28} />}
                  </div>
                  <div className="fy-polaroid__name">{sheet.name}</div>
                  <div className="fy-polaroid__role">{state.foot}</div>
                </div>
              </div>
            </div>
          );
        })}
        {characters.length === 0 && pendingCast.length === 0 && (
          <div style={{ textAlign: "center", paddingTop: 120 }}>
            <EmptyState
              title="No one lives here yet"
              hint="Start with a sentence — a character grows from it."
            />
          </div>
        )}
      </div>
      <div className="fy-ctas">
        {production && cut && (
          <div className="fy-cta" onClick={() => navigate(`/w/${worldId}/p/${production.meta.id}`)}>
            <div className="fy-cta__frame">
              <Portrait
                worldSlug={slug}
                path={hasChapters ? (world.keyArt ?? "") : `productions/${production.meta.id}/${production.scenes[0]?.board?.image ?? "board-v2.png"}`}
                label={production.meta.title}
                fallbackSrc={productionPlate(production.meta)}
                radius={8}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-cta__title">Continue {production.meta.title}</div>
              <div className="fy-cta__sub">
                {hasChapters ? `${chapterCountLabel(production)} · ${production.meta.status}`
                  : cut.entries.length === 0 ? "No shots yet."
                  : `${cut.covered} of ${cut.entries.length} shots covered${cut.gaps > 0
                    ? ` · ${cut.gaps} gap${cut.gaps === 1 ? "" : "s"} to close.`
                    : " · the boards are ready."}`}
              </div>
            </div>
            <Button>Open</Button>
          </div>
        )}
        <div className="fy-cta" onClick={() => navigate(`/w/${worldId}/canon`)}>
          <div className="fy-cta__frame">
            <Portrait worldSlug={slug} path={world.keyArt ?? ""} label="Canon" fallbackSrc="./worlds/new-world.webp" radius={8} />
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
      </div>
      {/*
       * Below the fold (design 63b). Needs you, Open threads and Recent changes used to stack
       * here as panels, and turn 44 pulled them off precisely because screens' worth of content
       * pushed the world's own entrances down the page. What is here now sits *after* the fan and
       * the two doors and costs them nothing: what the world is made of, what it has been made
       * into, and one line naming what is waiting.
       */}
      <div className="fy-worldmore">
        <div className="fy-worldmore__rule" />
        <WorldGlance world={world} />
        <WorldProductions worldId={worldId!} world={world} />
        <NeedsYou worldId={worldId!} world={world} />
      </div>
    </div>
  );
}

/** A heading pair used by both sections below the fold: the label, the sentence, and an aside. */
function SectionHead({ eyebrow, title, aside }: { eyebrow: string; title: string; aside: ReactNode }) {
  return (
    <div className="fy-wsection__head">
      <div>
        <div className="fy-wsection__eyebrow">{eyebrow}</div>
        <h2 className="fy-wsection__title">{title}</h2>
      </div>
      {aside}
    </div>
  );
}

/**
 * What the world is made of (design 63b).
 *
 * Four figures, each with a second line naming what is outstanding about it rather than repeating
 * the count in words. Every one of them is the world's own — `worldSheets` drops a production's
 * guests, which would otherwise inflate a cast the world has never met (SPEC-020 R-8).
 *
 * Figures, not buttons: the tab row above already reaches all seven screens, and a second set of
 * doors to the same places is the inventory this page has twice been cleared of.
 */
export function referenceSummary(kit: ReferenceKit | null | undefined) {
  const counts = referenceKitCounts(kit);
  const parts = [[counts.photos, "main photo"], [counts.sheets, "sheet"], [counts.looks, "look"],
    [counts.views, "view"], [counts.tiles, "tile"]] as const;
  return { total: counts.total, detail: parts.filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`).join(" · ") || "No accepted references" };
}

function WorldGlance({ world }: { world: WorldBundle }) {
  const owned = worldSheets(world.sheets).filter((s) => s.retired !== true);
  const characters = owned.filter((s) => s.type === "character");
  const places = owned.filter((s) => s.type === "location");
  const truths = world.canon.filter((c) => c.status === "settled" && c.retired !== true);
  const threads = world.canon.filter((c) => c.status === "open").length;
  const sketchPlaces = places.filter((s) => s.status === "sketch").length;
  // Accepted reference material: the identity anchors, the model sheets that ride along with a
  // dispatch, and a location's accepted angles. Candidates and superseded views are not assets —
  // nothing has said yes to them yet, or something has since said no.
  const kits = world.referenceKits;
  const anchored = kits.filter((kit) => mainPhotoFor(kit) !== null).length;
  const assets = kits.reduce(
    (n, kit) =>
      n +
      (mainPhotoFor(kit) !== null ? 1 : 0) +
      (designatedCompilation(kit) !== null ? 1 : 0) +
      (kit.locationViews ?? []).filter((v) => v.status === "active").length,
    0,
  );
  const cells: Array<{ n: number; label: string; sub: string }> = [
    {
      n: truths.length,
      label: `Canon truth${truths.length === 1 ? "" : "s"}`,
      sub: threads > 0 ? `${threads} open thread${threads === 1 ? "" : "s"}` : "nothing unsettled",
    },
    {
      n: characters.length,
      label: `Character${characters.length === 1 ? "" : "s"}`,
      sub:
        characters.length === 0
          ? "no one lives here yet"
          : `${characters.filter((s) => s.status === "locked").length} locked to canon`,
    },
    {
      n: places.length,
      label: "Places",
      sub:
        places.length === 0
          ? "nowhere yet"
          : sketchPlaces > 0
            ? `${sketchPlaces} still a sketch`
            : "all locked to canon",
    },
    {
      n: assets,
      label: "Accepted assets",
      sub: assets === 0 ? "nothing accepted yet" : `${anchored} generation-ready`,
    },
  ];
  return (
    <section className="fy-wsection">
      <SectionHead
        eyebrow="The world at a glance"
        title="Everything here becomes material."
        aside={
          <p className="fy-wsection__lede">
            Build the foundations once, then carry them into stories, films and interactive experiences.
          </p>
        }
      />
      <div className="fy-glance">
        {cells.map((cell) => (
          <div key={cell.label} className="fy-glance__cell">
            <div className="fy-glance__n">{cell.n}</div>
            <div className="fy-glance__label">{cell.label}</div>
            <div className="fy-glance__sub">{cell.sub}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function chapterCountLabel(production: WorldBundle["productions"][number]): string {
  const count = production.chapters.filter(chapter => !chapter.retired).length;
  return `${count} chapter${count === 1 ? "" : "s"}`;
}

/**
 * What the world has been made into (design 63b).
 * A story names its live chapters and saved status; a film keeps its shot coverage.
 */
function WorldProductions({ worldId, world }: { worldId: string; world: WorldBundle }) {
  const navigate = useNavigate();
  const productions = world.productions;
  return (
    <section className="fy-wsection fy-wsection--productions">
      <SectionHead
        eyebrow="Productions"
        title="One world, many forms."
        aside={
          <Button className="fy-world-newproduction" variant="secondary" onClick={() => navigate(`/w/${worldId}/productions/new`)}>
            <Plus size={13} /> New production
          </Button>
        }
      />
      {productions.length === 0 ? (
        <p className="fy-wsection__none">
          Nothing has been made from this world yet. Same cast, same canon — any format: film, stills, book.
        </p>
      ) : (
        <div
          className="fy-prodstrip"
          // Never a hole where a card is missing: two productions are two halves, not two thirds
          // of a row — the rule the location and faction grids already follow.
          style={{
            "--cols": Math.min(Math.max(productions.length, 2), 3),
          } as CSSProperties}
        >
          {productions.map((p) => {
            const { hasChapters, playsAsBeats } = productionShape(p.meta);
            const shots = p.scenes.flatMap((s) => orderedShots(s));
            const covered = coveredProductionShots(p, world?.artifacts ?? []);
            const board = p.scenes.find((s) => s.board)?.board;
            const take = p.takes.find((t) => t.media);
            const art = board
              ? `productions/${p.meta.id}/${board.image}`
              : take
                ? `productions/${p.meta.id}/takes/${take.id}/${take.media}`
                : (world.keyArt ?? "");
            return (
              <button
                key={p.meta.id}
                type="button"
                className="fy-prodtile"
                onClick={() => navigate(`/w/${worldId}/p/${p.meta.id}`)}
                aria-label={`${p.meta.title}, ${productionShape(p.meta).displayLabel}. Open the workspace.`}
              >
                <div className="fy-prodtile__frame">
                  <Portrait
                    worldSlug={world.meta.slug}
                    path={art}
                    label={`${p.meta.title}: frame`}
                    fallbackSrc={productionPlate(p.meta)}
                    radius={7}
                  />
                </div>
                <div className="fy-prodtile__eyebrow">{productionShape(p.meta).displayLabel}</div>
                <div className="fy-prodtile__name">{p.meta.title}</div>
                <div className="fy-prodtile__foot">
                  <span className="fy-prodtile__meta">
                    {hasChapters ? `${chapterCountLabel(p)} · ${p.meta.status}` : shots.length > 0
                      ? `${shots.length} ${playsAsBeats ? "picture" : "shot"}${shots.length === 1 ? "" : "s"} · ${covered} ${playsAsBeats ? "ready" : "accepted"}`
                      : `${p.scenes.length} scene${p.scenes.length === 1 ? "" : "s"} · ${p.meta.status}`}
                  </span>
                  {!hasChapters && shots.length > 0 && (
                    <span className="fy-prodtile__pct">{Math.round((covered / shots.length) * 100)}%</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Which decision a staged proposal is, in the words the person who has to make it would use. */
const PROPOSAL_WHY: Record<string, string> = {
  "new-sheet": "new sheet proposal",
  "sheet-edit": "edit to a sheet",
  "new-canon": "new canon entry",
  "canon-edit": "edit to canon",
  "canon-settle": "a thread to settle",
  "chapter-draft": "drafted chapter",
  "story-overview": "story overview",
  "prose-style": "prose style",
  "episode-script": "episode script draft",
  "comic-script": "pages draft",
  "season-edit": "season change",
  "episode-edit": "episode change",
  "series-edit": "series change",
  "scene-draft": "drafted scene",
  "scene-edit": "edit to a scene",
  extraction: "extracted from an artifact",
  restore: "a restore to confirm",
  "art-direction": "change to the world look",
  worldbuilding: "several changes, staged together",
};

/**
 * One line naming what is waiting, or nothing at all (design 63b).
 *
 * At most two, because this is a convenience rather than the guarantee: the chrome's warning dot
 * reaches proposals and activity from every screen in the app, so a third thing sitting off the
 * end of this line is not lost. Never rendered at zero — a bar saying "0 things need you" is the
 * kind of furniture that makes a page longer without making it say more.
 */
function NeedsYou({ worldId, world }: { worldId: string; world: WorldBundle }) {
  const navigate = useNavigate();
  const items = [
    ...unattendedProposalsOf(world.proposals, world.conversations).map((p) => ({
      key: p.proposal.id,
      name: p.proposal.summary,
      why: PROPOSAL_WHY[p.proposal.kind] ?? p.proposal.kind.replace(/-/g, " "),
      action: "Review",
      go: () => navigate(`/w/${worldId}/proposals`),
    })),
    ...world.canon
      .filter((c) => c.status === "open" && c.retired !== true)
      .map((c) => ({
        key: c.id,
        name: c.title,
        why: "an open thread",
        action: "Resolve",
        go: () => navigate(`/w/${worldId}/canon/${c.id}/thread`),
      })),
  ];
  if (items.length === 0) return null;
  return (
    <div className="fy-needs">
      <div className="fy-needs__count">
        <span className="fy-dot fy-dot--warn" />
        {items.length} thing{items.length === 1 ? "" : "s"} need{items.length === 1 ? "s" : ""} you
      </div>
      {/*
        The subject clips; the kind and the verb never do. A proposal's summary is a whole
        sentence — "Maren pays for scene four — her left ear is gone, and the sheet should say
        so" — so leaving the kind after it in the same clipped run meant the one thing this line
        exists to say, what sort of decision is waiting, was the first thing the ellipsis ate.
      */}
      {items.slice(0, 2).map((item) => (
        <button key={item.key} type="button" className="fy-needs__item" onClick={item.go}>
          <span className="fy-needs__what">{item.name}</span>
          <span className="fy-needs__why">{item.why}</span>
          <span className="fy-needs__go">{item.action} →</span>
        </button>
      ))}
    </div>
  );
}
