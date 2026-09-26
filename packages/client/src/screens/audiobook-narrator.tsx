import { useEffect, useMemo, useState } from "react";
import { estimateMicroUsd, formatMicroUsd, supportsVoiceUse, type AudiobookReader } from "@arke-studio/contracts";
import { EditorDialog } from "../components/editor-dialog.js";
import { Button } from "../components/ui.js";
import { playClip } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { hearAudiobookLine, quoteAudiobookNarrator, setAudiobookNarrator, useHeardLines, useNarratorQuotes, useStore } from "../lib/store.js";

const same = (a: AudiobookReader | null | undefined, b: AudiobookReader | null | undefined) =>
  a != null && b != null && a.provider === b.provider && a.model === b.model && a.voiceId === b.voiceId;

/**
 * The book's narrator (design turn 155h, SPEC-047 R-46): the app's, followed as it changes, or
 * a voice for this book. Before the press the dialog states what the switch does, as data —
 * the blocks that go stale, the direction the new reader holds, the price of reading the book
 * again, the takes kept — and the press writes the book record and makes nothing.
 */
export function NarratorDialog({ worldId, productionId, narratorLabel, bookNarrator, appLabel, trial, slug, data, onClose }: {
  worldId: string;
  productionId: string;
  /** The narrator the book reads in now, by name. */
  narratorLabel: string;
  /** The book's own, when it has one. */
  bookNarrator?: AudiobookReader;
  /** The app's narrator by name, for the seg. */
  appLabel: string;
  /** The block a voice is tried on: the selected one, or the first chapter's title. */
  trial: { chapterFile: string; block: string } | null;
  slug: string | undefined;
  /** The book's data line. */
  data: string;
  onClose: () => void;
}) {
  const { state, voiceCatalogue } = useStore();
  const models = state?.app.manifest?.models ?? [];
  const voices = useMemo(
    () => (voiceCatalogue ?? []).filter((voice) => supportsVoiceUse(voice, "narration") && voice.unavailableReason === undefined),
    [voiceCatalogue],
  );
  const [mode, setMode] = useState<"app" | "book">(bookNarrator !== undefined ? "book" : "app");
  const [picked, setPicked] = useState<AudiobookReader | null>(bookNarrator ?? null);
  const target = mode === "app" ? null : picked;
  // What the switch would do, asked again whenever the choice changes (R-46).
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const quote = useNarratorQuotes()[quoteId ?? ""];
  const unchanged = mode === "app" ? bookNarrator === undefined : same(picked, bookNarrator);
  useEffect(() => {
    if (unchanged || (mode === "book" && picked === null)) {
      setQuoteId(null);
      return;
    }
    setQuoteId(quoteAudiobookNarrator(worldId, productionId, target));
    // `target` is `picked` or null by mode; both are in the list.
  }, [mode, picked?.provider, picked?.model, picked?.voiceId, unchanged]);
  // A voice tried on the block, as it would read it (R-46): heard, never a take.
  const [hearing, setHearing] = useState<{ id: string; voice: string } | null>(null);
  const heard = useHeardLines()[hearing?.id ?? ""];
  useEffect(() => {
    if (heard?.state !== "done" || slug === undefined || hearing === null) return;
    void playClip({ id: `hear-${hearing.id}`, url: mediaUrl(slug, heard.file), title: "Narrator", sub: hearing.voice });
  }, [heard?.state]);
  const price = (voice: AudiobookReader) => {
    const model = models.find((m) => m.provider === voice.provider && m.id === voice.model && m.capability === "voice-tts");
    if (model === undefined) return "";
    const perK = estimateMicroUsd(model, { characters: 1000 });
    return perK === 0 ? "free" : `${formatMicroUsd(perK)} / 1k`;
  };
  const rows = (
    <div className="fy-abnarr__list" role="listbox" aria-label="Voices">
      {voices.map((voice) => {
        const reader = { provider: voice.provider, model: voice.model, voiceId: voice.voiceId, label: voice.label };
        const on = mode === "book" && same(picked, reader);
        return (
          <div key={`${voice.provider}/${voice.model}/${voice.voiceId}`} className={`fy-abnarr__row${on ? " fy-abnarr__row--on" : ""}`} role="option" aria-selected={on} onClick={() => {
            setMode("book");
            setPicked(reader);
          }}>
            <button
              type="button"
              className="fy-ab__play"
              aria-label={`Hear ${voice.label}`}
              disabled={trial === null || voice.readsClone !== undefined}
              onClick={(event) => {
                event.stopPropagation();
                if (trial === null) return;
                const id = hearAudiobookLine(worldId, productionId, trial.chapterFile, trial.block, reader);
                if (id !== null) setHearing({ id, voice: voice.label });
              }}
            >
              ▶
            </button>
            <span className="fy-abnarr__who">
              <span className="fy-abnarr__name">{voice.label}</span>
              <span className="fy-abnarr__reader fy-mono">
                {voice.provider} · {voice.model}
              </span>
            </span>
            <span className="fy-abnarr__price fy-mono">{price(reader)}</span>
            <span className="fy-abnarr__tick" aria-hidden="true">
              {on ? "✓" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
  const facts =
    quote?.state === "done"
      ? [
          `${quote.stale.toLocaleString()} block${quote.stale === 1 ? "" : "s"} stale`,
          ...(quote.directed > 0 ? [`${quote.held} of ${quote.directed} held`] : []),
          `${quote.estimatedMicroUsd === 0 ? "free" : formatMicroUsd(quote.estimatedMicroUsd)} to read again`,
          `${quote.kept.toLocaleString()} take${quote.kept === 1 ? "" : "s"} kept`,
        ]
      : quote?.state === "refused"
        ? [quote.refused]
        : quote?.state === "working"
          ? ["…"]
          : [];
  return (
    <EditorDialog open title="Narrator" subtitle={data} onClose={onClose} width={580}>
      <div className="fy-abnarr" data-testid="narrator-dialog">
        <span className="fy-seg" role="group" aria-label="Narrator">
          <button type="button" className={`fy-seg__item${mode === "app" ? " fy-seg__item--active" : ""}`} aria-pressed={mode === "app"} onClick={() => setMode("app")}>
            App narrator · {appLabel}
          </button>
          <button type="button" className={`fy-seg__item${mode === "book" ? " fy-seg__item--active" : ""}`} aria-pressed={mode === "book"} onClick={() => setMode("book")}>
            This book
          </button>
        </span>
        {mode === "book" && rows}
        {heard?.state === "refused" && <p className="fy-rectake__refused">{heard.refused}</p>}
        {facts.length > 0 && (
          <ul className="fy-abnarr__facts fy-mono" data-testid="narrator-quote">
            {facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        )}
        <div className="fy-rectake__foot">
          <span className="fy-mono fy-abnarr__now">{narratorLabel}</span>
          <span className="fy-rectake__push" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={unchanged || (mode === "book" && picked === null)}
            onClick={() => {
              setAudiobookNarrator(worldId, productionId, target);
              onClose();
            }}
            data-testid="narrator-use"
          >
            {mode === "app" ? "Use the app narrator" : "Use for this book"}
          </Button>
        </div>
      </div>
    </EditorDialog>
  );
}
