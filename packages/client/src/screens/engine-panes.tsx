import { useEffect, useRef, useState } from "react";
import {
  FIT_LABEL,
  ENGINE_LABEL,
  comfyUiWeightsComponentId,
  transferProgress,
  type ComfyUiEngineStatus,
  type EngineId,
  type ComponentHealth,
  type SetupComponent,
  type VoiceRuntimeStatus,
} from "@arke-studio/contracts";
import { Button, cx } from "../components/ui.js";
import { SetupTransferControl } from "../components/setup-transfer-control.js";
import {
  HealthDot,
  RuntimeHead,
  engineCapabilityWords,
  RuntimeSection,
  RuntimeStatus,
  sizeMb,
  type RuntimeTone,
} from "./settings-parts.js";
import { playClip, usePlayback } from "../lib/audio.js";
import {
  chooseComfyUiModelsDir,
  chooseComfyUiPath,
  chooseVoxaExecutable,
  clearComfyUiEngine,
  clearComfyUiModelsDir,
  clearVoxaExecutable,
  openEngineLog,
  openModelFolder,
  updateComfyUiRuntime,
  refreshComfyUi,
  restartComfyUi,
  repairVoiceModels,
  restartVoxa,
  setComfyUiUrl,
  setupRepair,
  setupRetry,
  setupSkip,
  testLocalVoice,
  useBundledVoxa,
  useDetectedComfyUi,
  useSetup,
  useStore,
  useVoiceRuntimeTest,
  verifyComfyUiRecipe,
} from "../lib/store.js";
/**
 * The engine panes of Settings · Providers (SPEC-034 R-5). The machinery, deliberately and
 * completely.
 *
 * Most people never open one. The ones who do are troubleshooting, and abridging it for them
 * would be the wrong kindness — so the detail is unabridged, and R-5 moves it into a provider
 * pane without taking anything out: version, state, port, model directory, executable, logs,
 * restart, re-verify, repair. Logs opens what the child supervisor kept for an engine Arke
 * spawned (issue 585); for Ollama and a URL ComfyUI, which it never spawns, the row names where
 * that engine keeps its own instead.
 *
 * It absorbs Components. A component is a thing that must be on this machine — an engine's own
 * concern — so it is stated under the engine that requires it, and the link is declared on the
 * component rather than read off an id prefix.
 *
 * **`statedElsewhere` is deleted, not moved.** It suppressed a component from the Components
 * group when one of four other groups already stated it — hand-written deduplication, with a
 * rule per destination, for groups that overlapped by construction. It was correct code solving
 * a problem that should not exist. Once every fact belongs to exactly one surface there is
 * nothing to suppress; if something still needs suppressing, the split is wrong somewhere and
 * that is the finding (SPEC-033 R-6).
 *
 * OpenCode is not here (SPEC-033 R-5, R-72). It governs agent execution rather than generation,
 * and the authoring harness keeps its own tab.
 */
/** Failed beats moving beats arrived — the worst thing in the group is what its dot says. */
export function componentsTone(components: readonly SetupComponent[]): RuntimeTone {
  if (components.some((c) => c.state === "failed" || c.state === "blocked")) return "warn";
  if (components.some((c) => c.state !== "ready" && c.state !== "present")) return "idle";
  return "ok";
}
/**
 * The catalogue: what has arrived and what has not. Setup shows a bar and nothing else; this is
 * where the detail lives (prototype 22a), and since turn 75 it is a group of its own rather than
 * a section every other group's rows had to be read past.
 */
export function ComponentRows({ components }: { components: readonly SetupComponent[] }) {
  return (
    <>
      {components.map((c) => {
        const settled = c.state === "ready" || c.state === "present";
        const offered = c.state === "available";
        // Downloads owns progress; every other surface renders the same projection (R-82).
        const pct = transferProgress(c).percent;
        return (
          <div key={c.id} className={cx("fy-set__row", "fy-set__row--stack", c.state === "skipped" && "fy-set__row--off")}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="fy-set__name fy-set__name--wide">
                <div className="fy-set__title">{c.displayName}</div>
                <div className="fy-set__caps">
                  {c.purpose} · {sizeMb(c.sizeMb)}
                </div>
              </div>
              <RuntimeStatus tone={c.state === "failed" ? "warn" : settled ? "ok" : "idle"}>
                {c.state === "present"
                  ? "already here"
                  : c.state === "downloading"
                    ? `${pct}%`
                    : c.state === "paused"
                      ? `paused · ${pct}%`
                      : c.state}
              </RuntimeStatus>
              <SetupTransferControl component={c} />
              {offered && <Button onClick={() => setupRetry(c.id)}>Download · {sizeMb(c.sizeMb)}</Button>}
              {!settled && !offered && c.state !== "skipped" && (
                <button type="button" className="fy-set__link" onClick={() => setupSkip(c.id)}>
                  Skip
                </button>
              )}
              {(c.state === "skipped" || c.state === "failed" || c.state === "blocked") &&
                c.repairRequired !== true && (
                <button type="button" className="fy-set__link" onClick={() => setupRetry(c.id)}>
                  Retry
                </button>
              )}
              {c.repairRequired === true && (
                <button type="button" className="fy-set__link" onClick={() => setupRepair(c.id)}>
                  Repair
                </button>
              )}
            </div>
            {/* Paused bytes remain visible because they are retained for the resume. */}
            {(c.state === "downloading" || c.state === "paused") && (
              <div className="fy-set__bar">
                <div className="fy-set__barfill" style={{ width: `${pct}%` }} />
              </div>
            )}
            {c.detail !== undefined && (
              <div className="fy-set__why">
                <span className={cx("fy-set__dot", c.state === "failed" && "fy-set__dot--warn")} />
                <span>{c.detail}</span>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
const VOICE_ENGINES = ["kokoro", "whisper", "phonemizer"] as const;
const VOICE_ENGINE_LABEL: Record<(typeof VOICE_ENGINES)[number], string> = {
  kokoro: "Kokoro voice",
  whisper: "Whisper dictation",
  phonemizer: "espeak-ng phonemizer",
};
/**
 * The local voice runtime, the narrator it reads with, and the engines it supervises. Seven loose
 * links used to sit under this in one wrapped row; each one now hangs off the thing it acts on —
 * the path is changed on the field that shows the path — and only the three that act on the
 * runtime as a whole are left at the foot (turn 75).
 */
export function VoxaDetail({
  voiceRuntime,
  health,
  components,
}: {
  voiceRuntime: VoiceRuntimeStatus | null;
  health: ComponentHealth | undefined;
  components: readonly SetupComponent[];
}) {
  const voiceTest = useVoiceRuntimeTest();
  const playback = usePlayback();
  const playedTest = useRef<string | null>(null);
  useEffect(() => {
    if (voiceTest?.status !== "ready" || !voiceTest.audioBase64 || playedTest.current === voiceTest.requestId) return;
    playedTest.current = voiceTest.requestId;
    void playClip({
      id: voiceTest.requestId,
      url: `data:audio/wav;base64,${voiceTest.audioBase64}`,
      title: "Local voice test",
      sub: "settings · engines",
    });
  }, [voiceTest]);
  const sourceLabel =
    voiceRuntime?.source === "environment"
      ? "Environment override"
      : voiceRuntime?.source === "configured"
        ? "Configured Voxa"
        : voiceRuntime?.source === "bundled"
          ? "Bundled Voxa"
          : "Runtime missing";
  const engineTone = (engine: { state: string } | undefined): RuntimeTone =>
    engine?.state === "ready" ? "ok" : engine?.state === "unknown" || engine === undefined ? "idle" : "warn";
  const ready = VOICE_ENGINES.filter((e) => voiceRuntime?.engineStatus[e]?.state === "ready").length;
  return (
    <>
      <RuntimeHead
        title={ENGINE_LABEL.voxa}
        caps={engineCapabilityWords("voxa").toUpperCase()}
        tone={voiceRuntime?.detail === "Ready" ? "ok" : "warn"}
        state={voiceRuntime?.processState ?? "unconfigured"}
      />
      <div className="fy-rt__keyline">
        <div className="fy-rt__eyebrow">ENGINE</div>
        <div className="fy-set__field">
          <span style={{ flex: 1 }}>
            {sourceLabel}
            {voiceRuntime?.version ? ` ${voiceRuntime.version}` : ""} ·{" "}
            {voiceRuntime?.architecture ?? voiceRuntime?.expectedArchitecture ?? "unknown architecture"}
            {/* A basename, never a path: renderer state may not carry an absolute one, and the
                host already publishes exactly the safe half (SPEC-028 R-4). */}
            {voiceRuntime?.executableName ? ` · ${voiceRuntime.executableName}` : ""}
          </span>
          <button type="button" className="fy-set__link" onClick={() => chooseVoxaExecutable()}>
            Change
          </button>
          {voiceRuntime?.bundledAvailable && voiceRuntime.source === "configured" && (
            <button type="button" className="fy-set__link" onClick={() => useBundledVoxa()}>
              Use bundled
            </button>
          )}
          {voiceRuntime?.configured && (
            <button type="button" className="fy-set__link" onClick={() => clearVoxaExecutable()}>
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="fy-set__why">
        <span className={cx("fy-set__dot", voiceRuntime?.detail === "Ready" ? "fy-set__dot--ok" : "fy-set__dot--warn")} />
        <span>{voiceRuntime?.detail ?? "Runtime discovery has not completed."}</span>
      </div>
      {voiceRuntime?.configurationWarning && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>{voiceRuntime.configurationWarning}</span>
        </div>
      )}
      <RuntimeSection label="ENGINES">
        <span className="fy-rt__count">
          {ready} OF {VOICE_ENGINES.length} READY
        </span>
      </RuntimeSection>
      {VOICE_ENGINES.map((engine) => {
        const engineStatus = voiceRuntime?.engineStatus[engine];
        return (
          <div key={engine} className="fy-set__row">
            <div className="fy-set__name fy-set__name--wide">
              <div className="fy-set__title">{VOICE_ENGINE_LABEL[engine]}</div>
              <div className="fy-set__caps">{engineStatus?.detail ?? "Managed by Arke Studio"}</div>
            </div>
            <RuntimeStatus tone={engineTone(engineStatus)}>{engineStatus?.state ?? "unknown"}</RuntimeStatus>
          </div>
        );
      })}
      <div className="fy-rt__actions">
        <Button onClick={() => testLocalVoice()} disabled={voiceTest?.status === "testing"}>
          {voiceTest?.status === "testing" ? "Testing…" : "Test voice"}
        </Button>
        <button type="button" className="fy-set__link" onClick={() => restartVoxa()}>
          Restart
        </button>
        <button type="button" className="fy-set__link" onClick={() => repairVoiceModels()}>
          Repair models
        </button>
        <button type="button" className="fy-set__link" onClick={() => openModelFolder()}>
          Open folder
        </button>
        <button type="button" className="fy-set__link" onClick={() => openEngineLog("voxa")}>
          Logs
        </button>
        <span style={{ flex: 1 }} />
        <HealthDot label="Voxa local speech" health={health} />
      </div>
      {/* Kokoro and whisper.cpp are Voxa's own weights, so they are stated here rather than in
          a flat catalogue two panes away from the engine that reads them (R-71). */}
      <RuntimeSection label="COMPONENTS" />
      <ComponentRows components={components} />
      {voiceTest && (
        <div className="fy-set__note">
          {voiceTest.detail}
          {voiceTest.status === "ready" && voiceTest.audioBase64 && playback.status !== "playing" && (
            <>
              {" · "}
              <button
                type="button"
                className="fy-set__link"
                onClick={() =>
                  void playClip({
                    id: voiceTest.requestId,
                    url: `data:audio/wav;base64,${voiceTest.audioBase64}`,
                    title: "Local voice test",
                    sub: "settings · engines",
                  })
                }
              >
                Play test
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
/** Ready is ok; starting has not failed yet; every other state owes a reason, so it warns. */
export function comfyUiTone(engine: ComfyUiEngineStatus | null): RuntimeTone {
  if (engine === null) return "idle";
  if (engine.state === "ready") return "ok";
  return engine.state === "starting" ? "idle" : "warn";
}
/**
 * The ComfyUI engine and its recipes (SPEC-021 §2.2, §2.12, design turn 72). The engine row
 * states its source; detection offers are adopted, never typed; and a disabled recipe carries
 * its one measured clause.
 *
 * A recipe's weights hang off the recipe (SPEC-028 T-25). They are catalogue components like
 * any other and stayed under Components for that reason, which left the row that says "1 of 1
 * model files missing" two panes away from the Download for those exact files. The action now
 * sits on the row that states the lack; Components keeps them until they arrive, as it does for
 * everything else spoken for elsewhere.
 */
export function ComfyUiDetail() {
  const { state } = useStore();
  const setup = useSetup();
  const comfyui = state?.app.comfyui ?? null;
  const [urlDraft, setUrlDraft] = useState("");
  const engine = comfyui?.engine ?? null;
  const sourceLabel =
    comfyui === null
      ? "Not yet known"
      : engine?.source === "user-path"
        ? "Your install"
        : engine?.source === "user-url"
          ? "Your URL · never spawned"
          : engine?.source === "managed"
            ? "Arke-managed"
            : "Not installed";
  // The exception, in the product's words. `remote` was ours; `another machine` is what the
  // reader is being told, and this line is one of exactly two places it is said (SPEC-034 R-9) —
  // the other is `elsewhere` in the rail, which says *that* it is rather than where.
  const sourceWithLocality =
    engine?.locality === "remote" ? `another machine · ${sourceLabel}` : sourceLabel;
  const recipes = comfyui?.recipes ?? [];
  const ready = recipes.filter((r) => r.state === "ready").length;
  const managedRuntime = setup?.components.find((component) => component.id === "comfyui-runtime");
  const managedAvailable = engine?.source === "absent" && managedRuntime !== undefined;
  useEffect(() => {
    refreshComfyUi();
  }, []);
  return (
    <div data-testid="comfyui-engine">
      <RuntimeHead
        title="ComfyUI"
        caps={engineCapabilityWords("comfyui").toUpperCase()}
        tone={comfyUiTone(engine)}
        state={engine?.state ?? "unknown"}
      />
      <div className="fy-rt__keyline">
        <div className="fy-rt__eyebrow">ENGINE</div>
        <div className="fy-set__field">
          <span className="fy-rt__path">
            {sourceWithLocality}
            {engine?.version ? ` · v${engine.version}` : ""}
            {engine?.location ? ` · ${engine.location}` : ""}
          </span>
          <button type="button" className="fy-set__link" onClick={() => chooseComfyUiPath()}>
            Change
          </button>
          {engine !== null && engine.source !== "absent" && engine.source !== "managed" && (
            <button type="button" className="fy-set__link" onClick={() => clearComfyUiEngine()}>
              Clear
            </button>
          )}
        </div>
      </div>
      {/* Managed currency (SPEC-021 R-20): read from the tree itself, stated, offered — never applied.
          Shown whichever engine is selected, since a stale managed tree behind a user URL is the case
          this exists to find. */}
      {managedRuntime?.currency === "behind" && managedRuntime.installedVersion !== undefined && (
        <div className="fy-set__why" data-testid="comfyui-managed-update">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>
            Arke-managed v{managedRuntime.installedVersion} installed · v{managedRuntime.pinnedVersion} available
          </span>
          <button
            type="button"
            className="fy-set__link"
            disabled={managedRuntime.state !== "present"}
            onClick={() => updateComfyUiRuntime()}
          >
            Update
          </button>
        </div>
      )}
      {managedRuntime?.currency === "unknown" && managedRuntime.state === "present" && (
        <div className="fy-set__why">
          <span className="fy-set__dot" />
          <span>Arke-managed · installed version unknown · v{managedRuntime.pinnedVersion} pinned</span>
        </div>
      )}
      {engine?.detail && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>{engine.detail}</span>
        </div>
      )}
      {/* Installs detection found: adopted by selection among the host's own offers (D10). */}
      {(engine?.detected ?? []).map((found) => (
        <div key={found.location} className="fy-set__why" data-testid="comfyui-detected">
          <span className="fy-set__dot" />
          <span>
            Found · {found.location}
            {found.version ? ` · v${found.version}` : ""}
          </span>
          <button type="button" className="fy-set__link" onClick={() => useDetectedComfyUi(found.location)}>
            Use this install
          </button>
        </div>
      ))}
      {managedAvailable && (
        <div className="fy-set__why" data-testid="comfyui-managed-option">
          <span className="fy-set__dot" />
          <span>Arke-managed ComfyUI · {managedRuntime.sizeMb} MB download</span>
          {managedRuntime.state === "downloading" || managedRuntime.state === "paused" ? (
            <SetupTransferControl component={managedRuntime} />
          ) : (
            <button
              type="button"
              className="fy-set__link"
              disabled={managedRuntime.state === "installing" || managedRuntime.state === "queued"}
              onClick={() => setupRetry(managedRuntime.id)}
            >
              {managedRuntime.state === "installing" || managedRuntime.state === "queued" ? "installing…" : "Download"}
            </button>
          )}
        </div>
      )}
      <div className="fy-rt__keyline">
        <div className="fy-rt__eyebrow">URL</div>
        <div className="fy-set__field">
          <input
            className="fy-set__input"
            aria-label="ComfyUI URL"
            placeholder="http://127.0.0.1:8188"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
          />
          <button
            type="button"
            className="fy-set__link"
            disabled={urlDraft.trim().length === 0}
            onClick={() => {
              setComfyUiUrl(urlDraft.trim());
              setUrlDraft("");
            }}
          >
            Use this URL
          </button>
        </div>
      </div>
      {/* No path here: the mapped folder is a setting the coordinator does not publish on the
          engine status, and a location this pane cannot read is one it must not draw. The two
          actions are the whole of what it can offer until modelsDir reaches the wire. */}
      <RuntimeSection label="MODELS FOLDER">
        <button type="button" className="fy-set__link" onClick={() => chooseComfyUiModelsDir()}>
          Map a folder
        </button>
        <button type="button" className="fy-set__link" onClick={() => clearComfyUiModelsDir()}>
          Use the engine's own
        </button>
      </RuntimeSection>
      <RuntimeSection label="RECIPES">
        <span className="fy-rt__count">
          {comfyui === null
            ? "NOT YET KNOWN"
            : recipes.length === 0
              ? "NONE IN THIS BUILD"
              : `${ready} OF ${recipes.length} READY`}
        </span>
      </RuntimeSection>
      {recipes.map((recipe) => {
        const weights = setup?.components.find((c) => c.id === comfyUiWeightsComponentId(recipe.recipeId));
        const gated = (state?.app.runtime?.models ?? []).find((m) => m.modelId === recipe.recipeId);
        const refused = gated?.fit === "insufficient" || gated?.fit === "unsupported";
        // One of the five outcomes prints, and it is the same one a model row prints (R-20,
        // R-21). A refusal is the headline with its figures on the line beneath; `runs well` and
        // `unknown` change no decision.
        const verdict = gated?.fit === "runs-slowly" ? FIT_LABEL["runs-slowly"] : undefined;
        const recommended = state?.app.runtime?.recommended[recipe.capability] === recipe.recipeId;
        const settled = weights === undefined || weights.state === "ready" || weights.state === "present";
        // The shared projection, not a second derivation: Downloads owns progress, and a row
        // that computes its own figure is how two surfaces come to disagree about one transfer
        // with nothing left to arbitrate between them (R-82, D15).
        const pct = weights === undefined ? 0 : transferProgress(weights).percent;
        // While the weights are moving or stuck, that IS what this recipe is doing, and the dot
        // has to agree with the word beside it: a running download is not a fault, and a failed
        // one is not the recipe's own "disabled".
        const speaksForRecipe =
          !settled && weights.state !== "available" && weights.state !== "skipped";
        const tone: RuntimeTone = speaksForRecipe
          ? weights.state === "failed" || weights.state === "blocked"
            ? "warn"
            : "idle"
          : recipe.state === "ready"
            ? "ok"
            : recipe.state === "disabled"
              ? "warn"
              : "idle";
        return (
          <div
            key={recipe.recipeId}
            className={cx(
              "fy-set__row--stack",
              "fy-set__row",
              // A declared refusal recedes; a measured shortfall does not, because a smaller
              // model or a bigger card answers it (SPEC-033 D8, SPEC-034 R-23).
              (recipe.state === "disabled" || gated?.fit === "unsupported") && "fy-set__row--off",
            )}
            data-testid="comfyui-recipe"
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="fy-set__name fy-set__name--wide">
                <div className="fy-set__title">{recipe.displayName}</div>
                <div className="fy-set__caps fy-set__caps--tokens">
                  {recipe.capability} · v{recipe.recipeVersion}
                </div>
                {recipe.untested !== undefined && <div className="fy-set__caps">{recipe.untested}</div>}
              </div>
              {weights?.state === "available" && (
                <Button onClick={() => setupRetry(weights.id)}>Download · {sizeMb(weights.sizeMb)}</Button>
              )}
              {weights !== undefined && <SetupTransferControl component={weights} />}
              {(weights?.state === "failed" || weights?.state === "blocked" || weights?.state === "skipped") &&
                weights.repairRequired !== true && (
                  <button type="button" className="fy-set__link" onClick={() => setupRetry(weights.id)}>
                    Retry
                  </button>
                )}
              {/* For the file that is on disk, intact, and not the bytes the recipe pins — the
                  one case Retry cannot answer, because presence is completion to it. */}
              {(settled || weights?.repairRequired === true) && weights !== undefined && (
                <button type="button" className="fy-set__link" onClick={() => setupRepair(weights.id)}>
                  Repair
                </button>
              )}
              <button type="button" className="fy-set__link" onClick={() => verifyComfyUiRecipe(recipe.recipeId)}>
                Re-verify
              </button>
              {recommended && <span className="fy-prov__unverified">recommended</span>}
              {/* A dot only where it warns (R-22): a refusal, or a transfer that failed. `ready`
                  says what a green dot would have said, and grey stood for the rest. */}
              <RuntimeStatus tone={refused ? "warn" : tone === "warn" ? "warn" : undefined}>
                {[
                  refused ? "unsupported" : undefined,
                  verdict,
                  refused
                    ? undefined
                    : speaksForRecipe
                      ? weights.state === "downloading"
                        ? `${pct}%`
                        : weights.state === "paused"
                          ? `paused · ${pct}%`
                          : weights.state
                      : recipe.state,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </RuntimeStatus>
            </div>
            {/* Paused bytes remain visible because they are retained for the resume. */}
            {(weights?.state === "downloading" || weights?.state === "paused") && (
              <div className="fy-set__bar">
                <div className="fy-set__barfill" style={{ width: `${pct}%` }} />
              </div>
            )}
            {/* Kept visible, disabled, with the measured reason — never quietly absent (R-10).
                A stalled weights fetch states its own cause instead: "1 of 1 model files
                missing" is true but says nothing about the disk that refused it. */}
            {speaksForRecipe && weights.detail !== undefined ? (
              <div className="fy-set__why">
                <span className={cx("fy-set__dot", weights.state === "failed" && "fy-set__dot--warn")} />
                <span>{weights.detail}</span>
              </div>
            ) : refused && gated?.reason !== undefined ? (
              <div className="fy-set__why">
                <span className="fy-set__dot fy-set__dot--warn" />
                <span>{gated.reason}</span>
              </div>
            ) : (
              recipe.reason && (
                <div className="fy-set__why">
                  <span className={cx("fy-set__dot", recipe.state === "disabled" && "fy-set__dot--warn")} />
                  <span>{recipe.reason}</span>
                </div>
              )
            )}
          </div>
        );
      })}
      <div className="fy-rt__actions">
        {(engine?.source === "managed" || engine?.source === "user-path") && (
          <button type="button" className="fy-set__link" onClick={() => restartComfyUi()}>
            Restart
          </button>
        )}
        {/* Logs only where Arke spawned the process (SPEC-033 R-70). A URL engine's log belongs
            to whoever runs it, and a control that opened nothing would be the lie R-70 forbids. */}
        {(engine?.source === "managed" || engine?.source === "user-path") && (
          <button type="button" className="fy-set__link" onClick={() => openEngineLog("comfyui")}>
            Logs
          </button>
        )}
        {engine?.source === "user-url" && <span className="fy-set__caps">Logs · kept by whoever runs it</span>}
        <button type="button" className="fy-set__link" onClick={() => refreshComfyUi()}>
          {engine === null || engine.source === "absent"
            ? "Re-detect"
            : engine.source === "user-url"
              ? "Check now"
              : "Refresh"}
        </button>
      </div>
      {/*
       * No COMPONENTS band here, and deliberately.
       *
       * Every ComfyUI component is already on this pane, on the control that acts on it: the
       * engine itself in the ENGINE line above with its own Download, and each recipe's weights
       * on the recipe row, where SPEC-028 T-25 put them because that is the row that states the
       * lack. Listing them a second time would put two Downloads for one fetch on one screen —
       * the duplication R-6 exists to end, rebuilt inside the work that deletes it.
       */}
    </div>
  );
}
/**
 * The components one engine requires, or — for `null` — the ones nobody does.
 *
 * A component naming a provider is that provider's, and Providers states it beside the
 * credential it exists for (R-1). This is an assignment read off the component's own
 * declaration, not a list of what to hide where: the second of those is `statedElsewhere`, and
 * R-6 deletes it.
 */
export function componentsFor(all: readonly SetupComponent[], engine: EngineId | null): SetupComponent[] {
  return all.filter((c) => (c.engine ?? null) === engine && (engine !== null || c.provider === undefined));
}
/** Ready is ok; not yet asked is idle; anything else owes a reason, so it warns. */
export function processTone(state: string | undefined): RuntimeTone {
  if (state === "ready" || state === "healthy" || state === "valid") return "ok";
  if (state === undefined || state === "starting" || state === "unconfigured" || state === "untested") return "idle";
  return "warn";
}
/**
 * Ollama, as much of it as the product actually knows. It has no supervisor of its own — the
 * installer hands it to the operating system and it answers on its own port — so what there is
 * to state is the runtime component, the models pulled through it, and whether the provider
 * answered when it was last asked. Stating less than that would be an apology; inventing a
 * version string we never read would be worse.
 */
export function OllamaDetail({ components }: { components: readonly SetupComponent[] }) {
  const { state } = useStore();
  const provider = (state?.app.providers ?? []).find((p) => p.id === "ollama");
  const answered = provider?.probes.some((probe) => probe.available) === true;
  const refusal = provider?.probes.find((probe) => !probe.available)?.reason;
  return (
    <>
      <RuntimeHead
        title={ENGINE_LABEL.ollama}
        caps={engineCapabilityWords("ollama").toUpperCase()}
        tone={processTone(provider?.validation)}
        state={answered ? "answering" : (provider?.validation ?? "not asked")}
      />
      {/* Only where the probe gave one. A fallback line under a warning dot, beside a head that
          says `untested` under an idle one, is two dots of different colours about one engine
          three inches apart — and the fallback was a URL nothing reads. */}
      {refusal !== undefined && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>{refusal}</span>
        </div>
      )}
      {/* Ollama is handed to the operating system by its installer and answers on its own port:
          there is no child of ours to keep a log for, so the row names where it keeps its own
          (SPEC-033 R-70) rather than offering a file this application never wrote. */}
      <div className="fy-set__caps">Logs · Ollama keeps its own · server.log in its data folder (%LOCALAPPDATA%\Ollama on Windows, ~/.ollama/logs elsewhere)</div>
      <RuntimeSection label="COMPONENTS" />
      <ComponentRows components={components} />
    </>
  );
}
/** A component no engine requires. It keeps a place; it does not organise the screen (R-71). */
export function OtherComponentsDetail({ components }: { components: readonly SetupComponent[] }) {
  return (
    <>
      <RuntimeHead
        title="Other components"
        caps="NO ENGINE"
        tone={componentsTone(components)}
        state={components.length === 0 ? "none" : `${components.length} in the catalogue`}
      />
      <RuntimeSection label="ON THIS MACHINE" />
      <ComponentRows components={components} />
    </>
  );
}
