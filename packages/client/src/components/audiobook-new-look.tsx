import { useEffect, useMemo, useState } from "react";
import { chapterLooksOf, estimateCharacterImageMicroUsd, mainPhotoFor, priceLabel, type Take } from "@arke-studio/contracts";
import { resolveModel, worldModel } from "./dispatch-bar.js";
import { PageSheet } from "./page-sheet.js";
import { SavedLookCollection } from "./saved-look-collection.js";
import { mediaUrl } from "../lib/media.js";
import { acceptChapterLook, chooseAudiobookLook, makeChapterLook, useStore } from "../lib/store.js";
import { lookJobState, lookJobs, useQueueRefusals, type LookJobState } from "./look-jobs.js";
import { Button, Checkbox, Input, Textarea, cx } from "./ui.js";

/**
 * Making a look (design turn 193b, SPEC-047 R-112, R-118): a character's main photo and a clothing
 * line become three full-length candidates on a plain ground, under the book's art direction, with
 * the main photo as the face reference; the author chooses one, an optional close view of it (head
 * and shoulders, on by default, at the image model's own price for one picture from two references —
 * GPT Image 2's is ~$0.26, not the ~$0.04 the drawing guessed) is made beside the candidates, and
 * Accept look files both as a kit look of kind costume — chosen for the chapter that asked, by
 * default. Nothing is made until Make, which is the price the sheet shows; nothing here reaches the
 * writing service. A candidate or a close view the provider refuses says so in its slot, with the
 * reason, and never stays `making` (2026-10-04).
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
  const [lookName, setLookName] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [closeOn, setCloseOn] = useState(true);
  const [chooseOn, setChooseOn] = useState(true);
  const [batch, setBatch] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  /** Close views already asked for, by the candidate they are of, with the request that asked: asked once, never twice by a second press. */
  const [asked, setAsked] = useState<Record<string, string>>({});
  const queueRefused = useQueueRefusals();
  useEffect(() => {
    if (!open) return;
    setClothing(line);
    setLookName("");
    setBrowsing(false);
    setCloseOn(true);
    setChooseOn(true);
    setBatch(null);
    setChosen(null);
    setAsked({});
  }, [open, worldId, chapterFile, who.key]);

  const kit = world?.referenceKits.find((candidate) => candidate.sheetId === who.sheet) ?? null;
  const photo = kit === null ? null : mainPhotoFor(kit);
  const model = resolveModel(store.state, "image", undefined, worldModel(store.state, "image")).model;
  const pending = useMemo(() => (world === null ? [] : pendingLooks(world.referenceTakes, world.referenceReviews, who.sheet)), [world, who.sheet]);
  const candidates = pending.filter((take) => batch !== null && take.params["lookBatch"] === batch && take.params["lookFraming"] === "full-body").sort((a, b) => (a.id < b.id ? -1 : 1));
  const chosenTake = candidates.find((take) => take.id === chosen) ?? null;
  const closeTake = chosenTake === null ? null : (pending.find((take) => take.params["lookFraming"] === "close" && take.params["lookOfTake"] === chosenTake.id) ?? null);
  const jobs = store.state?.app.jobs ?? [];
  // The batch's jobs and the close view's: a job that ended without a picture is a slot that says
  // why, never one left making (2026-10-04, a close view the safety system refused).
  const batchJobs = batch === null ? [] : lookJobs(jobs, (params) => params["lookBatch"] === batch && params["lookFraming"] === "full-body");
  const batchFailures = batchJobs.map(lookJobState).filter((state): state is Extract<LookJobState, { state: "failed" }> => state?.state === "failed");
  const batchRefused = batch === null ? undefined : queueRefused[batch];
  const closeRequest = chosenTake === null ? undefined : asked[chosenTake.id];
  const closeJob = closeRequest === undefined ? undefined : lookJobs(jobs, (params) => params["lookBatch"] === closeRequest)[0];
  const closeEnded = lookJobState(closeJob);
  const closeFailed = closeTake !== null || closeRequest === undefined ? null : (queueRefused[closeRequest]?.reason ?? (closeEnded?.state === "failed" ? closeEnded.reason : null));
  // A picture made and paid for whose filing failed is Activity's to retry, at no charge: no paid Try again.
  const closeRetry = closeFailed !== null && !(closeEnded?.state === "failed" && !closeEnded.retry && queueRefused[closeRequest ?? ""] === undefined);
  const closeWaiting = closeOn && chosenTake !== null && closeTake === null && closeRequest !== undefined && closeFailed === null;
  const looks = chapterLooksOf(kit);

  const plan = model?.pricing.kind === "included-plan" ? "included-plan" : undefined;
  const priceOf = (images: number, references: number): string => (model === null ? "" : priceLabel(estimateCharacterImageMicroUsd(model, "character-look", images, references), plan));
  const manyCost = priceOf(LOOK_CANDIDATES, LOOK_CANDIDATES);
  const closeCost = priceOf(1, 2);
  const againCost = model === null ? "" : priceLabel(estimateCharacterImageMicroUsd(model, "character-look", LOOK_CANDIDATES, LOOK_CANDIDATES) + (closeOn ? estimateCharacterImageMicroUsd(model, "character-look", 1, 2) : 0), plan);

  const askClose = (takeId: string, again = false) => {
    if (asked[takeId] !== undefined && !again) return;
    const request = makeChapterLook(worldId, who.sheet, { framing: "close", prompt: clothing.trim(), count: 1, closeOf: { takeId } });
    if (request !== null) setAsked((held) => ({ ...held, [takeId]: request }));
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
      ...(lookName.trim() ? { name: lookName.trim() } : {}),
      ...(closeOn && closeTake !== null ? { closeTakeId: closeTake.id } : {}),
      ...(chooseOn ? { choose: { productionId, chapterFile, key: who.key, name: who.name, sheet: who.sheet } } : {}),
    });
    onClose();
  };
  const canMake = !off && photo !== null && model !== null && clothing.trim() !== "";
  const slug = world?.meta.slug ?? "";

  const footer = (
        <div className="fy-newlook__foot">
          <Checkbox label={`Choose for Chapter ${chapterOrder}`} checked={chooseOn} disabled={off} onChange={(event) => setChooseOn(event.target.checked)} data-testid="new-look-choose" />
          <span className="fy-ch__panelpush" />
          <Button variant="ghost" onClick={onClose} data-testid="new-look-cancel">
            Cancel
          </Button>
          {batch !== null && (
            <Button variant="secondary" disabled={!canMake} onClick={make} data-testid="new-look-again">
              {plan ? "Make again" : `Make again · ${againCost}`}
            </Button>
          )}
          <Button variant="primary" disabled={off || chosenTake === null || (closeOn && closeTake === null && closeWaiting)} onClick={accept} data-testid="new-look-accept">
            Accept look
          </Button>
        </div>
  );
  return (
    <>
    <PageSheet preserveReturnFocus open={open} onClose={onClose} title={`New look · ${who.name}`} className="fy-newlook" footer={footer}>
      <div className="fy-newlook__body" data-testid="new-look-sheet">
        <div className="fy-newlook__top">
          <div className="fy-newlook__photo" data-testid="new-look-photo" hidden>
            {photo !== null ? <img src={mediaUrl(slug, `references/${who.sheet}/${photo.file}`)} alt="" /> : <i aria-hidden="true" />}
            <span className="fy-mono">Main photo</span>
          </div>
          <div className="fy-newlook__clothing">
            <b>Clothing</b>
            <Textarea aria-label="Clothing" rows={3} value={clothing} disabled={off} onChange={(event) => setClothing(event.target.value)} data-testid="new-look-clothing" />
          </div>
          <label className="fy-newlook__clothing">Look name <span className="fy-mono">Optional</span><Input aria-label="Look name" value={lookName} maxLength={60} disabled={off} onChange={(event) => setLookName(event.target.value)} data-testid="new-look-name" /></label>
        </div>
        <div className="fy-newlook__fixed" data-testid="new-look-fixed"><span>Full body · plain background · art direction v{world?.artDirection.version ?? 1}</span><Checkbox label={plan ? "Close view" : `Close view · ${closeCost}`} checked={closeOn} disabled={off} onChange={(event) => { setCloseOn(event.target.checked); if (event.target.checked && chosenTake !== null) askClose(chosenTake.id); }} data-testid="new-look-close-box" /></div>
        <div className="fy-newlook__candheader">
          <b>Candidates</b>
          <span className="fy-mono" data-testid="new-look-price">
            {batch !== null ? `${candidates.length} of ${LOOK_CANDIDATES} ready · ` : `${LOOK_CANDIDATES} pictures · `}{plan ? "Included in your plan" : manyCost}
            {closeOn && !plan ? ` · close view ${closeCost}` : ""}
          </span>
          {batch === null && (
            <Button variant="primary" disabled={!canMake} onClick={make} data-testid="new-look-make">
              {plan ? "Make" : `Make · ${manyCost}`}
            </Button>
          )}
        </div>
        {photo === null && <p className="fy-mono fy-ch__who-where--warn" data-testid="new-look-nophoto">{who.name} has no main photo yet</p>}
        <div className="fy-newlook__cands" data-testid="new-look-candidates">
          {batch === null
            ? null
            : Array.from({ length: LOOK_CANDIDATES }, (_, index) => {
                const take = candidates[index];
                // The slots past the pictures made: those whose job ended without one say why, last.
                // A picture the coordinator would not queue has no job: counted from its answer, not left making.
                const left = LOOK_CANDIDATES - candidates.length;
                const unqueued = batchRefused === undefined ? 0 : batchRefused.whole ? LOOK_CANDIDATES : batchRefused.count;
                const reasons = [...batchFailures.map((failure) => failure.reason), ...Array.from({ length: unqueued }, () => batchRefused!.reason)];
                const failedSlots = Math.min(reasons.length, left);
                if (take === undefined && index >= LOOK_CANDIDATES - failedSlots) {
                  const reason = reasons[index - (LOOK_CANDIDATES - failedSlots)] ?? "not made";
                  return (
                    <div key={`failed-${index}`} className="fy-newlook__cand fy-newlook__cand--wait" data-testid="new-look-candidate" data-state="failed">
                      <span className="fy-mono fy-ch__who-where--warn" data-testid="new-look-candidate-reason">{reason}</span>
                    </div>
                  );
                }
                if (take === undefined) return <div key={`wait-${index}`} className="fy-newlook__cand fy-newlook__cand--wait" data-testid="new-look-candidate" data-state="making"><span className="fy-mono">Making {String.fromCharCode(65 + index)}…</span></div>;
                return (
                  <button key={take.id} type="button" className={cx("fy-newlook__cand", chosen === take.id && "fy-newlook__cand--on")} aria-pressed={chosen === take.id} aria-label={`Candidate ${String.fromCharCode(65 + index)}`} data-testid="new-look-candidate" data-state={chosen === take.id ? "chosen" : "made"} onClick={() => choose(take)}>
                    <img src={tileOf(slug, who.sheet, take)} alt="" />
                    <span className="fy-mono">{String.fromCharCode(65 + index)}{chosen === take.id ? " · chosen" : ""}</span>
                  </button>
                );
              })}
          {closeOn && chosenTake !== null && (
            <div className="fy-newlook__close" data-testid="new-look-close" data-state={closeTake !== null ? "made" : closeFailed !== null ? "failed" : closeWaiting ? "making" : "none"}>
              {closeTake !== null ? <img src={tileOf(slug, who.sheet, closeTake)} alt="" /> : <i aria-hidden="true" />}
              <span className="fy-mono">Close view</span>
              {closeFailed !== null && (
                <>
                  <span className="fy-mono fy-ch__who-where--warn" data-testid="new-look-close-reason">{closeFailed}</span>
                  {closeRetry && (
                    <button type="button" className="fy-sugg__make" disabled={off} onClick={() => askClose(chosenTake.id, true)} data-testid="new-look-close-retry">
                      Try again · {closeCost}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <details className="fy-newlook__looks" data-testid="new-look-looks"><summary>Saved looks · {looks.length}</summary><Button variant="ghost" onClick={() => setBrowsing(true)} data-testid="new-look-browse">Browse saved looks</Button></details>

      </div>
    </PageSheet>
    {open && browsing && <SavedLookCollection worldId={worldId} productionId={productionId} sheetId={who.sheet} name={who.name} chapterOrder={chapterOrder} currentId={null} fromNewLook onClose={() => setBrowsing(false)} onChoose={(id) => { if (id !== null && chooseAudiobookLook(worldId, productionId, chapterFile, who, id) !== null) { setBrowsing(false); onClose(); } }} />}
    </>
  );
}
