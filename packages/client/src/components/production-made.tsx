import { useEffect, useRef, useState } from "react";
import { DRAMA_DELIVERY_LABEL, type DomainEvent, type ProductionBundle } from "@arke-studio/contracts";
import {
  listDramaEditions,
  listStoryPublications,
  listWebPackages,
  openExportsFolder,
  subscribeDramaEditions,
  subscribeStoryPublications,
  subscribeWebPackages,
  useConnection,
  useExports,
} from "../lib/store.js";
import { downloadMedia } from "../lib/download.js";
import { dramaEditionMediaUrl } from "../lib/media.js";
import { megabytes } from "./audiobook-video.js";
import { Copy, Folder } from "./icons.js";
import { StoryEditionSave } from "./story-publish.js";
import { Button } from "./ui.js";

/** One file this production has made (design turn 276 rule 7, 276a). */
export interface MadeRow {
  key: string;
  kind: string;
  what: string;
  data: string;
  at: string;
  bytes?: number;
  sha256?: string;
  /** In the world's exports, where Show opens it; story and drama editions are kept elsewhere. */
  inExports: boolean;
  /** One file in the world's exports, which a paired phone downloads where the desktop shows it. */
  file?: string;
  /**
   * An edition's files, saved from here as its own list offered them: Made replaced the Publish
   * sheet's editions and the audio drama's Editions (turn 276 rule 7).
   */
  story?: StoryEdition;
  drama?: DramaEdition;
  /** An export that failed, said where it would have been listed; it is not counted as made. */
  failed?: true;
}

/** How many a production has made: a failure is listed, not counted. */
export const madeCount = (rows: readonly MadeRow[]) => rows.filter((row) => row.failed !== true).length;

type Listed = Extract<DomainEvent, { type: "web-packages.listed" }>["packages"][number];
type StoryEdition = Extract<DomainEvent, { type: "story.editions" }>["editions"][number];
type DramaEdition = Extract<DomainEvent, { type: "drama.editions" }>["editions"][number];

const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** When an export began, from its id's ULID: `ms_…` and `vb_…` carry no other date. */
export function ulidTime(id: string): string | null {
  const ulid = id.slice(id.indexOf("_") + 1, id.indexOf("_") + 11).toUpperCase();
  if (ulid.length !== 10) return null;
  let ms = 0;
  for (const char of ulid) {
    const value = ULID.indexOf(char);
    if (value < 0) return null;
    ms = ms * 32 + value;
  }
  return new Date(ms).toISOString();
}

const PACKAGE_KIND: Record<Listed["kind"], [string, string]> = {
  "arke-player": ["Arke Player", "Package"],
  interactive: ["Web package", "Interactive"],
  "visual-novel": ["Web package", "Visual novel"],
  audiobook: ["Audiobook", "Player"],
  "audiobook-chapters": ["Audiobook", "Chapter files"],
  "audiobook-video": ["Audiobook", "Video"],
  comic: ["Comic files", "File"],
};

/**
 * Everything this production has made, newest first, in one list (turn 276 rule 7): its packages,
 * its finished exports, its story and drama editions. Each is listed as the coordinator already keeps
 * it, asked for as the sheets ask; the list is the same whichever sheet made the file.
 */
export function useProductionMade(worldId: string, production: ProductionBundle, sheetOpen: boolean): MadeRow[] | null {
  const connection = useConnection();
  const exports = useExports();
  const productionId = production.meta.id;
  const [packages, setPackages] = useState<Listed[] | null>(null);
  const [stories, setStories] = useState<StoryEdition[]>([]);
  const [dramas, setDramas] = useState<DramaEdition[]>([]);
  const asked = useRef<{ drama: string | null }>({ drama: null });
  useEffect(() => {
    const offPackages = subscribeWebPackages((answer) => { if (answer.worldId === worldId) setPackages(answer.packages); });
    const offStories = subscribeStoryPublications((answer) => { if (answer.type === "story.editions") setStories(answer.editions); });
    const offDramas = subscribeDramaEditions((answer) => { if (answer.requestId === asked.current.drama) setDramas(answer.editions); });
    return () => { offPackages(); offStories(); offDramas(); };
  }, [worldId]);
  // Listed again as a sheet closes: the coordinator lists only when asked, and a sheet's export
  // answers that sheet alone.
  useEffect(() => {
    if (connection !== "open" || sheetOpen) return;
    listWebPackages(worldId);
    listStoryPublications();
    asked.current.drama = listDramaEditions(worldId, productionId);
  }, [connection, worldId, productionId, sheetOpen]);
  if (packages === null) return null;
  const rows: MadeRow[] = [];
  for (const entry of packages.filter((candidate) => candidate.productionId === productionId)) {
    const [kind, what] = PACKAGE_KIND[entry.kind];
    const part = entry.kind === "arke-player" ? entry.release?.part?.number : undefined;
    // A comic file says its format and its name, as a manuscript does.
    const comic = entry.kind === "comic";
    rows.push({ key: entry.dir, kind, what: comic ? entry.holds ?? what : part !== undefined ? `Part ${part}` : what, data: comic ? entry.dir.split("/").pop() ?? "" : entry.holds ?? "", at: entry.exportedAt, ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}), ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}), inExports: true,
      // A package or a comic is one file to download; a folder's listed file, a chapter export's
      // manifest.json among them, is not served (codex on PR 2987).
      ...(entry.file !== undefined && (entry.kind === "arke-player" || entry.kind === "comic") ? { file: entry.file } : {}) });
  }
  // A manuscript or a film finished by the coordinator; the packages above already list the rest.
  for (const [id, entry] of Object.entries(exports)) {
    // The export state is the session's, kept across worlds: this world's and this production's alone.
    if (entry.worldId !== worldId || entry.productionId !== productionId) continue;
    if (entry.deliveryKind !== "manuscript" && entry.deliveryKind !== "video") continue;
    const kind = entry.deliveryKind === "manuscript" ? "Manuscript" : "Film";
    // A failure says why where the file would have been: the sheets' Delivered rows said so, and
    // Activity lists only what is running (codex on PR 2987).
    if (entry.status === "failed") {
      rows.push({ key: id, kind, what: "Failed", data: entry.error ?? "", at: ulidTime(id) ?? "", inExports: false, failed: true });
      continue;
    }
    if (entry.status !== "done" || !entry.output) continue;
    const file = entry.output.split("/").pop() ?? entry.output;
    rows.push({ key: id, kind, what: entry.deliveryKind === "manuscript" ? (file.endsWith(".epub") ? "EPUB" : "Word") : entry.label ?? "Film", data: file, at: ulidTime(id) ?? "", inExports: true, file: entry.output });
  }
  for (const edition of stories.filter((candidate) => candidate.worldId === worldId && candidate.productionId === productionId && candidate.status === "ready")) {
    rows.push({ key: edition.id, kind: "Edition", what: edition.settings.label, data: edition.files.map((file) => file.format.toUpperCase()).join(" · "), at: edition.createdAt, bytes: edition.files.reduce((sum, file) => sum + file.bytes, 0), inExports: false, story: edition });
  }
  for (const edition of dramas.filter((candidate) => candidate.productionId === productionId)) {
    rows.push({ key: edition.id, kind: "Edition", what: edition.name, data: `${DRAMA_DELIVERY_LABEL[edition.delivery]} · ${edition.episodes.length} episode${edition.episodes.length === 1 ? "" : "s"}`, at: edition.createdAt, inExports: false, drama: edition });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

const day = (at: string) => (at === "" ? "" : new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }));

/** A season's stems are many files (issue 1882): kept under one line, each by its lane. */
const stemNames = (edition: DramaEdition) => new Map(edition.episodes.flatMap((episode) => (episode.stems ?? []).map((stem) => [stem.file, `Episode ${episode.episode} · ${stem.track}`] as const)));

/** A drama edition's files to download, as the drama's Editions offered them (230q, R-76). */
function DramaEditionFiles({ edition }: { edition: DramaEdition }) {
  const stems = stemNames(edition);
  return (
    <div className="fy-publish-made__files">
      {edition.files.filter((file) => !stems.has(file.name)).map((file) => <a key={file.name} className="fy-linkbtn" href={dramaEditionMediaUrl(edition.id, file.name)} download={`${edition.name} - ${file.name}`}>{file.name}</a>)}
      {stems.size > 0 && (
        <details className="fy-ad-show__stems">
          <summary>Stems · {stems.size}</summary>
          {[...stems].map(([file, label]) => <a key={file} className="fy-linkbtn" href={dramaEditionMediaUrl(edition.id, file)} download={`${edition.name} - ${file}`}>{label}</a>)}
        </details>
      )}
    </div>
  );
}

/**
 * The Made list (276a): kind, what it is, the date and the size; a package's SHA-256, and Show. An
 * edition's files are saved from its row, and away from the desktop app a file in the exports
 * downloads.
 */
export function ProductionMade({ worldId, worldSlug, rows }: { worldId: string; worldSlug: string; rows: MadeRow[] | null }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Only the desktop app opens a folder (SPEC-012 R-51), as Export manuscript said: a browser, a
  // paired phone among them, downloads the file instead.
  const hosted = typeof window !== "undefined" && window.arke?.openDataFolder !== undefined;
  const download = async (file: string) => {
    setNote(null);
    const outcome = await downloadMedia(worldSlug, file, file.split("/").pop() ?? null, "file");
    if (!outcome.ok && !outcome.cancelled) setNote(outcome.reason);
  };
  return (
    <section className="fy-publish-made" aria-label="Made">
      <div className="fy-publish-made__head"><h2>Made</h2>{rows !== null && madeCount(rows) > 0 && <span className="fy-h1row__meta">{madeCount(rows)}</span>}</div>
      {rows === null ? <p className="fy-publish-made__empty" aria-busy="true">…</p> : rows.length === 0 ? <p className="fy-publish-made__empty">Nothing made yet.</p> : (
        <div className="fy-publish-made__rows">
          {rows.map((row) => (
            <div key={row.key} className="fy-publish-made__row" data-testid="made-row">
              <b className="fy-publish-made__kind">{row.kind}</b>
              <div className="fy-publish-made__what">
                <span>{row.what}</span>{row.data !== "" && <i>{row.data}</i>}
                {row.story !== undefined && <div className="fy-publish-made__files">{row.story.files.map((file) => <StoryEditionSave key={file.name} edition={row.story!} file={file} onSaved={setNote} className="fy-linkbtn" />)}</div>}
                {row.drama !== undefined && <DramaEditionFiles edition={row.drama} />}
              </div>
              <span className="fy-publish-made__m">{day(row.at)}</span>
              <span className="fy-publish-made__m fy-publish-made__size">{row.bytes === undefined ? "" : megabytes(row.bytes)}</span>
              {/* A phone's row says the date and size on one line under what it is (276h). */}
              <span className="fy-publish-made__line">{[day(row.at), row.bytes === undefined ? "" : megabytes(row.bytes)].filter(Boolean).join(" · ")}</span>
              <span className="fy-publish-made__acts">
                {row.sha256 !== undefined && <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(row.sha256!).then(() => setCopied(row.key))}><Copy size={13} />{copied === row.key ? "Copied" : "SHA-256"}</Button>}
                {row.inExports && hosted && <Button size="sm" variant="ghost" onClick={() => openExportsFolder(worldId)}><Folder size={13} />Show</Button>}
                {row.file !== undefined && !hosted && <Button size="sm" variant="ghost" onClick={() => void download(row.file!)}>Download</Button>}
              </span>
            </div>
          ))}
        </div>
      )}
      {note !== null && <p className="fy-publish-made__note" role="status">{note}</p>}
    </section>
  );
}
