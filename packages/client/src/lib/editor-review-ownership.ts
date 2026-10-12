type Activation = { key: string; kind: "effects" | "transitions" };
const listeners = new Set<(activation: Activation) => void>();
/** One reviewed candidate owns the picture. Only explicit Review claims it. */
export function claimEditorReview(activation: Activation): void { for (const listener of listeners) listener(activation); }
export function subscribeEditorReviewOwner(listener: (activation: Activation) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
