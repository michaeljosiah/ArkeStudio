import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  ENGINE_CAPABILITIES,
  ENGINE_LABEL,
  comfyUiWeightsComponentId,
  type ComfyUiEngineStatus,
  type EngineId,
  type ComponentHealth,
  type SetupComponent,
  type VoiceRuntimeStatus,
} from "@arke-studio/contracts";
import { Button, cx } from "../components/ui.js";
import {
  HealthDot,
  RuntimeHead,
  RuntimeSection,
  RuntimeStatus,
  TONE_CLASS,
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
  openModelFolder,
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
 * Settings · Engines (SPEC-033 §1.11). The machinery, deliberately and completely.
 *
 * Most people never open this screen. The ones who do are troubleshooting, and abridging it for
 * them would be the wrong kindness — so the detail is unabridged: version, state, port, model
 * directory, executable, logs, restart, re-verify, repair.
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
 * that is the finding (R-6).
 *
 * OpenCode is not here (R-5, R-72). It governs agent execution rather than generation, the
 * authoring harness was stated twice — a tab and a group inside Local runtime — and this ends
 * that by removing the group, never the tab.
 */
/** Failed beats moving beats arrived — the worst thing in the group is what its dot says. */
function componentsTone(components: readonly SetupComponent[]): RuntimeTone {
  if (components.some((c) => c.state === "failed" || c.state === "blocked")) return "warn";
  if (components.some((c) => c.state !== "ready" && c.state !== "present")) return "idle";
  return "ok";
}


/**
 * The catalogue: what has arrived and what has not. Setup shows a bar and nothing else; this is
 * where the detail lives (prototype 22a), and since turn 75 it is a group of its own rather than
 * a section every other group's rows had to be read past.
 */
function ComponentRows({ components }: { components: readonly SetupComponent[] }) {
  return (
    <>
      {components.map((c) => {
        const settled = c.state === "ready" || c.state === "present";
        const offered = c.state === "available";
        const pct = c.bytesTotal > 0 ? Math.min(100, Math.round((c.bytesDone / c.bytesTotal) * 100)) : 0;
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
                {c.state === "present" ? "already here" : c.state === "downloading" ? `${pct}%` : c.state}
              </RuntimeStatus>
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
            {/* The bar only exists while something is actually moving. */}
            {c.state === "downloading" && (
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
function VoxaDetail({
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
        caps={ENGINE_CAPABILITIES.voxa.toUpperCase()}
        tone={voiceRuntime?.detail === "Ready" ? "ok" : "warn"}
        state={voiceRuntime?.processState ?? "unconfigured"}
      />
      <div className="fy-rt__keyline">
        <div className="fy-rt__eyebrow">RUNTIME</div>
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
function comfyUiTone(engine: ComfyUiEngineStatus | null): RuntimeTone {
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
function ComfyUiDetail() {
  const { state } = useStore();
  const setup = useSetup();
  const comfyui = state?.app.comfyui ?? null;
  const [urlDraft, setUrlDraft] = useState("");
  const engine = comfyui?.engine ?? null;
  const sourceLabel =
    engine?.source === "user-path"
      ? "Your install"
      : engine?.source === "user-url"
        ? "Your URL · never spawned"
        : engine?.source === "managed"
          ? "Arke-managed"
          : "Not installed";
  const sourceWithLocality = engine?.source === "user-url" && engine.locality === "remote"
    ? `${sourceLabel} · remote`
    : sourceLabel;
  const recipes = comfyui?.recipes ?? [];
  const ready = recipes.filter((r) => r.state === "ready").length;
  const managedRuntime = setup?.components.find((component) => component.id === "comfyui-runtime");
  const managedAvailable = engine?.source === "absent" && managedRuntime !== undefined;
  return (
    <div data-testid="comfyui-engine">
      <RuntimeHead
        title="ComfyUI"
        caps={ENGINE_CAPABILITIES.comfyui.toUpperCase()}
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
          <button
            type="button"
            className="fy-set__link"
            disabled={managedRuntime.state === "downloading" || managedRuntime.state === "installing" || managedRuntime.state === "queued"}
            onClick={() => setupRetry(managedRuntime.id)}
          >
            {managedRuntime.state === "downloading" || managedRuntime.state === "installing" || managedRuntime.state === "queued"
              ? "installing…"
              : "Download"}
          </button>
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
          {recipes.length === 0 ? "NONE IN THIS BUILD" : `${ready} OF ${recipes.length} READY`}
        </span>
      </RuntimeSection>
      {recipes.map((recipe) => {
        const weights = setup?.components.find((c) => c.id === comfyUiWeightsComponentId(recipe.recipeId));
        const settled = weights === undefined || weights.state === "ready" || weights.state === "present";
        const pct =
          weights && weights.bytesTotal > 0
            ? Math.min(100, Math.round((weights.bytesDone / weights.bytesTotal) * 100))
            : 0;
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
            className={cx("fy-set__row--stack", "fy-set__row", recipe.state === "disabled" && "fy-set__row--off")}
            data-testid="comfyui-recipe"
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="fy-set__name fy-set__name--wide">
                <div className="fy-set__title">{recipe.displayName}</div>
                <div className="fy-set__caps fy-set__caps--tokens">
                  {recipe.capability} · v{recipe.recipeVersion}
                </div>
              </div>
              {weights?.state === "available" && (
                <Button onClick={() => setupRetry(weights.id)}>Download · {sizeMb(weights.sizeMb)}</Button>
              )}
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
              <RuntimeStatus tone={tone}>
                {speaksForRecipe
                  ? weights.state === "downloading"
                    ? `${pct}%`
                    : weights.state
                  : recipe.state}
              </RuntimeStatus>
            </div>
            {/* The bar only exists while something is actually moving. */}
            {weights?.state === "downloading" && (
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
        <button type="button" className="fy-set__link" onClick={() => restartComfyUi()}>
          Restart
        </button>
        <button type="button" className="fy-set__link" onClick={() => refreshComfyUi()}>
          Refresh
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
function componentsFor(all: readonly SetupComponent[], engine: EngineId | null): SetupComponent[] {
  return all.filter((c) => (c.engine ?? null) === engine && (engine !== null || c.provider === undefined));
}

/** Ready is ok; not yet asked is idle; anything else owes a reason, so it warns. */
function processTone(state: string | undefined): RuntimeTone {
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
function OllamaDetail({ components }: { components: readonly SetupComponent[] }) {
  const { state } = useStore();
  const provider = (state?.app.providers ?? []).find((p) => p.id === "ollama");
  const answered = provider?.probes.some((probe) => probe.available) === true;
  const refusal = provider?.probes.find((probe) => !probe.available)?.reason;
  return (
    <>
      <RuntimeHead
        title={ENGINE_LABEL.ollama}
        caps={ENGINE_CAPABILITIES.ollama.toUpperCase()}
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
      <RuntimeSection label="COMPONENTS" />
      <ComponentRows components={components} />
    </>
  );
}

/** A component no engine requires. It keeps a place; it does not organise the screen (R-71). */
function OtherComponentsDetail({ components }: { components: readonly SetupComponent[] }) {
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

/**
 * The rail: one row per engine, then the components no engine requires.
 *
 * An engine's row states what it is used for in the same five capability words the two
 * capability screens share, and its locality — this is the one screen whose subject is the
 * destination, and a non-loopback URL is named as remote there (R-69, SPEC-028 R-37).
 */
export function SettingsEnginesScreen() {
  const { state } = useStore();
  const setup = useSetup();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const all = setup?.components ?? [];
  const running = setup?.running === true;
  const comfyui = state?.app.comfyui ?? null;
  const voiceRuntime = state?.app.voiceRuntime ?? null;

  const ollamaComponents = componentsFor(all, "ollama");
  const voxaComponents = componentsFor(all, "voxa");
  const unowned = componentsFor(all, null);
  const ollama = (state?.app.providers ?? []).find((p) => p.id === "ollama");

  const rows: Array<{ id: EngineId | "other"; label: string; tone: RuntimeTone; count: string }> = [
    {
      id: "comfyui",
      label: ENGINE_LABEL.comfyui,
      tone: comfyUiTone(comfyui?.engine ?? null),
      // Every row states its locality, not only the one that turns out to be remote: R-69 makes
      // this the screen whose subject is the destination, and a row that states it sometimes is
      // a row nobody can read the absence of. The state is what the dot says.
      count: comfyui === null ? "—" : comfyui.engine.locality === "remote" ? "remote" : "this machine",
    },
    {
      id: "ollama",
      label: ENGINE_LABEL.ollama,
      // The same derivation the pane uses. Anything that is not `valid` reading as merely
      // unmeasured made a stopped Ollama show a neutral dot on the rail — the half you scan to
      // find what is broken — beside a pane that warned about it in red.
      tone: processTone(ollama?.validation),
      count: "this machine",
    },
    {
      id: "voxa",
      label: ENGINE_LABEL.voxa,
      tone: processTone(voiceRuntime?.processState),
      count: "this machine",
    },
    {
      id: "other",
      label: "Other components",
      tone: componentsTone(unowned),
      count: unowned.length === 0 ? "none" : `${unowned.length}`,
    },
  ];

  const asked = searchParams.get("engine");
  const current = rows.some((r) => r.id === asked) ? (asked as EngineId | "other") : rows[0]!.id;
  return (
    <div data-screen="settings-engines" className="fy-set fy-set--runtime">
      <div className="fy-rt">
        <div className="fy-rt__rail" role="tablist" aria-label="Engines">
          {rows.map((r) => (
            <button
              type="button"
              key={r.id}
              role="tab"
              aria-selected={r.id === current}
              className={cx("fy-rt__railitem", r.id === current && "is-current")}
              onClick={() => setSearchParams({ engine: r.id }, { replace: true })}
            >
              <span className={cx("fy-set__dot", TONE_CLASS[r.tone])} />
              <span>{r.label}</span>
              <span style={{ flex: 1 }} />
              <span className="fy-rt__count">{r.count}</span>
            </button>
          ))}
        </div>
        <div className="fy-rt__pane">
          {current === "comfyui" && <ComfyUiDetail />}
          {current === "ollama" && <OllamaDetail components={ollamaComponents} />}
          {current === "voxa" && (
            <VoxaDetail voiceRuntime={voiceRuntime} health={state?.app.health.voice} components={voxaComponents} />
          )}
          {current === "other" && <OtherComponentsDetail components={unowned} />}
          <div className="fy-rt__actions">
            {/* Stopping is global — one setup run fetches for every engine — so it is stated
                once, here, rather than under a heading that names one of them. */}
            <span style={{ flex: 1 }} />
            {/* Watching a transfer belongs to Downloads, which owns progress; starting one stays
                where the decision is made (R-82, R-83). */}
            <Button variant="secondary" onClick={() => navigate("/settings/downloads")}>
              {running ? "Downloads · running" : "Downloads"}
            </Button>
            <Button variant="secondary" onClick={() => navigate("/settings/local-ai")}>
              Local AI
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
