import {
  DELIVERIES,
  firstReadNotice,
  legacyVoiceModel,
  orderedShots,
  supportedDeliveries,
  voiceSourceFor,
  type Delivery,
} from "@arke-studio/contracts";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { DegradedBanner, EmptyState } from "../components/layout.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { RemoteVoiceUploadConfirmation } from "../components/remote-voice-upload-confirmation.js";
import { Button } from "../components/ui.js";
import { useProduction } from "../lib/selectors.js";
import {
  requestVoiceLine,
  setProductionModel,
  subscribeQueueResults,
  subscribeVoiceUploadConfirmations,
  useStore,
} from "../lib/store.js";

export function VoiceLineDialogScreen() {
  const { worldId, prodId } = useParams();
  const [params] = useSearchParams();
  const { world, production } = useProduction(worldId, prodId);
  const clientState = useStore().state;
  const navigate = useNavigate();
  const spoken =
    production?.scenes.flatMap((s) => orderedShots(s)).filter((s) => s.audio?.line && s.audio.speaker) ?? [];
  // The shot the row asked for. Without this the dialog showed whichever line came first, so
  // pressing Generate beside one character opened another character's line.
  const asked = params.get("shot");
  const shot = spoken.find((s) => s.id === asked) ?? spoken[0];
  const speaker = shot?.audio?.speaker ? world?.sheets.find((c) => c.id === shot.audio!.speaker) : undefined;
  const assignedVoiceModelId = speaker?.voice
    ? (speaker.voice.model ?? legacyVoiceModel(speaker.voice.provider, speaker.voice.voiceId, world?.clonedVoices ?? []))
    : null;
  const voiceModel = speaker?.voice && assignedVoiceModelId
    ? clientState?.app.manifest?.models.find(
        (model) =>
          model.provider === speaker.voice!.provider &&
          model.capability === "voice-tts" &&
          model.id === assignedVoiceModelId,
      )
    : undefined;
  const voiceDeliveries = supportedDeliveries(voiceModel);
  const voiceReadiness =
    speaker?.voice && voiceModel?.provider === "comfyui"
      ? clientState?.app.comfyui?.recipes.find((recipe) => recipe.recipeId === voiceModel.id)
      : null;
  const assignedVoiceUnavailableReason =
    voiceReadiness?.state === "disabled" ||
    (voiceReadiness?.state === "unknown" && clientState?.app.comfyui?.engine.locality === "local")
      ? (voiceReadiness.reason ?? "The assigned voice recipe is not ready.")
      : voiceModel !== undefined && (clientState?.app.models.disabled ?? []).includes(voiceModel.id)
        ? `${voiceModel.displayName} is turned off in AI models.`
      : voiceModel === undefined && speaker?.voice
        ? "The assigned voice model is no longer available."
        : null;
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<Delivery | "">("");
  const [voiceModelOverride, setVoiceModelOverride] = useState<string | undefined>();
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const [uploadConfirmation, setUploadConfirmation] = useState<{
    destinationLabel: string;
    confirmationToken: string;
    destinationNotice?: string;
  } | null>(null);
  const rememberedVoiceModelId = production?.meta.models?.["voice-tts"];
  const effectiveVoiceModelId = voiceModelOverride ?? rememberedVoiceModelId ?? assignedVoiceModelId ?? undefined;
  const selectedVoiceModel = clientState?.app.manifest?.models.find(
    (model) => model.id === effectiveVoiceModelId && model.capability === "voice-tts",
  );
  const voiceModelConflict =
    effectiveVoiceModelId !== undefined && assignedVoiceModelId !== null && effectiveVoiceModelId !== assignedVoiceModelId
      ? selectedVoiceModel === undefined
        ? `This production still names ${effectiveVoiceModelId}, which is no longer available.`
        : `This production uses ${selectedVoiceModel.displayName}, but ${speaker?.name ?? "this character"}'s assigned voice uses ${voiceModel?.displayName ?? assignedVoiceModelId}. Choose the assigned model for this line.`
      : null;
  const voiceUnavailableReason = voiceModelConflict ?? assignedVoiceUnavailableReason;
  // What the first read through a slot-keeping reader adds (SPEC-046 R-14, R-34), stated before
  // the press: the library entry says whether the vendor already holds the voice.
  const firstRead = (() => {
    if (!speaker?.voice || !voiceModel) return null;
    const source = voiceSourceFor(world?.clonedVoices ?? [], speaker.voice.provider, voiceModel.id, speaker.voice.voiceId);
    return source.kind === "cloned" ? firstReadNotice(source.voice, speaker.voice.provider) : null;
  })();
  useEffect(
    () =>
      subscribeQueueResults((result) => {
        if (result.requestId !== pending.current) return;
        pending.current = null;
        setSending(false);
        if (result.disposition === "accepted") navigate(`/w/${worldId}/p/${prodId}/audio`);
        else setRefusal(result.failures[0]?.reason ?? "The line could not be queued.");
      }),
    [navigate, worldId, prodId],
  );
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== pending.current) return;
        setUploadConfirmation(confirmation);
      }),
    [],
  );
  const generateLine = (voiceUploadConfirmedFor?: string) => {
    if (!worldId || !prodId || !shot) return;
    setRefusal(null);
    setSending(true);
    pending.current = requestVoiceLine({
      worldId,
      productionId: prodId,
      shotId: shot.id,
      ...(effectiveVoiceModelId !== undefined ? { modelId: effectiveVoiceModelId } : {}),
      ...(delivery ? { delivery } : {}),
      ...(voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor } : {}),
    });
  };
  return (
    <div className="fy-dialogwrap" data-screen="voice-line-dialog">
      <div className="fy-dialog" style={{ maxWidth: 560 }}>
        <div className="fy-h1row">
          <h1 className="fy-h1" style={{ fontSize: 22 }}>
            Voice line
          </h1>
          <span className="fy-h1row__push" />
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
            Close
          </Button>
        </div>
        <DegradedBanner component="voice" />
        {shot && speaker ? (
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <div style={{ width: 56, height: 64, flex: "none" }}>
              <Portrait
                worldSlug={world?.meta.slug}
                path={sheetPortraitPath(speaker.id)}
                label={speaker.name}
                radius={8}
              />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ font: "600 14px var(--font-sans)" }}>{speaker.name}</div>
              <div
                style={{
                  font: "400 13px/1.5 var(--font-sans)",
                  color: "var(--muted-foreground)",
                  fontStyle: "italic",
                  marginTop: 2,
                }}
              >
                “{shot.audio!.line}”
              </div>
              <div className="fy-mono" style={{ marginTop: 4 }}>
                {`voice · ${speaker.voice ? `${speaker.voice.label ?? speaker.voice.voiceId} (${speaker.voice.provider})` : "none assigned"}`}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState title="No spoken lines in this production yet" />
        )}
        {refusal !== null && <p className="fy-refusal">{refusal}</p>}
        {voiceUnavailableReason !== null && (
          <p className="fy-refusal">
            {voiceModelConflict ?? `Assigned voice unavailable · ${assignedVoiceUnavailableReason}`}
          </p>
        )}
        {speaker?.voice && assignedVoiceModelId && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <select
              aria-label="Voice model"
              className="fy-bench__chip"
              value={effectiveVoiceModelId}
              onChange={(event) => setVoiceModelOverride(event.target.value)}
            >
              {rememberedVoiceModelId && rememberedVoiceModelId !== assignedVoiceModelId && (
                <option value={rememberedVoiceModelId}>
                  {selectedVoiceModel?.displayName ?? rememberedVoiceModelId} · this production
                </option>
              )}
              <option value={assignedVoiceModelId}>{voiceModel?.displayName ?? assignedVoiceModelId} · assigned voice</option>
            </select>
            {effectiveVoiceModelId === assignedVoiceModelId && rememberedVoiceModelId !== assignedVoiceModelId && worldId && prodId && (
              <button
                type="button"
                className="fy-set__link"
                onClick={() => setProductionModel(worldId, prodId, "voice-tts", assignedVoiceModelId)}
              >
                Remember for this production
              </button>
            )}
          </div>
        )}
        {speaker?.voice &&
          (voiceDeliveries.length > 0 ? (
            <select
              aria-label="Delivery"
              className="fy-bench__chip"
              value={delivery}
              onChange={(event) => setDelivery(event.target.value as Delivery | "")}
            >
              <option value="">delivery · default</option>
              {DELIVERIES.filter((item) => voiceDeliveries.includes(item)).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          ) : (
            <span className="fy-mono">delivery · provider default only</span>
          ))}
        <div>
          <Button
            variant="primary"
            data-testid="voice-line-generate"
            disabled={
              shot === undefined ||
              speaker === undefined ||
              speaker.voice === undefined ||
              voiceUnavailableReason !== null ||
              sending
            }
            title={
              speaker !== undefined && speaker.voice === undefined
                ? `${speaker.name} has no assigned voice — choose one on their sheet`
                : (voiceUnavailableReason ?? undefined)
            }
            onClick={() => generateLine()}
          >
            {sending ? "Generating…" : "Generate line"}
          </Button>
          {firstRead !== null && (
            <span className="fy-mono" data-testid="voice-line-first-read" style={{ marginLeft: 12 }}>
              {firstRead}
            </span>
          )}
        </div>
        {uploadConfirmation && (
          <RemoteVoiceUploadConfirmation
            destinationLabel={uploadConfirmation.destinationLabel}
            destinationNotice={uploadConfirmation.destinationNotice}
            onCancel={() => {
              pending.current = null;
              setSending(false);
              setUploadConfirmation(null);
            }}
            onConfirm={() => {
              const token = uploadConfirmation.confirmationToken;
              setUploadConfirmation(null);
              generateLine(token);
            }}
          />
        )}
      </div>
    </div>
  );
}
