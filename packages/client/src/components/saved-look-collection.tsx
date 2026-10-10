import { useEffect, useId, useRef, useState } from "react";
import { chapterLooksOf, lookName, lookOlderFace, mainPhotoFor, type CharacterLook } from "@arke-studio/contracts";
import { mediaUrl } from "../lib/media.js";
import { readAudiobookLooks, renameSavedLook, subscribeLookRename, useAudiobookAsks, useStore } from "../lib/store.js";
import { PageSheet } from "./page-sheet.js";
import { Button, cx } from "./ui.js";

/** A lost thumbnail must not silently turn into the character's main photo. */
export function SavedLookImage({ src, className = "", alt = "" }: { src: string | null; className?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src === null || failed ? <span className={cx("fy-savedlook__image", "fy-savedlook__image--missing", className)} role="img" aria-label="Preview unavailable">Preview unavailable</span> : <img className={cx("fy-savedlook__image", className)} src={src} alt={alt} onError={() => setFailed(true)} />;
}

/** Turns 207/209: browsing a saved look is local; only Use changes the chapter. */
export function SavedLookCollection({ worldId, productionId, sheetId, name, chapterOrder, currentId, onChoose, onClose, onNewLook, fromNewLook = false }: {
  worldId: string;
  productionId: string;
  sheetId: string;
  name: string;
  chapterOrder: number;
  currentId: string | null;
  onChoose: (id: string | null) => void;
  onClose: () => void;
  onNewLook?: () => void;
  fromNewLook?: boolean;
}) {
  const store = useStore();
  const world = store.state?.world;
  const kit = world?.referenceKits.find((candidate) => candidate.sheetId === sheetId) ?? null;
  const available = chapterLooksOf(kit);
  // Completion of a background job may add a look. Append it here instead of shifting the row
  // the author is reading; names and usage can refresh without resetting the list's viewport.
  const order = useRef(available.map((look) => look.id));
  for (const look of available) if (!order.current.includes(look.id)) order.current.push(look.id);
  const looks = order.current.flatMap((id) => available.find((look) => look.id === id) ?? []);
  const [selection, setSelection] = useState<string | null>(currentId ?? (fromNewLook ? looks[0]?.id ?? null : null));
  const [query, setQuery] = useState("");
  const [rename, setRename] = useState<{ value: string; expected: string | null } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [usageRequest, setUsageRequest] = useState<string | null>(null);
  const asks = useAudiobookAsks();
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const optionIds = useId();
  const selected = looks.find((look) => look.id === selection) ?? null;
  const photo = kit === null ? null : mainPhotoFor(kit);
  const gone = selection !== null && selected === null;
  const off = store.connection !== "open" || world?.meta.worldId !== worldId;
  const needle = query.trim().toLocaleLowerCase();
  const matches = looks.filter((look) => `${lookName(look, looks)} ${look.prompt}`.toLocaleLowerCase().includes(needle));
  const showMain = !fromNewLook && (needle === "" || "main photo".includes(needle));
  const options = [...(showMain ? [null] : []), ...matches.map((look) => look.id)];
  const [focused, setFocused] = useState<string | null>(selection);
  const tabStop = options.includes(focused) ? focused : options[0];
  const usageAnswer = usageRequest === null ? undefined : asks[usageRequest];
  const usage = usageAnswer?.state === "looks" ? usageAnswer.usage : null;
  const usageLine = (id: string) => {
    if (usage === null) return usageAnswer?.state === "working" ? "Loading usage…" : "Usage unavailable";
    const chapters = usage[id] ?? [];
    return chapters.length === 0 ? "No chapters" : `Chapter${chapters.length === 1 ? "" : "s"} ${[...chapters].sort((a, b) => a - b).join(", ")}`;
  };
  const imageOf = (look: CharacterLook | null) => {
    const file = look === null ? photo?.file : look.file || look.closeFile;
    return file && world ? mediaUrl(world.meta.slug, `references/${sheetId}/${file}`) : null;
  };
  const closeRename = () => { setRename(null); setRenameError(null); renameButton.current?.focus(); };
  useEffect(() => { setUsageRequest(readAudiobookLooks(worldId, productionId)); }, [worldId, productionId]);
  useEffect(() => {
    if (rename !== null) renameInput.current?.focus();
  }, [rename === null]);
  useEffect(() => subscribeLookRename((answer) => {
    if (answer.requestId !== saving || answer.worldId !== worldId || answer.sheetId !== sheetId) return;
    setSaving(null);
    if (answer.error !== undefined) setRenameError(answer.error);
    else closeRename();
  }), [saving, worldId, sheetId]);
  useEffect(() => {
    if (off && saving !== null) {
      setSaving(null);
      setRenameError("Connection lost. Check the current name after reconnecting before saving again.");
    }
  }, [off, saving]);
  const saveName = () => {
    if (rename === null || selected === null || saving !== null || off) return;
    setRenameError(null);
    setSaving(renameSavedLook(worldId, sheetId, selected.id, rename.value, rename.expected));
  };
  const browse = (id: string | null) => { setSelection(id); setFocused(id); };
  const leave = () => { if (saving !== null) return; if (rename !== null) closeRename(); else onClose(); };
  return (
    <PageSheet preserveReturnFocus open title={`${fromNewLook ? "Saved looks" : "Choose look"} · ${name}`} onClose={leave} onBack={leave} className="fy-savedlook" footer={<>
      {fromNewLook ? <Button variant="ghost" onClick={leave} disabled={saving !== null}>Back to New look</Button> : <Button variant="ghost" onClick={leave} disabled={saving !== null}>Back to Looks</Button>}
      {onNewLook !== undefined && <Button variant="secondary" onClick={onNewLook} disabled={rename !== null}>New look</Button>}
      <span className="fy-ch__panelpush" />
      <Button variant="primary" disabled={off || gone || (fromNewLook && selected === null) || saving !== null || rename !== null} onClick={() => onChoose(selection)} data-testid="saved-look-use">Use for Chapter {chapterOrder}</Button>
    </>}>
      <div className="fy-savedlook__columns" data-testid="saved-look-collection">
        <div className="fy-savedlook__browse">
          <div className="fy-savedlook__count">{needle ? `${matches.length} of ${looks.length}` : looks.length} saved look{looks.length === 1 ? "" : "s"}</div>
          {(looks.length >= 8 || query !== "") && <input className="ui-input" ref={search} type="search" aria-label="Find a look" placeholder="Find a look" value={query} onChange={(event) => setQuery(event.target.value)} disabled={rename !== null} />}
          <div ref={list} className="fy-savedlook__list" role="listbox" aria-label={`${name}'s saved looks`} onKeyDown={(event) => {
            const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
            if ((!direction && event.key !== "Home" && event.key !== "End") || options.length === 0 || rename !== null) return;
            event.preventDefault();
            const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : Math.max(0, Math.min(options.length - 1, options.indexOf(focused) + direction));
            const id = options[index]!;
            browse(id);
            const button = list.current?.querySelectorAll<HTMLButtonElement>("[role=option]")[index];
            button?.focus(); button?.scrollIntoView?.({ block: "nearest" });
          }}>
            {options.map((id, index) => {
              const look = id === null ? null : looks.find((entry) => entry.id === id)!;
              return <button key={id ?? "main"} id={`${optionIds}-${index}`} type="button" role="option" aria-selected={selection === id} tabIndex={tabStop === id ? 0 : -1} disabled={rename !== null} className={cx("fy-savedlook__row", selection === id && "fy-savedlook__row--on")} onClick={() => browse(id)} onFocus={() => setFocused(id)} data-testid="saved-look-option" data-look={id ?? "main"}>
                <SavedLookImage src={imageOf(look)} />
                <span className="fy-savedlook__words"><b>{look === null ? "Main photo" : lookName(look, looks)}</b><small>{look === null ? "Head and shoulders" : usageLine(look.id)}</small>{look !== null && kit !== null && lookOlderFace(kit, look) && <small className="fy-ch__who-where--warn">Older face</small>}</span><span className="fy-savedlook__check" aria-hidden="true">{selection === id ? "✓" : ""}</span>
              </button>;
            })}
            {options.length === 0 && <div className="fy-savedlook__empty"><span>{needle ? "No looks found" : "No saved looks"}</span>{needle && <Button variant="secondary" onClick={() => { setQuery(""); search.current?.focus(); }}>Clear search</Button>}</div>}
          </div>
        </div>
        <div className="fy-savedlook__selected">
          {gone ? <p role="status">This saved look is no longer available. Choose another look.</p> : fromNewLook && selected === null ? <p role="status">Make a look to start this collection.</p> : <>
            <div className="fy-savedlook__preview"><SavedLookImage src={imageOf(selected)} className="fy-savedlook__full" /><div><h3>{selected === null ? "Main photo" : lookName(selected, looks)}</h3><p>{selected === null ? "Head and shoulders" : `${selected.closeFile ? "Full body + close" : "Full body"} · ${usageLine(selected.id)}`}</p>
              {selected !== null && <Button ref={renameButton} variant="ghost" onClick={() => { setRename({ value: selected.name ?? "", expected: selected.name ?? null }); setRenameError(null); }} disabled={off || rename !== null} data-testid="saved-look-rename">Rename</Button>}
            </div></div>
            {rename !== null && <form className="fy-savedlook__rename" onSubmit={(event) => { event.preventDefault(); saveName(); }}><label>Look name<input className="ui-input" ref={renameInput} value={rename.value} maxLength={60} onChange={(event) => setRename({ ...rename, value: event.target.value })} disabled={saving !== null} /></label><p>A name for this saved look, wherever you use it.</p><div><Button variant="ghost" type="button" onClick={closeRename} disabled={saving !== null}>Cancel</Button><Button variant="primary" type="submit" disabled={off || saving !== null || gone}>{saving !== null ? "Saving…" : "Save name"}</Button></div>{renameError !== null && <p role="alert">Name not saved. {renameError}</p>}</form>}
            {selected !== null && <details className="fy-savedlook__details"><summary>Details</summary><p className="fy-savedlook__prompt">{selected.prompt}</p><dl><dt>Name</dt><dd>{lookName(selected, looks)}</dd><dt>Used in</dt><dd>{usage === null ? usageLine(selected.id) : (usage[selected.id]?.length ?? 0) === 0 ? "No chapters" : usage[selected.id]!.map((order, i) => {
              const chapter = world?.productions.find((production) => production.meta.id === productionId)?.chapters.find((entry) => entry.order === order);
              return <span key={order}>{i ? ", " : ""}{chapter ? <a href={`#/w/${worldId}/p/${productionId}/story/chapters/${chapter.file}?view=audiobook`}>Chapter {order}</a> : `Chapter ${order}`}</span>;
            })}</dd><dt>Views</dt><dd>{selected.closeFile ? "Full body and close view" : "Full body"}</dd><dt>Accepted</dt><dd>{new Date(selected.acceptedAt).toLocaleString()}</dd>{kit !== null && <><dt>Face</dt><dd>{lookOlderFace(kit, selected) ? "Older face" : "Main photo"}</dd></>}</dl></details>}
          </>}
          {off && <p role="status">Reconnect to use or rename a look.</p>}
        </div>
      </div>
    </PageSheet>
  );
}
