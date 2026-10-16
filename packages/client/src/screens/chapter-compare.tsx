import { useEffect, useState } from "react";
import { versionDiff } from "@arke-studio/contracts";
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
  // The older on the left whichever way the heads were set.
  const [older, newer] = left <= right ? [left, right] : [right, left];
  const olderBody = bodies.get(older);
  const newerBody = bodies.get(newer);
  const choices = [...kept, now.version];
  const label = (version: number) => (version === now.version ? `Now · v${version}` : `v${version}`);
  const pick = (value: number, onPick: (version: number) => void) => (
    <select className="fy-compare__pick" value={value} onChange={(e) => onPick(Number(e.target.value))}>
      {choices.map((version) => (
        <option key={version} value={version}>{label(version)}</option>
      ))}
    </select>
  );
  const diff = olderBody !== undefined && newerBody !== undefined ? versionDiff(olderBody, newerBody) : null;
  return (
    <section className="fy-compare" aria-label="Compare versions" data-testid="chapter-compare">
      <header className="fy-compare__heads">
        <div className="fy-compare__head">
          {pick(left, setLeft)}
          {older !== now.version && <Button variant="ghost" disabled={locked} onClick={() => onRestore(older)}>Restore</Button>}
        </div>
        <div className="fy-compare__head">
          {pick(right, setRight)}
          <span className="fy-compare__push" />
          <button type="button" className="fy-ch__wbtn" aria-label="Close compare" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </header>
      {failed !== null ? (
        <p className="fy-bible__empty">{failed}</p>
      ) : diff === null ? (
        <p className="fy-bible__empty">Opening…</p>
      ) : (
        <div className="fy-compare__cols">
          <div className="fy-compare__col fy-compare__col--older" aria-label={label(older)}>
            {diff.map((paragraph, i) =>
              paragraph.kind === "added" ? null : (
                <p key={i}>
                  {paragraph.kind === "changed" ? paragraph.segments.map((segment) => (segment.kind === "same" ? segment.text : segment.before)).join("") : paragraph.text}
                </p>
              ),
            )}
          </div>
          <div className="fy-compare__col" aria-label={label(newer)}>
            {diff.map((paragraph, i) =>
              paragraph.kind === "same" ? (
                <p key={i}>{paragraph.text}</p>
              ) : paragraph.kind === "added" ? (
                <p key={i}><ins>{paragraph.text}</ins></p>
              ) : paragraph.kind === "removed" ? (
                <p key={i}><del>{paragraph.text}</del></p>
              ) : (
                <p key={i}>
                  {paragraph.segments.map((segment, j) =>
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
              ),
            )}
          </div>
        </div>
      )}
    </section>
  );
}
