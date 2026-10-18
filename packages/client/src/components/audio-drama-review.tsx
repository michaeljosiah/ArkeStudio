import { useMemo, useState } from "react";
import {
  DRAMA_NARRATOR, reviewDramaScript,
  type DramaReviewCheck, type EpisodeScriptBlock, type ProductionBundle, type WorldBundle,
} from "@arke-studio/contracts";
import { ChevronLeft, ChevronRight, X } from "./icons.js";
import { Button, IconButton, cx } from "./ui.js";
import { decideDramaNote } from "../lib/store.js";

const CHECK: Record<DramaReviewCheck, string> = {
  fidelity: "Fidelity", clarity: "Clarity", pacing: "Pacing", emotion: "Emotion", mystery: "Mystery", intelligibility: "Intelligibility",
};

/**
 * Review in the score (design turn 230j, SPEC-057 R-49..R-53): one review, its header saying exactly
 * how much has been heard, each note numbered with what it rests on and the line it quotes, decided
 * Intentional or Dismiss. Checks with nothing to say are listed closed; intelligibility waits for
 * heard audio and never reads as passed.
 */
export function ReviewColumn({ world, production, episode, version, blocks, onPick, onClose }: {
  world: WorldBundle; production: ProductionBundle; episode: number; version: number;
  blocks: readonly EpisodeScriptBlock[]; onPick: (block: string) => void; onClose: () => void;
}) {
  const record = production.audioDrama;
  const review = useMemo(() => {
    const cast = record?.cast ?? {};
    const names: Record<string, string> = {};
    const voices: Record<string, string> = {};
    for (const block of blocks) {
      if (block.kind !== "dialogue" || names[block.speaker] !== undefined) continue;
      const sheet = world.sheets.find((candidate) => candidate.id === block.speaker);
      names[block.speaker] = sheet?.name ?? block.speaker;
      const voice = cast[block.speaker]?.voice ?? sheet?.voice;
      if (voice) voices[block.speaker] = `${voice.provider}/${voice.voiceId}`;
    }
    for (const key of Object.keys(cast)) {
      if (key === DRAMA_NARRATOR || names[key] !== undefined) continue;
      names[key] = world.sheets.find((sheet) => sheet.id === key)?.name ?? key;
    }
    const chapters = blocks.flatMap((block) => {
      if (block.kind !== "heading" || !block.source) return [];
      const pin = block.source;
      const chapter = world.productions.find((candidate) => candidate.meta.id === pin.story)?.chapters.find((candidate) => candidate.id === pin.chapter);
      return chapter ? [{ story: pin.story, chapter: pin.chapter, version: chapter.version ?? 1, hash: chapter.hash }] : [];
    });
    return reviewDramaScript({
      episode, version, blocks, names, voices, cast, chapters,
      ...(record?.plan ? { plan: { minutes: record.plan.minutes, keptFromListener: record.plan.keptFromListener } } : {}),
    });
  }, [blocks, version, episode, record, world.sheets, world.productions]);
  const decided = record?.review ?? {};
  const open = review.notes.filter((note) => decided[note.key] === undefined);
  // Decided notes stay to be read, with how they were decided, and can be opened again (codex on PR 1873).
  const settledNotes = review.notes.filter((note) => decided[note.key] !== undefined);
  const settled = settledNotes.length;
  const [current, setCurrent] = useState<string | null>(null);
  const at = Math.max(0, open.findIndex((note) => note.key === current));
  const show = (index: number) => {
    const note = open[(index + open.length) % open.length];
    if (!note) return;
    setCurrent(note.key);
    if (note.blocks[0]) onPick(note.blocks[0]);
  };
  const decide = (key: string, decision: "intentional" | "dismissed") => {
    decideDramaNote(world.meta.worldId, production.meta.id, key, decision);
    setCurrent(null);
  };
  return (
    <aside className="fy-ad-source fy-ad-review" aria-label="Review">
      <header>
        <h2>Review</h2><small>{open.length} open{settled > 0 ? ` · ${settled} decided` : ""}</small><span className="gap" />
        <IconButton label="Previous note" disabled={open.length < 2} onClick={() => show(at - 1)}><ChevronLeft size={14} /></IconButton>
        <IconButton label="Next note" disabled={open.length < 2} onClick={() => show(at + 1)}><ChevronRight size={14} /></IconButton>
        <IconButton label="Close review" onClick={onClose}><X size={14} /></IconButton>
      </header>
      <p className="fy-ad-review__cover" data-testid="review-coverage">{review.coverage}</p>
      <ol className="fy-ad-review__notes">
        {open.map((note, index) => {
          const on = note.key === (current ?? open[0]?.key);
          return (
            <li key={note.key} className={cx("fy-ad-review__note", on && "fy-ad-review__note--open")}
              onClick={() => { setCurrent(note.key); if (note.blocks[0]) onPick(note.blocks[0]); }}>
              <span className="fy-ad-review__kind"><b>{index + 1}</b> {CHECK[note.check]} · {note.evidence}</span>
              <p>{note.says}</p>
              {on && note.quote && <q>{note.quote.length > 140 ? `${note.quote.slice(0, 140)}…` : note.quote}</q>}
              {on && (
                <span className="fy-ad-review__acts" onClick={(event) => event.stopPropagation()}>
                  <Button size="sm" variant="secondary" onClick={() => decide(note.key, "intentional")}>Intentional</Button>
                  <Button size="sm" variant="ghost" onClick={() => decide(note.key, "dismissed")}>Dismiss</Button>
                </span>
              )}
            </li>
          );
        })}
        {settledNotes.map((note) => (
          <li key={note.key} className="fy-ad-review__note fy-ad-review__note--closed" data-decided={decided[note.key]}>
            <span className="fy-ad-review__kind">{CHECK[note.check]} · {note.evidence} · {decided[note.key] === "intentional" ? "intentional" : "dismissed"}</span>
            <p>{note.says}</p>
            <button type="button" className="fy-linkbtn" onClick={() => decideDramaNote(world.meta.worldId, production.meta.id, note.key, null)}>Reopen</button>
          </li>
        ))}
        {review.checked.map((entry, index) => (
          <li key={`${entry.check}-${index}`} className="fy-ad-review__note fy-ad-review__note--closed">
            <span className="fy-ad-review__kind">{CHECK[entry.check]} · {entry.check === "intelligibility" ? "audio · not heard" : `script v${version} · checked`}</span>
            <p>{entry.says}</p>
          </li>
        ))}
      </ol>
    </aside>
  );
}
