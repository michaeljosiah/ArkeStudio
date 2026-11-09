// A world's artifacts screen (issue 2816).
import { useParams, useNavigate } from "react-router";
import { useOpenWorldGuard } from "../lib/selectors.js";
import { useCompact, usePhone } from "../lib/media-query.js";
import { useState, useRef } from "react";
import {
  useImportReport, useArtifactNotices, uploadArtifacts, useBench, sendBenchNewSession,
  fileArtifactMsg, restoreArtifact, extractArtifact, retireArtifact,
} from "../lib/store.js";
import {
  artifactUses, linkNameResolver, artifactShelfName, artifactOpenLabel, artifactDisplayName,
} from "../lib/artifact-view.js";
import { isGeneratedArtifact, formatSeconds, artifactPosterPath } from "@arke-studio/contracts";
import { cx, Button, Callout, Badge } from "../components/ui.js";
import { Upload, Plus, Sparkle, More } from "../components/icons.js";
import { Section, EmptyState } from "../components/layout.js";
import { ExtractionReviewCandidates } from "../components/extraction-review.js";
import { generatedOriginLabel } from "../lib/format.js";
import { Portrait } from "../components/portrait.js";
import { ClipPlayButton } from "../components/player.js";
import { mediaUrl } from "../lib/media.js";
import { Wave } from "../components/wave.js";
import { PageSheet } from "../components/page-sheet.js";
import { ArtifactViewer } from "../components/artifact-viewer.js";
import { EditorDialog } from "../components/editor-dialog.js";

// ---- Artifacts -------------------------------------------------------------

export function ArtifactsScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const compact = useCompact();
  const phone = usePhone();
  const [menuId, setMenuId] = useState<string | null>(null);
  // The world's own shelf (SPEC-020 R-13): artifacts a production owns are shown there, and
  // counting them here would make "12 files" a number no filter on this screen can reach.
  const shelfArtifacts = (world?.artifacts ?? []).filter((a) => a.production === undefined);
  const [retiredOnly, setRetiredOnly] = useState(false);
  const retiredCount = shelfArtifacts.filter(a => a.retiredAt !== undefined).length;
  const artifacts = shelfArtifacts.filter(a => (a.retiredAt !== undefined) === retiredOnly);
  const report = useImportReport();
  /*
   * The world's own refusals, not every surface's (Codex round 1).
   *
   * `artifactNotices` is one global list, and a `needs-consent` notice is an offer to retry at a
   * scope — this one retries at the world's. A production's refusal answered here would file its
   * bytes as the world's, which is the escape hatch firing where nobody invoked it. A notice
   * with no scope is a filing that stated no opinion, and the world is what that means.
   */
  const notices = useArtifactNotices().filter((n) => (n.production ?? null) === null);
  const [dropActive, setDropActive] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const upload = (files?: readonly File[]) => {
    if (worldId) setUploadError(uploadArtifacts(worldId, files).reason ?? null);
  };
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  // "Made here" combines with the kind filter rather than replacing it (issue 305 §2).
  const [madeHereOnly, setMadeHereOnly] = useState(false);
  /*
   * Which artifact is open, by id (issue 477).
   *
   * The id rather than the row: the sidecar is looked up in the live snapshot every render, so a
   * filing, a supersede or any other world update moves the frame's contents or closes it, where
   * an index would have quietly re-pointed it at whichever file slid into that position. Local
   * state rather than a route, so opening one does not remount the shelf and drop its filters,
   * its import report and its scroll position.
   */
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const [retireId, setRetireId] = useState<string | null>(null);
  const retiringArtifact = artifacts.find(a => a.id === retireId) ?? null;
  const uses = world && retiringArtifact ? artifactUses(world, retiringArtifact) : [];
  const openTrigger = useRef<HTMLButtonElement | null>(null);
  const closeRetirement = () => {
    setRetireId(null);
    openTrigger.current?.focus();
  };
  // Whatever made it, not the bench alone (issue 475): a character's generated references are
  // filed here too, and the chip that counts what this application made counts those as well.
  const madeHere = (a: (typeof artifacts)[number]) => isGeneratedArtifact(a);
  // Superseded artifacts drop out of the listing the way they drop out of pickers (R-5).
  const superseded = new Set(shelfArtifacts.map((a) => a.supersedes).filter((s): s is string => s !== undefined));
  const visible = artifacts.filter(
    (a) =>
      (retiredOnly || !superseded.has(a.id)) &&
      (kindFilter === null || a.kind === kindFilter) &&
      (!madeHereOnly || madeHere(a)),
  );
  const kinds = [...new Set(artifacts.map((a) => a.kind))];
  const madeHereCount = artifacts.filter((a) => !superseded.has(a.id) && madeHere(a)).length;
  const batches = shelfArtifacts.filter((a) => (a.extraction?.pending.length ?? 0) > 0);
  // Resolve names from this world's existing records; unknown links retain their spelling. The
  // Cut names its rows by the same rule (issue 1005), so the resolver lives beside the display name.
  const linkName = linkNameResolver(world);
  const kindLabel: Record<string, string> = {
    image: "Images",
    board: "Boards",
    audio: "Audio",
    video: "Video",
    document: "Documents",
  };
  const menuArtifact = visible.find(item => item.id === menuId);
  const addFilesCard = (
    <button
      key="add-files"
      type="button"
      aria-label="Add files"
      onClick={() => upload()}
      className={cx("fy-gridcard fy-gridcard--quiet fy-artifact-add", dropActive && "fy-artifact-add--over")}
    >
      <span className="fy-newprodcard__ring" style={{ width: 40, height: 40 }}>
        {compact ? <Upload size={22} /> : <Plus size={18} />}
      </span>
      <div>
        <div style={{ font: "600 14px var(--font-sans)" }}>{compact ? "Add files" : dropActive ? "Drop to add files" : "Drop files or click to add"}</div>
        <div
          style={{ font: "400 10.5px var(--font-mono)", color: "var(--muted-foreground)", marginTop: 4 }}
        >
          up to 16 files · audio · documents · images
        </div>
      </div>
    </button>
  );
  // Turn 164 keeps the picker in the fifth slot; later artifacts continue in shelf order.
  const benchSessionId = useBench()?.session.id;
  const cards = compact ? [...visible.slice(0, 4), null, ...visible.slice(4)] : [...visible, null];
  const doors = (<div className="fy-artifacts-door">
        <Button variant="outline" onClick={() => upload()}>{compact && <Upload size={16} />}Add files</Button>
        <Button
          variant="primary"
          data-testid="artifacts-generate"
          onClick={() => {
            // A new picture starts blank: resuming dropped the author into the last session's brief,
            // a whole comic page's on this run (issue 2480). The last session is on the Bench's own list.
            if (worldId) sendBenchNewSession(worldId);
            void navigate(`/w/${worldId}/artifacts/bench`, { state: { leaving: benchSessionId ?? "" } });
          }}
        >
          {compact && <Sparkle size={16} />}Generate
        </Button>
      </div>);
  return (
    <div data-screen="artifacts">
      {!compact && doors}
      <div className="fy-hero">
        <div className="fy-artifacts-head"><div>
        <div className="fy-hero__eyebrow">
          {world?.meta.name} · {visible.length} file{visible.length === 1 ? "" : "s"}
          {madeHereCount > 0 ? ` · ${madeHereCount} made in Arke` : ""}
          {superseded.size > 0 ? ` · ${superseded.size} superseded — history keeps them` : ""}
        </div>
        <h1 className="fy-hero__title fy-artifacts-title">
          Artifacts
        </h1>
        </div>{compact && doors}</div>
        <div className="fy-filterrow">
          <button
            type="button"
            className={cx("fy-filterchip", !retiredOnly && kindFilter === null && "fy-filterchip--active")}
            onClick={() => { setRetiredOnly(false); setKindFilter(null); }}
          >
            All {shelfArtifacts.filter((a) => a.retiredAt === undefined && !superseded.has(a.id)).length}
          </button>
          <button type="button" className={cx("fy-filterchip", retiredOnly && "fy-filterchip--active")}
            onClick={() => { setRetiredOnly(true); setKindFilter(null); setMadeHereOnly(false); }}>
            Retired {retiredCount}
          </button>
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className={cx("fy-filterchip", kindFilter === k && "fy-filterchip--active")}
              onClick={() => setKindFilter(k)}
            >
              {kindLabel[k] ?? k.charAt(0).toUpperCase() + k.slice(1)}{" "}
              {artifacts.filter((a) => a.kind === k && (retiredOnly || !superseded.has(a.id))).length}
            </button>
          ))}
          {madeHereCount > 0 && (
            <button
              type="button"
              className={cx("fy-filterchip", madeHereOnly && "fy-filterchip--active")}
              onClick={() => setMadeHereOnly((v) => !v)}
            >
              {`Made in Arke ${madeHereCount}`}
            </button>
          )}
        </div>

      </div>
      <div className="fy-artifact-notices">
        {uploadError && <Callout tone="warning" title="Import unavailable">{uploadError}</Callout>}
        {notices.map((n, i) => (
          <Callout
            key={`${n.sourcePath}-${i}`}
            tone="warning"
            title={n.outcome === "needs-consent" ? "Large file" : "Filing refused"}
          >
            {n.reason}
            {n.outcome === "needs-consent" && worldId && (
              <>
                {" "}
                {/* `production: null` is the world saying so out loud. Filing from the world's own
                  shelf is how a production-scoped document is brought back to the world, and on
                  the dedup path silence would leave it scoped (SPEC-020 §2.5). */}
                <Button
                  onClick={() =>
                    fileArtifactMsg(worldId, n.sourcePath, { allowLarge: true, production: null })
                  }
                >
                  Copy it anyway
                </Button>
              </>
            )}
          </Callout>
        ))}
        {report && (
          <Callout
            title={`Imported: ${report.filed.length} filed · ${report.deduplicated.length} already held · ${report.excluded.length} excluded`}
          >
            {report.excluded.length > 0 && (
              <span>
                excluded:{" "}
                {report.excluded
                  .slice(0, 5)
                  .map((e) => `${e.name} (${e.reason})`)
                  .join(", ")}
                {report.excluded.length > 5 ? "…" : ""} — reported, never silent.
              </span>
            )}
            {report.needsConsent.length > 0 && (
              <span>
                {" "}
                {report.needsConsent.length} large file{report.needsConsent.length === 1 ? "" : "s"} await
                consent above.
              </span>
            )}
          </Callout>
        )}
        {batches.map((artifact) => (
          <Section
            key={artifact.id}
            title={`Extracted from ${artifact.file}`}
            aside={
              <span>
                {artifact.extraction!.pending.length} candidate
                {artifact.extraction!.pending.length === 1 ? "" : "s"}
                {artifact.extraction!.droppedCount > 0
                  ? ` · ${artifact.extraction!.droppedCount} dropped — quotes did not verify`
                  : ""}
              </span>
            }
          >
            {worldId && <ExtractionReviewCandidates worldId={worldId} artifact={artifact} />}
          </Section>
        ))}
      </div>
      <div
        className="fy-cardgrid fy-artifact-grid"
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
        }}
        onDrop={(event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          setDropActive(false);
          if (event.dataTransfer.files.length) upload(Array.from(event.dataTransfer.files));
        }}
      >
        {cards.map((a) => {
          if (a === null) return addFilesCard;
          const filename = a.file.split("/").pop() ?? a.file;
          const name = artifactShelfName(a, linkName, world?.benchSessions ?? []);
          const isImage = a.kind === "image" || /\.(png|jpe?g|webp|gif)$/i.test(a.file);
          // One line, the design's vocabulary (68a): type · made here · duration · linked. An
          // uploaded file carries no provenance token — where it came from is not what it is.
          const meta = [
            filename.includes(".") ? filename.split(".").pop() : a.kind,
            ...(madeHere(a) ? [generatedOriginLabel(a)] : []),
            ...(a.mediaInfo?.durationSec !== undefined ? [formatSeconds(a.mediaInfo.durationSec)] : []),
            ...(a.links.length > 0 ? [`linked: ${a.links.slice(0, 2).map((link) => linkName(link, a.links)).join(", ")}`] : []),
          ].join(" · ");
          return (
            <div
              key={a.id}
              className={cx("fy-gridcard fy-gridcard--openable", isImage && "fy-artifact--image")}
              style={{ opacity: a.retiredAt ? 0.65 : 1 }}
            >
              {/*
                * The open target: one real <button> laid over the card, so a pointer and a
                * keyboard reach the same viewer and Enter and Space come from the element rather
                * than from a handler. Never a <button> around the card — the save control, the
                * play control and "Lift facts" live inside it, and a button within a button is
                * markup the browser resolves by dropping one of the two.
                */}
              <button
                type="button"
                className="fy-gridcard__open"
                aria-label={artifactOpenLabel(a, name)}
                title={filename}
                onClick={(event) => {
                  openTrigger.current = event.currentTarget;
                  setOpenArtifactId(a.id);
                }}
              />
              {compact ? <button type="button" className="fy-artifact-more" aria-label={`Options for ${name}`} onClick={() => setMenuId(a.id)}><More size={16} /></button> : a.retiredAt ? (
                <button type="button" className="fy-artifact-retire" aria-label={`Restore ${name}`}
                  onClick={() => { if (worldId) restoreArtifact(worldId, a.id); }}>Restore</button>
              ) : (
                <button type="button" className="fy-artifact-retire" aria-label={`Remove ${name} from shelf`}
                  onClick={(event) => { openTrigger.current = event.currentTarget; setRetireId(a.id); }}>Remove</button>
              )}
              {isImage ? (
                <div className="fy-imghost fy-artifact-frame">
                  <Portrait
                    worldSlug={world?.meta.slug}
                    path={`artifacts/${a.file}`}
                    label={name}
                    download={!compact}
                    downloadName={filename}
                  />
                </div>
              ) : a.kind === "video" ? (
                <div className="fy-imghost fy-artifact-frame">
                  <Portrait worldSlug={world?.meta.slug} path={artifactPosterPath(a.id)} label={name} radius={8} />
                  {a.mediaInfo && <span className="fy-artifact-duration">{formatSeconds(a.mediaInfo.durationSec)}</span>}
                </div>
              ) : a.kind === "audio" ? (
                <div className="fy-artifact-audio fy-artifact-frame">
                  <ClipPlayButton
                    small
                    clip={
                      world
                        ? {
                            id: `artifact:${a.id}`,
                            url: mediaUrl(world.meta.slug, `artifacts/${a.file}`),
                            title: name,
                            sub: `artifact · ${a.file}`,
                          }
                        : null
                    }
                  />
                  <span className="fy-artifact-wave">
                    <Wave seed={a.file} width={compact ? 240 : 120} height={compact ? 26 : 18} stretch={compact} />
                  </span>
                </div>
              ) : (
                <div className="fy-doclines fy-artifact-frame">
                  <span style={{ width: "80%" }} />
                  <span style={{ width: "95%" }} />
                  <span style={{ width: "60%" }} />
                  {compact && <><span style={{ width: "85%" }} /><span style={{ width: "95%" }} /><span style={{ width: "60%" }} /></>}
                </div>
              )}
              <div className="fy-artifact-caption">
                <div className="fy-artifact-name">{name}</div>
                <div className="fy-mono">{meta}</div>
                {a.retiredAt && <Badge tone="danger">retired</Badge>}
                {a.supersedes !== undefined && (
                  <div className="fy-mono">supersedes {a.supersedes.slice(0, 10)}…</div>
                )}
                {!compact && a.kind === "document" && (
                  /* An offer, not a headline — card-meta quiet, or it reads as the card's title. */
                  <button
                    type="button"
                    className="fy-liftfacts"
                    onClick={() => {
                      if (worldId) extractArtifact(worldId, a.id);
                    }}
                  >
                    Lift facts
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {/* A cell of the same grid, filling out the last row (design 68a) — never its own band. */}

        {artifacts.length === 0 && (
          <EmptyState
            title={retiredOnly ? "No retired artifacts" : "Nothing filed yet"}
            hint={phone ? "Add recordings, documents, boards or images to this world." : "Drop recordings, documents, boards or images to file them against the world."}
          />
        )}
      </div>
      <PageSheet open={Boolean(menuArtifact)} title={menuArtifact ? artifactDisplayName(menuArtifact, linkName) : "Artifact"} onClose={() => setMenuId(null)}>
        {menuArtifact && <>
          {menuArtifact.retiredAt ? <Button variant="outline" onClick={() => { if (worldId) restoreArtifact(worldId, menuArtifact.id); setMenuId(null); }}>Restore</Button>
            : <Button variant="outline" onClick={() => { setMenuId(null); setRetireId(menuArtifact.id); }}>Remove from shelf</Button>}
          {menuArtifact.kind === "document" && <Button variant="ghost" onClick={() => { if (worldId) extractArtifact(worldId, menuArtifact.id); setMenuId(null); }}>Lift facts</Button>}
        </>}
      </PageSheet>
      <ArtifactViewer
        artifact={artifacts.find((a) => a.id === openArtifactId) ?? null}
        artifacts={shelfArtifacts}
        visibleArtifacts={visible}
        onNavigate={setOpenArtifactId}
        worldSlug={world?.meta.slug}
        linkName={linkName}
        onRetire={retiredOnly ? undefined : (artifactId) => { setOpenArtifactId(null); setRetireId(artifactId); }}
        onClose={() => {
          setOpenArtifactId(null);
          // A dialog that dropped focus leaves the keyboard at the top of the document.
          if (retireId === null) openTrigger.current?.focus();
        }}
      />
      <EditorDialog open={retiringArtifact !== null} title="Remove from shelf?" subtitle={retiringArtifact?.file}
        onClose={closeRetirement}>
        <p>This retires the artifact from the shelf and file pickers. Its file and provenance stay in the world;
          existing clips, references and exports keep working. No disk space is freed.</p>
        <p>Retired items stay on the shelf behind the Retired filter, where you can restore them.</p>
        <p>{uses.length ? "Current uses — kept intact:" : "No current uses found in the loaded world records. History is kept."}</p>
        {uses.length > 0 && <ul style={{ maxHeight: 200, overflowY: "auto" }}>{uses.map(use => <li key={use}>{use}</li>)}</ul>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="outline" onClick={closeRetirement}>Cancel</Button>
          <Button variant="primary" onClick={() => {
            if (worldId && retiringArtifact) retireArtifact(worldId, retiringArtifact.id);
            setRetireId(null);
          }}>Remove from shelf</Button>
        </div>
      </EditorDialog>
    </div>
  );
}
