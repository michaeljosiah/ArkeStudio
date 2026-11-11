import { useState, type ReactNode } from "react";
import { downloadMedia } from "../lib/download.js";
import { mediaUrl } from "../lib/media.js";
import { openExportsFolder, useConnection, type ArkePlayerExported } from "../lib/store.js";
import { CreatorPublishingPanel } from "./creator-publishing.js";
import { Check, Folder, megabytes } from "./audiobook-video.js";

export type ArkePlayerPackage = Extract<ArkePlayerExported["result"], { ok: true }>;

/**
 * The package made, the same block for every kind (design turn 276c, 276d; SPEC-058 R-103). A book,
 * an album, a story and a graphic novel each made it their own way and showed it four ways: only
 * the book could be submitted, the comic had no SHA-256, the album could not be made again. What
 * differs by kind is passed in — its picture, what it holds, what the read-back found, the
 * releases it sits among — and everything a person does with the file is here once.
 */
export function ArkePlayerMade({ worldId, worldSlug, productionId, exportId, made, picture, holds, readBack, title, remote, phone, onMakeAgain, testId, children }: {
  worldId: string;
  worldSlug: string | undefined;
  productionId: string;
  /** The export's id; Submit to Arke Player freezes this exact package (R-95). */
  exportId: string | null;
  made: ArkePlayerPackage;
  /** A world-relative picture for the file's row, or none. */
  picture: string | null;
  /** What the package holds, as data: `16 chapters · 174 pictures · the book`. */
  holds: string;
  /** What the read-back found, where the kind says more than the schema and the files (a story's routes). */
  readBack?: ReactNode;
  /** The share sheet's title on a phone. */
  title: string;
  remote: boolean;
  phone: boolean;
  /** Makes a new package with the sheet's options; a new file, never this one again (R-7). */
  onMakeAgain: () => void;
  testId: string;
  /** Rows beneath the read-back: the releases this package sits among (236e, 245d). */
  children?: ReactNode;
}) {
  const connection = useConnection();
  const [copied, setCopied] = useState(false);
  const [handing, setHanding] = useState(false);
  const [handed, setHanded] = useState<string | null>(null);
  const name = made.file.slice("exports/".length);
  const canShare = typeof navigator !== "undefined" && typeof navigator.canShare === "function";
  const download = async () => {
    setHanding(true);
    const outcome = await downloadMedia(worldSlug, made.file, name, "package");
    setHanding(false);
    setHanded(outcome.ok || outcome.cancelled === true ? null : outcome.reason);
  };
  // From a paired phone (233f): the package was made on the desktop; Share hands it to the phone's
  // share sheet, where Arke Player takes it.
  const share = async () => {
    if (worldSlug === undefined) return;
    setHanding(true);
    setHanded(null);
    try {
      const response = await fetch(mediaUrl(worldSlug, made.file));
      if (!response.ok) throw new Error(String(response.status));
      const file = new File([await response.blob()], name, { type: "application/zip" });
      if (!navigator.canShare({ files: [file] })) setHanded("this phone cannot share the package · use Download");
      else await navigator.share({ files: [file], title });
    } catch (error) {
      // Closing the share sheet is an answer, not a failure.
      if (!(error instanceof DOMException && error.name === "AbortError")) setHanded("the package could not be shared · use Download");
    } finally {
      setHanding(false);
    }
  };
  // A result rebuilt from Publications' list after a reconnect carries no read-back facts.
  const found = readBack ?? (made.schema === undefined ? null : <span>{`schema ${made.schema}${made.files === undefined ? "" : ` · ${made.files} file${made.files === 1 ? "" : "s"}`}`}</span>);
  return (
    <div className="fy-abv-made" data-testid={testId}>
      <div className="fy-abv-est">
        <b>{made.part !== undefined ? "1 part" : "1 package"} · {megabytes(made.bytes)}</b>
        <span className="m">{made.file}</span>
      </div>
      <div className="fy-abv-file">
        {picture !== null && worldSlug !== undefined ? <img src={mediaUrl(worldSlug, picture)} alt="" /> : <span className="ph" />}
        <div>
          <div>{name}</div>
          <div className="m">{[holds, megabytes(made.bytes)].filter(Boolean).join(" · ")}</div>
        </div>
        <span />
      </div>
      <div className="fy-abv-sha">
        <b>SHA-256</b>
        <code>{made.sha256}</code>
        <button type="button" className="fy-abv-btn" onClick={() => void navigator.clipboard?.writeText(made.sha256).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <div className="fy-abv-back" data-testid={testId.replace(/-done$/, "-read-back")}>
        <Check />
        <b>Read back</b>
        {found}
      </div>
      {children}
      <div className="fy-abv-acts">
        {!remote && (
          <button type="button" className="fy-abv-btn" onClick={() => openExportsFolder(worldId)}>
            <Folder />
            Show in folder
          </button>
        )}
        {!phone && <button type="button" className="fy-abv-btn" disabled={connection !== "open"} onClick={onMakeAgain}>Make again</button>}
        {remote && <button type="button" className="fy-abv-btn" disabled={handing} onClick={() => void download()}>Download</button>}
        {remote && canShare && <button type="button" className="fy-abv-btn" disabled={handing} onClick={() => void share()}>Share</button>}
      </div>
      {handed !== null && <div className="fy-abv-warn">{handed}</div>}
      {exportId !== null && <CreatorPublishingPanel worldId={worldId} productionId={productionId} exportId={exportId} />}
    </div>
  );
}
