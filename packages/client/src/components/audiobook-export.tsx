import { useEffect, useRef, useState } from "react";
import { ulid, type AudiobookListening, type ProductionBundle } from "@arke-studio/contracts";
import {
  exportAudiobookPlayer,
  listWebPackages,
  openAudiobookListening,
  openExportsFolder,
  subscribeAudiobookExported,
  subscribeAudiobookListening,
  subscribeWebPackages,
  useStore,
  type AudiobookExported,
  type WebPackagesListed,
} from "../lib/store.js";
import { bookHasTakes } from "./audiobook-player.js";
import { EditorDialog } from "./editor-dialog.js";
import { Button } from "./ui.js";

/**
 * Export audiobook (design turn 186e, SPEC-047 R-72): the book as the player — `player.html`, the
 * chapters read whole with their audio and their pictures, a web package beside the interactive's
 * and the visual novel's. What it would hold is read from the same listening plan the player
 * plays, so the sheet's counts are the package's.
 *
 * Chapter files (146d) are SPEC-047's own export, not yet built (issue 1336): the sheet offers
 * only what it will make.
 */

/** What a package of this plan would hold: the chapters read whole, of all of them, and each picture once. */
export function packageCounts(listening: AudiobookListening): { chapters: number; of: number; pictures: number } {
  const whole = listening.chapters.filter((chapter) => chapter.state === "read" && chapter.blocks.length > 0);
  const pictures = new Set<string>([...(listening.cover !== null ? [listening.cover] : []), ...whole.flatMap((chapter) => [...chapter.pictures.map((picture) => picture.file), ...(chapter.opening !== null ? [chapter.opening] : [])])]);
  return { chapters: whole.length, of: listening.chapters.length, pictures: pictures.size };
}

const size = (bytes: number) => (bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function AudiobookExportSheet({ worldId, production, onClose }: { worldId: string; production: ProductionBundle; onClose: () => void }) {
  const connection = useStore().connection;
  const asked = useRef<string | null>(null);
  const exporting = useRef<string | null>(null);
  /** The package being made, by its id: found again by listing the packages if a reconnect lost the answer. */
  const making = useRef<string | null>(null);
  const listing = useRef<string | null>(null);
  const [plan, setPlan] = useState<AudiobookListening | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AudiobookExported["result"] | null>(null);
  useEffect(() => {
    const offPlan = subscribeAudiobookListening((answer) => {
      if (answer.requestId === asked.current && answer.listening !== null) setPlan(answer.listening);
    });
    const offExport = subscribeAudiobookExported((answer) => {
      if (answer.requestId !== exporting.current) return;
      exporting.current = null;
      making.current = null;
      setBusy(false);
      setResult(answer.result);
    });
    // A connection dropped mid-export loses the one answer it would have heard (codex on PR 1498):
    // on the way back the packages are listed, and the one with this export's id is the answer.
    const offPackages = subscribeWebPackages((answer) => {
      if (answer.requestId !== listing.current || making.current === null) return;
      const id = making.current;
      const found = answer.packages.find((entry) => entry.dir.endsWith(`-${id}`));
      if (found === undefined) return;
      exporting.current = null;
      making.current = null;
      setBusy(false);
      setResult({ ok: true, id, dir: found.dir, file: `${found.dir}/player.html`, chapters: 0, pictures: 0, bytes: 0, joined: false });
    });
    asked.current = openAudiobookListening(worldId, production.meta.id);
    return () => {
      offPlan();
      offExport();
      offPackages();
    };
  }, [worldId, production.meta.id]);
  useEffect(() => {
    if (connection === "open" && making.current !== null) listing.current = listWebPackages(worldId);
  }, [connection, worldId]);
  const counts = plan === null ? null : packageCounts(plan);
  const start = () => {
    setBusy(true);
    setResult(null);
    making.current = `ab_${ulid()}`;
    exporting.current = exportAudiobookPlayer(worldId, production.meta.id, making.current);
    if (exporting.current === null) {
      making.current = null;
      setBusy(false);
    }
  };
  const folder = result?.ok === true ? result.dir.slice("exports/".length) : null;
  return (
    <EditorDialog open title={`Export audiobook · ${production.meta.title}`} onClose={onClose} width={620} labelledBy="audiobook-export-title" onBody>
      <div className="fy-exsheet" data-testid="audiobook-export">
        <div className="fy-abexport__opt fy-abexport__opt--on" role="radio" aria-checked="true">
          <span className="fy-abexport__radio" aria-hidden="true" />
          <div>
            <b>Audiobook player</b>
            <div className="fy-mono">{counts === null ? "…" : `player.html · ${counts.chapters} chapter${counts.chapters === 1 ? "" : "s"} · ${counts.pictures} picture${counts.pictures === 1 ? "" : "s"} · web package`}</div>
          </div>
        </div>
        {counts !== null && (
          <div className="fy-ab__reads">
            <div className="fy-ab__read">
              <b>Chapters</b>
              <span>{counts.chapters} of {counts.of} · read whole</span>
            </div>
            <div className="fy-ab__read">
              <b>Pictures</b>
              <span>{counts.pictures} · cover where a chapter has none</span>
            </div>
          </div>
        )}
        {busy && <div className="fy-ms__line fy-mono" data-testid="audiobook-export-busy">exporting…</div>}
        {result?.ok === false && result.blockers.map((blocker) => <div key={blocker} className="fy-ms__line fy-ch__who-where--warn">{blocker}</div>)}
        {result?.ok === true && (
          <div className="fy-ms__line fy-mono" data-testid="audiobook-export-done">
            {result.chapters > 0 ? `${result.dir} · ${result.chapters} chapter${result.chapters === 1 ? "" : "s"} · ${size(result.bytes)}` : result.dir}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {result?.ok === true ? (
            <>
              <Button variant="ghost" onClick={() => folder !== null && openExportsFolder(worldId, folder)}>
                Show in folder
              </Button>
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || connection !== "open" || counts === null || counts.chapters === 0} onClick={start} data-testid="audiobook-export-start">
                Export
              </Button>
            </>
          )}
        </div>
      </div>
    </EditorDialog>
  );
}

/**
 * `Export` on the audiobook door (186e): offered once a block anywhere is made. What is whole is the
 * listening plan's to say, by the words (codex on PR 1498): a chapter whose takes the door calls
 * stale after a narrator or a direction changed still says its words, and still goes in.
 */
export function ExportAudiobookButton({ worldId, production }: { worldId: string; production: ProductionBundle }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" disabled={!bookHasTakes(production)} onClick={() => setOpen(true)} data-testid="audiobook-export-open">
        Export
      </Button>
      {open && <AudiobookExportSheet worldId={worldId} production={production} onClose={() => setOpen(false)} />}
    </>
  );
}

const KIND: Record<WebPackagesListed["packages"][number]["kind"], string> = { interactive: "Interactive", "visual-novel": "Visual novel", audiobook: "Audiobook" };

/** The open world's web packages in Publications (186e): the audiobook beside the interactive and the visual novel. */
export function WebPackages({ worldId }: { worldId: string }) {
  const connection = useStore().connection;
  const asked = useRef<string | null>(null);
  const [packages, setPackages] = useState<WebPackagesListed["packages"] | null>(null);
  useEffect(() => {
    const off = subscribeWebPackages((answer) => {
      if (answer.requestId === asked.current) setPackages(answer.packages);
    });
    if (connection === "open") asked.current = listWebPackages(worldId);
    return off;
  }, [worldId, connection]);
  if (packages === null || packages.length === 0) return null;
  return (
    <section className="fy-publication-packages" aria-label="Web packages" data-testid="web-packages">
      <h2 className="fy-h2">Web packages</h2>
      {packages.map((entry) => (
        <div key={entry.dir} className="fy-publication-job" data-testid="web-package">
          <strong>{entry.title}</strong>
          <span className="fy-mono">{KIND[entry.kind]} · {entry.exportedAt.slice(0, 10)}</span>
          <div className="fy-publication-actions">
            <Button variant="ghost" onClick={() => openExportsFolder(worldId, entry.dir.slice("exports/".length))}>
              Show in folder
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
