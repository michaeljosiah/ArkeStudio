import { createHash } from "node:crypto";
import { voiceTargetKey, type DomainEvent, type VoiceCandidate } from "@arke-studio/contracts";

/**
 * What coordinator.jsonl keeps of an event. Almost always the event itself; the exceptions are
 * events that carry the whole voice catalogue, which is about 1.5 MB and is re-sent on every
 * picker open and refresh. Journalled whole, 1,248 of them made up most of a 2.6 GB log
 * (issue 1845). Nothing reads a catalogue back from the journal, and clients still receive the
 * full event, so the record keeps only what a diagnosis needs: how many voices, from which
 * providers, and a digest that says whether two refreshes returned the same list.
 *
 * A summarised record no longer parses as a DomainEvent, which its one reader
 * (durableExportReads, after export.progress rows) skips as it skips every other type.
 */
export function journalRecord(event: DomainEvent): Record<string, unknown> {
  if (event.type === "voice.catalogue") {
    const { voices, ...rest } = event;
    return { ...rest, voicesSummary: voiceCatalogueSummary(voices) };
  }
  if (event.type === "genesis.voices") {
    const { catalogue, ...voices } = event.voices;
    return { ...event, voices: { ...voices, catalogueSummary: voiceCatalogueSummary(catalogue) } };
  }
  return event;
}

export interface VoiceCatalogueSummary {
  count: number;
  providers: Record<string, number>;
  /** sha256 over the sorted voice identities: equal across refreshes that list the same voices. */
  digest: string;
}

export function voiceCatalogueSummary(voices: readonly Pick<VoiceCandidate, "provider" | "model" | "voiceId">[]): VoiceCatalogueSummary {
  const providers: Record<string, number> = {};
  for (const voice of voices) providers[voice.provider] = (providers[voice.provider] ?? 0) + 1;
  const keys = voices.map(voiceTargetKey).sort();
  return { count: voices.length, providers, digest: `sha256:${createHash("sha256").update(keys.join("\n")).digest("hex")}` };
}
