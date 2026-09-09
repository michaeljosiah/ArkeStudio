import { useRef, useState } from "react";
import { useParams } from "react-router";
import { formatSeconds, isGeneratedArtifact, orderedShots, type ArtifactSidecar } from "@arke-studio/contracts";
import { EmptyState, Screen } from "../components/layout.js";
import { Badge, Button, Callout, cx } from "../components/ui.js";
import { Plus } from "../components/icons.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { Portrait } from "../components/portrait.js";
import { ClipPlayButton } from "../components/player.js";
import { ArtifactViewer } from "../components/artifact-viewer.js";
import { useProduction } from "../lib/selectors.js";
import { generatedOriginLabel } from "../lib/format.js";
import { mediaUrl } from "../lib/media.js";
import {
  artifactDisplayName,
  artifactOpenLabel,
  artifactUses,
  artifactsForProduction,
} from "../lib/artifact-view.js";
import {
  extractArtifact,
  fileArtifactMsg,
  restoreArtifact,
  retireArtifact,
  uploadArtifacts,
  useArtifactNotices,
  useImportReport,
} from "../lib/store.js";
import { Wave } from "./production.js";

/**
 * A production's artifacts (design 134, SPEC-020 R-13).
 *
 * The rail said `Artifacts` and the press left the production: it addressed the world's shelf,
 * which is the one surface guaranteed *not* to hold this production's own files, and the count
 * beside the row was the world's number. This page is the destination that row should always
 * have had — the set every picker and the Cut's Library already work from, on a screen.
 *
 * **One grid, and ownership is a word on the card.** The world's shelf and this production's own
 * are ordered together rather than banded apart, because they are one set to the person choosing
 * a file. What differs is stated where it matters: a file this production owns leads its meta
 * line with `only here`, and three chips lens the set.
 *
 * **What changes the world happens on the world's shelf.** `Remove`, `Restore` and `Lift facts`
 * are offered on what this production owns and on nothing else. That is not tidiness — it is
 * what keeps R-12 true without a caveat on the page: a production-scoped document lifts guests
 * and never canon, so a world document must not be lifted from inside a production.
 */
export function ProductionArtifactsScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const report = useImportReport();
  const notices = useArtifactNotices();
  const [dropActive, setDropActive] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** All / owned / world, plus the retired lens, which only ever shows what this page can restore. */
  const [scope, setScope] = useState<"all" | "owned" | "world" | "retired">("all");
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [madeHereOnly, setMadeHereOnly] = useState(false);
  /*
   * Which artifact is open, by id (issue 477): the sidecar is looked up in the live snapshot
   * every render, so a filing or a supersede moves the frame's contents or closes it. Local
   * state rather than a route, so opening one does not drop the filters or the scroll position.
   */
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const [retireId, setRetireId] = useState<string | null>(null);
  const openTrigger = useRef<HTMLButtonElement | null>(null);

  if (!world || !production) {
    return (
      <Screen id="production-artifacts">
        <EmptyState title="Opening the artifacts…" />
      </Screen>
    );
  }

  const productionId = production.meta.id;
  const owns = (a: ArtifactSidecar) => a.production === productionId;
  const scoped = artifactsForProduction(world.artifacts, productionId);
  const live = scoped.filter((a) => a.retiredAt === undefined);
  // Superseded artifacts drop out of the listing the way they drop out of pickers (R-5).
  const superseded = new Set(scoped.map((a) => a.supersedes).filter((s): s is string => s !== undefined));
  const shelf = live.filter((a) => !superseded.has(a.id));
  // Only what this page could have removed: retirement is offered on owned files alone, so a
  // Retired lens over the world's would list files this screen cannot restore.
  const retired = scoped.filter((a) => a.retiredAt !== undefined && owns(a));
  const ownedCount = shelf.filter(owns).length;
  const madeHere = (a: ArtifactSidecar) => isGeneratedArtifact(a);
  const madeHereCount = shelf.filter(madeHere).length;

  const inScope = scope === "retired" ? retired : shelf.filter(
    (a) => scope === "all" || (scope === "owned" ? owns(a) : !owns(a)),
  );
  const kinds = [...new Set(inScope.map((a) => a.kind))];
  const visible = inScope.filter(
    (a) => (kindFilter === null || a.kind === kindFilter) && (!madeHereOnly || madeHere(a)),
  );

  const upload = (files?: readonly File[]) => {
    // Scoped, at both entrances. This page shows what the production owns, so what it takes is
    // the production's; filing to the world is done on the world's own shelf.
    if (worldId) setUploadError(uploadArtifacts(worldId, files, productionId).reason ?? null);
  };
  const retiringArtifact = scoped.find((a) => a.id === retireId) ?? null;
  const uses = retiringArtifact ? artifactUses(world, retiringArtifact) : [];
  const closeRetirement = () => {
    setRetireId(null);
    openTrigger.current?.focus();
  };

  /** Resolve names from this world's records; unknown links retain their spelling. */
  const linkName = (link: string, links: readonly string[] = []): string => {
    const name = world.sheets.find((s) => s.id === link)?.name ?? world.canon.find((c) => c.id === link)?.title;
    if (name) return name;
    const owning = world.productions.filter((p) => links.includes(p.meta.id));
    const names: string[] = [];
    for (const candidate of owning.length ? owning : world.productions) {
      if (candidate.meta.id === link) return candidate.meta.title;
      const episode = candidate.episodes.find((e) => e.id === link);
      if (episode) names.push(episode.title);
      for (const scene of candidate.scenes) {
        if (scene.id === link) names.push(scene.title);
        const shot = orderedShots(scene).find((s) => s.id === link);
        if (shot) names.push(`Shot ${shot.number} · ${shot.title}`);
      }
    }
    return names.length === 1 ? names[0]! : link;
  };

  const kindLabel: Record<string, string> = {
    image: "Images",
    board: "Boards",
    audio: "Audio",
    video: "Video",
    document: "Documents",
  };
  const chip = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      type="button"
      className={cx("fy-filterchip", active && "fy-filterchip--active")}
      onClick={onClick}
    >
      {label}
    </button>
  );
  const lens = (next: typeof scope) => () => {
    setScope(next);
    setKindFilter(null);
    if (next === "retired") setMadeHereOnly(false);
  };

  return (
    <div className="fy-prodscroll" data-screen="production-artifacts">
      {/* No Generate door (design 134): a production reaches the bench through its own Generate,
          which answers to shots. Outside any animated ancestor, as the world's shelf places it —
          a transformed ancestor would quietly become this control's containing block. */}
      <div className="fy-artifacts-door">
        <Button variant="outline" data-testid="production-artifacts-add" onClick={() => upload()}>
          Add files
        </Button>
      </div>
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">
          {production.meta.title} · {shelf.length} file{shelf.length === 1 ? "" : "s"}
          {` · ${ownedCount} only here`}
          {madeHereCount > 0 ? ` · ${madeHereCount} made here` : ""}
        </div>
        <h1 className="fy-hero__title" style={{ fontSize: 52 }}>
          Artifacts
        </h1>
        <div className="fy-filterrow">
          {chip(`All ${shelf.length}`, scope === "all" && kindFilter === null, lens("all"))}
          {chip(`Only here ${ownedCount}`, scope === "owned", lens("owned"))}
          {chip(`From the world ${shelf.length - ownedCount}`, scope === "world", lens("world"))}
          {retired.length > 0 && chip(`Retired ${retired.length}`, scope === "retired", lens("retired"))}
          {kinds.map((k) =>
            chip(
              `${kindLabel[k] ?? k.charAt(0).toUpperCase() + k.slice(1)} ${inScope.filter((a) => a.kind === k).length}`,
              kindFilter === k,
              () => setKindFilter(kindFilter === k ? null : k),
            ),
          )}
          {madeHereCount > 0 &&
            scope !== "retired" &&
            chip(`Made here ${madeHereCount}`, madeHereOnly, () => setMadeHereOnly((v) => !v))}
        </div>
      </div>
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "12px 24px 0", display: "grid", gap: 10 }}>
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
                {/* The scope is repeated, not inherited. Filing a large file from here is still
                    filing into this production, and silence on the dedup path would leave it at
                    world scope — the mirror of the world shelf's `production: null`. */}
                <Button
                  onClick={() =>
                    fileArtifactMsg(worldId, n.sourcePath, { allowLarge: true, production: productionId })
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
                {report.excluded.slice(0, 5).map((e) => `${e.name} (${e.reason})`).join(", ")}
                {report.excluded.length > 5 ? "…" : ""} — reported, never silent.
              </span>
            )}
          </Callout>
        )}
      </div>
      <div
        className="fy-cardgrid"
        style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", paddingTop: 24 }}
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
        {visible.map((a) => {
          const filename = a.file.split("/").pop() ?? a.file;
          const name = artifactDisplayName(a, linkName);
          const isImage = a.kind === "image" || /\.(png|jpe?g|webp|gif)$/i.test(a.file);
          const mine = owns(a);
          // One line, the shelf's vocabulary (68a), with ownership at the front of it (134):
          // only here · type · made here · duration · linked.
          const meta = [
            filename.includes(".") ? filename.split(".").pop() : a.kind,
            ...(madeHere(a) ? [generatedOriginLabel(a)] : []),
            ...(a.mediaInfo?.durationSec !== undefined ? [formatSeconds(a.mediaInfo.durationSec)] : []),
            ...(a.links.length > 0
              ? [`linked: ${a.links.slice(0, 2).map((link) => linkName(link, a.links)).join(", ")}`]
              : []),
          ].join(" · ");
          return (
            <div
              key={a.id}
              className="fy-gridcard fy-gridcard--openable"
              style={{ padding: isImage ? "10px 10px 14px" : 16, opacity: a.retiredAt ? 0.65 : 1 }}
            >
              {/* One real <button> laid over the card, never a <button> around it: the play
                  control and "Lift facts" live inside, and a button within a button is markup
                  the browser resolves by dropping one of the two. */}
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
              {mine &&
                (a.retiredAt ? (
                  <button
                    type="button"
                    className="fy-artifact-retire"
                    aria-label={`Restore ${name}`}
                    onClick={() => { if (worldId) restoreArtifact(worldId, a.id); }}
                  >
                    Restore
                  </button>
                ) : (
                  <button
                    type="button"
                    className="fy-artifact-retire"
                    aria-label={`Remove ${name} from ${production.meta.title}`}
                    onClick={(event) => {
                      openTrigger.current = event.currentTarget;
                      setRetireId(a.id);
                    }}
                  >
                    Remove
                  </button>
                ))}
              {isImage ? (
                <div className="fy-imghost" style={{ width: "100%", height: 110 }}>
                  <Portrait
                    worldSlug={world.meta.slug}
                    path={`artifacts/${a.file}`}
                    label={name}
                    download
                    downloadName={filename}
                  />
                </div>
              ) : a.kind === "audio" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <ClipPlayButton
                    small
                    clip={{
                      id: `artifact:${a.id}`,
                      url: mediaUrl(world.meta.slug, `artifacts/${a.file}`),
                      title: name,
                      sub: `artifact · ${a.file}`,
                    }}
                  />
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
                <div className="fy-mono">
                  {mine && <span className="fy-artifact-scope">only here</span>}
                  {mine && " · "}
                  {meta}
                </div>
                {a.retiredAt && <Badge tone="danger">retired</Badge>}
                {/* Lifting is scoped by the artifact's own ownership (R-12): a guest comes out of
                    a production's document, and the world's documents are lifted where they live. */}
                {mine && a.kind === "document" && a.retiredAt === undefined && (
                  <button
                    type="button"
                    className="fy-liftfacts"
                    onClick={() => { if (worldId) extractArtifact(worldId, a.id); }}
                  >
                    Lift facts
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {/* A cell of the same grid, filling out the last row (68a) — never its own band. Absent
            under the world lens and the retired one: there is nothing this page can add there. */}
        {(scope === "all" || scope === "owned") && (
          <button
            type="button"
            aria-label={`Add files to ${production.meta.title}`}
            onClick={() => upload()}
            className="fy-gridcard fy-gridcard--quiet"
            style={{
              gridColumn: "span 2",
              border: `1.5px dashed ${dropActive ? "var(--foreground)" : "var(--neutral-300)"}`,
              background: dropActive ? "var(--muted)" : "transparent",
              color: "inherit",
              cursor: "pointer",
              textAlign: "left",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              minHeight: 176,
            }}
          >
            <span className="fy-newprodcard__ring" style={{ width: 40, height: 40 }}>
              <Plus size={18} />
            </span>
            <div>
              <div style={{ font: "600 14px var(--font-sans)" }}>
                {dropActive ? "Drop to add files" : "Drop files or click to add"}
              </div>
              {/* One string, not an interpolation between two text nodes: the scope is the whole
                  of what this line says, and SSR splits a mixed line with comment markers. */}
              <div style={{ font: "400 10.5px var(--font-mono)", color: "var(--muted-foreground)", marginTop: 4 }}>
                {`only in ${production.meta.title} · up to 16 at a time`}
              </div>
            </div>
          </button>
        )}
        {visible.length === 0 && (
          <EmptyState
            title={
              scope === "retired"
                ? "Nothing retired here"
                : scope === "owned"
                ? "Nothing filed here yet"
                : "Nothing on the world's shelf"
            }
            hint={
              scope === "world"
                ? "Files on the world's shelf are shared by every production."
                : "Recordings, documents, boards and images filed here belong to this production alone."
            }
          />
        )}
      </div>
      <ArtifactViewer
        artifact={visible.find((a) => a.id === openArtifactId) ?? null}
        artifacts={scoped}
        worldSlug={world.meta.slug}
        linkName={linkName}
        onRetire={
          retiringOffered(visible, openArtifactId, owns)
            ? (artifactId) => { setOpenArtifactId(null); setRetireId(artifactId); }
            : undefined
        }
        onClose={() => {
          setOpenArtifactId(null);
          // A dialog that dropped focus leaves the keyboard at the top of the document.
          if (retireId === null) openTrigger.current?.focus();
        }}
      />
      <EditorDialog
        open={retiringArtifact !== null}
        title={`Remove from ${production.meta.title}?`}
        subtitle={retiringArtifact?.file}
        onClose={closeRetirement}
      >
        <p>
          This retires the artifact from this production's shelf and its file pickers. Its file and
          provenance stay in the world; existing clips, references and exports keep working. No disk
          space is freed.
        </p>
        <p>Retired items stay behind the Retired filter, where you can restore them.</p>
        <p>{uses.length ? "Current uses — kept intact:" : "No current uses found in the loaded world records. History is kept."}</p>
        {uses.length > 0 && <ul style={{ maxHeight: 200, overflowY: "auto" }}>{uses.map((use) => <li key={use}>{use}</li>)}</ul>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="outline" onClick={closeRetirement}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              if (worldId && retiringArtifact) retireArtifact(worldId, retiringArtifact.id);
              setRetireId(null);
            }}
          >
            Remove
          </Button>
        </div>
      </EditorDialog>
    </div>
  );
}

/** The viewer offers removal exactly where a card does: on a live file this production owns. */
function retiringOffered(
  visible: readonly ArtifactSidecar[],
  openArtifactId: string | null,
  owns: (a: ArtifactSidecar) => boolean,
): boolean {
  const open = visible.find((a) => a.id === openArtifactId);
  return open !== undefined && open.retiredAt === undefined && owns(open);
}
