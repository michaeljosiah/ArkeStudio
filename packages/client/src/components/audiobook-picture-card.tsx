import { useNavigate } from "react-router";
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

/** One person in frame, or the place: both look images (the riding one ringed), the name, the look, the reason and the expression. */
function InFrameRow({ who, kits, slug, shot, onMake }: { who: PictureWho; kits: readonly ReferenceKit[]; slug: string; shot: PictureShot | undefined; onMake: (who: PictureWho) => void }) {
  const look = who.look === undefined || who.sheet === undefined ? undefined : kits.find((kit) => kit.sheetId === who.sheet)?.looks?.find((candidate) => candidate.id === who.look!.lookId);
  const expression = who.kind === "character" ? shot?.expressions[who.key] : undefined;
  const state = who.reference === null ? "none" : who.carried ? "carried" : "over";
  return (
    <div className={cx("fy-pcard__who", state === "none" && "fy-pcard__who--miss", state === "over" && "fy-pcard__who--over")} data-testid="suggest-who" data-key={who.key} data-state={state}>
      <span className="fy-pcard__thumbs">
        {look !== undefined && who.sheet !== undefined ? (
          <>
            <Thumb slug={slug} file={`references/${who.sheet}/${look.file}`} on={who.look?.view === "full"} view="full" />
            {look.closeFile !== undefined ? <Thumb slug={slug} file={`references/${who.sheet}/${look.closeFile}`} on={who.look?.view === "close"} view="close" /> : <i className="fy-pcard__thumb fy-pcard__thumb--none" aria-hidden="true" />}
          </>
        ) : who.reference !== null ? (
          <Thumb slug={slug} file={who.reference} on={who.carried} view={who.kind === "place" ? "place" : "main"} />
        ) : (
          <i className="fy-pcard__thumb fy-pcard__thumb--none" aria-hidden="true" />
        )}
      </span>
      <span className="fy-pcard__whotx">
        <b>{who.name}</b>
        {who.reference === null ? (
          who.sheet !== undefined && (
            <button type="button" className="fy-sugg__make" onClick={() => onMake(who)} data-testid="suggest-make-reference">
              {who.kind === "place" ? "Make a reference" : "Make a look"}
            </button>
          )
        ) : (
          <span className="fy-mono">
            {who.kind === "place" ? "place" : look !== undefined ? `${lookName(look)} · ${who.look?.view === "close" ? "close view" : "full body"}` : "main photo"}
            {who.carried ? "" : " · over the limit"}
          </span>
        )}
        {expression !== undefined && (
          <span className="fy-pcard__expr" data-testid="picture-card-expression">
            <span className="fy-mono">Expression</span> {expression}
          </span>
        )}
      </span>
      {who.kind === "character" && who.reference !== null && (
        <span className="fy-mono fy-pcard__why" data-testid="picture-card-why">
          {rideReason(who, shot, look?.closeFile !== undefined)}
        </span>
      )}
    </div>
  );
}

/** The card (193c): what the picture will be, who is in it and who is not, the prompt and its checks, then Edit prompt and Generate. */
export function PictureCard({ world, worldId, state, onEdit, offline }: {
  world: Pick<WorldBundle, "meta" | "referenceKits" | "sheets">;
  worldId: string;
  state: PictureSuggestionState;
  onEdit: (suggestion: PictureSuggestion, prompt: string) => void;
  offline: boolean;
}) {
  const navigate = useNavigate();
  const { ask, making } = state;
  if (ask === null) return null;
  if (ask.state === "working") return <p className="fy-mono fy-ab__card-line" data-testid="suggest-reading">reading…</p>;
  if (ask.state === "refused") {
    return (
      <div className="fy-sugg" data-testid="suggest-refused">
        <p className="fy-mono fy-ch__who-where--warn">{ask.refused}</p>
        <div className="fy-ab__control">
          <span className="fy-ch__panelpush" />
          <Button variant="ghost" onClick={state.dismiss}>
            Discard
          </Button>
          <Button variant="secondary" disabled={offline} onClick={state.suggest}>
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
        <div className="fy-pcard__slot" aria-hidden="true">
          <span className="fy-mono">{suggestion.aspect ?? ""}</span>
        </div>
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
          <div className="fy-sugg__meta fy-mono">
            <span>
              {suggestion.model.name}
              {suggestion.aspect !== undefined ? ` · ${suggestion.aspect}` : ""}
            </span>
            <span>{priceLabel(suggestion.estimatedMicroUsd)}</span>
          </div>
        </div>
      </div>
      <div className="fy-pcard__sec" data-testid="picture-card-in-frame">
        <span className="fy-mono fy-pcard__h">In frame</span>
        {suggestion.who.length === 0 ? (
          <span className="fy-mono fy-pcard__none">{detail ? "no one · a detail" : "no one"}</span>
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
        <div className="fy-pcard__sec fy-pcard__out" data-testid="picture-card-not-in-frame">
          <span className="fy-mono fy-pcard__h">Not in frame</span>
          {shot.notInFrame.map((key) => (
            <span key={key} className="fy-pcard__outname">
              {nameOf(key)}
            </span>
          ))}
        </div>
      )}
      <Textarea className="fy-sugg__prompt" aria-label="Prompt" rows={5} value={prompt} disabled={busy} onChange={(event) => state.setPrompt(event.target.value)} />
      {shot !== undefined && shot.checks.length > 0 && (
        <ul className="fy-pcard__checks" data-testid="picture-card-checks">
          {shot.checks.map((check) => (
            <li key={check.id} className={cx("fy-pcard__check", !check.ok && "fy-pcard__check--mark")} data-testid="picture-card-check" data-check={check.id} data-ok={check.ok ? "true" : "false"}>
              <i aria-hidden="true">{check.ok ? "✓" : "!"}</i>
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
      <div className="fy-ab__control">
        <Button variant="ghost" onClick={state.dismiss} disabled={busy}>
          Discard
        </Button>
        <span className="fy-ch__panelpush" />
        <Button variant="secondary" disabled={offline || busy} onClick={() => onEdit(suggestion, prompt)} data-testid="suggest-edit">
          Edit prompt
        </Button>
        <Button variant="primary" disabled={offline || busy || prompt.trim() === ""} onClick={() => state.generate(suggestion, prompt)} data-testid="suggest-generate">
          {busy ? "Generating…" : `Generate · ${priceLabel(suggestion.estimatedMicroUsd)}`}
        </Button>
      </div>
    </div>
  );
}
