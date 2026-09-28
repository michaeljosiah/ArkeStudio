import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cloudSpeechPreference, estimateMicroUsd, formatMicroUsd, modelPriceCopy, readerName, readerPlace, supportsVoiceUse, type AudiobookReader, type ManifestModel } from "@arke-studio/contracts";
import { EditorDialog } from "../components/editor-dialog.js";
import { DesignVoiceDialog } from "../components/design-voice-dialog.js";
import { Button } from "../components/ui.js";
import { playClip } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { hearAudiobookLine, quoteAudiobookNarrator, setAudiobookNarrator, useHeardLines, useNarratorQuotes, useStore, type ReadingVoice } from "../lib/store.js";

const same = (a: AudiobookReader | null | undefined, b: AudiobookReader | null | undefined) =>
  a != null && b != null && a.provider === b.provider && a.model === b.model && a.voiceId === b.voiceId;

const readerOf = (voice: ReadingVoice): AudiobookReader => ({ provider: voice.provider, model: voice.model, voiceId: voice.voiceId, label: voice.label });

/**
 * Where a voice sits in the list (design turn 165, 165c): this machine first, the world's saved
 * voices next, the cloud last. The build listed 340 voices in the catalogue's order, the free
 * local ones after hundreds of paid ones (issue 1324 §3), so the voice a person most often wants
 * was the one they could not find.
 */
type Where = "local" | "saved" | "cloud";
const whereOf = (voice: ReadingVoice): Where => (voice.local ? "local" : voice.readsClone !== undefined || voice.readsDesigned !== undefined ? "saved" : "cloud");
const GROUPS: ReadonlyArray<{ where: Where; title: string; chip: string }> = [
  { where: "local", title: "On this machine", chip: "This machine" },
  { where: "saved", title: "Saved for this world", chip: "Saved" },
  { where: "cloud", title: "Cloud", chip: "Cloud" },
];

/** A search is words, each of which must be somewhere in the voice's name, provider, reader or attributes. */
function matches(voice: ReadingVoice, row: ManifestModel | undefined, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const hay = [voice.label, voice.provider, readerPlace(voice.provider, voice.local), readerName(voice, row), ...voice.attributes].join(" ").toLowerCase();
  return words.every((word) => hay.includes(word));
}

/**
 * The book's narrator (design turns 155h and 165c, SPEC-047 R-46): the app's, followed as it
 * changes, or a voice for this book, found by search among every voice the catalogue has.
 * Before the press the dialog states what the switch does, as data — the blocks that go stale,
 * the direction the new reader holds, the price of reading the book again, the takes kept —
 * and the press waits for that answer, writes the book record and makes nothing.
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
  const disabledModels = state?.app.models.disabled;
  const rowOf = (voice: { provider: string; model: string }) => models.find((m) => m.provider === voice.provider && m.id === voice.model && m.capability === "voice-tts");
  const voices = useMemo(
    () =>
      (voiceCatalogue ?? [])
        .filter((voice) => supportsVoiceUse(voice, "narration") && voice.unavailableReason === undefined)
        .filter((voice) => !disabledModels?.includes(voice.model))
        .sort((a, b) => {
          const rank = GROUPS.findIndex((g) => g.where === whereOf(a)) - GROUPS.findIndex((g) => g.where === whereOf(b));
          return rank !== 0 ? rank : cloudSpeechPreference(a) - cloudSpeechPreference(b) || readerPlace(a.provider).localeCompare(readerPlace(b.provider)) || a.label.localeCompare(b.label);
        }),
    [voiceCatalogue, disabledModels],
  );
  const [mode, setMode] = useState<"app" | "book">(bookNarrator !== undefined ? "book" : "app");
  const [picked, setPicked] = useState<AudiobookReader | null>(bookNarrator ?? null);
  const [search, setSearch] = useState("");
  const [designing, setDesigning] = useState(false);
  const [where, setWhere] = useState<Where | "all">("all");
  const words = search.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
  const found = voices.filter((voice) => matches(voice, rowOf(voice), words));
  const shown = where === "all" ? found : found.filter((voice) => whereOf(voice) === where);
  const count = (w: Where) => found.filter((voice) => whereOf(voice) === w).length;
  // A group with nothing in it is not offered: the saved voices arrive with the voice library
  // (issue 1331), and a chip that filters to nothing is a control with no function (turn 165).
  const groups = GROUPS.filter((g) => voices.some((voice) => whereOf(voice) === g.where));
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
  const [hearing, setHearing] = useState<{ id: string; voice: string; reader: AudiobookReader } | null>(null);
  const heard = useHeardLines()[hearing?.id ?? ""];
  useEffect(() => {
    if (heard?.state !== "done" || slug === undefined || hearing === null) return;
    void playClip({ id: `hear-${hearing.id}`, url: mediaUrl(slug, heard.file), title: "Narrator", sub: hearing.voice });
  }, [heard?.state]);
  const hear = (voice: ReadingVoice) => {
    if (trial === null) return;
    const id = hearAudiobookLine(worldId, productionId, trial.chapterFile, trial.block, readerOf(voice));
    if (id !== null) setHearing({ id, voice: voice.label, reader: readerOf(voice) });
  };
  const price = (voice: { provider: string; model: string }) => {
    const model = rowOf(voice);
    if (model === undefined) return "";
    if (model.pricing.kind === "perToken") return "quoted per read";
    const perK = estimateMicroUsd(model, { characters: 1000 });
    return perK === 0 ? "free" : `${formatMicroUsd(perK)} / 1k`;
  };
  // The search takes focus when the list is what the dialog is for (turn 165: the book's seg).
  const searchBox = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode === "book") searchBox.current?.focus();
  }, [mode]);
  const options = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = options();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = all[Math.min(all.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))];
      next?.focus();
    } else if (at >= 0 && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const voice = shown[at];
      if (voice === undefined) return;
      if (event.key === "Enter") setPicked(readerOf(voice));
      else hear(voice);
    }
  };
  const chosen = picked === null ? undefined : voices.find((voice) => same(readerOf(voice), picked));
  const option = (voice: ReadingVoice, first: boolean) => {
    const reader = readerOf(voice);
    const model = rowOf(voice);
    const on = same(picked, reader);
    const current = same(bookNarrator, reader);
    return (
      <div
        key={`${voice.provider}/${voice.model}/${voice.voiceId}`}
        className={`fy-abnarr__row${on ? " fy-abnarr__row--on" : ""}${current && !on ? " fy-abnarr__row--current" : ""}`}
        role="option"
        aria-selected={on}
        // One stop in the tab ring for the list; the arrows move inside it.
        tabIndex={on || (picked === null && first) ? 0 : -1}
        onClick={() => setPicked(reader)}
      >
        <button
          type="button"
          className="fy-ab__play"
          aria-label={`Hear ${voice.label}`}
          tabIndex={-1}
          disabled={trial === null || voice.readsClone !== undefined}
          onClick={(event) => {
            event.stopPropagation();
            hear(voice);
          }}
        >
          ▶
        </button>
        <span className="fy-abnarr__who">
          <span className="fy-abnarr__name">{voice.label}</span>
          <span className="fy-abnarr__reader fy-mono">
            {[readerPlace(voice.provider, voice.local), ...(voice.local ? [] : [readerName(voice, rowOf(voice))]), ...(cloudSpeechPreference(voice) === 0 ? ["Recommended"] : []), ...voice.attributes.slice(0, 2)].join(" · ")}
          </span>
        </span>
        <span className="fy-abnarr__price fy-mono" title={model === undefined ? undefined : modelPriceCopy(model)}>{price(reader)}</span>
        <span className="fy-abnarr__tick" aria-hidden="true">
          {on ? "✓" : ""}
        </span>
      </div>
    );
  };
  let first = true;
  const list_ = (
    <div className="fy-abnarr__pick">
      <input
        ref={searchBox}
        className="fy-abnarr__search"
        type="search"
        placeholder={`Search ${voices.length} voices`}
        aria-label="Search voices"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          options()[0]?.focus();
        }}
      />
      <div className="fy-abnarr__chips" role="radiogroup" aria-label="Where it reads">
        {[{ where: "all" as const, chip: "All", n: found.length }, ...groups.map((g) => ({ where: g.where, chip: g.chip, n: count(g.where) }))].map((chip) => (
          <button key={chip.where} type="button" role="radio" aria-checked={where === chip.where} className={`fy-ab__fchip${where === chip.where ? " fy-ab__fchip--on" : ""}`} onClick={() => setWhere(chip.where)}>
            {chip.chip}
            <span className="fy-ab__fcount">{chip.n}</span>
          </button>
        ))}
      </div>
      <div className="fy-abnarr__list" role="listbox" aria-label="Voices" ref={list} onKeyDown={onListKey}>
        {groups.map((g) => {
          const members = shown.filter((voice) => whereOf(voice) === g.where);
          if (members.length === 0) return null;
          return [
            <div key={`group-${g.where}`} className="fy-abnarr__group" role="presentation">
              <span>{g.title}</span>
              <span className="fy-abnarr__groupcount fy-mono">{members.length}</span>
            </div>,
            ...members.map((voice) => {
              const row = option(voice, first);
              first = false;
              return row;
            }),
          ];
        })}
        {shown.length === 0 && <p className="fy-bible__empty fy-abnarr__none">{voiceCatalogue === null ? "Loading voices…" : "No voice matches"}</p>}
      </div>
    </div>
  );
  const facts: Array<{ k: string; v: string; warn?: boolean }> =
    quote?.state === "done"
      ? [
          { k: "Blocks", v: `${quote.stale.toLocaleString()} stale`, warn: quote.stale > 0 },
          ...(quote.directed > 0 ? [{ k: "Direction", v: quote.held === 0 ? `${quote.directed} · none held` : `${quote.held} of ${quote.directed} held`, warn: quote.held > 0 }] : []),
          { k: "Read the book", v: quote.estimatedMicroUsd === 0 ? "no charge" : `up to ${formatMicroUsd(quote.estimatedMicroUsd)}` },
          { k: "Takes", v: `kept · ${quote.kept.toLocaleString()}` },
        ]
      : quote?.state === "refused"
        ? [{ k: "Refused", v: quote.refused, warn: true }]
        : quote?.state === "working"
          ? [{ k: "Blocks", v: "…" }]
          : [];
  const detail = (
    <div className="fy-abnarr__detail">
      {mode === "book" && chosen !== undefined && (
        <>
          <p className="fy-abnarr__chosen">
            <span className="fy-abnarr__name">{chosen.label}</span>
            <span className="fy-mono">{readerPlace(chosen.provider, chosen.local)} · {readerName(chosen, rowOf(chosen))}</span>
          </p>
          <Button variant="ghost" disabled={trial === null || chosen.readsClone !== undefined} onClick={() => hear(chosen)} data-testid="narrator-hear">
            ▶ Hear on this block{price(chosen) === "" || price(chosen) === "free" ? "" : ` · ${price(chosen)}`}
          </Button>
        </>
      )}
      {heard?.state === "refused" && <p className="fy-rectake__refused">{heard.refused}</p>}
      {heard?.state === "priced" && hearing !== null && trial !== null && (
        <Button variant="ghost" onClick={() => {
          const id = hearAudiobookLine(worldId, productionId, trial.chapterFile, trial.block, hearing.reader, heard.token);
          if (id !== null) setHearing({ ...hearing, id });
        }} data-testid="narrator-hear-confirm">
          Hear {hearing.voice} · up to {formatMicroUsd(heard.authorisedMicroUsd)} · {heard.parts} part{heard.parts === 1 ? "" : "s"}
        </Button>
      )}
      {facts.length > 0 && (
        <dl className="fy-abnarr__facts" data-testid="narrator-quote">
          {facts.map((fact) => (
            <div key={fact.k} className="fy-abnarr__fact">
              <dt>{fact.k}</dt>
              <dd className={`fy-mono${fact.warn === true ? " fy-ch__who-where--warn" : ""}`}>{fact.v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
  if (designing) return <DesignVoiceDialog worldId={worldId} name="Book narrator" useLabel="Choose for this book"
    onClose={() => setDesigning(false)} onUse={voice => { setPicked(readerOf({ ...voice, usedBy: [] })); setMode("book"); setDesigning(false); }} />;
  return (
    <EditorDialog open title="Narrator" subtitle={data} onClose={onClose} width={mode === "book" ? 860 : 580} panelClassName="fy-abnarr__panel">
      <div className="fy-abnarr" data-testid="narrator-dialog">
        {models.some(model => model.provider === "google" && model.capability === "voice-tts") && <Button onClick={() => setDesigning(true)}>Design a narrator</Button>}
        <span className="fy-seg" role="group" aria-label="Narrator">
          <button type="button" className={`fy-seg__item${mode === "app" ? " fy-seg__item--active" : ""}`} aria-pressed={mode === "app"} onClick={() => setMode("app")}>
            App narrator · {appLabel}
          </button>
          <button type="button" className={`fy-seg__item${mode === "book" ? " fy-seg__item--active" : ""}`} aria-pressed={mode === "book"} onClick={() => setMode("book")}>
            This book
          </button>
        </span>
        {mode === "book" ? (
          <div className="fy-abnarr__cols">
            {list_}
            {detail}
          </div>
        ) : (
          detail
        )}
        <div className="fy-rectake__foot">
          <span className="fy-mono fy-abnarr__now">{narratorLabel}</span>
          <span className="fy-rectake__push" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            // The press waits for what the switch costs (turn 165): a person sees the stale
            // blocks and the price before choosing, never after.
            disabled={unchanged || (mode === "book" && picked === null) || quote?.state !== "done"}
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
