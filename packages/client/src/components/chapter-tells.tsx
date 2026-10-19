import { TELL_KINDS, TELL_LABELS, tellsByKind, tellsPerThousand, type ChapterReview, type ReviewTells } from "@arke-studio/contracts";

/*
 * AI tells in the review report (design turn 232h, issue 1952). The reading is the coordinator's,
 * pinned in the review with the line it used: this only shows it. Counts are the model's tags
 * checked against the saved words, so the copy never calls them a detector or a score.
 */

const count = (n: number) => n.toLocaleString("en-GB");

/** One bar per 450 words, start to end, against the line. */
export function TellStrip({ reading }: { reading: ReviewTells }) {
  // Room above the line for the densest bar, and never less than twice the line so it sits midway.
  const scale = Math.max(reading.line * 2, ...reading.strip.map((bar) => bar.count));
  const label = `AI tells in each ${reading.stretchWords} words, start to end: ${reading.strip.map((bar) => bar.count).join(", ")}. The line is ${reading.line}.`;
  return (
    <div className="fy-tells__strip" role="img" aria-label={label}>
      <div className="fy-tells__bars">
        {reading.strip.map((bar) => (
          <span key={bar.start} className={bar.crowded ? "fy-tells__bar fy-tells__bar--crowded" : "fy-tells__bar"} style={{ height: `${Math.max(bar.count, 0.4) / scale * 100}%` }}>
            <small>{bar.count}</small>
          </span>
        ))}
        <span className="fy-tells__line" style={{ bottom: `${reading.line / scale * 100}%` }}><small>{reading.line}</small></span>
      </div>
      <div className="fy-tells__ends"><span>Start</span><span>End</span></div>
    </div>
  );
}

export function ChapterTellsReport({ review }: { review: ChapterReview }) {
  const task = review.tasks.find((t) => t.specialist === "prose");
  // A review from before turn 232 never ran the check; it says nothing rather than "none found".
  if (!task) return null;
  const reading = review.tells;
  if (!reading) {
    const waiting = task.state === "pending" || task.state === "running";
    return (
      <section className="fy-tells" aria-label="AI tells">
        <h3>AI tells</h3>
        <p>{waiting ? "Checking AI tells…" : `Not checked. ${task.detail ?? ""}`.trim()}</p>
      </section>
    );
  }
  const byKind = tellsByKind(reading.tells);
  const most = Math.max(1, ...TELL_KINDS.map((kind) => byKind[kind]));
  const kinds = [...TELL_KINDS].sort((a, b) => byKind[b] - byKind[a]);
  return (
    <section className="fy-tells" aria-label="AI tells">
      <h3>AI tells</h3>
      <p className="fy-tells__facts">
        <span><b>{count(reading.tells.length)}</b> tells</span>
        <span><b>{count(reading.words)}</b> words</span>
        <span><b>{count(tellsPerThousand(reading))}</b> per 1,000 words</span>
      </p>
      <TellStrip reading={reading} />
      <div className="fy-tells__two">
        <section>
          <h4>By kind</h4>
          {kinds.map((kind) => (
            <div key={kind} className="fy-tells__kind">
              <span>{TELL_LABELS[kind]}</span>
              <i style={{ width: `${byKind[kind] / most * 100}%` }} />
              <b>{byKind[kind]}</b>
            </div>
          ))}
        </section>
        <section>
          <h4>Crowded passages</h4>
          {reading.passages.length === 0
            ? <p className="fy-tells__none">None crowded. {reading.tells.length} in {count(reading.words)} words, spread out.</p>
            : reading.passages.map((passage, i) => {
              const { densest } = passage;
              const top = [...TELL_KINDS].filter((kind) => densest.byKind[kind] > 0).sort((a, b) => densest.byKind[b] - densest.byKind[a]);
              return (
                <div key={passage.id} className="fy-tells__passage">
                  <span className="fy-tells__n">{i + 1}</span>
                  <div>
                    <q>{opening(review.body, passage.start)}</q>
                    <small>{densest.count} in {count(densest.words)} words · {top.map((kind) => `${TELL_LABELS[kind]} ${densest.byKind[kind]}`).join(" · ")}</small>
                  </div>
                </div>
              );
            })}
        </section>
      </div>
      <p className="fy-tells__cover">
        Flagged at {reading.line} in any {reading.stretchWords} words, or {reading.kindLine} of one kind. The line is provisional.
        Counts are the model’s reading, checked against your words. Not an AI detector.
        {reading.unplaced > 0 ? ` ${reading.unplaced} tagged ${reading.unplaced === 1 ? "quotation was" : "quotations were"} not in the chapter and not counted.` : ""}
      </p>
    </section>
  );
}

/** The passage's first words, to find it by. */
function opening(body: string, start: number): string {
  const text = body.slice(start, start + 90).replace(/\s+/g, " ").trim();
  return start + 90 < body.length ? `${text.replace(/\s\S*$/, "")}…` : text;
}
