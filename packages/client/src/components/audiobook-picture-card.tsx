import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Check } from "./icons.js";
import { CLOSE_FRAMES, frameWord, lookName, priceLabel, type PictureShot, type PictureSuggestion, type PictureWho, type ReferenceKit, type WorldBundle } from "@arke-studio/contracts";
import { mediaUrl } from "../lib/media.js";
import type { PictureSuggestionState } from "./audiobook-suggest.js";
import { Button, Textarea, cx } from "./ui.js";

/**
 * A block's picture card (design turn 193c, rules 13 and 14; SPEC-047 R-122): the picture's slot
 * beside its facts — Frame, Rides, the model and ratio, the price — then In frame, a row a person
 * with both of their look's images (the one that rides ringed, the other dim, the frame as the
 * reason) and their expression, Not in frame as dashed names, the prompt to edit, and the seven
 * checks, each ticked or marked. The author reads the words, then the card, and sees at once whether
 * the frame, the people and the references are what the words say. A mark never blocks Generate.
 */

/** What rides, as the card's Rides line says it: `Close view`, `2 close views`, `Full body`, `Main photo`, `Place view`, `no reference · no faces`. */
export function ridesLabel(who: readonly PictureWho[], shot: Pick<PictureShot, "frame"> | undefined): string {
  if (shot !== undefined && frameWord(shot.frame) === "Detail") return "no reference · no faces";
  const people = who.filter((entry) => entry.kind === "character" && entry.carried);
  if (people.length === 0) return who.some((entry) => entry.kind === "place" && entry.carried) ? "Place view" : "no reference";
  const close = people.filter((entry) => entry.look?.view === "close").length;
  const full = people.filter((entry) => entry.look?.view === "full").length;
  const main = people.length - close - full;
  const line = [
    close > 0 ? (close === 1 ? "close view" : `${close} close views`) : null,
    full > 0 ? (full === 1 ? "full body" : `${full} full body`) : null,
    main > 0 ? (main === 1 ? "main photo" : `${main} main photos`) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

/** Why a person's image rides (193c): `close frame`, `wide frame`, `no close view` for a face frame the look cannot serve, or `head and shoulders` with no look. */
export function rideReason(who: Pick<PictureWho, "look">, shot: Pick<PictureShot, "frame"> | undefined, hasClose: boolean): string {
  if (who.look === undefined) return "head and shoulders";
  if (who.look.view === "close") return "close frame";
  const word = frameWord(shot?.frame);
  return !hasClose && word !== null && CLOSE_FRAMES.has(word) ? "no close view" : "wide frame";
}

function Thumb({ slug, file, on, view }: { slug: string; file: string; on: boolean; view: string }) {
  return <img className={cx("fy-pcard__thumb", on ? "fy-pcard__thumb--on" : "fy-pcard__thumb--dim")} src={mediaUrl(slug, file)} alt="" data-testid="picture-card-thumb" data-view={view} data-on={on ? "true" : "false"} />;
}

/**
 * One person in frame, or the place (194g): a bordered row — the image that rides, ringed, the
 * name over the look and its view, and why that image rides at the row's end. The expression the
 * prompt names is the expression check's, and the image that does not ride is the Looks sheet's.
 */
function InFrameRow({ who, kits, slug, shot, onMake }: { who: PictureWho; kits: readonly ReferenceKit[]; slug: string; shot: PictureShot | undefined; onMake: (who: PictureWho) => void }) {
  const look = who.look === undefined || who.sheet === undefined ? undefined : kits.find((kit) => kit.sheetId === who.sheet)?.looks?.find((candidate) => candidate.id === who.look!.lookId);
  const state = who.reference === null ? "none" : who.carried ? "carried" : "over";
  const riding = look !== undefined && who.sheet !== undefined
    ? { file: `references/${who.sheet}/${who.look?.view === "close" && look.closeFile !== undefined ? look.closeFile : look.file}`, view: who.look?.view === "close" && look.closeFile !== undefined ? "close" : "full" }
    : who.reference !== null ? { file: who.reference, view: who.kind === "place" ? "place" : "main" } : null;
  return (
    <div className={cx("fy-pcard__who", state === "none" && "fy-pcard__who--miss", state === "over" && "fy-pcard__who--over")} data-testid="suggest-who" data-key={who.key} data-state={state}>
      {riding !== null ? <Thumb slug={slug} file={riding.file} on={who.carried} view={riding.view} /> : <i className="fy-pcard__thumb fy-pcard__thumb--none" aria-hidden="true" />}
      <span className="fy-pcard__whotx">
        <b>{who.name}</b>
        {who.reference === null ? (
          who.sheet !== undefined && (
            <button type="button" className="fy-sugg__make" onClick={() => onMake(who)} data-testid="suggest-make-reference">
              {who.kind === "place" ? "Make a reference" : "Make a look"}
            </button>
          )
        ) : (
          <span>
            {who.kind === "place" ? "place" : look !== undefined ? `${lookName(look)} · ${who.look?.view === "close" ? "close view" : "full body"}` : "main photo"}
            {who.carried ? "" : " · over the limit"}
          </span>
        )}
      </span>
      {/* A look's image rode for the frame: with no frame kept (a picture made before 194g), nothing says why. */}
      {who.kind === "character" && who.reference !== null && (shot !== undefined || who.look === undefined) && (
        <span className="fy-mono fy-pcard__why" data-testid="picture-card-why">
          {rideReason(who, shot, look?.closeFile !== undefined)}
        </span>
      )}
    </div>
  );
}

/**
 * The block's picture as the press that picks another from the world (186c's chooser). 194 draws
 * no Choose in the card's foot, so the picture itself is where choosing lives; it looks as drawn
 * and says what it does to the pointer and to a screen reader.
 */
export function PicturePress({ onChoose, children }: { onChoose: (() => void) | undefined; children: ReactNode }) {
  if (onChoose === undefined) return <>{children}</>;
  return (
    <button type="button" className="fy-pcard__pick" aria-label="Choose another picture" title="Choose another picture" onClick={onChoose} data-testid="audiobook-picture-open">
      {children}
    </button>
  );
}

/**
 * The card (193c; 194g): the picture's slot — the picture itself once one is set — beside Frame,
 * Rides and the model, then In frame, Not in frame, the prompt folded to three lines until it is
 * pressed, and the checks; Remove (or Discard), Edit prompt and Generate — Make again once a
 * picture is set — in the panel's foot.
 */
export function PictureCard({ world, worldId, state, onEdit, offline, picture = null, onRemove, onChoose }: {
  world: Pick<WorldBundle, "meta" | "referenceKits" | "sheets">;
  worldId: string;
  state: PictureSuggestionState;
  onEdit: (suggestion: PictureSuggestion, prompt: string) => void;
  offline: boolean;
  /** The picture set on the block, drawn in the slot. */
  picture?: string | null;
  onRemove?: () => void;
  /** Pick another picture from the world: the picture is the press. */
  onChoose?: () => void;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const { ask, making } = state;
  if (ask === null) return null;
  if (ask.state === "working") return <p className="fy-mono fy-ab__card-line" data-testid="suggest-reading">reading…</p>;
  if (ask.state === "refused") {
    return (
      <div className="fy-sugg" data-testid="suggest-refused">
        <p className="fy-mono fy-ch__who-where--warn">{ask.refused}</p>
        <div className="fy-abp__foot">
          <Button variant="outline" onClick={state.dismiss}>
            Discard
          </Button>
          <span className="fy-ch__panelpush" />
          <Button variant="primary" disabled={offline} onClick={state.suggest}>
            Suggest picture
          </Button>
        </div>
      </div>
    );
  }
  if (ask.state !== "suggested") return null;
  const suggestion = ask.suggestion;
  const shot = suggestion.shot;
  const prompt = state.prompt ?? suggestion.prompt;
  const busy = making?.state === "working";
  const failed = making?.state === "failed" ? making : null;
  const slug = world.meta.slug;
  const nameOf = (key: string): string => world.sheets.find((sheet) => sheet.id === key)?.name ?? key;
  const detail = shot !== undefined && frameWord(shot.frame) === "Detail";
  const make = (who: PictureWho) => void navigate(`/w/${worldId}/${who.kind === "place" ? "locations" : "cast"}/${who.sheet}`);
  return (
    <div className="fy-sugg fy-pcard" data-testid="suggest-card">
      <div className="fy-pcard__top">
        {picture !== null ? (
          <PicturePress onChoose={busy ? undefined : onChoose}>
            <img className="fy-pcard__img" src={picture} alt="" data-testid="picture-card-picture" />
          </PicturePress>
        ) : (
          <div className="fy-pcard__slot" aria-hidden="true">
            <span className="fy-mono">{suggestion.aspect ?? ""}</span>
          </div>
        )}
        <div className="fy-pcard__facts" data-testid="picture-card-facts">
          {shot !== undefined && shot.frame !== "" && (
            <div className="fy-pcard__fact">
              <span className="fy-mono">Frame</span>
              <b data-testid="picture-card-frame">{shot.frame}</b>
            </div>
          )}
          <div className="fy-pcard__fact">
            <span className="fy-mono">Rides</span>
            <b data-testid="picture-card-rides">{ridesLabel(suggestion.who, shot)}</b>
          </div>
          <div className="fy-pcard__fact">
            <span className="fy-mono">Model</span>
            {/* The model and the price, as the master draws it; the shape is on the empty slot, and here as its tooltip. */}
            <b data-testid="picture-card-model" {...(suggestion.aspect !== undefined ? { title: suggestion.aspect } : {})}>
              {suggestion.model.name} · {priceLabel(suggestion.estimatedMicroUsd, suggestion.model.plan)}
            </b>
          </div>
        </div>
      </div>
      <div className="fy-pcard__sec" data-testid="picture-card-in-frame">
        <span className="fy-pcard__h">In frame</span>
        {suggestion.who.length === 0 ? (
          <span className="fy-pcard__none">{detail ? "no one · a detail" : "no one"}</span>
        ) : (
          suggestion.who.map((who) => <InFrameRow key={who.key} who={who} kits={world.referenceKits} slug={slug} shot={shot} onMake={make} />)
        )}
        {shot !== undefined &&
          shot.details.map((entry) => (
            <span key={`${entry.of}-${entry.part}`} className="fy-pcard__expr fy-mono" data-testid="picture-card-detail">
              {nameOf(entry.of)} · {entry.part}
              {entry.state !== undefined ? ` · ${entry.state}` : ""}
            </span>
          ))}
      </div>
      {shot !== undefined && shot.notInFrame.length > 0 && (
        <div className="fy-abp__kv fy-pcard__out" data-testid="picture-card-not-in-frame">
          <span className="fy-abp__k">Not in frame</span>
          <span className="fy-abp__v fy-abp__v--off">{shot.notInFrame.map(nameOf).join(" · ")}</span>
        </div>
      )}
      <div className="fy-pcard__sec">
        <span className="fy-pcard__h">Prompt</span>
        {editing || busy ? (
          <Textarea className="fy-sugg__prompt" aria-label="Prompt" rows={5} value={prompt} disabled={busy} autoFocus={editing} onChange={(event) => state.setPrompt(event.target.value)} />
        ) : (
          <button type="button" className="fy-pcard__prompt" aria-label="Prompt" onClick={() => setEditing(true)} data-testid="picture-card-prompt">
            <span>{prompt}</span>
          </button>
        )}
      </div>
      {shot !== undefined && shot.checks.length > 0 && (
        <ul className="fy-pcard__checks" data-testid="picture-card-checks">
          {shot.checks.map((check) => (
            <li key={check.id} className={cx("fy-pcard__check", !check.ok && "fy-pcard__check--mark")} data-testid="picture-card-check" data-check={check.id} data-ok={check.ok ? "true" : "false"}>
              <i aria-hidden="true">{check.ok ? <Check size={12} /> : "!"}</i>
              <span>{check.label}</span>
              {check.note !== undefined && <span className="fy-mono">{check.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {failed !== null && (
        <p className="fy-mono fy-ch__who-where--warn" data-testid="suggest-failed">
          {failed.reason}
        </p>
      )}
      <div className="fy-abp__foot">
        {onRemove !== undefined ? (
          <Button variant="outline" disabled={offline || busy} onClick={onRemove} data-testid="audiobook-picture-remove">
            Remove
          </Button>
        ) : (
          <Button variant="outline" onClick={state.dismiss} disabled={busy}>
            Discard
          </Button>
        )}
        <span className="fy-ch__panelpush" />
        <Button variant="outline" disabled={offline || busy} onClick={() => onEdit(suggestion, prompt)} data-testid="suggest-edit">
          Edit prompt
        </Button>
        <Button variant="primary" disabled={offline || busy || prompt.trim() === ""} onClick={() => state.generate(suggestion, prompt)} data-testid="suggest-generate">
          {busy ? "Generating…" : `${picture !== null ? "Make again" : "Generate"} · ${priceLabel(suggestion.estimatedMicroUsd, suggestion.model.plan)}`}
        </Button>
      </div>
    </div>
  );
}
