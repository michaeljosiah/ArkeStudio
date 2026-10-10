import { useEffect, useRef, useState } from "react";
import {
  chapterLooksOf,
  estimateCharacterImageMicroUsd,
  lookClothing,
  lookName,
  lookOlderFace,
  mainPhotoFor,
  priceLabel,
  type AudiobookLook,
  type CharacterLook,
  type ChapterAudiobook,
  type LookCharacter,
  type LookTarget,
  type ReferenceKit,
} from "@arke-studio/contracts";
import { resolveModel, worldModel } from "./dispatch-bar.js";
import { PageSheet } from "./page-sheet.js";
import { SavedLookCollection, SavedLookImage } from "./saved-look-collection.js";
import { NewLookSheet } from "./audiobook-new-look.js";
import { mediaUrl } from "../lib/media.js";
import { acceptChapterLook, chooseAudiobookLook, deriveAudiobookLook, makeChapterLook, rejectReferenceTake, setAudiobookLook, useAudiobookRecords, useStore } from "../lib/store.js";
import { lookJobState, lookJobs, useQueueRefusals } from "./look-jobs.js";
import { Button, Select, Textarea } from "./ui.js";

/**
 * The chapter's Looks (approved turns 209/210; SPEC-047 R-180): compact choices followed by the place, the mood
 * and the light, and for each character the look chosen for this chapter — a kit look, its full-body
 * image, its clothing line, where it is used and where it came from — with a picker over the
 * character's looks, Make a look where there is none, and a conflict row where the chapter's words
 * and the look disagree. Every line is the author's to change and is theirs from then on. The
 * look's image is the reference that rides in this chapter's pictures; the words never override it.
 * Chapter details starts folded. Existing field-blur writes, close-view operations and derivation
 * remain in that disclosure; compact rows keep warnings and the explicit chooser reachable.
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
  line?: LookCharacter;
}

/** The sheet's rows: the place, the mood, then each character in the look's own order. */
export function lookRows(look: AudiobookLook | null, numberOf: (key: string) => number | null): Row[] {
  if (look === null) return [];
  const rows: Row[] = [];
  if (look.place !== undefined) rows.push({ id: "place", target: { kind: "place" }, label: null, text: look.place.text, source: look.place.by === "author" ? "yours" : "from the prose" });
  if (look.mood !== undefined) rows.push({ id: "mood", target: { kind: "mood" }, label: null, text: look.mood.text, source: look.mood.by === "author" ? "yours" : "from the art direction · light only" });
  for (const [key, line] of Object.entries(look.characters)) {
    const blocks = blocksLabel(line.blocks, numberOf);
    rows.push({
      id: key,
      target: { kind: "character", key },
      label: line.name,
      text: line.text,
      line,
      ...(line.sheet !== undefined ? { sheet: line.sheet } : {}),
      source: [blocks, line.by === "author" ? "yours" : null].filter((part): part is string => part !== null).join(" · ") || null,
    });
  }
  return rows;
}

/** The words of one line, written on leaving the field when they changed (the author's from then on). */
function Field({ row, label, disabled, onWrite }: { row: Row; label: string; disabled: boolean; onWrite: (target: LookTarget, text: string | null) => void }) {
  const [text, setText] = useState(row.text);
  const saved = useRef(row.text);
  useEffect(() => {
    saved.current = row.text;
    setText(row.text);
  }, [row.text]);
  const leave = () => {
    const words = text.replace(/\s+/g, " ").trim();
    if (words === saved.current) return;
    onWrite(row.target, words === "" ? null : words);
  };
  return <Textarea aria-label={label} rows={2} value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} onBlur={leave} />;
}

/** One line: the place, the mood, or a character with no sheet to hold a look. */
function LookLine({ row, disabled, onWrite }: { row: Row; disabled: boolean; onWrite: (target: LookTarget, text: string | null) => void }) {
  const tag = row.id === "place" ? "Place" : row.id === "mood" ? "Mood" : null;
  return <div className="fy-look__line" data-testid="look-line" data-key={row.id}>
    <div className="fy-look__tx"><b>{row.label ?? tag}</b><Field row={row} label={row.label ?? tag ?? "Line"} disabled={disabled} onWrite={onWrite} />
      {tag === null && row.sheet === undefined && <span className="fy-ch__who-where--warn" data-testid="look-unlinked">Identity not linked · confirm which character this is</span>}
    </div>
    {row.source !== null && <span className="fy-look__src fy-mono">{row.source}</span>}
  </div>;
}

const kitOf = (world: { referenceKits: readonly ReferenceKit[] } | null, sheet: string | undefined): ReferenceKit | null => (world === null || sheet === undefined ? null : (world.referenceKits.find((candidate) => candidate.sheetId === sheet) ?? null));

/**
 * Where a chosen look's close view stands: none yet, being made, refused with its reason, made and
 * waiting to be accepted or discarded, or accepted (shown at once, before the kit's snapshot says so).
 */
export type CloseViewState =
  | { kind: "none" }
  | { kind: "making" }
  | { kind: "failed"; reason: string; retry: boolean }
  | { kind: "made"; take: { id: string; path: string } }
  | { kind: "accepted"; path: string };

/** The price of one close view on this model: one picture from two references, the main photo and the full body, as the job is priced. */
export function closeViewCost(model: Parameters<typeof estimateCharacterImageMicroUsd>[0] | null): string {
  return model === null ? "" : priceLabel(estimateCharacterImageMicroUsd(model, "character-look", 1, 2), model.pricing.kind === "included-plan" ? "included-plan" : undefined);
}

/** One character: the look chosen (or the main photo), the picker over their looks, the line, and what to do about the rest. */
function CharacterRow({ view, row, kit, slug, orderOf, off, onWrite, onNewLook, onBrowse, closeState, onMakeClose, onAcceptClose, onDiscardClose }: {
  view: "overview" | "details";
  row: Row;
  kit: ReferenceKit | null;
  slug: string;
  orderOf: (file: string) => number | null;
  off: boolean;
  onWrite: (target: LookTarget, text: string | null) => void;
  onNewLook: (row: Row) => void;
  onBrowse: (row: Row) => void;
  closeState: (look: CharacterLook) => CloseViewState;
  onMakeClose: (row: Row, look: CharacterLook) => void;
  onAcceptClose: (row: Row, look: CharacterLook, take: { id: string; path: string }) => void;
  onDiscardClose: (look: CharacterLook, takeId: string, again: boolean) => void;
}) {
  const sheet = row.sheet;
  const line = row.line!;
  const looks = chapterLooksOf(kit);
  const chosen = looks.find((look) => look.id === line.lookId) ?? null;
  const photo = kit === null ? null : mainPhotoFor(kit);
  const model = useStore().state;
  const closeCost = closeViewCost(resolveModel(model, "image", undefined, worldModel(model, "image")).model);
  const from = line.from !== undefined ? orderOf(line.from) : null;
  const close: CloseViewState = chosen === null ? { kind: "none" } : chosen.closeFile !== undefined ? { kind: "accepted", path: `references/${sheet}/${chosen.closeFile}` } : closeState(chosen);
  const priced = (label: string) => `${label}${closeCost !== "" ? ` · ${closeCost}` : ""}`;
  const gone = line.lookId !== undefined && chosen === null;
  return (
    <div className={view === "overview" ? "fy-look__char" : "fy-look__detailchar"} data-testid={view === "overview" ? "look-overview-row" : "look-line"} data-key={row.id}>
      {view === "overview" ? <><div className="fy-look__overview">
        <SavedLookImage src={photo !== null ? mediaUrl(slug, `references/${sheet}/${photo.file}`) : null} className="fy-look__avatar" />
        <div className="fy-look__person"><b>{row.label}</b><small>{looks.length === 0 ? "No saved looks" : `${looks.length} saved look${looks.length === 1 ? "" : "s"}`}</small></div>
        <button type="button" className="fy-look__choice" onClick={() => onBrowse(row)} data-testid="look-browse" data-look={line.lookId ?? "main"}>
          {(gone || chosen !== null) && <SavedLookImage src={gone ? null : mediaUrl(slug, `references/${sheet}/${chosen!.file}`)} />}
          <span className="fy-look__choicewords"><b>{gone ? "Saved look unavailable" : chosen !== null ? lookName(chosen, looks) : "Main photo"}</b><small>{gone ? "Choose another look" : chosen !== null ? "Chosen for this chapter" : "Choose or make a look"}</small></span><span aria-hidden="true">›</span>
        </button>
        <Button variant="ghost" className="fy-look__new" disabled={off} onClick={() => onNewLook(row)} data-testid="look-new">New look…</Button>
      </div>
      {((line.conflicts?.length ?? 0) > 0 || (chosen !== null && kit !== null && lookOlderFace(kit, chosen))) && <p className="fy-look__warning fy-ch__who-where--warn">{[(line.conflicts?.length ?? 0) > 0 ? "Check clothing in Chapter details" : null, chosen !== null && kit !== null && lookOlderFace(kit, chosen) ? "Older face" : null].filter(Boolean).join(" · ")}</p>}
      </> : <div className="fy-look__details">
      <div className="fy-look__charhead">
        {gone ? <SavedLookImage src={null} className="fy-look__full" /> : chosen !== null ? (
          <img className="fy-look__full" src={mediaUrl(slug, `references/${sheet}/${chosen.file}`)} alt="" data-testid="look-image" data-view="full" />
        ) : photo !== null && sheet !== undefined ? (
          <img className="fy-look__main" src={mediaUrl(slug, `references/${sheet}/${photo.file}`)} alt="" data-testid="look-image" data-view="main" />
        ) : (
          <i className="fy-look__main fy-look__thumb--none" aria-hidden="true" />
        )}
        <div className="fy-look__tx">
          <b>{row.label} · clothing</b>
          <Field row={row} label={row.label ?? "Line"} disabled={off} onWrite={onWrite} />
          <div className="fy-look__facts fy-mono" data-testid="look-facts">
            <span data-testid="look-state">{gone ? "Saved look unavailable" : chosen !== null ? (close.kind === "accepted" ? "Full body and close view" : "Full body · no close view") : "Main photo · no saved look"}</span>
            {row.source !== null && <span>{row.source}</span>}
            {from !== null && <span data-testid="look-from">From Chapter {from}</span>}
            {chosen !== null && kit !== null && (lookOlderFace(kit, chosen) ? <span className="fy-ch__who-where--warn" data-testid="look-older">Older face</span> : <span>Main photo · current face</span>)}
            {chosen !== null && line.by === "author" && <span data-testid="look-edited">line edited</span>}
          </div>
          {(line.conflicts ?? []).map((conflict) => (
            <div key={`${conflict.kind}-${conflict.part}`} className="fy-look__conflict fy-mono" data-testid="look-conflict">
              <b>{conflict.part}</b>
              <span>
                {conflict.kind === "chapter" ? "chapter" : "photo"} {conflict.a} · {conflict.kind === "chapter" ? "look" : "line"} {conflict.b}
              </span>
              {sheet !== undefined && (
                <button type="button" className="fy-sugg__make" disabled={off} onClick={() => onNewLook(row)} data-testid="look-conflict-make">
                  {chosen !== null ? "Make again" : "Make a look"}
                </button>
              )}
            </div>
          ))}
          {chosen !== null && (close.kind === "none" || close.kind === "making") && (
            <div className="fy-look__facts fy-mono">
              <button type="button" className="fy-sugg__make" disabled={off || close.kind === "making"} onClick={() => onMakeClose(row, chosen)} data-testid="look-make-close">
                {close.kind === "making" ? "Making close view…" : priced("Make close view")}
              </button>
            </div>
          )}
          {chosen !== null && close.kind === "failed" && (
            <div className="fy-look__facts fy-mono" data-testid="look-close-failed">
              <span className="fy-ch__who-where--warn" data-testid="look-close-reason">Close view {close.reason}</span>
              {close.retry && (
                <button type="button" className="fy-sugg__make" disabled={off} onClick={() => onMakeClose(row, chosen)} data-testid="look-close-retry">
                  {priced("Try again")}
                </button>
              )}
            </div>
          )}
          {chosen !== null && close.kind === "made" && (
            <div className="fy-look__facts fy-mono" data-testid="look-close-made">
              <img className="fy-look__closeimg" src={mediaUrl(slug, close.take.path)} alt="" />
              <button type="button" className="fy-sugg__make" disabled={off} onClick={() => onAcceptClose(row, chosen, close.take)} data-testid="look-accept-close">
                Accept close view
              </button>
              <button type="button" className="fy-sugg__make" disabled={off} onClick={() => onDiscardClose(chosen, close.take.id, true)} data-testid="look-close-again">
                {priced("Make again")}
              </button>
              <button type="button" className="fy-sugg__make" disabled={off} onClick={() => onDiscardClose(chosen, close.take.id, false)} data-testid="look-close-discard">
                Discard
              </button>
            </div>
          )}
          {chosen !== null && close.kind === "accepted" && chosen.closeFile === undefined && (
            <div className="fy-look__facts fy-mono" data-testid="look-close-accepted">
              <img className="fy-look__closeimg" src={mediaUrl(slug, close.path)} alt="" />
              <span>close view · saving…</span>
            </div>
          )}
        </div>
      </div>
      </div>}
    </div>
  );
}

/** The words a target's line holds in a look, or null where it holds none. */
export function lineOf(look: AudiobookLook | null, target: LookTarget): string | null {
  if (look === null) return null;
  if (target.kind === "place") return look.place?.text ?? null;
  if (target.kind === "mood") return look.mood?.text ?? null;
  return look.characters[target.key]?.text ?? null;
}

/**
 * The look with choices laid over it that were pressed and not yet answered: a look chosen takes
 * that look's clothing line, the main photo takes back the chapter's own reading, as the
 * coordinator's `chooseLook` will write them.
 */
export function withChoices(look: AudiobookLook | null, choosing: Record<string, { lookId: string | null }>, kitLook: (sheet: string, lookId: string) => CharacterLook | null): AudiobookLook | null {
  if (look === null || Object.keys(choosing).length === 0) return look;
  const characters = { ...look.characters };
  for (const [key, press] of Object.entries(choosing)) {
    const line = characters[key];
    if (line === undefined) continue;
    if (press.lookId === null) {
      const { lookId: _id, from: _from, conflicts: _conflicts, reading, ...rest } = line;
      characters[key] = { ...rest, text: reading ?? line.text };
      continue;
    }
    const chosen = line.sheet === undefined ? null : kitLook(line.sheet, press.lookId);
    if (chosen === null) continue;
    const { from: _from, conflicts: _conflicts, ...rest } = line;
    characters[key] = { ...rest, text: lookClothing(chosen), lookId: press.lookId, ...(line.lookId === undefined ? { reading: line.text } : {}) };
  }
  return { ...look, characters };
}

/** The look with line writes not yet answered laid over it: a sheet closed and opened again still shows the words written (codex on PR 1559). */
export function withWrites(look: AudiobookLook | null, writing: ReadonlyArray<{ target: LookTarget; text: string | null }>): AudiobookLook | null {
  if (look === null || writing.length === 0) return look;
  let next = look;
  for (const { target, text } of writing) {
    // A line taken away (null) is shown gone, as the record will have it.
    if (target.kind === "place" && next.place !== undefined) {
      const { place: _place, ...rest } = next;
      next = text === null ? rest : { ...next, place: { ...next.place, text } };
    } else if (target.kind === "mood" && next.mood !== undefined) {
      const { mood: _mood, ...rest } = next;
      next = text === null ? rest : { ...next, mood: { ...next.mood, text } };
    } else if (target.kind === "character" && next.characters[target.key] !== undefined) {
      const { [target.key]: line, ...others } = next.characters;
      next = { ...next, characters: text === null ? others : { ...next.characters, [target.key]: { ...line!, text } } };
    } else if (target.kind === "character" && text !== null && target.name !== undefined) {
      // A character added here and not yet in the record: drawn from the write, so the row stays
      // and Add does not offer them twice (codex on PR 1559).
      next = { ...next, characters: { ...next.characters, [target.key]: { name: target.name, ...(target.sheet !== undefined ? { sheet: target.sheet } : {}), text, by: "author" as const } } };
    }
  }
  return next;
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
  const answers = useAudiobookRecords();
  // The newest of the record the chapter holds and the records this sheet's own writes were
  // answered with: the sheet never waits on the chapter view to take the answer first.
  const asking = useRef(new Set<string>());
  const current = Object.values(answers).reduce<ChapterAudiobook | null>((newest, answer) => (answer.record !== undefined && answer.requestId !== undefined && asking.current.has(answer.requestId) && (newest === null || answer.record.updatedAt > newest.updatedAt) ? answer.record : newest), record);
  useEffect(() => {
    asking.current = new Set();
  }, [chapterFile]);
  const look = current?.look ?? null;
  const numberOf = (key: string): number | null => {
    const index = blockKeys.indexOf(key);
    return index < 0 ? null : index + 1;
  };
  const jobs = store.state?.app.jobs ?? [];
  const queueRefused = useQueueRefusals();
  const [asked, setAsked] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [making, setMaking] = useState<{ key: string; name: string; sheet: string; line: string } | null>(null);
  const [browsing, setBrowsing] = useState<string | null>(null);
  /** Close views asked for here, by look: the request whose job is that row's. */
  const [closeAsked, setCloseAsked] = useState<Record<string, string>>({});
  /** Close views accepted or discarded here, shown so at once: the kit's snapshot follows. */
  // Held only until the world's next snapshot, which the coordinator sends after every accept: if
  // that snapshot's kit has no close view the accept did not land, and the row offers it again
  // rather than saying `saving…` for good (codex on PR 1559).
  const [closeAccepted, setCloseAccepted] = useState<Record<string, { path: string; under: unknown }>>({});
  // Hidden until the next snapshot, which records the rejection or shows the take still pending.
  const [discarded, setDiscarded] = useState<ReadonlyArray<{ takeId: string; under: unknown }>>([]);
  /**
   * Choices and line writes pressed and not yet in the record (2026-10-04, 0.5.60-local.14): the
   * coordinator wrote the choice, but the record it answers with took seconds to come back and the
   * sheet said `no look · 0 looks chosen` all that time, so the author thought nothing happened.
   * The sheet shows what was pressed at once, says `saving…`, and lets the record or a refusal
   * settle it.
   */
  const [choosing, setChoosing] = useState<Record<string, { lookId: string | null; requestId: string }>>({});
  const [writing, setWriting] = useState<ReadonlyArray<{ requestId: string; target: LookTarget; text: string | null }>>([]);
  useEffect(() => {
    const landed = (id: string) => Object.values(answers).find((value) => value.requestId === id);
    if (asked !== null && landed(asked) !== undefined) {
      setRefused(landed(asked)!.refused ?? null);
      setAsked(null);
    }
    const answered = Object.entries(choosing).filter(([, press]) => landed(press.requestId) !== undefined);
    const wrote = writing.filter((press) => landed(press.requestId) !== undefined);
    const refusal = [...answered.map(([, press]) => press.requestId), ...wrote.map((press) => press.requestId)].map((id) => landed(id)!.refused).find((said) => said !== undefined);
    if (refusal !== undefined) setRefused(refusal);
    if (answered.length > 0) setChoosing((held) => Object.fromEntries(Object.entries(held).filter(([key]) => !answered.some(([done]) => done === key))));
    if (wrote.length > 0) setWriting((held) => held.filter((press) => !wrote.includes(press)));
  }, [answers, asked, choosing, writing]);
  // A press the record already shows is settled, whichever answer brought it: answers to quick
  // presses replace one another in the store, so its own may never be read.
  useEffect(() => {
    if (look === null) return;
    const shown = Object.entries(choosing).filter(([key, press]) => (look.characters[key]?.lookId ?? null) === press.lookId);
    if (shown.length > 0) setChoosing((held) => Object.fromEntries(Object.entries(held).filter(([key]) => !shown.some(([done]) => done === key))));
    const written = writing.filter((press) => (lineOf(look, press.target) ?? null) === press.text);
    if (written.length > 0) setWriting((held) => held.filter((press) => !written.includes(press)));
  }, [look]);
  const [adding, setAdding] = useState<Array<{ key: string; name: string; sheet?: string }>>([]);
  useEffect(() => {
    if (!open) {
      setAdding([]);
      setRefused(null);
      setMaking(null);
      setBrowsing(null);
      setCloseAsked({});
      setCloseAccepted({});
      setDiscarded([]);
      // Presses still on their way are kept: closed and opened again, the sheet still shows them
      // until their answer or the record settles them (codex on PR 1559).
      return;
    }
  }, [open]);
  const off = connection !== "open";
  const derive = () => {
    setRefused(null);
    const requestId = deriveAudiobookLook(worldId, productionId, chapterFile);
    if (requestId !== null) asking.current.add(requestId);
    setAsked(requestId);
  };
  const write = (target: LookTarget, text: string | null) => {
    // A new write starts clean: an earlier refusal is not this one's (codex on PR 1559).
    setRefused(null);
    const requestId = setAudiobookLook(worldId, productionId, chapterFile, target, text);
    if (requestId === null) return;
    asking.current.add(requestId);
    setWriting((held) => [...held, { requestId, target, text }]);
  };
  // What the sheet draws: the record, with the choices pressed and not yet answered laid over it.
  const shownLook = withWrites(withChoices(look, choosing, (sheet, lookId) => chapterLooksOf(kitOf(world, sheet)).find((candidate) => candidate.id === lookId) ?? null), writing);
  const rows = lookRows(shownLook, numberOf);
  // A character the look holds no line for, offered to add: a sheet of the world's, by name.
  const held = new Set(Object.keys(shownLook?.characters ?? {}));
  const addable = (world?.sheets ?? []).filter((sheet) => sheet.type === "character" && sheet.retired !== true && sheet.neverDepicted !== true && !held.has(sheet.id) && !adding.some((entry) => entry.key === sheet.id));
  const count = Object.keys(shownLook?.characters ?? {}).length;
  const chosenCount = Object.values(shownLook?.characters ?? {}).filter((line) => line.lookId !== undefined).length;
  const saving = Object.keys(choosing).length > 0 || writing.length > 0;
  const slug = world?.meta.slug ?? "";
  const orderOf = (file: string): number | null => world?.productions.find((candidate) => candidate.meta.id === productionId)?.chapters.find((chapter) => chapter.file === file)?.order ?? null;
  const choose = (row: Row, lookId: string | null) => {
    // The row already shows what was pressed and not yet answered: the same press again sends nothing.
    if ((row.line?.lookId ?? null) === lookId) return;
    setRefused(null);
    const requestId = chooseAudiobookLook(worldId, productionId, chapterFile, { key: row.id, ...(row.label !== null ? { name: row.label } : {}), ...(row.sheet !== undefined ? { sheet: row.sheet } : {}) }, lookId);
    if (requestId === null) return;
    asking.current.add(requestId);
    setChoosing((pressed) => ({ ...pressed, [row.id]: { lookId, requestId } }));
  };
  const pendingClose = (sheet: string, lookId: string): { id: string; path: string } | null => {
    if (world === null) return null;
    const found = world.referenceTakes
      .filter((take) => take.kind === "look" && take.reference?.sheetId === sheet && take.media !== undefined && take.params["lookFraming"] === "close" && take.params["lookOfLook"] === lookId && !discarded.some((entry) => entry.takeId === take.id && entry.under === world) && !world.referenceReviews.some((review) => review.takeId === take.id))
      .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    return found === undefined ? null : { id: found.id, path: `references/${sheet}/takes/${found.id}/${found.media}` };
  };
  /** The close view's row (R-118): accepted here, made and waiting, being made, or refused with its reason — never a spinner on a job that ended. */
  const closeStateFor = (sheet: string, chosen: CharacterLook): CloseViewState => {
    const accepted = closeAccepted[chosen.id];
    if (accepted !== undefined && accepted.under === world) return { kind: "accepted", path: accepted.path };
    // A close view waiting to be accepted is the row's (a discarded one is gone at once, and Make
    // again discards before it asks, so a newer request never stands behind an older picture).
    const take = pendingClose(sheet, chosen.id);
    if (take !== null) return { kind: "made", take };
    const request = closeAsked[chosen.id];
    if (request !== undefined && queueRefused[request] !== undefined) return { kind: "failed", reason: queueRefused[request]!.reason, retry: true };
    // A request asked here is followed by its own job; otherwise the newest close job of this look.
    const job = request !== undefined ? lookJobs(jobs, (params) => params["lookBatch"] === request)[0] : lookJobs(jobs, (params) => params["lookFraming"] === "close" && params["lookOfLook"] === chosen.id)[0];
    const ended = lookJobState(job);
    if (ended?.state === "failed") return { kind: "failed", reason: ended.reason, retry: ended.retry };
    return ended?.state === "making" || request !== undefined ? { kind: "making" } : { kind: "none" };
  };
  const makeClose = (row: Row, chosen: CharacterLook) => {
    if (row.sheet === undefined) return;
    const request = makeChapterLook(worldId, row.sheet, { framing: "close", prompt: lookClothing(chosen), count: 1, closeOf: { lookId: chosen.id } });
    if (request !== null) setCloseAsked((heldAsks) => ({ ...heldAsks, [chosen.id]: request }));
  };
  const detailActions = (
          <div className="fy-look__detailactions">
            {addable.length > 0 && (
              <Select
                label="Add"
                value=""
                disabled={off}
                onChange={(event) => {
                  const sheet = addable.find((candidate) => candidate.id === event.target.value);
                  if (sheet !== undefined) setAdding((heldRows) => [...heldRows, { key: sheet.id, name: sheet.name, sheet: sheet.id }]);
                }}
                data-testid="look-add"
              >
                <option value="">Add a character</option>
                {addable.map((sheet) => (
                  <option key={sheet.id} value={sheet.id}>
                    {sheet.name}
                  </option>
                ))}
              </Select>
            )}
            {/* Keep the target in place until click: blurring a new character inserts its compact
                row. Focus here then sends that field write before the explicit derive request. */}
            <Button variant="outline" disabled={off || asked !== null} onPointerDown={(event) => event.preventDefault()} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); derive(); }} data-testid="look-derive">
              {asked !== null ? "Reading…" : look === null ? "Derive" : "Derive again"}
            </Button>
          </div>
  );
  const renderRow = (row: Row, view: "overview" | "details") => row.line !== undefined && row.sheet !== undefined ? (
    <CharacterRow
      view={view}
      key={row.id}
      row={row}
      kit={kitOf(world, row.sheet)}
      slug={slug}
      orderOf={orderOf}
      off={off}
      onWrite={write}
      onNewLook={(entry) => setMaking({ key: entry.id, name: entry.label ?? entry.id, sheet: entry.sheet!, line: entry.text })}
      onBrowse={(entry) => setBrowsing(entry.id)}
      closeState={(chosen) => closeStateFor(row.sheet!, chosen)}
      onMakeClose={makeClose}
      onAcceptClose={(entry, chosen, take) => {
        // Shown at once only when the command went: a closed connection sends nothing.
        if (!acceptChapterLook(worldId, entry.sheet!, take.id, { closeFor: chosen.id })) return;
        setCloseAccepted((heldViews) => ({ ...heldViews, [chosen.id]: { path: take.path, under: world } }));
      }}
      onDiscardClose={(chosen, takeId, again) => {
        // Hidden at once only when the command went (codex on PR 1559); a take another window
        // decided is gone from the snapshot anyway.
        if (!rejectReferenceTake(worldId, takeId, "close view", again ? "made again" : "discarded")) return;
        setDiscarded((heldTakes) => [...heldTakes, { takeId, under: world }]);
        setCloseAsked(({ [chosen.id]: _gone, ...rest }) => rest);
        if (again) makeClose(row, chosen);
      }}
    />
  ) : (
    view === "details" ? <LookLine key={row.id} row={row} disabled={off} onWrite={write} /> : <div className="fy-look__unlinked" key={row.id}><b>{row.label}</b><p className="fy-ch__who-where--warn">Identity not linked · confirm which character this is in Chapter details</p></div>
  );
  const chapter = world?.productions.find((production) => production.meta.id === productionId)?.chapters.find((entry) => entry.file === chapterFile);
  const footer = <><span className="fy-look__footcount">{chosenCount} chosen look{chosenCount === 1 ? "" : "s"} · {count} character{count === 1 ? "" : "s"}</span><span className="fy-ch__panelpush" /><Button variant="primary" onClick={onClose} data-testid="look-done">Done</Button></>;
  return (
    <>
      <PageSheet preserveReturnFocus open={open} onClose={onClose} title="Looks" subtitle={`Chapter ${chapterOrder}${chapter?.title ? ` · ${chapter.title}` : ""}`} className="fy-look" footer={footer}>
        <div className="fy-look__body" data-testid="look-sheet">
          {rows.length === 0 && adding.length === 0 && (
            <p className="fy-mono fy-look__none" data-testid="look-none">
              {asked !== null ? "reading…" : "not read"}
            </p>
          )}
          {rows.filter((row) => row.line !== undefined).map((row) => renderRow(row, "overview"))}
          <p className="fy-look__hint">A chapter look applies to new pictures. Existing pictures stay as they are.</p>
          {refused !== null && <p className="fy-mono fy-ch__who-where--warn" data-testid="look-refused">{refused}</p>}
          <details className="fy-look__chapterdetails" data-testid="look-chapter-details">
            <summary>Chapter details</summary>
            <div className="fy-look__chapterfields">
          {rows.map((row) => renderRow(row, "details"))}
          {adding.map((entry) => (
            <LookLine
              key={`new-${entry.key}`}
              row={{ id: entry.key, target: { kind: "character", key: entry.key, name: entry.name, ...(entry.sheet !== undefined ? { sheet: entry.sheet } : {}) }, label: entry.name, text: "", ...(entry.sheet !== undefined ? { sheet: entry.sheet } : {}), source: null }}
              disabled={off}
              onWrite={(target, text) => {
                write(target, text);
                if (text !== null) setAdding((heldRows) => heldRows.filter((candidate) => candidate.key !== entry.key));
              }}
            />
          ))}
          {detailActions}
          <p className="fy-look__savehint">Edits save when you leave a field. Done closes this sheet and returns to where you were.</p>
          <p className="fy-look__savehint">Derive again refreshes these details from the chapter.</p>
          {look !== null && <p className="fy-look__savehint" data-testid="look-summary">{saving ? "Saving…" : "Saved"} · {count} character{count === 1 ? "" : "s"} · {chosenCount} chosen look{chosenCount === 1 ? "" : "s"}</p>}
            </div>
          </details>

        </div>
      </PageSheet>
      {browsing !== null && (() => {
        const row = rows.find((entry) => entry.id === browsing);
        return row?.sheet === undefined ? null : <SavedLookCollection worldId={worldId} productionId={productionId} sheetId={row.sheet} name={row.label ?? row.id} chapterOrder={chapterOrder} currentId={row.line?.lookId ?? null} sourceOrder={row.line?.from === undefined ? null : orderOf(row.line.from)} onClose={() => setBrowsing(null)} onChoose={(id) => { choose(row, id); setBrowsing(null); }} onNewLook={() => { setBrowsing(null); setMaking({ key: row.id, name: row.label ?? row.id, sheet: row.sheet!, line: row.text }); }} />;
      })()}
      {making !== null && (
        <NewLookSheet open onClose={() => setMaking(null)} worldId={worldId} productionId={productionId} chapterFile={chapterFile} chapterOrder={chapterOrder} who={{ key: making.key, name: making.name, sheet: making.sheet }} line={making.line} />
      )}
    </>
  );
}

/** The panel's one line about the look: how many people it holds, or that it has not been read. */
export function lookCount(look: AudiobookLook | null | undefined): string {
  if (look === undefined || look === null) return "not read";
  const count = Object.keys(look.characters).length;
  return `${count} character${count === 1 ? "" : "s"}`;
}
