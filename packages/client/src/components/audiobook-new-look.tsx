import { useEffect, useMemo, useState } from "react";
import { chapterLooksOf, estimateCharacterImageMicroUsd, mainPhotoFor, priceLabel, type CharacterLook, type Take } from "@arke-studio/contracts";
import { resolveModel, worldModel } from "./dispatch-bar.js";
import { EditorDialog } from "./editor-dialog.js";
import { mediaUrl } from "../lib/media.js";
import { acceptChapterLook, makeChapterLook, useStore } from "../lib/store.js";
import { Button, Checkbox, Textarea, cx } from "./ui.js";

/**
 * Making a look (design turn 193b, SPEC-047 R-112, R-109): a character's main photo and a clothing
 * line become three full-length candidates on a plain ground, under the book's art direction, with
 * the main photo as the face reference; the author chooses one, an optional close view of it (head
 * and shoulders, ~$0.04, on by default) is made beside the candidates, and Accept look files both as
 * a kit look of kind costume — chosen for the chapter that asked, by default. Nothing is made until
 * Make, which is the price the sheet shows; nothing here reaches the writing service.
 */

/** Candidates asked for at a time (193b). */
export const LOOK_CANDIDATES = 3;

/** A take a look job left, still undecided: how a sheet finds its own among the kit's pending looks. */
function pendingLooks(takes: readonly Take[], reviews: ReadonlyArray<{ takeId: string }>, sheetId: string): Take[] {
  return takes.filter((take) => take.kind === "look" && take.reference?.sheetId === sheetId && take.media !== undefined && !reviews.some((review) => review.takeId === take.id));
}

const tileOf = (slug: string, sheetId: string, take: Take): string => mediaUrl(slug, `references/${sheetId}/takes/${take.id}/${take.media}`);

export function NewLookSheet({ open, onClose, worldId, productionId, chapterFile, chapterOrder, who, line }: {
  open: boolean;
  onClose: () => void;
  worldId: string;
  productionId: string;
  chapterFile: string;
  chapterOrder: number;
  /** The character: the look's key, name and sheet — a look is made from a sheet's main photo. */
  who: { key: string; name: string; sheet: string };
  /** The clothing line to start from: the chapter's own words for them, editable. */
  line: string;
}) {
  const store = useStore();
  const world = store.state?.world ?? null;
  const off = store.connection !== "open";
  const [clothing, setClothing] = useState(line);
  const [closeOn, setCloseOn] = useState(true);
  const [chooseOn, setChooseOn] = useState(true);
  const [batch, setBatch] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  /** Close views already asked for, by the candidate they are of: asked once, never twice by a second press. */
  const [asked, setAsked] = useState<Record<string, true>>({});
  useEffect(() => {
    if (!open) return;
    setClothing(line);
    setCloseOn(true);
    setChooseOn(true);
    setBatch(null);
    setChosen(null);
    setAsked({});
  }, [open, line]);

  const kit = world?.referenceKits.find((candidate) => candidate.sheetId === who.sheet) ?? null;
  const photo = kit === null ? null : mainPhotoFor(kit);
  const model = resolveModel(store.state, "image", undefined, worldModel(store.state, "image")).model;
  const pending = useMemo(() => (world === null ? [] : pendingLooks(world.referenceTakes, world.referenceReviews, who.sheet)), [world, who.sheet]);
  const candidates = pending.filter((take) => batch !== null && take.params["lookBatch"] === batch && take.params["lookFraming"] === "full-body").sort((a, b) => (a.id < b.id ? -1 : 1));
  const chosenTake = candidates.find((take) => take.id === chosen) ?? null;
  const closeTake = chosenTake === null ? null : (pending.find((take) => take.params["lookFraming"] === "close" && take.params["lookOfTake"] === chosenTake.id) ?? null);
  const closeWaiting = closeOn && chosenTake !== null && closeTake === null && asked[chosenTake.id] === true;
  const looks = chapterLooksOf(kit);

  const priceOf = (images: number, references: number): string => (model === null ? "" : priceLabel(estimateCharacterImageMicroUsd(model, "character-look", images, references)));
  const manyCost = priceOf(LOOK_CANDIDATES, LOOK_CANDIDATES);
  const closeCost = priceOf(1, 2);
  const againCost = model === null ? "" : priceLabel(estimateCharacterImageMicroUsd(model, "character-look", LOOK_CANDIDATES, LOOK_CANDIDATES) + (closeOn ? estimateCharacterImageMicroUsd(model, "character-look", 1, 2) : 0));

  const askClose = (takeId: string) => {
    if (asked[takeId] === true) return;
    if (makeChapterLook(worldId, who.sheet, { framing: "close", prompt: clothing.trim(), count: 1, closeOf: { takeId } }) !== null) setAsked((held) => ({ ...held, [takeId]: true }));
  };
  const make = () => {
    const request = makeChapterLook(worldId, who.sheet, { framing: "full-body", prompt: clothing.trim(), count: LOOK_CANDIDATES });
    if (request === null) return;
    setBatch(request);
    setChosen(null);
    setAsked({});
  };
  const choose = (take: Take) => {
    setChosen(take.id);
    if (closeOn) askClose(take.id);
  };
  const accept = () => {
    if (chosenTake === null) return;
    acceptChapterLook(worldId, who.sheet, chosenTake.id, {
      ...(closeOn && closeTake !== null ? { closeTakeId: closeTake.id } : {}),
      ...(chooseOn ? { choose: { productionId, chapterFile, key: who.key, name: who.name, sheet: who.sheet } } : {}),
    });
    onClose();
  };
  const canMake = !off && photo !== null && model !== null && clothing.trim() !== "";
  const slug = world?.meta.slug ?? "";

  return (
    <EditorDialog open={open} onClose={onClose} width={1060} title={`New look · ${who.name}`} subtitle={`for Chapter ${chapterOrder}`} panelClassName="fy-newlook">
      <div className="fy-newlook__body" data-testid="new-look-sheet">
        <div className="fy-newlook__top">
          <div className="fy-newlook__photo" data-testid="new-look-photo">
            {photo !== null ? <img src={mediaUrl(slug, `references/${who.sheet}/${photo.file}`)} alt="" /> : <i aria-hidden="true" />}
            <span className="fy-mono">Main photo</span>
          </div>
          <div className="fy-newlook__fixed" data-testid="new-look-fixed">
            <Checkbox label="Full body" checked disabled readOnly />
            <Checkbox label="Plain background" checked disabled readOnly />
            <Checkbox label={`Art direction · v${world?.artDirection.version ?? 1}`} checked disabled readOnly />
            <Checkbox label={`Close view · ${closeCost}`} checked={closeOn} disabled={off} onChange={(event) => {
              setCloseOn(event.target.checked);
              if (event.target.checked && chosenTake !== null) askClose(chosenTake.id);
            }} data-testid="new-look-close-box" />
          </div>
          <div className="fy-newlook__clothing">
            <b>Clothing</b>
            <Textarea aria-label="Clothing" rows={3} value={clothing} disabled={off} onChange={(event) => setClothing(event.target.value)} data-testid="new-look-clothing" />
          </div>
        </div>
        <div className="fy-newlook__candheader">
          <b>Candidates</b>
          <span className="fy-mono" data-testid="new-look-price">
            {LOOK_CANDIDATES} pictures · {manyCost}
            {closeOn ? ` · close view ${closeCost}` : ""}
          </span>
          {batch === null && (
            <Button variant="primary" disabled={!canMake} onClick={make} data-testid="new-look-make">
              Make · {manyCost}
            </Button>
          )}
        </div>
        {photo === null && <p className="fy-mono fy-ch__who-where--warn" data-testid="new-look-nophoto">{who.name} has no main photo yet</p>}
        <div className="fy-newlook__cands" data-testid="new-look-candidates">
          {batch === null
            ? null
            : Array.from({ length: LOOK_CANDIDATES }, (_, index) => {
                const take = candidates[index];
                if (take === undefined) return <i key={`wait-${index}`} className="fy-newlook__cand fy-newlook__cand--wait" data-testid="new-look-candidate" data-state="making" aria-hidden="true" />;
                return (
                  <button key={take.id} type="button" className={cx("fy-newlook__cand", chosen === take.id && "fy-newlook__cand--on")} aria-pressed={chosen === take.id} aria-label={`Candidate ${String.fromCharCode(65 + index)}`} data-testid="new-look-candidate" data-state={chosen === take.id ? "chosen" : "made"} onClick={() => choose(take)}>
                    <img src={tileOf(slug, who.sheet, take)} alt="" />
                    <span className="fy-mono">{String.fromCharCode(65 + index)}{chosen === take.id ? " · chosen" : ""}</span>
                  </button>
                );
              })}
          {closeOn && chosenTake !== null && (
            <div className="fy-newlook__close" data-testid="new-look-close" data-state={closeTake !== null ? "made" : closeWaiting ? "making" : "none"}>
              {closeTake !== null ? <img src={tileOf(slug, who.sheet, closeTake)} alt="" /> : <i aria-hidden="true" />}
              <span className="fy-mono">Close view</span>
            </div>
          )}
        </div>
        <div className="fy-newlook__looks" data-testid="new-look-looks">
          <b>Looks of {who.name}</b>
          {looks.length === 0 && <span className="fy-mono">none yet</span>}
          {looks.map((look: CharacterLook) => (
            <span key={look.id} className="fy-newlook__look fy-mono" data-testid="new-look-existing">
              {look.prompt.length > 40 ? `${look.prompt.slice(0, 40)}…` : look.prompt} · {look.closeFile !== undefined ? "full, close" : "full"}
            </span>
          ))}
        </div>
        <div className="fy-newlook__foot">
          <Checkbox label={`Choose for Chapter ${chapterOrder}`} checked={chooseOn} disabled={off} onChange={(event) => setChooseOn(event.target.checked)} data-testid="new-look-choose" />
          <span className="fy-ch__panelpush" />
          <Button variant="ghost" onClick={onClose} data-testid="new-look-cancel">
            Cancel
          </Button>
          {batch !== null && (
            <Button variant="secondary" disabled={!canMake} onClick={make} data-testid="new-look-again">
              Make again · {againCost}
            </Button>
          )}
          <Button variant="primary" disabled={off || chosenTake === null || (closeOn && closeTake === null && closeWaiting)} onClick={accept} data-testid="new-look-accept">
            Accept look
          </Button>
        </div>
      </div>
    </EditorDialog>
  );
}
