import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  deriveRehearsalLines,
  estimateMicroUsd,
  formatMicroUsd,
  lookHoldingScope,
  normalizeSpeechText,
  orderedShots,
  resolveCast,
  ulid,
  type ClientMessage,
  type PerformanceRecord,
  type ProductionBundle,
  type ReferenceKit,
  type SceneRecord,
  type WorldBundle,
} from "@arke-studio/contracts";
import { X } from "../../components/icons.js";
import { Button, cx } from "../../components/ui.js";
import { characterPortraitPath } from "../../components/portrait.js";
import { playClip } from "../../lib/audio.js";
import { mediaUrl } from "../../lib/media.js";
import { attachCharacterLook, send, useStore } from "../../lib/store.js";
import { lookTileLabel } from "../character-reference.js";
import { GenerateLineSheet, RecordLineSheet, textHash, type SpokenLine } from "./line-doors.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];
type Look = NonNullable<ReferenceKit["looks"]>[number];

const seconds = (value: number | null | undefined): string | null => (value == null ? null : `${value.toFixed(1)}s`);
const shotList = (numbers: readonly number[]): string => `shot${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}`;

/** One card in a row (SPEC-044 R-11): solid is a choice, dashed is a door, the one in use is ringed. */
function Card({ on, door, thumb, label, sub, disabled, onPress }: {
  on?: boolean; door?: boolean; thumb?: React.ReactNode; label: string; sub?: string | null; disabled?: boolean; onPress: () => void;
}) {
  return (
    <button
      type="button"
      className={cx("fy-chardialog__card", on && "fy-chardialog__card--on", door && "fy-chardialog__card--door")}
      aria-pressed={door ? undefined : on === true}
      aria-label={sub ? `${label} · ${sub}` : label}
      disabled={disabled}
      onClick={onPress}
    >
      {thumb}
      <span className="fy-chardialog__cardtext">
        <span className="fy-chardialog__cardname">{label}</span>
        {sub ? <span className="fy-chardialog__cardsub">{sub}</span> : null}
      </span>
    </button>
  );
}

/**
 * A character in the scene (SPEC-044 R-11..R-16): the picture in use on the left, a preview and
 * not a control; on the right the name, what the scene says about them, and three rows in one
 * grammar — Look, Voice, Lines — where a press commits. Nothing is saved on Done, because
 * nothing waits to be saved.
 */
export function CharacterDialog({ world, production, scene, sheetId, onClose, onWrite }: {
  world: WorldBundle; production: ProductionBundle; scene: SceneRecord; sheetId: string;
  onClose: () => void; onWrite: (command: Command) => boolean;
}) {
  const navigate = useNavigate();
  const { state } = useStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const [door, setDoor] = useState<"record" | "generate" | null>(null);
  useEffect(() => {
    const node = dialog.current;
    if (node === null) return;
    if (node.showModal !== undefined) node.showModal();
    else node.setAttribute("open", "");
  }, []);
  const worldId = world.meta.worldId, productionId = production.meta.id;
  const sheet = world.sheets.find((candidate) => candidate.id === sheetId);
  const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheetId) ?? null;
  const name = sheet?.name ?? sheetId;
  const member = scene.cast?.[sheetId];
  const shots = orderedShots(scene);
  const numberOf = (shotId: string) => shots.find((shot) => shot.id === shotId)?.number ?? 0;
  const lines: SpokenLine[] = deriveRehearsalLines(scene, world.sheets)
    .filter((line) => line.speakerSheetId === sheetId && line.reason === undefined)
    .map((line) => ({ id: line.id, shotId: line.shotId, ...(line.blockId ? { blockId: line.blockId } : {}), number: numberOf(line.shotId), text: line.text }));
  const speaksIn = [...new Set(lines.map((line) => line.number))];
  const seenIn = shots.filter((shot) => resolveCast(shot.description, world.sheets).cast.some((entry) => entry.sheet.id === sheetId)).map((shot) => shot.number);
  const facts = [
    sheet?.billing,
    sheet === undefined ? null : `sheet v${sheet.version}`,
    speaksIn.length > 0 ? `speaks in ${shotList(speaksIn)}` : null,
    seenIn.length > 0 ? `seen in ${shotList(seenIn)}` : null,
    speaksIn.length === 0 && seenIn.length === 0 ? "in no shot yet" : null,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

  // The look in use is the resolver's (SPEC-017 R-20): this scene's, else the production's,
  // else the kit's own portrait. Attaching displaces the previous scene attachment on the
  // coordinator (one look per scope), so a press is one message.
  const sceneLook = lookHoldingScope(kit, { kind: "scene", productionId, sceneId: scene.id });
  const productionLook = lookHoldingScope(kit, { kind: "production", productionId });
  const lookInUse = sceneLook ?? productionLook;
  const looks = (kit?.looks ?? []).filter((look) => {
    const held = look.attachedTo;
    return held !== undefined && held.productionId === productionId && (held.kind === "production" || held.sceneId === scene.id);
  });
  const picture = lookInUse === undefined ? characterPortraitPath(world, sheetId) : `references/${sheetId}/${lookInUse.file}`;
  const useLook = (look: Look | null) => {
    if (look !== null) attachCharacterLook(worldId, sheetId, look.id, { kind: "scene", productionId, sceneId: scene.id });
    else if (lookInUse !== undefined) attachCharacterLook(worldId, sheetId, lookInUse.id, null);
  };

  // The voice: the kit's sample by default (R-8), or one read chosen for this scene (R-13).
  const sample = kit?.designatedVoiceSample;
  const sampleSeconds = sample !== undefined && "schemaVersion" in sample ? seconds(sample.provenance.outputTechnical.durationSec) : null;
  const latestReview = (record: PerformanceRecord) => production.performanceReview.reviews.filter((review) => review.performanceId === record.id).at(-1)?.decision;
  const reads = production.performances
    .filter((record) => record.target.sceneId === scene.id && record.target.speakerSheetId === sheetId)
    .map((record) => ({ record, decision: latestReview(record) }))
    .filter((entry) => entry.decision !== "reject");
  const choice = member?.voice;
  const chosen = choice?.kind === "performance"
    ? reads.find((entry) => entry.decision === "accept" && entry.record.id === choice.performanceId && entry.record.provenance.outputHash === choice.hash)
    : undefined;
  const stale = choice?.kind === "performance" && chosen === undefined;
  const chooseVoice = (voice: NonNullable<NonNullable<SceneRecord["cast"]>[string]["voice"]>) =>
    onWrite({ kind: "edit-scene", cast: { [sheetId]: { ...member, voice } } });
  // A generated line arrives unreviewed; one press accepts, selects and chooses (R-15), the
  // composition Keep uses, under the review's own request id.
  const acceptAndChoose = (record: PerformanceRecord) =>
    send({ kind: "review-performance", requestId: ulid(), worldId, productionId, performanceId: record.id, decision: "accept",
      expectedReviewHash: production.performanceReview.reviewHash, expectedSelectionHash: production.performanceReview.selectionHash,
      select: true, expectedSceneVersion: scene.version });
  const voiceModel = sheet?.voice === undefined ? undefined
    : state?.app.manifest?.models.find((model) => model.capability === "voice-tts" && model.provider === sheet.voice?.provider && model.cadence);
  const firstLine = lines[0];
  const price = voiceModel !== undefined && firstLine !== undefined
    ? formatMicroUsd(estimateMicroUsd(voiceModel, { characters: normalizeSpeechText(firstLine.text).length }))
    : null;
  const voicePage = () => { onClose(); navigate(`/w/${worldId}/cast/${sheetId}/voice`); };

  // A line's read is stale when the wording moved (R-16): the target's hash is the text's own.
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const lineKey = lines.map((line) => `${line.id}${line.text}`).join("");
  useEffect(() => {
    let active = true;
    void Promise.all(lines.map(async (line) => [line.id, await textHash(line.text)] as const)).then((entries) => {
      if (active) setHashes(Object.fromEntries(entries));
    });
    return () => { active = false; };
  }, [lineKey]);
  const readFor = (line: SpokenLine) => {
    const selection = production.performanceReview.selections[line.id];
    return selection?.performanceId ? production.performances.find((record) => record.id === selection.performanceId) : undefined;
  };
  const play = (record: PerformanceRecord, line: SpokenLine) =>
    void playClip({ id: record.id, url: mediaUrl(world.meta.slug, `productions/${productionId}/performances/${record.id}/${record.file}`), title: `${name} · shot ${line.number}` });

  return (
    <dialog
      ref={dialog}
      className="fy-chardialog"
      aria-label={`${name} in scene ${scene.number}`}
      onCancel={(event) => { event.preventDefault(); if (door !== null) setDoor(null); else onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="fy-chardialog__panel">
        <div className="fy-chardialog__picture" aria-hidden="true">
          <img src={mediaUrl(world.meta.slug, picture)} alt="" draggable={false} onError={(event) => { event.currentTarget.style.display = "none"; }} />
        </div>
        <div className="fy-chardialog__body">
          <div className="fy-chardialog__head">
            <span className="fy-chardialog__title">
              <span className="fy-chardialog__name">{name}</span>
              <span className="fy-chardialog__facts">{facts.join(" · ")}</span>
            </span>
            <button type="button" className="fy-chardialog__close" aria-label="Close" onClick={onClose}><X size={13} /></button>
          </div>

          <div className="fy-chardialog__row" aria-label="Look">
            <div className="fy-chardialog__label">Look</div>
            <div className="fy-chardialog__cards">
              <Card
                on={lookInUse === undefined}
                label="Kit"
                sub="portrait"
                thumb={<span className="fy-chardialog__thumb fy-chardialog__thumb--round"><img src={mediaUrl(world.meta.slug, characterPortraitPath(world, sheetId))} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /></span>}
                onPress={() => useLook(null)}
              />
              {looks.map((look) => (
                <Card
                  key={look.id}
                  on={lookInUse?.id === look.id}
                  label={lookTileLabel(look.prompt, look.kind)}
                  sub={look.attachedTo?.kind === "scene" ? "this scene" : "this production"}
                  thumb={<span className="fy-chardialog__thumb"><img src={mediaUrl(world.meta.slug, `references/${sheetId}/${look.file}`)} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /></span>}
                  onPress={() => useLook(look)}
                />
              ))}
              <Card door label="Add a look" sub="Looks page" onPress={() => { onClose(); navigate(`/w/${worldId}/cast/${sheetId}/looks?attach=scene:${productionId}:${scene.id}`); }} />
            </div>
          </div>

          <div className="fy-chardialog__row" aria-label="Voice">
            <div className="fy-chardialog__label">Voice</div>
            <div className="fy-chardialog__cards">
              {sample === undefined
                ? <Card door label="no sample yet" sub="Voice page" onPress={voicePage} />
                : <Card on={choice === undefined || choice.kind === "sample"} label="Sample" sub={sampleSeconds === null ? "Voice page" : `Voice page · ${sampleSeconds}`} thumb={<span className="fy-chardialog__dot" />} onPress={() => chooseVoice({ kind: "sample" })} />}
              {stale ? <Card on label="read missing" sub="the sample rides" thumb={<span className="fy-chardialog__dot" />} disabled onPress={() => undefined} /> : null}
              {reads.map(({ record, decision }) => (
                <Card
                  key={record.id}
                  on={chosen?.record.id === record.id}
                  label={`Line ${numberOf(record.target.shotId)}`}
                  sub={decision === "accept" ? `read · ${seconds(record.provenance.outputTechnical.durationSec) ?? "kept"}` : "new"}
                  thumb={<span className="fy-chardialog__dot fy-chardialog__dot--read" />}
                  onPress={() => {
                    if (decision === "accept") chooseVoice({ kind: "performance", performanceId: record.id, hash: record.provenance.outputHash });
                    else acceptAndChoose(record);
                  }}
                />
              ))}
              <Card door label="Record a line" sub={lines.length === 0 ? "no line to read" : "your microphone"} disabled={lines.length === 0} onPress={() => setDoor("record")} />
              {voiceModel === undefined
                ? <Card door label="Generate a line" sub="Voice page" onPress={voicePage} />
                : <Card door label="Generate a line" sub={lines.length === 0 ? "no line to read" : price} disabled={lines.length === 0} onPress={() => setDoor("generate")} />}
            </div>
          </div>

          <div className="fy-chardialog__row" aria-label="Lines in this scene">
            <div className="fy-chardialog__label">Lines in this scene</div>
            {lines.length === 0 ? <p className="fy-chardialog__none">no lines in this scene</p> : lines.map((line) => {
              const record = readFor(line);
              const earlier = record !== undefined && hashes[line.id] !== undefined && record.target.authoredTextHash !== hashes[line.id];
              return (
                <div className="fy-chardialog__line" key={line.id}>
                  <span className="fy-chardialog__lineshot">shot {line.number}</span>
                  <span className="fy-chardialog__linetext">“{line.text}”</span>
                  {record === undefined ? <span className="fy-chardialog__lineread">no read yet</span> : (
                    <>
                      <button type="button" className="fy-chardialog__play" aria-label={`Play shot ${line.number}`} onClick={() => play(record, line)} />
                      <span className="fy-chardialog__lineread">{earlier ? "read · earlier wording" : `read · ${seconds(record.provenance.outputTechnical.durationSec) ?? "kept"}`}</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <span className="fy-chardialog__spacer" />
          <div className="fy-chardialog__foot">
            <Button variant="ghost" size="sm" disabled={member === undefined} title={member === undefined ? "cited by a shot" : undefined}
              onClick={() => { onWrite({ kind: "edit-scene", cast: { [sheetId]: null } }); onClose(); }}>
              Remove from scene
            </Button>
            <span className="fy-chardialog__spacer" />
            <Button variant="primary" size="sm" onClick={onClose}>Done</Button>
          </div>
        </div>
        {door === "record" && sheet !== undefined ? (
          <RecordLineSheet world={world} production={production} scene={scene} sheet={sheet} lines={lines} onClose={() => setDoor(null)} />
        ) : null}
        {door === "generate" && sheet !== undefined && voiceModel !== undefined ? (
          <GenerateLineSheet world={world} production={production} scene={scene} sheet={sheet} model={voiceModel} lines={lines} onClose={() => setDoor(null)} />
        ) : null}
      </div>
    </dialog>
  );
}
