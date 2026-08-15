import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { bibleSize, splitBible } from "@arke-studio/contracts";
import { Button, Callout, cx } from "../components/ui.js";
import { restoreBible, saveBible, useStore } from "../lib/store.js";
import { useOpenWorldGuard } from "../lib/selectors.js";

/**
 * The world bible (SPEC-022) — one page, one document, no approval step.
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

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onChange = (value: string) => {
    setDraft(value);
    setSaving(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!worldId) return;
      saveBible(worldId, value, base.current ?? undefined);
      setSaving(false);
      // Cleared so the next snapshot from the coordinator becomes the live text again. Keeping
      // the draft would leave the editor showing its own copy forever, and a Studio edit landing
      // in the same document would never appear.
      setDraft(null);
    }, AUTOSAVE_MS);
  };

  const size = useMemo(() => bibleSize(text), [text]);
  const outline = useMemo(() => splitBible(text), [text]);
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
          it is not canon, and nothing generates from it
        </div>
      </div>

      <div className="fy-biblegrid">
        <div className="fy-biblegrid__main">
          <textarea
            className="fy-bible__editor"
            value={text}
            onChange={(e) => onChange(e.target.value)}
            spellCheck
            placeholder={
              "Write anything here — what this world is about, how it should feel, what you have not decided yet.\n\n## The tides\n\nThe tide is the world's clock and its accountant."
            }
            aria-label="The world bible"
          />
          <div className="fy-bible__foot">
            <span className="fy-mono">
              {saving ? "Saving…" : bible?.present ? `Saved · v${bible.version}` : "Not saved yet"}
            </span>
            <span className="fy-mono">
              {size.words.toLocaleString()} words · ~{size.approxTokens.toLocaleString()} tokens a
              turn
            </span>
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
                {outline.sections.map((section) => (
                  <li key={section.heading}>{section.heading}</li>
                ))}
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
