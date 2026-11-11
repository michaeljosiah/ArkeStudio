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
import { megabytes } from "./audiobook-video.js";
import { Copy, Folder } from "./icons.js";
import { Button } from "./ui.js";

/** One file this production has made (design turn 276 rule 6, 276a). */
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
}

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
};

/**
 * Everything this production has made, newest first, in one list (turn 276 rule 6): its packages,
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
    rows.push({ key: entry.dir, kind, what: part !== undefined ? `Part ${part}` : what, data: entry.holds ?? "", at: entry.exportedAt, ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}), ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}), inExports: true });
  }
  // A manuscript or a film finished by the coordinator; the packages above already list the rest.
  for (const [id, entry] of Object.entries(exports)) {
    // The export state is the session's, kept across worlds: this world's and this production's alone.
    if (entry.worldId !== worldId || entry.productionId !== productionId || entry.status !== "done" || !entry.output) continue;
    if (entry.deliveryKind !== "manuscript" && entry.deliveryKind !== "video") continue;
    const file = entry.output.split("/").pop() ?? entry.output;
    rows.push({ key: id, kind: entry.deliveryKind === "manuscript" ? "Manuscript" : "Film", what: entry.deliveryKind === "manuscript" ? (file.endsWith(".epub") ? "EPUB" : "Word") : entry.label ?? "Film", data: file, at: ulidTime(id) ?? "", inExports: true });
  }
  for (const edition of stories.filter((candidate) => candidate.worldId === worldId && candidate.productionId === productionId && candidate.status === "ready")) {
    rows.push({ key: edition.id, kind: "Edition", what: edition.settings.label, data: edition.files.map((file) => file.format.toUpperCase()).join(" · "), at: edition.createdAt, bytes: edition.files.reduce((sum, file) => sum + file.bytes, 0), inExports: false });
  }
  for (const edition of dramas.filter((candidate) => candidate.productionId === productionId)) {
    rows.push({ key: edition.id, kind: "Edition", what: edition.name, data: `${DRAMA_DELIVERY_LABEL[edition.delivery]} · ${edition.episodes.length} episode${edition.episodes.length === 1 ? "" : "s"}`, at: edition.createdAt, inExports: false });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

const day = (at: string) => (at === "" ? "" : new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }));

/** The Made list (276a): kind, what it is, the date and the size; a package's SHA-256, and Show. */
export function ProductionMade({ worldId, rows }: { worldId: string; rows: MadeRow[] | null }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <section className="fy-publish-made" aria-label="Made">
      <div className="fy-publish-made__head"><h2>Made</h2>{rows !== null && rows.length > 0 && <span className="fy-h1row__meta">{rows.length}</span>}</div>
      {rows === null ? <p className="fy-publish-made__empty" aria-busy="true">…</p> : rows.length === 0 ? <p className="fy-publish-made__empty">Nothing made yet.</p> : (
        <div className="fy-publish-made__rows">
          {rows.map((row) => (
            <div key={row.key} className="fy-publish-made__row" data-testid="made-row">
              <b className="fy-publish-made__kind">{row.kind}</b>
              <div className="fy-publish-made__what"><span>{row.what}</span>{row.data !== "" && <i>{row.data}</i>}</div>
              <span className="fy-publish-made__m">{day(row.at)}</span>
              <span className="fy-publish-made__m fy-publish-made__size">{row.bytes === undefined ? "" : megabytes(row.bytes)}</span>
              {/* A phone's row says the date and size on one line under what it is (276h). */}
              <span className="fy-publish-made__line">{[day(row.at), row.bytes === undefined ? "" : megabytes(row.bytes)].filter(Boolean).join(" · ")}</span>
              <span className="fy-publish-made__acts">
                {row.sha256 !== undefined && <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(row.sha256!).then(() => setCopied(row.key))}><Copy size={13} />{copied === row.key ? "Copied" : "SHA-256"}</Button>}
                {row.inExports && <Button size="sm" variant="ghost" onClick={() => openExportsFolder(worldId)}><Folder size={13} />Show</Button>}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
