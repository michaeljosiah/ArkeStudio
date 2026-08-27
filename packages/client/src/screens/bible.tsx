import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { bibleSize, DEFAULT_NARRATOR, formatMicroUsd, splitBible, supportsVoiceUse } from "@arke-studio/contracts";
import { RichMarkdownEditor } from "../components/editor/rich-markdown-editor.js";
import { updateRichModeGate, type RichModeGate } from "../components/editor/rich-mode.js";
import { Button, Callout, cx } from "../components/ui.js";
import { readBibleSection, restoreBible, saveBible, useStore, useVoiceAudio, useVoiceParts } from "../lib/store.js";
import { useOpenWorldGuard } from "../lib/selectors.js";
import { mediaUrl } from "../lib/media.js";
import { clearQueue, enqueueClip, playClip } from "../lib/audio.js";
import { ClipPlayButton } from "../components/player.js";

/**
 * The world Bible (master §4.5) — one page, one document, no approval step.
 *
 * Everything on this screen follows from that last part. Nothing here proposes; the text saves in
 * place. What replaces the accept step is on screen instead: the version, the meter, and a list of
 * every earlier version with a way back to it. An author who can see what a save cost and undo it
 * in one click does not need to be asked first.
 */

/** Long enough that a pause reads as a pause, short enough that nobody watches the word "Saving". */
const AUTOSAVE_MS = 1200;

/**
 * Where the meter stops being informational and starts being advice.
 *
 * Not a cap — nothing truncates, ever, and the point of the whole design is that the Studio reads
 * the bible whole. This is the size at which carrying it on every turn is worth mentioning, which
 * is a different thing from the size at which it is wrong. Roughly 4,000 words.
 */
const NOTABLE_CHARACTERS = 24_000;

/** What an empty bible says. The source editor appends an example; the rich one cannot show one. */
const PLACEHOLDER =
  "Write anything here — what this world is about, how it should feel, what you have not decided yet.";

export function BibleScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const { state } = useStore();
  const bible = world?.bible;

  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /*
   * The version the editor is writing against.
   *
   * Held in a ref rather than read from the bundle at save time because the two disagree exactly
   * when it matters: the Studio can edit the bible mid-conversation, and a save that quietly
   * carried the newer version would overwrite that edit instead of being refused by it.
   */
  const base = useRef<number | null>(null);

  const live = bible?.text ?? "";
  const text = draft ?? live;

  // Adopt the document from underneath the editor whenever it moves and nothing is being typed.
  // That covers all three writers — this screen, the Studio, and a text editor outside the app —
  // without any of them needing to know about the others.
  useEffect(() => {
    if (draft === null) base.current = bible?.version ?? 1;
  }, [bible?.version, draft]);

  /*
   * The draft lives until the store speaks again, and not one render longer.
   *
   * It used to be cleared the moment the save was dispatched, which left a window showing `live` —
   * still the pre-save text until the coordinator's snapshot arrives — as the authoritative
   * document. A text area only flickered; the rich editor reads that as the file having moved
   * underneath it and reloads, taking the caret with it. Dropping the draft on the *next* snapshot
   * covers both writers: our own echo (identical text, nothing happens) and somebody else's edit
   * (different text, adopted). It cannot stick, because any snapshot at all releases it.
   */
  const draftedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (draft !== null && live !== draftedFrom.current) setDraft(null);
  }, [live, draft]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /*
   * Which editor owns this bible.
   *
   * Deciding costs a full markdown parse, so `updateRichModeGate` reuses the last verdict for a
   * document the rich editor itself wrote, and re-reads anything else — including text typed in the
   * source editor, which is a text area somebody can put HTML into. `richWrite` is what carries
   * that distinction: it holds the last text only while the rich editor was the one that produced
   * it, and is cleared the moment the source editor writes.
   *
   * It judges `text` and not `live`, which is the whole difference between catching that and not.
   * The two are the same until somebody types, and then `text` is the draft — the document the rich
   * editor would actually be handed. Judging `live` meant HTML typed in the source editor and still
   * inside the 1200ms before it saved was invisible here, so the toggle could hand the rich editor
   * exactly the document this gate exists to keep away from it.
   *
   * Skipped entirely while the source editor is up: there is no question to answer, the text area
   * is showing either way, and asking would put a parse on every keystroke. The verdict is taken
   * again on the way back, against whatever was typed in the meantime.
   */
  const [preferSource, setPreferSource] = useState(false);
  const richWrite = useRef<string | null>(null);
  const gate = useRef<RichModeGate | null>(null);
  if (!preferSource) gate.current = updateRichModeGate(gate.current, text, richWrite.current);
  const richRefusal = gate.current?.verdict ?? null;
  const richMode = richRefusal === null && !preferSource;

  const onChange = (value: string) => {
    if (draft === null) draftedFrom.current = live;
    richWrite.current = richMode ? value : null;
    setDraft(value);
    setSaving(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!worldId) return;
      saveBible(worldId, value, base.current ?? undefined);
      setSaving(false);
    }, AUTOSAVE_MS);
  };

  const size = useMemo(() => bibleSize(text), [text]);
  const outline = useMemo(() => splitBible(text), [text]);

  /*
   * Read-aloud, on the contents rather than in the prose (2026-08-24).
   *
   * The sheet screen puts its speaker on hover over the paragraph itself, which works there
   * because a sheet's readable prose is two short blocks. A bible is one long editable document
   * and the body of this screen is a text editor — hanging a play button inside it would fight
   * the caret. The contents list already names every section, so it is the one place that can
   * offer "hear this" without getting in the way of writing.
   *
   * Asked for by an author who wanted the story read back to her. The whole arc lives in here.
   */
  const voiceAudio = useVoiceAudio();
  const [read, setRead] = useState<{ requestId: string; heading: string } | null>(null);
  const readResult = read ? voiceAudio[read.requestId] : undefined;
  const narrator = state?.app.narrator ?? null;
  const narratorLabel = narrator && !supportsVoiceUse(narrator, "narration")
    ? DEFAULT_NARRATOR.label
    : narrator?.label ?? narrator?.voiceId ?? DEFAULT_NARRATOR.label;
  /*
   * Plays the moment it lands, rather than making somebody press twice for the same thing.
   *
   * A long section arrives in pieces, because local synthesis runs at about the speed of speech
   * and holding the first word until the last one exists is a ten-minute silence. Each piece is
   * queued as it appears and the first starts immediately; the player walks the rest. A short
   * section still arrives whole and takes the single-clip path, unchanged.
   */
  const parts = useVoiceParts()[read?.requestId ?? ""] ?? [];
  const queued = useRef(0);
  useEffect(() => {
    if (!read || !world) return;
    for (let i = queued.current; i < parts.length; i += 1) {
      const file = parts[i];
      if (file === undefined) return; // a gap means the piece is still being made; wait for it
      void enqueueClip({
        id: read.requestId,
        url: mediaUrl(world.meta.slug, file),
        title: read.heading,
        sub: `read aloud · ${narratorLabel}`,
        part: i,
      });
      queued.current = i + 1;
    }
  }, [read?.requestId, read?.heading, parts.length, world?.meta.slug, narratorLabel]);

  useEffect(() => {
    if (parts.length > 0) return; // a streamed read is already sounding
    if (read && readResult?.status === "ready" && readResult.file && world) {
      void playClip({
        id: readResult.requestId,
        url: mediaUrl(world.meta.slug, readResult.file),
        title: read.heading,
        sub: `read aloud · ${narratorLabel}`,
      });
    }
  }, [read?.heading, readResult?.requestId, readResult?.status, readResult?.file, parts.length, world?.meta.slug, narratorLabel]);
  const history = useMemo(() => {
    const current = bible?.version ?? 1;
    return Array.from({ length: Math.max(0, current - 1) }, (_, i) => current - 1 - i).slice(0, 12);
  }, [bible?.version]);

  if (!state || !world) return null;

  return (
    <div data-screen="bible">
      <div className="fy-hero">
        <div className="fy-hero__eyebrow">
          {world.meta.name} · {bible?.present ? `v${bible.version}` : "not started"} ·{" "}
          {size.words.toLocaleString()} word{size.words === 1 ? "" : "s"}
        </div>
        <h1 className="fy-hero__title" style={{ fontSize: 52 }}>
          Bible
        </h1>
        <div className="fy-mono" style={{ marginTop: 8 }}>
          your thinking about this world, in your words · the Studio reads all of it, every turn ·
          it may guide creative generation, but it is never canon or evidence
        </div>
      </div>

      <div className="fy-biblegrid">
        <div className="fy-biblegrid__main">
          {richMode ? (
            <RichMarkdownEditor
              // Remounting on the world is what re-reads the document from the store; without it a
              // second bible would open into the first one's editor, holding the first one's text.
              key={worldId}
              value={text}
              onChange={onChange}
              placeholder={PLACEHOLDER}
              ariaLabel="The world bible"
            />
          ) : (
            <textarea
              className="fy-bible__editor"
              value={text}
              onChange={(e) => onChange(e.target.value)}
              spellCheck
              placeholder={`${PLACEHOLDER}\n\n## The tides\n\nThe tide is the world's clock and its accountant.`}
              aria-label="The world bible"
            />
          )}
          <div className="fy-bible__foot">
            <span className="fy-mono">
              {saving ? "Saving…" : bible?.present ? `Saved · v${bible.version}` : "Not saved yet"}
            </span>
            <span className="fy-mono">
              {size.words.toLocaleString()} words · ~{size.approxTokens.toLocaleString()} tokens a
              turn
            </span>
            {richRefusal ? (
              <span className="fy-mono">{richRefusal.message}</span>
            ) : (
              <Button variant="ghost" onClick={() => setPreferSource((source) => !source)}>
                {preferSource ? "Rich text" : "Markdown source"}
              </Button>
            )}
          </div>
          {size.characters > NOTABLE_CHARACTERS && (
            <Callout tone="warning" title="This is a long bible now">
              All of it goes to the Studio on every turn — nothing is cut — so it costs about{" "}
              {size.approxTokens.toLocaleString()} tokens each time you say something. That is fine
              if it is all worth carrying. If it is not, the parts you have stopped thinking about
              are the ones to move into Canon or take out.
            </Callout>
          )}
        </div>

        <aside className="fy-biblegrid__side">
          <section className="fy-bible__panel">
            <h2 className="fy-bible__paneltitle">In here</h2>
            {outline.sections.length === 0 ? (
              <p className="fy-bible__empty">
                Headings you write with <code>## </code> show up here, and the Studio can edit them
                one at a time rather than rewriting everything.
              </p>
            ) : (
              <ol className="fy-bible__toc">
                {outline.sections.map((section) => {
                  const mine = read?.heading === section.heading ? readResult : undefined;
                  return (
                    <li key={section.heading}>
                      <span className="fy-bible__tocrow">
                        <span className="fy-bible__tocname">{section.heading}</span>
                        {mine?.status === "ready" && mine.file && world ? (
                          <ClipPlayButton
                            clip={{
                              id: mine.requestId,
                              url: mediaUrl(world.meta.slug, mine.file),
                              title: section.heading,
                              sub: `read aloud · ${narratorLabel}`,
                            }}
                          />
                        ) : (
                          <Button
                            aria-label={`Read ${section.heading} aloud`}
                            disabled={section.body.trim() === "" || (read?.heading === section.heading && !mine)}
                            onClick={() => {
                              if (!worldId) return;
                              queued.current = 0;
                              clearQueue();
                              setRead({ requestId: readBibleSection(worldId, section.heading), heading: section.heading });
                            }}
                          >
                            {read?.heading === section.heading && !mine ? "Preparing…" : "Listen"}
                          </Button>
                        )}
                      </span>
                      {mine?.status === "confirmation-required" && (
                        <span className="fy-bible__tocnote">
                          This section goes to ElevenLabs and is kept in Activity.
                          <Button
                            onClick={() => {
                              if (worldId && read && mine.confirmationToken)
                                readBibleSection(worldId, section.heading, read.requestId, mine.confirmationToken);
                            }}
                          >
                            Confirm {mine.characterCount} characters · {formatMicroUsd(mine.estimatedMicroUsd)}
                          </Button>
                        </span>
                      )}
                      {mine?.status === "failed" && (
                        <span className="fy-bible__tocnote">{mine.error ?? "Read aloud failed."}</span>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section className="fy-bible__panel">
            <h2 className="fy-bible__paneltitle">Earlier versions</h2>
            {history.length === 0 ? (
              <p className="fy-bible__empty">
                Every save keeps the one before it. Nothing here yet — this is still v
                {bible?.version ?? 1}.
              </p>
            ) : (
              <>
                <p className="fy-bible__empty">
                  Restoring brings a version back as a new one. Nothing in between is lost.
                </p>
                <ul className="fy-bible__versions">
                  {history.map((version) => (
                    <li key={version}>
                      <span className="fy-mono">v{version}</span>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (worldId) restoreBible(worldId, version);
                        }}
                      >
                        Restore
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className={cx("fy-bible__panel", "fy-bible__panel--quiet")}>
            <h2 className="fy-bible__paneltitle">Bible or Canon?</h2>
            <p className="fy-bible__empty">
              If changing it should ripple into productions and regenerate references, it is Canon.
              If it is how you think about the place, it belongs here. The Studio reads both, and
              says so when they disagree.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
