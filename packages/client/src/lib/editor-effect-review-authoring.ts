import { EffectCreativeCommandSchema, type EffectHumanIntent, type EffectProposalVersion,
  type ProductionTimeline, type TimelineCommand } from "@arke-studio/contracts";

/** Only effects are projected from a pending version. The saved picture and sound stay canonical. */
export function effectReviewTimeline(current: ProductionTimeline, version: Pick<EffectProposalVersion, "state">): ProductionTimeline {
  return { ...current,
    tracks: [...current.tracks.filter(track => track.kind !== "effect"),
      ...version.state.tracks.map(track => ({ ...track, kind: "effect" as const, clips: [] }))],
    effectProtection: version.state.protection,
  };
}

/** The ordinary Inspector can describe a human edit, but cannot turn other editor actions into one. */
export function effectReviewCommandIntent(timeline: ProductionTimeline, commands: readonly TimelineCommand[]):
  { ok: true; intent: EffectHumanIntent } | { ok: false; reason: string } {
  if (commands.length === 1) {
    const command = commands[0]!;
    if (command.kind === "effect-protect") return { ok: true, intent: { kind: "protect", rule: command.rule } };
    if (command.kind === "effect-release") return { ok: true, intent: { kind: "release", ruleId: command.ruleId } };
  }
  if (!commands.length || commands.length > 50) return { ok: false, reason: "A pending effect edit needs 1–50 operations." };
  const admitted = [];
  for (const command of commands) {
    const parsed = EffectCreativeCommandSchema.safeParse(command);
    if (!parsed.success) return { ok: false, reason: "Return to Current editing to change picture or sound." };
    if (parsed.data.kind === "set-track" || parsed.data.kind === "remove-track") {
      const trackId = parsed.data.trackId;
      if (timeline.tracks.find(track => track.id === trackId)?.kind !== "effect") {
        return { ok: false, reason: "Only effects tracks can be changed in this review." };
      }
    }
    admitted.push(parsed.data);
  }
  return { ok: true, intent: { kind: "adjust", commands: admitted } };
}
