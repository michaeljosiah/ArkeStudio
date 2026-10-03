import { useEffect, useRef, useState } from "react";
import { sheetReferencePicture, type AudiobookLook, type ChapterAudiobook, type LookTarget } from "@arke-studio/contracts";
import { EditorDialog } from "./editor-dialog.js";
import { mediaUrl } from "../lib/media.js";
import { deriveAudiobookLook, setAudiobookLook, useAudiobookRecords, useStore } from "../lib/store.js";
import { Button, Select, Textarea } from "./ui.js";

/**
 * The look sheet (design turn 191c, SPEC-047 R-98): the place, the time and the light, and what
 * each character wears and carries in this chapter — read from the prose once, kept on the
 * chapter's record, every line the author's to change. It is the one text every picture prompt of
 * the chapter takes its lines from, so a coat stays a coat. Opened from a block's Picture and from
 * the proposal; 720 wide and centred, drawn on the body.
 */

/** `blocks 3, 9` · `block 31` — the numbers the margin shows, by position in the chapter. */
export function blocksLabel(keys: readonly string[] | undefined, numberOf: (key: string) => number | null): string | null {
  const numbers = [...new Set((keys ?? []).map(numberOf).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  return `block${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}`;
}

interface Row {
  id: string;
  target: LookTarget;
  label: string | null;
  text: string;
  sheet?: string;
  source: string | null;
}

/** The sheet's rows: the place, then each character in the look's own order. */
export function lookRows(look: AudiobookLook | null, numberOf: (key: string) => number | null): Row[] {
  if (look === null) return [];
  const rows: Row[] = [];
  if (look.place !== undefined) rows.push({ id: "place", target: { kind: "place" }, label: null, text: look.place.text, source: look.place.by === "author" ? "yours" : "from the prose" });
  for (const [key, line] of Object.entries(look.characters)) {
    const blocks = blocksLabel(line.blocks, numberOf);
    rows.push({
      id: key,
      target: { kind: "character", key },
      label: line.name,
      text: line.text,
      ...(line.sheet !== undefined ? { sheet: line.sheet } : {}),
      source: [blocks, line.by === "author" ? "yours" : null].filter((part): part is string => part !== null).join(" · ") || null,
    });
  }
  return rows;
}

/** One line, written on leaving the field when its words changed (the author's from then on). */
function LookLine({ row, disabled, onWrite }: { row: Row; disabled: boolean; onWrite: (target: LookTarget, text: string | null) => void }) {
  const store = useStore();
  const world = store.state?.world ?? null;
  const [text, setText] = useState(row.text);
  const saved = useRef(row.text);
  useEffect(() => {
    saved.current = row.text;
    setText(row.text);
  }, [row.text]);
  const picture = row.sheet !== undefined && world !== null ? sheetReferencePicture(world, row.sheet) : null;
  const leave = () => {
    const words = text.replace(/\s+/g, " ").trim();
    if (words === saved.current) return;
    onWrite(row.target, words === "" ? null : words);
  };
  return (
    <div className="fy-look__line" data-testid="look-line" data-key={row.id}>
      {row.label === null ? (
        <span className="fy-look__place fy-mono">Place</span>
      ) : picture !== null && world !== null ? (
        <img className="fy-look__thumb" src={mediaUrl(world.meta.slug, picture)} alt="" />
      ) : (
        <i className="fy-look__thumb fy-look__thumb--none" aria-hidden="true" />
      )}
      <div className="fy-look__tx">
        {row.label !== null && <b>{row.label}</b>}
        <Textarea
          aria-label={row.label ?? "Place"}
          rows={2}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onBlur={leave}
        />
      </div>
      {row.source !== null && <span className="fy-look__src fy-mono">{row.source}</span>}
    </div>
  );
}

export function LookSheet({ open, onClose, worldId, productionId, chapterFile, chapterOrder, record, blockKeys }: {
  open: boolean;
  onClose: () => void;
  worldId: string;
  productionId: string;
  chapterFile: string;
  chapterOrder: number;
  record: ChapterAudiobook | null;
  /** The chapter's blocks in order, for the numbers a line says it comes from. */
  blockKeys: readonly string[];
}) {
  const store = useStore();
  const world = store.state?.world ?? null;
  const connection = store.connection;
  const look = record?.look ?? null;
  const numberOf = (key: string): number | null => {
    const index = blockKeys.indexOf(key);
    return index < 0 ? null : index + 1;
  };
  const answers = useAudiobookRecords();
  const [asked, setAsked] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    if (asked === null) return;
    const landed = Object.values(answers).find((value) => value.requestId === asked);
    if (landed === undefined) return;
    setAsked(null);
    setRefused(landed.refused ?? null);
  }, [answers, asked]);
  const [adding, setAdding] = useState<Array<{ key: string; name: string; sheet?: string }>>([]);
  useEffect(() => {
    if (!open) {
      setAdding([]);
      setRefused(null);
    }
  }, [open]);
  const off = connection !== "open";
  const derive = () => {
    setRefused(null);
    setAsked(deriveAudiobookLook(worldId, productionId, chapterFile));
  };
  const write = (target: LookTarget, text: string | null) => {
    setAudiobookLook(worldId, productionId, chapterFile, target, text);
  };
  const rows = lookRows(look, numberOf);
  // A character the look holds no line for, offered to add: a sheet of the world's, by name.
  const held = new Set(Object.keys(look?.characters ?? {}));
  const addable = (world?.sheets ?? []).filter((sheet) => sheet.type === "character" && sheet.retired !== true && sheet.neverDepicted !== true && !held.has(sheet.id) && !adding.some((entry) => entry.key === sheet.id));
  const count = Object.keys(look?.characters ?? {}).length;
  const state = look === null ? null : rows.some((row) => row.source?.includes("yours")) ? "edited" : "derived";
  return (
    <EditorDialog open={open} onClose={onClose} width={720} title={`Look · Chapter ${chapterOrder}`} panelClassName="fy-look">
      <div className="fy-look__body" data-testid="look-sheet">
        {rows.length === 0 && adding.length === 0 && (
          <p className="fy-mono fy-look__none" data-testid="look-none">
            {asked !== null ? "reading…" : "not read"}
          </p>
        )}
        {rows.map((row) => (
          <LookLine key={row.id} row={row} disabled={off} onWrite={write} />
        ))}
        {adding.map((entry) => (
          <LookLine
            key={`new-${entry.key}`}
            row={{ id: entry.key, target: { kind: "character", key: entry.key, name: entry.name, ...(entry.sheet !== undefined ? { sheet: entry.sheet } : {}) }, label: entry.name, text: "", ...(entry.sheet !== undefined ? { sheet: entry.sheet } : {}), source: null }}
            disabled={off}
            onWrite={(target, text) => {
              write(target, text);
              if (text !== null) setAdding((held) => held.filter((candidate) => candidate.key !== entry.key));
            }}
          />
        ))}
        {look !== null && (
          <div className="fy-look__meta fy-mono">
            <span>
              {count} character{count === 1 ? "" : "s"} · {state} · saved
            </span>
            <span>used by every picture in this chapter</span>
          </div>
        )}
        {refused !== null && <p className="fy-mono fy-ch__who-where--warn" data-testid="look-refused">{refused}</p>}
        <div className="fy-look__foot">
          {addable.length > 0 && (
            <Select
              label="Add"
              value=""
              disabled={off}
              onChange={(event) => {
                const sheet = addable.find((candidate) => candidate.id === event.target.value);
                if (sheet !== undefined) setAdding((held) => [...held, { key: sheet.id, name: sheet.name, sheet: sheet.id }]);
              }}
              data-testid="look-add"
            >
              <option value="">Add</option>
              {addable.map((sheet) => (
                <option key={sheet.id} value={sheet.id}>
                  {sheet.name}
                </option>
              ))}
            </Select>
          )}
          <span className="fy-ch__panelpush" />
          <Button variant="secondary" disabled={off || asked !== null} onClick={derive} data-testid="look-derive">
            {asked !== null ? "Reading…" : look === null ? "Derive" : "Derive again"}
          </Button>
          <Button variant="primary" onClick={onClose} data-testid="look-done">
            Done
          </Button>
        </div>
      </div>
    </EditorDialog>
  );
}

/** The panel's one line about the look: how many people it holds, or that it has not been read. */
export function lookCount(look: AudiobookLook | null | undefined): string {
  if (look === undefined || look === null) return "not read";
  const count = Object.keys(look.characters).length;
  return `${count} character${count === 1 ? "" : "s"}`;
}
