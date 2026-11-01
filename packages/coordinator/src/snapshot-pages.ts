import { jobSummary, type ClientState, type SnapshotPage } from "@arke-studio/contracts";

type Collections = { artifacts: NonNullable<ClientState["world"]>["artifacts"]; jobs: ClientState["app"]["jobs"]; ledger: ClientState["app"]["ledger"] };
const PAGE_BYTES = 1024 * 1024;

/** Per authenticated connection. Full first delivery, then changed rows only. The final
 * snapshot is a barrier: its pages must never be coalesced independently of that snapshot. */
export class SnapshotPages {
  private previous: Partial<Collections> = {};
  private worldId: string | null = null;
  reset(): void { this.previous = {}; this.worldId = null; }
  *prepare(state: ClientState): Generator<SnapshotPage> {
    const worldId = state.world?.meta.worldId ?? null;
    const values: Collections = { artifacts: state.world?.artifacts ?? [], jobs: state.app.jobs, ledger: state.app.ledger };
    for (const collection of ["artifacts", "jobs", "ledger"] as const) {
      const rows = values[collection], before = collection === "artifacts" && worldId !== this.worldId ? undefined : this.previous[collection];
      if (rows === before) continue;
      let reset = before === undefined, batch: unknown[] = [], offset = 0, bytes = 0;
      const page = (): SnapshotPage => ({ collection, offset, length: rows.length, reset, rows: batch } as SnapshotPage);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!, prior = before?.[index];
        if (row === prior || prior && JSON.stringify(row) === JSON.stringify(prior)) {
          if (batch.length) { yield page(); batch = []; bytes = 0; reset = false; }
          continue;
        }
        const projected = collection === "jobs" ? jobSummary(row as Collections["jobs"][number]) : row;
        const size = Buffer.byteLength(JSON.stringify(projected));
        if (batch.length && (batch.length >= 256 || bytes + size > PAGE_BYTES)) { yield page(); batch = []; bytes = 0; reset = false; }
        if (!batch.length) offset = index;
        batch.push(projected); bytes += size;
      }
      if (batch.length) yield page();
      else if (before === undefined || rows.length !== before.length) { offset = rows.length; yield page(); }
    }
    this.previous = values; this.worldId = worldId;
  }
}
