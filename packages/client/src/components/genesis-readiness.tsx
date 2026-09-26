import type { GenesisReadiness, FoundingBuildState } from "@arke-studio/contracts";
import { Button, Callout } from "./ui.js";
import { runBuildItem, stopFoundingBuild, dismissBuildNotice } from "../lib/store.js";
export function GenesisReadinessCard({ review, busy, onRefresh, onFix, onLeave }: {
  review?: GenesisReadiness; busy: boolean; onRefresh(): void; onFix(text: string): void; onLeave(id: string, digest: string): void;
}) {
  return <section aria-label="World readiness review">
    <h2>Review the world</h2>
    <Button disabled={busy} onClick={onRefresh}>Check readiness</Button>
    {!review && <p>Check the current approved content, unresolved choices and references before building.</p>}
    {review && <>
      <p>{review.canBegin ? "No deterministic content blockers found. Creative choices can remain open." : "Resolve the blockers before founding."}</p>
      <p>This is a check of known records, not a guarantee of creative consistency.</p>
      {review.findings.map(finding => <Callout key={finding.id} title={finding.title}>
        <p>{finding.category === "possible-conflict" ? "Possible conflict" : finding.category}{finding.leftOpen ? " · intentionally left open" : ""}</p>
        <p>{finding.detail}</p>
        {!!finding.records.length && <details><summary>Inspect related records</summary>{finding.records.map((record, index) =>
          <section key={index}><strong>{record.key}</strong><p style={{ whiteSpace: "pre-wrap" }}>{record.text}</p></section>)}</details>}
        <Button variant="ghost" disabled={busy} onClick={() => onFix(`Please propose a fix for "${finding.title}": ${finding.detail}\nRecords: ${finding.records.map(record => record.key).join(", ")}. Show changes for approval.`)}>Propose a fix</Button>
        {!finding.leftOpen && !["blocker", "approval"].includes(finding.category) && <Button variant="ghost" disabled={busy} onClick={() => onLeave(finding.id, review.digest)}>Leave unresolved</Button>}
      </Callout>)}
      <details><summary>Approved records ({review.approved.length})</summary>{review.approved.map(record => <p key={record.key}>{record.title}</p>)}</details>
      {review.reused.map(item => <p key={item}>Reuse {item}</p>)}
    </>}
  </section>;
}
export function FoundingProgressCard({ build }: { build: FoundingBuildState }) {
  if (build.noticeDismissed && build.status !== "running") return null;
  return <section aria-label="Founding progress" className="fy-actioncard">
    <h3>{build.worldName} · {build.status}</h3>
    <p>{build.progress.terminal} of {build.progress.authorized} items finished. Completed work is kept.</p>
    {build.items.filter(item => item.state !== "landed").map(item => <div key={item.key}>
      <p>{item.name} · {item.kind.replaceAll("-", " ")} · {item.state}</p>
      {item.detail && <p>{item.detail}</p>}
      {build.status !== "running" && ["failed", "skipped", "held"].includes(item.state) &&
        <Button onClick={() => runBuildItem(build.worldId, item.key)}>Retry {item.name}</Button>}
    </div>)}
    <p>Retries use the original build authorization and cost checks. Completed items are not repeated.</p>
    {build.status === "running" ? <Button onClick={() => stopFoundingBuild(build.worldId)}>Stop and skip remaining work</Button>
      : <Button variant="ghost" onClick={() => dismissBuildNotice(build.worldId)}>Keep completed work and leave the rest</Button>}
  </section>;
}
