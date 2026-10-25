/** Initialization owns each child until Coordinator can close it. Failed cleanup retains
 * ownership so StartupController cannot retry alongside an unconfirmed previous runtime. */
export class StartupRuntimeOwners {
  private readonly owners = new Set<{ dispose(): Promise<void> }>();

  own(owner: { dispose(): Promise<void> }): () => void {
    this.owners.add(owner);
    return () => { this.owners.delete(owner); };
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.owners].map(async owner => {
      await owner.dispose();
      this.owners.delete(owner);
    }));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Startup runtime cleanup did not confirm exit.");
  }
}
