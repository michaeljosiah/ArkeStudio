import { useEffect, useRef, useState } from "react";
import { importWorld, subscribeWorldImport } from "../lib/store.js";
import { Outlet, useLocation, useNavigate } from "react-router";
import { remoteStudio } from "./launch.js";
import { Button, Callout, cx } from "../components/ui.js";
import { BodyLayer } from "../components/body-layer.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { Archive, Book, More, Plus, Sparkle, Upload, ArrowRight } from "../components/icons.js";
import { useMediaQuery } from "../lib/media-query.js";
// Providers absorbed both surfaces (SPEC-034 R-5), so its pane draws their parts: the engine
// details unabridged, and one engine's models grouped by the provider that owns them.
import { AppChrome } from "../components/chrome.js";
import { Portrait } from "../components/portrait.js";
import { relativeDate, shortDateTime } from "../lib/format.js";
import {
  archiveWorld, installSampleWorld, useSampleWorld, useArchiveNote, useEnvCheck, useStore,
} from "../lib/store.js";


export function ShellChrome() {
  // Every shell screen carries its own chrome (prototype 1a/5a/22a/26a) — no shared bar.
  return (
    <div className="scr-frame__content" style={{ height: "100%" }}>
      <Outlet />
    </div>
  );
}

// ---- Connection ------------------------------------------------------------

/**
 * An expired browser capability, said once for every screen past the launch surface. The
 * surface itself says it on its local way instead (design turn 158).
 */
export function SessionRefusal() {
  const { connection } = useStore();
  const { pathname } = useLocation();
  // The launch surface says it on its own local way (design turn 158), where it belongs.
  if (connection !== "auth-refused" || pathname === "/" || pathname === "/starting") return null;
  // Reached from another device, the developer's instruction is not something a phone can do.
  if (remoteStudio() !== null) return <div role="alert" className="fy-session-refusal">
    <Callout tone="warning" title="This link has expired">Open a new one from Arke Studio on your computer.</Callout>
  </div>;
  return <div role="alert" className="fy-session-refusal">
    <Callout tone="warning" title="Session link is out of date">Restart the frontend and open the new Arke session link from its terminal. If it still fails, check that the server allows this browser address.</Callout>
  </div>;
}

/**
 * The one line shown wherever a Settings pane is waiting on a coordinator that is not there:
 * its rows draw `—` from an absent snapshot exactly as they draw `—` from an unconfigured
 * provider (issue 599). The launch surface says the same thing on its local way.
 */
export function WaitingForCoordinator() {
  const { connection } = useStore();
  if (typeof window !== "undefined" && window.arke) {
    return <Callout tone="warning" title="Starting Arke Studio…">Connecting to your workspace. The app keeps retrying on its own.</Callout>;
  }
  if (connection === "auth-refused") return null;
  return (
    <Callout tone="warning" title="Waiting for the coordinator">
      The app keeps retrying on its own. Check that your Studio server is running.
    </Callout>
  );
}

// ---- First run -------------------------------------------------------------

export function FirstRunScreen() {
  const navigate = useNavigate();
  const env = useEnvCheck();
  const sample = useSampleWorld();
  return (
    <div className="fy-app" data-screen="first-run">
      <AppChrome divided={false} />
      {/* Below 1100 the page centres when it fits (design turn 159), so the classes carry the
          sizes the three widths need rather than inline values none of them can reach. */}
      <div className="fy-content fy-firstrun">
        <div className="fy-hero fy-firstrun__hero">
          <div className="fy-hero__eyebrow">Welcome</div>
          <h1 className="fy-hero__title fy-firstrun__title">
            Every world starts as a name.
          </h1>
          <p className="fy-hero__lede fy-firstrun__lede">Give yours one.</p>
        </div>
        {env && (!env.pathBudgetOk || !env.nativeIndexOk) && (
          <div className="fy-firstrun__warnings">
            {!env.pathBudgetOk && (
              <Callout tone="warning" title="Your data folder sits too deep">
                {env.pathBudgetDetail}
              </Callout>
            )}
            {!env.nativeIndexOk && (
              <Callout tone="warning" title="The search index could not load">
                {env.nativeIndexDetail}
              </Callout>
            )}
          </div>
        )}
        <div className="fy-firstrun__doors">
          <div className="fy-firstrun__flank fy-firstrun__flank--left" />
          <div className="fy-fan__drift">
            <div className="fy-createcard" onClick={() => navigate("/worlds/new")}>
              <div className="fy-createcard__ring">
                <Plus size={22} />
              </div>
              <div className="fy-createcard__title">Your first world</div>

              <div style={{ marginTop: 4 }}>
                <Button variant="primary">Create a world</Button>
              </div>
            </div>
          </div>
          {/* A blank name is a hard place to start from if you have never seen one of these
              finished. The sample world takes the other side of the fan — solid rather than
              dashed, because unlike the card beside it, this one is not an empty slot. */}
          {sample?.available === true ? (
            <div className="fy-fan__drift" style={{ animationDelay: "0.6s" }}>
              <div
                className="fy-createcard fy-createcard--filled"
                onClick={() => {
                  if (sample.installing) return;
                  if (sample.download) navigate("/settings/sample-world"); else installSampleWorld();
                }}
              >
                <div className="fy-createcard__ring">
                  <Sparkle size={22} />
                </div>
                <div className="fy-createcard__title">Or start from ours</div>
                <div className="fy-createcard__sub">
                  {sample.download ? "The Undersong: an illustrated novel and editable world. Audiobook and video unfinished. Download separately." : "The Undersong: a cast, its canon, and a production part-way through. Yours to take apart."}
                </div>
                <div style={{ marginTop: 4 }}>
                  <Button disabled={sample.installing}>
                    {sample.installing ? "Installing…" : sample.download ? "Explore the story download" : "Install the sample world"}
                  </Button>
                </div>
                {sample.note?.refused === true && (
                  <div className="fy-createcard__sub" style={{ color: "var(--destructive)" }}>
                    {sample.note.text}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="fy-firstrun__flank fy-firstrun__flank--right" />
          )}
        </div>
        <div className="fy-firstrun__docs">
          <span>Already have a canon in documents? </span>
          <span
            className="fy-firstrun__docslink"
            title="Create the world first; then use Artifacts → Add files to file documents and lift facts."
            onClick={() => navigate("/worlds/new")}
          >
            Add documents
          </span>
          <span className="fy-firstrun__docstail">. It files into artifacts, ready to link.</span>
        </div>
      </div>
    </div>
  );
}

// ---- World picker ----------------------------------------------------------

/** Home (prototype 1a): the greeting, and every world as a held card with its key art. */
export function WorldPickerScreen() {
  const { state } = useStore();
  const navigate = useNavigate();
  const worlds = state?.worlds ?? [];
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const importRequest = useRef<string | null>(null);
  useEffect(() => subscribeWorldImport(result => {
    if (result.requestId !== importRequest.current) return;
    setImporting(false); importRequest.current = null;
    setImportNote(result.reason ?? null);
    if (result.worldId) navigate(`/w/${result.worldId}`);
  }), [navigate]);
  /*
   * The ages on the cards are computed at render, and this screen can sit open for hours with
   * nothing else to re-render it — so a card that said `now` when it was drawn went on saying
   * `now`, and `59m ago` never became `1h ago` (codex, 2026-09-09). A minute is the coarsest
   * tick that keeps every step of `relativeDate` honest; the timer is cleared with the screen.
   */
  const [, setMinute] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setMinute((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [confirming, setConfirming] = useState<string | null>(null);
  const archiveNote = useArchiveNote();
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  // A count, and nothing else (turn 137).
  const lede =
    worlds.length === 0
      ? "Nothing here yet."
      : worlds.length === 1
        ? "One world."
        : `${["", "", "Two", "Three", "Four", "Five"][worlds.length] ?? worlds.length} worlds.`;
  const ROT = [-2.5, 1.8, -1.2, 2.4, -2];
  // On a phone the last world opened leads, wide, and the grid holds the rest (design turn 159).
  // Both are rendered at every width and the stylesheet chooses, so the first paint is already
  // right and a window crossing 600 needs no render.
  const featured = worlds.reduce<(typeof worlds)[number] | undefined>(
    (best, w) => (best === undefined || Date.parse(w.updated) > Date.parse(best.updated) ? w : best),
    undefined,
  );
  // The confirm is the one place the width decides what renders: a phone asks in a sheet from the
  // bottom, where a thumb is, rather than inside a card half a thumb wide.
  const phone = useMediaQuery("(max-width: 599px)");
  const confirmingWorld = worlds.find((w) => w.worldId === confirming);
  return (
    <div className={cx("fy-app", worlds.length === 0 && "fy-home-welcome")} data-screen="world-picker">
      {/* No back and no context: this is the top, and the wordmark already says where you are. */}
      <AppChrome divided={false} />
      <div className="fy-content">
        <div className="fy-home-hero">
          <div className="fy-hero__eyebrow">{worlds.length ? greeting : "Welcome to your studio"}</div>
          <h1 className="fy-hero__title fy-hero__title--home" style={{ textAlign: "left" }}>
            {worlds.length ? "Pick up where you left off." : "Your first world starts here."}
          </h1>
          <div className="fy-home-count">
            <p className="fy-hero__lede" style={{ margin: worlds.length ? "10px 0 0" : 0, maxWidth: 540 }}>
              {lede}
            </p>
          </div>
          <div className="fy-home-import">
            <Button variant="ghost" className="fy-home-pub fy-home-action" onClick={() => navigate("/publications")}>
              <Book size={18} />
              Open publication
            </Button>
            {!isRemoteSession() && <Button variant="ghost" className="fy-home-action" disabled={importing} onClick={() => {
              setImportNote(null); importRequest.current = importWorld(); setImporting(importRequest.current !== null);
            }}><Upload size={18} />{importing ? "Importing world…" : "Import a world"}</Button>}
          </div>
          {archiveNote && (
            <div className="fy-set__why" style={{ marginTop: 10 }}>
              <span className={cx("fy-set__dot", archiveNote.refused ? "fy-set__dot--warn" : "fy-set__dot--ok")} />
              <span>{archiveNote.text}</span>
            </div>
          )}
          {importNote && <p role="alert">{importNote}</p>}
        </div>
        {featured && (
          <div className="fy-home-feature">
            <div className="fy-home-label">Last opened</div>
            <div
              className="fy-homefeature"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/w/${featured.worldId}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") navigate(`/w/${featured.worldId}`);
              }}
            >
              <div className="fy-homefeature__art">
                {featured.keyArt ? <Portrait worldSlug={featured.slug} path={featured.keyArt} label={featured.name} radius={0} /> :
                  <img className="fy-portrait fy-portrait--plate" src="./worlds/new-world.webp" alt="" />}
                {/* The featured world leaves the grid on a phone, so it carries its own ⋯. */}
                <button
                  type="button"
                  className="fy-worldcard__archive"
                  aria-label={`Archive ${featured.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirming(featured.worldId);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <span className="fy-worldcard__glyph fy-worldcard__glyph--hover"><Archive size={13} /></span>
                  <span className="fy-worldcard__glyph fy-worldcard__glyph--touch"><More size={16} /></span>
                </button>
              </div>
              <div className="fy-homefeature__body">
                <div className="fy-homefeature__name">{featured.name}</div>
                <div className="fy-homefeature__logline">{featured.logline ?? ""}</div>
                <WorldMeta world={featured} />
              </div>
            </div>
            <div className="fy-home-label">All worlds</div>
          </div>
        )}
        {worlds.length === 0 ? <WelcomeWorldCards /> : <div className="fy-home-cards">
          <button type="button" className="fy-worldcard fy-newworldcard" onClick={() => navigate("/worlds/new")}>
            <span className="fy-worldcard__frame fy-worldcard__empty fy-worldcard__empty--art" aria-hidden="true"><img src="./worlds/new-world.webp" alt="" /><Plus size={28} /></span>
            <span className="fy-worldcard__name">Create a world</span>
          </button>
            {worlds.map((w, i) => (
              <div
                key={w.worldId}
                className={cx("fy-fan__drift fy-home-drift", w.worldId === featured?.worldId && "fy-home-drift--featured")}
                style={{ animationDuration: `${7 + (i % 3) * 0.7}s`, animationDelay: `${i * 0.6}s` }}
              >
                <div
                  className="fy-worldcard"
                  // The lean is a variable rather than a transform, so a phone can stand the card
                  // up straight and a touch can leave it where it is (design turn 159).
                  style={{ "--lean": `${ROT[i % ROT.length]}deg` } as React.CSSProperties}
                  onClick={() => navigate(`/w/${w.worldId}`)}
                >
                  <div className="fy-worldcard__frame">
                    {w.keyArt ? <Portrait worldSlug={w.slug} path={w.keyArt} label={w.name} radius={10} /> :
                      <img className="fy-portrait fy-portrait--plate" src="./worlds/new-world.webp" alt="" style={{ borderRadius: 10 }} />}
                  </div>
                  {/* Archiving is two clicks and no dialog: the second click is the consent,
                      and the words say what actually happens to the folder. */}
                  {confirming === w.worldId && !phone ? (
                    <div className="fy-worldcard__confirm" onClick={(e) => e.stopPropagation()}>
                      <span>Move {w.name} to the archive folder? Nothing is deleted.</span>
                      <span className="fy-worldcard__confirmacts">
                        <button
                          type="button"
                          className="fy-set__b fy-set__b--go"
                          onClick={() => {
                            archiveWorld(w.worldId);
                            setConfirming(null);
                          }}
                        >
                          Archive
                        </button>
                        <button type="button" className="fy-set__b" onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="fy-worldcard__archive"
                      aria-label={`Archive ${w.name}`}
                      title="Archive — moves the folder, deletes nothing"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirming(w.worldId);
                      }}
                    >
                      {/* Without hover there is nothing to reveal it, so it shows as ⋯ (design turn 159). */}
                      <span className="fy-worldcard__glyph fy-worldcard__glyph--hover"><Archive size={13} /></span>
                      <span className="fy-worldcard__glyph fy-worldcard__glyph--touch"><More size={16} /></span>
                    </button>
                  )}
                  <div className="fy-worldcard__name">{w.name}</div>
                  {/* Always rendered: a world with no logline yet keeps the two-line box empty
                      rather than making its card shorter than the ones beside it. */}
                  <div className="fy-worldcard__logline">{w.logline ?? ""}</div>
                  <WorldMeta world={w} />
                </div>
              </div>
            ))}
        </div>
        }
        {worlds.length === 0 && <div className="fy-home-setup"><span>Write and organise now. Add AI whenever you need it.</span><Button className="fy-home-action" onClick={() => navigate("/settings/general")}>Settings <ArrowRight size={18} /></Button></div>}
      </div>
      {phone && confirmingWorld && (
        <ArchiveSheet
          world={confirmingWorld}
          onArchive={() => {
            archiveWorld(confirmingWorld.worldId);
            setConfirming(null);
          }}
          onKeep={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function WelcomeWorldCards() {
  const navigate = useNavigate();
  const sample = useSampleWorld();
  return <div className="fy-home-empty fy-firstrun"><div className="fy-firstrun__doors">
    <div className="fy-fan__drift"><div className="fy-createcard">
      <div className="fy-createcard__ring"><Plus size={22} /></div>
      <div className="fy-createcard__title">Your first world</div>
      <div style={{ marginTop: 4 }}><Button variant="primary" onClick={() => navigate("/worlds/new")}>Create a world</Button></div>
    </div></div>
    {sample?.available && <div className="fy-fan__drift" style={{ animationDelay: "0.6s" }}><div className="fy-createcard fy-createcard--filled">
      <div className="fy-createcard__ring"><Sparkle size={22} /></div>
      <div className="fy-createcard__title">Or start from ours</div>
      <div className="fy-createcard__sub">{sample.download ? "The Undersong: an illustrated novel and editable world. Audiobook and video unfinished. Download separately." : "The Undersong: a cast, its canon, and a production part-way through. Yours to take apart."}</div>
      <div style={{ marginTop: 4 }}><Button disabled={sample.installing} onClick={() => sample.download ? navigate("/settings/sample-world") : installSampleWorld()}>{sample.installing ? "Installing…" : "Explore sample world"}</Button></div>
      {sample.note?.refused && <div className="fy-createcard__sub" role="alert">{sample.note.text}</div>}
    </div></div>}
  </div></div>;
}

type WorldCardSummary = NonNullable<ReturnType<typeof useStore>["state"]>["worlds"][number];

/** The card's last band: the attention dot, the counts, and an age. */
function WorldMeta({ world: w }: { world: WorldCardSummary }) {
  return (
    <div className="fy-worldcard__meta">
      <span
        className={cx("fy-dot", (w.attention?.unreviewedTakes ?? 0) > 0 ? "fy-dot--warn" : "fy-dot--ok")}
      />
      <span className="fy-worldcard__counts">
        {/* A phone's half-width card keeps productions and the age; the characters go first. */}
        <span className="fy-worldcard__chars">
          {w.counts.characters} character{w.counts.characters === 1 ? "" : "s"} ·{" "}
        </span>
        {w.counts.productions} production{w.counts.productions === 1 ? "" : "s"}
      </span>
      {/* An age, as 1a draws it — `4d ago`, not `Sep 7, 02:22`. The long form
          took the room the counts beside it needed (issue 1007). */}
      <span className="mono" title={shortDateTime(w.updated)}>{relativeDate(w.updated)}</span>
    </div>
  );
}

/**
 * Archiving on a phone (design turn 159b): the same two presses as the card's own confirm, asked
 * in a sheet from the bottom. The scrim and Escape are Keep, since keeping is the safe answer.
 */
function ArchiveSheet({ world, onArchive, onKeep }: { world: WorldCardSummary; onArchive: () => void; onKeep: () => void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onKeep(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onKeep]);
  return (
    <BodyLayer>
      <div className="fy-archivesheet__scrim" onClick={onKeep}>
        <div
          className="fy-archivesheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fy-archivesheet-title"
          onClick={(event) => event.stopPropagation()}
        >
          <span className="fy-archivesheet__grab" aria-hidden />
          <div className="fy-archivesheet__who">
            {world.keyArt && (
              <span className="fy-archivesheet__art">
                <Portrait worldSlug={world.slug} path={world.keyArt} label={world.name} radius={8} />
              </span>
            )}
            <div>
              <h2 id="fy-archivesheet-title">Archive {world.name}?</h2>
              <p>Moves its folder to the archive. Nothing is deleted.</p>
            </div>
          </div>
          <div className="fy-archivesheet__acts">
            <Button variant="primary" size="lg" onClick={onArchive}>Archive</Button>
            <Button size="lg" onClick={onKeep}>Keep</Button>
          </div>
        </div>
      </div>
    </BodyLayer>
  );
}
