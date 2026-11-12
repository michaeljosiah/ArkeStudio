import type { ClientState, SnapshotPage } from "@arke-studio/contracts";

/** Staged rows become visible together at the final snapshot, never as partial history. */
export class SnapshotPageBuffer {
  private snapshot: number | null = null;
  private collections: Partial<Record<SnapshotPage["collection"], unknown[]>> = {};
  clear(): void { this.snapshot = null; this.collections = {}; }
  append(snapshot: number, page: SnapshotPage, base: ClientState | null): void {
    if (snapshot !== this.snapshot) { this.clear(); this.snapshot = snapshot; }
    const prior = this.collections[page.collection];
    const source = page.collection === "artifacts" ? base ? base.world?.artifacts ?? [] : undefined : base?.app[page.collection];
    if (!page.reset && !prior && !source) throw new Error("Snapshot page has no base.");
    const rows = page.reset ? [] : prior ?? [...source!];
    rows.length = page.length;
    for (let index = 0; index < page.rows.length; index++) rows[page.offset + index] = page.rows[index];
    this.collections[page.collection] = rows;
  }
  finish(snapshot: number, state: ClientState, base: ClientState | null = null): boolean {
    const artifacts = this.collections.artifacts ?? (base ? base.world?.artifacts ?? [] : undefined);
    const jobs = this.collections.jobs ?? base?.app.jobs, ledger = this.collections.ledger ?? base?.app.ledger;
    const complete = (rows: unknown[] | undefined) => { if (!rows) return false; for (let i = 0; i < rows.length; i++) if (!(i in rows)) return false; return true; };
    if (this.snapshot !== null && this.snapshot !== snapshot || !complete(artifacts) || !complete(jobs) || !complete(ledger)) { this.clear(); return false; }
    state.app.jobs = jobs as ClientState["app"]["jobs"];
    state.app.ledger = ledger as ClientState["app"]["ledger"];
    if (state.world) state.world.artifacts = artifacts as NonNullable<ClientState["world"]>["artifacts"];
    this.clear(); return true;
  }
}
