import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  MAX_ACTIVE_LOCATION_VIEWS,
  designatedCompilation,
  normalizeViewName,
  orderedLocationViews,
  panelMapPhrase,
  type LocationView,
  type ReferenceKit,
  type SizeTier,
  type Take,
} from "@arke-studio/contracts";
import { GenerationDialog } from "../components/generation-dialog.js";
import { ImageDialog } from "../components/image-dialog.js";
import { Portrait } from "../components/portrait.js";
import { Button, Callout, cx } from "../components/ui.js";
import { useOpenWorldGuard, useSheet } from "../lib/selectors.js";
import {
  acceptLocationView,
  clearLocationViewUpload,
  generateLocationView,
  importLocationViewCandidate,
  rejectReferenceTake,
  useLocationViewUpload,
} from "../lib/store.js";

const UPLOAD_UNAVAILABLE = "Upload is available in the desktop app";

/** The picker belongs to the host, so in the browser there is nothing to open. */
function canPickFiles(): boolean {
  return typeof window !== "undefined" && window.arke !== undefined;
}

function LocationHeader({ worldId, sheetId, name, status }: {
  worldId: string;
  sheetId: string;
  name: string;
  status: string;
}) {
  const navigate = useNavigate();
  return (
    <header className="fy-character-head">
      <div>
        <h1>{name}</h1>
        <p>{status} · location reference set</p>
      </div>
      <span className="fy-character-head__push" />
      <nav className="fy-seg fy-location-tabs">
        <button type="button" className="fy-seg__item" onClick={() => navigate(`/w/${worldId}/locations/${sheetId}`)}>
          Overview
        </button>
        <span className="fy-seg__item fy-seg__item--active">Reference</span>
      </nav>
    </header>
  );
}

/**
 * The location Reference tab (issue 243, design turn 57): accepted views on the left, the sheet they
 * compose on the right.
 *
 * The two panes are one fact shown twice on purpose. The left is what you can act on — accept,
 * replace, add — and the right is what a shot will actually carry. Keeping them apart is what
 * makes "the sheet is assembled, never generated" visible: the right pane never has a button.
 */
export function LocationReferenceScreen() {
  const { worldId, sheetId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const upload = useLocationViewUpload()[sheetId ?? ""];
  const [naming, setNaming] = useState<{
    takeId: string;
    name: string;
    confirmReplace: boolean;
    /** Promote this candidate to panel 1. Only ever a choice once there is a panel 1 to displace. */
    asEstablishing: boolean;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [replacingEstablishing, setReplacingEstablishing] = useState(false);
  const [angle, setAngle] = useState("");
  const [angleName, setAngleName] = useState("");
  const [choice, setChoice] = useState<{ modelId?: string; tier?: SizeTier }>({});
  const [count, setCount] = useState(2);
  const addRef = useRef<HTMLButtonElement>(null);
  // A landed upload says itself — the candidate appears below. What it must not do is linger,
  // or the next press of Upload would find the slot already occupied and go quietly dead.
  useEffect(() => {
    if (sheetId && upload?.status === "landed") clearLocationViewUpload(sheetId);
  }, [upload?.status, sheetId]);
  if (!world || !sheet || !sheetId || !worldId) return null;

  const kit: ReferenceKit | null = world.referenceKits.find((k) => k.sheetId === sheetId) ?? null;
  const views: LocationView[] = kit ? orderedLocationViews(kit) : [];
  const superseded = (kit?.locationViews ?? []).filter((view) => view.status === "superseded");
  const compilation = kit ? designatedCompilation(kit) : null;
  const sheetFile = compilation?.format === "location-sheet" ? compilation.file : null;
  const full = views.length >= MAX_ACTIVE_LOCATION_VIEWS;
  const uploading = upload?.status === null;
  const canUpload = canPickFiles();

  const pending: Take[] = world.referenceTakes
    .filter(
      (take) =>
        take.kind === "location-view" &&
        take.reference?.sheetId === sheetId &&
        !world.referenceReviews.some((review) => review.takeId === take.id),
    )
    .sort((a, b) => (b.completedAt ?? b.dispatchedAt).localeCompare(a.completedAt ?? a.dispatchedAt));

  // The name the user is typing against the names already taken. Folded the same way the
  // contract folds them, so the screen cannot say "free" about a name the write will refuse.
  const collides = (name: string) =>
    views.some((view) => normalizeViewName(view.name) === normalizeViewName(name));
  const establishing = views.length === 0;

  return (
    <div data-screen="location-reference">
      <LocationHeader worldId={worldId} sheetId={sheetId} name={sheet.name} status={sheet.status} />
      <main className="fy-locref">
        <section className="fy-locref__views">
          <div className="fy-locref__sechead">
            <h2>Accepted views</h2>
            <span className="fy-mono">
              {views.length} of {MAX_ACTIVE_LOCATION_VIEWS}
            </span>
          </div>

          {views.length === 0 && pending.length === 0 && (
            <Callout tone="neutral" title="Start with the establishing view">
              <p>
                The first view you accept becomes the one a card shows and the one every later view is
                anchored to. Its Look is already written — the generation reads it.
              </p>
            </Callout>
          )}

          {views.map((view, index) => (
            <article key={view.id} className="fy-locref__view">
              <span className="fy-locref__panel fy-mono">PANEL {String(index + 1).padStart(2, "0")}</span>
              <div className="fy-locref__viewimage">
                <ImageDialog
                  worldSlug={world.meta.slug}
                  path={`references/${sheetId}/${view.file}`}
                  label={`${sheet.name}: ${view.name}`}
                  title={sheet.name}
                  subtitle={view.name}
                  triggerLabel={`View larger: ${view.name}`}
                  closeLabel="Close view"
                  triggerClassName="fy-locref__zoom"
                  triggerRadius={6}
                />
              </div>
              <div className="fy-locref__viewfoot">
                <h3>{view.name}</h3>
                <p className="fy-mono">
                  accepted {new Date(view.acceptedAt).toLocaleDateString()} · sheet v{view.sheetVersion} · look v
                  {view.artDirectionVersion}
                </p>
                {index === 0 && (
                  // Panel 1 is the anchor every other angle was generated against, so replacing it
                  // is the one generation that is deliberately *not* anchored to anything.
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setAngleName(view.name);
                      setReplacingEstablishing(true);
                      setAdding(true);
                    }}
                  >
                    Replace
                  </Button>
                )}
              </div>
            </article>
          ))}

          {superseded.length > 0 && (
            <p className="fy-locref__superseded">
              {superseded.length} superseded view{superseded.length === 1 ? "" : "s"} kept — every take is still on
              disk.
            </p>
          )}

          {pending.length > 0 && (
            <section className="fy-locref__pending">
              <h3>A view is waiting on you</h3>
              {pending.map((take) => {
                const proposed = take.params["locationView"] as { name?: string } | undefined;
                const active = naming?.takeId === take.id ? naming : null;
                const name = active?.name ?? proposed?.name ?? "";
                const clash = name.trim() !== "" && collides(name);
                return (
                  <div key={take.id} className="fy-locref__candidate">
                    <span className="fy-locref__status fy-mono">UNREVIEWED</span>
                    <div className="fy-locref__candidateimage">
                      <Portrait
                        worldSlug={world.meta.slug}
                        path={`references/${sheetId}/takes/${take.id}/${take.media ?? ""}`}
                        label={name || "Candidate view"}
                        radius={6}
                      />
                    </div>
                    <p className="fy-mono">
                      {take.model} · {take.references.length > 0 ? "anchored to the establishing view" : "unanchored"}
                    </p>
                    <label className="fy-locref__namefield">
                      <span>Name this view</span>
                      <input
                        type="text"
                        value={name}
                        maxLength={80}
                        placeholder={establishing ? "Establishing view" : "Reverse angle"}
                        onChange={(event) =>
                          setNaming({
                            takeId: take.id,
                            name: event.target.value,
                            confirmReplace: false,
                            asEstablishing: active?.asEstablishing ?? false,
                          })
                        }
                      />
                    </label>
                    {clash && !active?.confirmReplace && (
                      <Callout tone="warning" title={`Replace “${name.trim()}”?`}>
                        <p>
                          This location already has an active view by that name. Accepting replaces it: the old one
                          becomes superseded, keeps its place in history, and leaves the panel order unchanged.
                        </p>
                        <Button
                          variant="secondary"
                          onClick={() =>
                            setNaming({
                              takeId: take.id,
                              name,
                              confirmReplace: true,
                              asEstablishing: active?.asEstablishing ?? false,
                            })
                          }
                        >
                          Replace it
                        </Button>
                      </Callout>
                    )}
                    {!establishing && (
                      // Offered rather than inferred. A replacement for panel 1 is usually named
                      // the same thing as the view it replaces, and a screen that read the name
                      // to decide would silently promote an angle that merely shared a word.
                      <label className="fy-locref__establishing">
                        <input
                          type="checkbox"
                          checked={active?.asEstablishing ?? false}
                          onChange={(event) =>
                            setNaming({
                              takeId: take.id,
                              name,
                              confirmReplace: active?.confirmReplace ?? false,
                              asEstablishing: event.target.checked,
                            })
                          }
                        />
                        <span>Make this the establishing view — it moves to panel 1</span>
                      </label>
                    )}
                    <div className="fy-locref__candidateactions">
                      <Button
                        variant="primary"
                        disabled={name.trim() === "" || (clash && !active?.confirmReplace) || (full && !clash)}
                        title={
                          full && !clash
                            ? `${MAX_ACTIVE_LOCATION_VIEWS} active views is the ceiling — replace one by name instead`
                            : undefined
                        }
                        onClick={() => {
                          acceptLocationView(worldId, sheetId, take.id, {
                            name: name.trim(),
                            ...(establishing || active?.asEstablishing ? { establishing: true } : {}),
                            ...(clash ? { replaceExistingName: true } : {}),
                          });
                          setNaming(null);
                        }}
                      >
                        Accept
                      </Button>
                      <Button variant="ghost" onClick={() => rejectReferenceTake(worldId, take.id, "environment")}>
                        Reject
                      </Button>
                    </div>
                    <p className="fy-locref__note">
                      Accepting rebuilds the location sheet. Rejecting records the decision and changes nothing else —
                      the take is kept either way.
                    </p>
                  </div>
                );
              })}
            </section>
          )}

          {full && (
            <Callout tone="warning" title={`${MAX_ACTIVE_LOCATION_VIEWS} active views`}>
              <p>
                One place, {MAX_ACTIVE_LOCATION_VIEWS} angles — past that a sheet stops being read as one room. Replace
                a view by name rather than adding a seventh.
              </p>
            </Callout>
          )}

          {/* The form is the standard dialog now (design 66) — the page keeps the candidates and
              the naming that accepts them, so the offer is still answered in one place. */}
          <div className="fy-locref__add">
            <Button ref={addRef} disabled={full} onClick={() => setAdding(true)}>
              {establishing ? "Generate" : "Add a view"}
            </Button>
            <Button
              variant="ghost"
              disabled={!canUpload || uploading || full}
              title={canUpload ? "Use an image from this computer — nothing is generated" : UPLOAD_UNAVAILABLE}
              onClick={() => importLocationViewCandidate(worldId, sheetId)}
            >
              {uploading ? "Uploading…" : "Upload"}
            </Button>
            {!establishing && <span className="fy-locref__note">anchored to the establishing view</span>}
          </div>
          <GenerationDialog
            open={adding}
            onClose={() => {
              setAdding(false);
              setReplacingEstablishing(false);
            }}
            returnFocus={addRef}
            title={establishing || replacingEstablishing ? "Generate the establishing view" : "Add a view"}
            lede={
              establishing || replacingEstablishing
                ? `${sheet.name} · the view every later angle is generated against`
                : `${sheet.name} · anchored to the establishing view, so it stays the same room`
            }
            promptLabel="Where is the camera?"
            prompt={angle}
            onPrompt={setAngle}
            promptPlaceholder="from the seaward stair looking back"
            // Optional, and genuinely so: the brief is composed from the sheet, its look and this
            // angle's name. This box only adds a camera position to it.
            promptOptional
            promptHint="Optional. The place, its look and the angle's name are sent whether or not you write here."
            worldSlug={world.meta.slug}
            extra={
              <label className="fy-locref__namefield">
                <span>What is this angle called?</span>
                <input
                  type="text"
                  value={angleName}
                  maxLength={80}
                  placeholder={establishing ? "Establishing view" : "Reverse angle"}
                  onChange={(event) => setAngleName(event.target.value)}
                />
              </label>
            }
            workflow="location-view"
            referenceImages={establishing || replacingEstablishing ? 0 : 1}
            count={count}
            onCount={setCount}
            choice={choice}
            onChoice={setChoice}
            submitLabel="Generate"
            submitDisabled={angleName.trim() === ""}
            {...(angleName.trim() === ""
              ? { why: "An angle needs a name — it is what the view is called once you accept it." }
              : {})}
            onSubmit={() => {
              generateLocationView(
                worldId,
                sheetId,
                {
                  name: angleName.trim(),
                  ...(angle.trim() ? { prompt: angle.trim() } : {}),
                  count,
                  ...(establishing || replacingEstablishing ? { establishing: true } : {}),
                },
                { ...(choice.modelId ? { modelId: choice.modelId } : {}), ...(choice.tier ? { tier: choice.tier } : {}) },
              );
              setAdding(false);
              setReplacingEstablishing(false);
              setAngle("");
              setAngleName("");
            }}
          />

          {upload?.status === "failed" && (
            <p className="fy-locref__note fy-locref__note--warn">{upload.reason ?? "The view was not added."}</p>
          )}
        </section>

        <section className={cx("fy-locref__sheet", !sheetFile && "fy-locref__sheet--empty")}>
          <div className="fy-locref__sechead">
            <h2>Location sheet</h2>
            <span className="fy-mono">assembled here, not generated</span>
          </div>
          {sheetFile ? (
            <>
              <ImageDialog
                worldSlug={world.meta.slug}
                path={`references/${sheetId}/${sheetFile}`}
                label={`${sheet.name} location sheet`}
                title={sheet.name}
                subtitle="location sheet"
                triggerLabel={`View larger location sheet for ${sheet.name}`}
                closeLabel="Close location sheet"
                triggerClassName="fy-locref__sheetimage"
                triggerRadius={6}
              />
              <p className="fy-mono">{sheetFile} · rebuilt on every acceptance</p>
              {/* The same function dispatch composes the preamble from, so what this promises and
                  what a request states cannot drift into disagreeing. */}
              <div className="fy-locref__carries">
                <span className="fy-mono">WHAT A SHOT CARRIES</span>
                <p>{panelMapPhrase(views.map((view) => view.name))}</p>
              </div>
            </>
          ) : (
            <p className="fy-locref__note">
              Accept a second view — a reverse angle, a day pass — and Arke assembles them into one location sheet.
              That sheet is what a shot carries, so the model sees the room from more than one side.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
