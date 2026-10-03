import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { priceLabel, type PictureSuggestion, type PictureWho, type WorldBundle } from "@arke-studio/contracts";
import { mediaUrl } from "../lib/media.js";
import { makeAudiobookPicture, suggestAudiobookPicture, useAudiobookAsks } from "../lib/store.js";
import { Button, Textarea, cx } from "./ui.js";

/**
 * Suggest picture (design turn 191a, SPEC-047 R-99, R-100): in a block's Picture section, one
 * editable prompt Arke drafted from the block, the chapter and who is in it — each person a chip
 * over their reference, the look lines it used, the model, the ratio and the price. Nothing is
 * made until Generate, which is the price confirmed; Edit prompt takes the same prompt to the Bench.
 */

export interface PictureSuggestionState {
  /** What the writing service has said of this block, or null before it is asked. */
  ask: ReturnType<typeof useAudiobookAsks>[string] | null;
  /** The prompt as the author has it: the draft until they change it. */
  prompt: string | null;
  setPrompt: (prompt: string) => void;
  /** Where the press to Generate stands: making, held with its reason, or on the block. */
  making: ReturnType<typeof useAudiobookAsks>[string] | null;
  suggest: () => void;
  generate: (suggestion: PictureSuggestion, prompt: string) => void;
  /** Put the card away: a suggestion not wanted, or one made and standing on its block. */
  dismiss: () => void;
}

export function usePictureSuggestion(worldId: string, productionId: string, chapterFile: string, blockKey: string): PictureSuggestionState {
  const asks = useAudiobookAsks();
  const [suggestId, setSuggestId] = useState<string | null>(null);
  const [makeId, setMakeId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  useEffect(() => {
    setSuggestId(null);
    setMakeId(null);
    setPrompt(null);
  }, [blockKey, chapterFile]);
  const ask = suggestId === null ? null : (asks[suggestId] ?? null);
  const making = makeId === null ? null : (asks[makeId] ?? null);
  // A picture that has landed on its block is the block's now: the card has done its work.
  useEffect(() => {
    if (making?.state !== "made") return;
    setSuggestId(null);
    setMakeId(null);
    setPrompt(null);
  }, [making?.state]);
  return {
    ask,
    prompt,
    setPrompt,
    making,
    suggest: () => {
      setMakeId(null);
      setPrompt(null);
      setSuggestId(suggestAudiobookPicture(worldId, productionId, chapterFile, blockKey));
    },
    generate: (suggestion, words) => {
      setMakeId(makeAudiobookPicture(worldId, productionId, chapterFile, blockKey, { prompt: words, who: suggestion.who.map((who) => who.key), confirmedMicroUsd: suggestion.estimatedMicroUsd }));
    },
    dismiss: () => {
      setSuggestId(null);
      setMakeId(null);
      setPrompt(null);
    },
  };
}

/** One person or place in the picture (R-100): a chip over their reference; dashed with `Make a reference` where they have none. */
export function WhoChip({ who, slug, onMake }: { who: PictureWho; slug: string; onMake: (who: PictureWho) => void }) {
  if (who.reference === null) {
    return (
      <span className="fy-sugg__ref fy-sugg__ref--miss" data-testid="suggest-who" data-key={who.key} data-state="none">
        <i aria-hidden="true" />
        {who.name}
        {who.sheet !== undefined && (
          <button type="button" className="fy-sugg__make" onClick={() => onMake(who)} data-testid="suggest-make-reference">
            Make a reference
          </button>
        )}
      </span>
    );
  }
  return (
    <span className={cx("fy-sugg__ref", !who.carried && "fy-sugg__ref--over")} data-testid="suggest-who" data-key={who.key} data-state={who.carried ? "carried" : "over"} title={who.carried ? undefined : "over the model's limit"}>
      <img src={mediaUrl(slug, who.reference)} alt="" />
      {who.name}
    </span>
  );
}

/** The card (191a): the prompt to edit, who is in it, their look, the model and price, then Edit prompt and Generate. */
export function PictureSuggestionCard({ world, worldId, state, onEdit, offline }: {
  world: Pick<WorldBundle, "meta">;
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
  const prompt = state.prompt ?? suggestion.prompt;
  const busy = making?.state === "working";
  const failed = making?.state === "failed" ? making : null;
  return (
    <div className="fy-sugg" data-testid="suggest-card">
      <Textarea className="fy-sugg__prompt" aria-label="Prompt" rows={4} value={prompt} disabled={busy} onChange={(event) => state.setPrompt(event.target.value)} />
      {suggestion.who.length > 0 && (
        <div className="fy-sugg__refs" data-testid="suggest-refs">
          {suggestion.who.map((who) => (
            <WhoChip key={who.key} who={who} slug={world.meta.slug} onMake={(entry) => void navigate(`/w/${worldId}/${entry.kind === "place" ? "locations" : "cast"}/${entry.sheet}`)} />
          ))}
        </div>
      )}
      {suggestion.lines.length > 0 && (
        <div className="fy-sugg__look" data-testid="suggest-look">
          {suggestion.lines.map((line) => (
            <div key={line.label}>
              <b>{line.label}</b>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      )}
      <div className="fy-sugg__meta fy-mono">
        <span>
          {suggestion.model.name}
          {suggestion.aspect !== undefined ? ` · ${suggestion.aspect}` : ""}
        </span>
        <span>{priceLabel(suggestion.estimatedMicroUsd)}</span>
      </div>
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
