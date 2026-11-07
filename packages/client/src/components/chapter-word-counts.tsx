import { chapterWordChangeLabel, chapterWordTotal, type ChapterWordChange } from "@arke-studio/contracts";

export function ChapterWordCounts({ changes, batch = false }: { changes: readonly ChapterWordChange[]; batch?: boolean }) {
  // A plan has no words yet: "0 → 0 (0)" on every chapter.
  if (changes.every((change) => change.before === 0 && change.after === 0)) return null;
  return <section className="fy-actioncard__body" aria-label="Measured proposed word counts">
    <p>{batch ? "Proposed batch words" : "Proposed words"} · measured from the drafts</p>
    <dl style={{ margin: 0 }}>{[...changes, ...(changes.length > 1 ? [{ title: "Total", ...chapterWordTotal(changes) }] : [])].map((change, index) =>
      <div key={index} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "4px 12px", padding: "8px 0" }}>
        <dt>{change.title}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{chapterWordChangeLabel(change)}</dd>
      </div>)}
    </dl>
    <p className="fy-actioncard__notice">Accepted chapter totals change only after acceptance.</p>
  </section>;
}
