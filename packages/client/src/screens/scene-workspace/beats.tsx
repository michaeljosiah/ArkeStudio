import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { formatMicroUsd, routingFindings, sceneBeats, type ProductionBundle, type RoutingFinding, type SceneBeat, type Sheet, type TableReadPlan, type WorldBundle } from "@arke-studio/contracts";
import { InteractivePlayerView } from "../../components/interactive-player.js";
import { unwalkedChoices } from "../../lib/branch-map.js";
import { listRoutingFindings, recordTraversal, subscribeRoutingFindings } from "../../lib/store.js";
import { beatPreviewOptions } from "../branch-map.js";
import { useProductionVoiceFiles, type LineVoice } from "./table-read.js";

/**
 * A visual novel's scene page reads its shots as beats (turn 174): the line each one carries,
 * whose it is, whether it is voiced, and how it moves on. Nothing here is a store of its own —
 * the line is the covered script block, the voice is the table read's, the rest is `shot.beat`.
 */

const VOICE_WORD: Record<LineVoice, string> = { voiced: "voiced", voicing: "voicing", unvoiced: "not voiced" };

/** Who a beat's line belongs to, as the page and the player say it. */
export function beatSpeakerName(beat: Pick<SceneBeat, "kind" | "speaker">, sheets: readonly Pick<Sheet, "id" | "name">[]): string | null {
  if (beat.kind === "narration") return "Narrator";
  if (beat.kind === "dialogue" && beat.speaker) return sheets.find((sheet) => sheet.id === beat.speaker)?.name ?? beat.speaker;
  return null;
}

/** The lines a row carries, each under its speaker, with whether it is voiced. */
export function BeatLines({
  beats,
  sheets,
  voices,
}: {
  beats: readonly SceneBeat[];
  sheets: readonly Pick<Sheet, "id" | "name">[];
  voices: ReadonlyMap<string, LineVoice>;
}) {
  const spoken = beats.filter((beat) => beat.kind !== "picture");
  if (spoken.length === 0) return <p className="fy-swbeat__none">No line · the picture alone</p>;
  return (
    <ul className="fy-swbeat" data-testid="beat-lines">
      {spoken.map((beat) => {
        const voice = beat.lineId === undefined ? "unvoiced" : voices.get(beat.lineId) ?? "unvoiced";
        return (
          <li key={beat.lineId ?? beat.shot.id} className="fy-swbeat__line" data-kind={beat.kind}>
            <span className="fy-swbeat__who">{beatSpeakerName(beat, sheets)}</span>
            <span className="fy-swbeat__text">{beat.text}</span>
            <span className="fy-swbeat__voice" data-voice={voice}>
              <i aria-hidden="true" />
              {VOICE_WORD[voice]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Voice lines" (174b): prepare every line the plan has no read for, at the price it quoted. A
 * visual novel plays an unvoiced line as text, so this is an offer, never a block — and when
 * every line has a read it says so rather than offering nothing.
 */
export function VoiceLinesControl({
  plan,
  preparing,
  notice,
  onPrepare,
  ceiling = false,
  planNote = null,
}: {
  plan: TableReadPlan | null;
  preparing: boolean;
  notice: string;
  onPrepare: () => void;
  /** A per-token reader's price is a ceiling, said "up to" as Preview's Play lines says it. */
  ceiling?: boolean;
  /** A free plan or credit named where the price was (design turn 182). */
  planNote?: string | null;
}) {
  if (plan === null || plan.items.length === 0) return null;
  const missing = plan.items.filter((item) => item.route === "local" || item.route === "cloud");
  const voicing = plan.items.filter((item) => item.route === "generating").length;
  const voiced = plan.items.filter((item) => item.file !== undefined).length;
  // Lines nothing can voice say why — a narrator to choose, a provider to validate — rather than
  // leaving a count with no way forward. The coordinator's reasons are already plain words.
  const blocked = plan.items.filter((item) => item.route === "unavailable" && item.reason !== undefined);
  const reasons = [...new Set(blocked.map((item) => item.reason!))];
  return (
    <span className="fy-swvoice">
      <span className="fy-swvoice__count">{voiced} of {plan.items.length} voiced{voicing > 0 ? ` · ${voicing} voicing` : ""}</span>
      {missing.length === 0 && reasons.length > 0 ? (
        <span className="fy-swvoice__notice" data-testid="voice-lines-blocked">
          {blocked.length} can’t be voiced: {reasons.slice(0, 2).join(" ")}{reasons.length > 2 ? " …" : ""}
        </span>
      ) : null}
      {missing.length > 0 ? (
        <button type="button" className="fy-swvoice__go" disabled={preparing} onClick={onPrepare}>
          {preparing ? "Voicing…" : `Voice ${missing.length} line${missing.length === 1 ? "" : "s"}`}
          {planNote !== null ? ` · ${planNote}` : plan.totalEstimatedMicroUsd > 0 ? ` · ${ceiling ? "up to " : ""}${formatMicroUsd(plan.totalEstimatedMicroUsd)}` : ""}
        </button>
      ) : null}
      {notice === "" ? null : <span role="status" className="fy-swvoice__notice">{notice}</span>}
    </span>
  );
}

/** How a beat moves on, as the row's chip says it. */
export function advanceWord(advance: "voice" | "tap" | "hold", holdSec: number): string {
  return advance === "voice" ? "after the voice" : advance === "tap" ? "on tap" : `hold ${holdSec}s`;
}

/**
 * A visual novel's scene previewed from its own page (174d): the one player over the window, from
 * this scene, reading as the branch map's preview reads — the same options, the same voices, the
 * same walk evidence. Closing it goes back to the beats. It waits for the voices, since the player
 * is mounted once and a beat cannot gain its voice after.
 */
export function SceneBeatPreview({
  world,
  production,
  sceneId,
  startShotId,
  onClose,
}: {
  world: WorldBundle;
  production: ProductionBundle;
  sceneId: string;
  /** "Play from here" on a shot: the preview opens on that shot's first beat. */
  startShotId?: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const worldId = world.meta.worldId;
  const productionId = production.meta.id;
  const [opened] = useState(() => Date.now());
  const voices = useProductionVoiceFiles({ worldId, productionId, scenes: production.scenes, key: opened });
  const [served, setServed] = useState<RoutingFinding[] | null>(null);
  useEffect(() => {
    const off = subscribeRoutingFindings((event) => {
      if (event.productionId === productionId) setServed(event.findings);
    });
    listRoutingFindings(worldId, productionId);
    return off;
  }, [worldId, productionId]);
  const unwalked = useMemo(() => {
    if (served !== null) return [...unwalkedChoices(served)].sort();
    return production.routing ? [...unwalkedChoices(routingFindings(production.routing, production.scenes, []))].sort() : [];
  }, [served, production.routing, production.scenes]);
  // The player's beats are the scene's beats in order, so a shot's first beat is its index there.
  const at = useMemo(() => {
    const scene = production.scenes.find((candidate) => candidate.id === sceneId);
    return startShotId === undefined || scene === undefined ? -1 : sceneBeats(scene).findIndex((beat) => beat.shot.id === startShotId);
  }, [production.scenes, sceneId, startShotId]);
  if (!voices.ready) return <p className="fy-swbeat__none" role="status">Gathering the voices…</p>;
  return (
    <InteractivePlayerView
      className="bm-player"
      label="Preview"
      unwalked={unwalked}
      options={beatPreviewOptions({
        world,
        production,
        voices: voices.files,
        from: sceneId,
        ...(at > 0 ? { at } : {}),
        unwalked,
        onChoice: (choice, walked) => recordTraversal(worldId, productionId, choice.id, choice.from, choice.to, walked),
        ...(production.routing ? { onBranchMap: () => navigate(`/w/${worldId}/p/${productionId}/branch-map`) } : {}),
        onClose,
      })}
    />
  );
}
