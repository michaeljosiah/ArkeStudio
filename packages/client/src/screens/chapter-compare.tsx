import { useEffect, useState } from "react";
import { versionDiff, type VersionParagraph } from "@arke-studio/contracts";
import { X } from "../components/icons.js";
import { Button } from "../components/ui.js";

/**
 * Compare versions (design turn 227f, SPEC-056 R-13): two versions side by side. The older is on
 * the left at muted strength, with Restore; the newer on the right with its changes against the
 * older marked, words removed struck and words added marked. Each head picks its version from
 * the chapter's history; the newest choice is the chapter as it stands now.
 */
export function CompareVersions({ kept, now, read, locked, onRestore, onClose }: {
  /** The earlier versions a snapshot exists for, ascending. */
  kept: readonly number[];
  /** The chapter as it stands: its version and saved prose. */
  now: { version: number; body: string };
  read: (version: number) => Promise<string>;
  locked: boolean;
  onRestore: (version: number) => void;
  onClose: () => void;
}) {
  const [left, setLeft] = useState(() => kept[kept.length - 1] ?? now.version);
  const [right, setRight] = useState(now.version);
  const [bodies, setBodies] = useState<ReadonlyMap<number, string>>(() => new Map([[now.version, now.body]]));
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => setBodies((held) => new Map(held).set(now.version, now.body)), [now.version, now.body]);
  useEffect(() => {
    let live = true;
    for (const version of [left, right]) {
      if (bodies.has(version)) continue;
      read(version).then(
        (body) => live && setBodies((held) => new Map(held).set(version, body)),
        (error: Error) => live && setFailed(error.message),
      );
    }
    return () => {
      live = false;
    };
  }, [left, right, bodies, read]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  const olderBody = bodies.get(left);
  const newerBody = bodies.get(right);
  const choices = [...kept, now.version];
  const label = (version: number) => (version === now.version ? `Now · v${version}` : `v${version}`);
  // The heads cannot cross (codex on PR 1802): the left offers only what is older than the right,
  // so the older is always on the left, beside its Restore.
  const pick = (value: number, offered: readonly number[], onPick: (version: number) => void) => (
    <select className="fy-compare__pick" value={value} onChange={(e) => onPick(Number(e.target.value))}>
      {offered.map((version) => (
        <option key={version} value={version}>{label(version)}</option>
      ))}
    </select>
  );
  const diff = olderBody !== undefined && newerBody !== undefined ? versionDiff(olderBody, newerBody) : null;
  return (
    <section className="fy-compare" aria-label="Compare versions" data-testid="chapter-compare">
      <div className="fy-compare__grid">
        <div className="fy-compare__head fy-compare__cell--older">
          {pick(left, choices.filter((version) => version < right), setLeft)}
          {left !== now.version && <Button variant="ghost" disabled={locked} onClick={() => onRestore(left)}>Restore</Button>}
        </div>
        <div className="fy-compare__head">
          {pick(right, choices.filter((version) => version > left), setRight)}
          <span className="fy-compare__push" />
          <button type="button" className="fy-ch__wbtn" aria-label="Close compare" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {failed !== null ? (
          <p className="fy-bible__empty fy-compare__wide">{failed}</p>
        ) : diff === null ? (
          <p className="fy-bible__empty fy-compare__wide">Opening…</p>
        ) : (
          // One row a paragraph, the older beside the newer, so an added paragraph leaves a space on
          // the left rather than sliding everything after it out of line (codex on PR 1802).
          diff.map((paragraph, i) => (
            <CompareRow key={i} paragraph={paragraph} />
          ))
        )}
      </div>
    </section>
  );
}

function CompareRow({ paragraph }: { paragraph: VersionParagraph }) {
  const older = paragraph.kind === "added" ? null
    : paragraph.kind === "changed" ? paragraph.segments.map((segment) => (segment.kind === "same" ? segment.text : segment.before)).join("")
    : paragraph.text;
  return (
    <>
      <p className="fy-compare__cell fy-compare__cell--older">{older}</p>
      <p className="fy-compare__cell">
        {paragraph.kind === "same" ? paragraph.text
          : paragraph.kind === "added" ? <ins>{paragraph.text}</ins>
          : paragraph.kind === "removed" ? <del>{paragraph.text}</del>
          : paragraph.segments.map((segment, j) =>
              segment.kind === "same" ? (
                <span key={j}>{segment.text}</span>
              ) : (
                <span key={j}>
                  {segment.before !== "" && <del>{segment.before}</del>}
                  {segment.after !== "" && <ins>{segment.after}</ins>}
                </span>
              ),
            )}
      </p>
    </>
  );
}
