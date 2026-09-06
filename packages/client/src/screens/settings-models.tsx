import { useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  ENGINE_LABEL,
  ENGINE_PROVIDERS,
  PROVIDERS as PROVIDER_TABLE,
  comfyUiWeightsComponentId,
  deriveCapabilityAvailability,
  engineOfProvider,
  modelPriceCopy,
  type Capability,
  type EngineId,
  type ManifestModel,
  type ProviderId,
  type SetupComponent,
} from "@arke-studio/contracts";
import { Button, cx } from "../components/ui.js";
import { Cloud, Monitor, RefreshCw } from "../components/icons.js";
import { SetupTransferControl } from "../components/setup-transfer-control.js";
import {
  setModelEnabled,
  setupInstall,
  setupRemove,
  setupRepair,
  setupRetry,
  testLocalVoice,
  useSetup,
  useStore,
  verifyComfyUiRecipe,
} from "../lib/store.js";
import { recipeFacts } from "./engine-panes.js";
import { LocalModelRow, entryStatusLine, localEntries, type Entry } from "./local-models.js";
import { KEYED_PROVIDERS, ProviderKeyLine, ProviderToolLine } from "./settings-providers.js";
import {
  CAPABILITY_ROWS,
  HalfHeading,
  ProviderMark,
  RuntimeStatus,
  kindId,
  kindOf,
  sizeMb,
  type CapabilityRow,
  type RuntimeTone,
} from "./settings-parts.js";

/**
 * Settings · AI models (SPEC-042 R-1, R-8, R-12..R-16). What can I make, with what, and is it on.
 *
 * The second column is the kinds — `Cloud` above, `On this machine` below, every kind present
 * at once with its count — so Speech-to-Text exists for somebody who has not scrolled an engine
 * pane to find it. The pane is one kind's models, grouped by who supplies them: a provider for
 * a cloud model, the engine that hosts it for a local one (SPEC-034 R-7, kept). Images and
 * Video are tiles with a picture on top and air around them; every other kind is rows, because
 * a card over a language model is a box with the row's words in it.
 *
 * **The switch is here, and so is the credential's remedy** (R-4). A supplier that cannot be
 * reached says so once, at its heading, and the heading's control renders Providers' own key or
 * sign-in row in place — never a route to Providers. SPEC-033 R-7 asks for exactly this, and
 * turn 112 merged the two surfaces because the previous split met it with a navigation button.
 * If `Add a key` ever becomes one, the split has regressed and the fix is to restore the control.
 *
 * Nothing here derives a fact another surface owns. A local model's facts are `localEntries`
 * and `recipeFacts`, the same projections its row read on Providers; a cloud model's
 * switchability is `deriveCapabilityAvailability`, the same question the pickers ask.
 */

type Half = "cloud" | "local";

const HALF_LABEL: Record<Half, string> = { cloud: "Cloud", local: "On this machine" };

/** Which half a model is drawn in (R-8): the provider table's own flag, which SPEC-033 R-2 splits on. */
function halfOf(model: ManifestModel): Half {
  return PROVIDER_TABLE[model.provider].local ? "local" : "cloud";
}

/** A kind that earns a picture (R-13): the two whose output is something you look at. */
function isVisual(row: CapabilityRow): boolean {
  return row.capabilities.includes("image") || row.capabilities.includes("video");
}

interface Kind {
  row: CapabilityRow;
  models: ManifestModel[];
}

/** The kinds a half draws, in R-8's order, and only where a model exists in that half. */
function kindsFor(models: readonly ManifestModel[], half: Half): Kind[] {
  return CAPABILITY_ROWS.map((row) => ({
    row,
    models: models.filter((m) => halfOf(m) === half && kindOf(m) === row),
  })).filter((k) => k.models.length > 0);
}

/** The picture's band: the sample's poster where the manifest carries one, a plain plate where not (R-17). */
function TilePicture({ model, ghost, bar }: { model: ManifestModel; ghost: boolean; bar?: number }) {
  return (
    <div className={cx("fy-mtile__pic", ghost && "fy-mtile__pic--ghost")}>
      {model.sample !== undefined && <img src={`./samples/${model.sample.poster}`} alt="" />}
      {bar !== undefined && (
        <span className="fy-mtile__bar">
          <span style={{ width: `${bar}%` }} />
        </span>
      )}
    </div>
  );
}

/** A model this studio offers, or does not. The switch is the whole tile's control (R-13). */
function ModelSwitch({ model, enabled, usable }: { model: ManifestModel; enabled: boolean; usable: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={model.displayName}
      disabled={!usable}
      className={cx("fy-prov__switch", enabled && "is-on")}
      onClick={() => setModelEnabled(model.id, !enabled)}
    >
      <span />
    </button>
  );
}

/** A supplier's section: its mark, its name, and on the right its count or its remedy (R-12). */
function Section({
  id,
  name,
  right,
  disclosure,
  children,
}: {
  id: string;
  name: string;
  right: ReactNode;
  /** The credential's own control, rendered under the heading where the remedy was pressed (R-4). */
  disclosure?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="fy-by" data-testid="models-section">
      <div className="fy-by__head">
        <ProviderMark id={id} label={name} />
        <span className="fy-by__name">{name}</span>
        <span style={{ flex: 1 }} />
        {right}
      </div>
      {disclosure !== undefined && <div className="fy-by__credential">{disclosure}</div>}
      {children}
    </section>
  );
}

/**
 * One cloud provider's models of one kind. Switchable only once the credential reaches them: a
 * model this studio cannot reach is not a choice, and letting it be switched on would put it in
 * pickers that must then refuse it.
 */
function CloudSection({ provider, models, visual }: { provider: ProviderId; models: ManifestModel[]; visual: boolean }) {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const info = PROVIDER_TABLE[provider];
  const status = (state?.app.providers ?? []).find((p) => p.id === provider);
  const disabled = new Set(state?.app.models.disabled ?? []);
  const external = info.credential === "external";
  const troubled = Boolean(status?.fault) || status?.validation === "invalid";
  // What this credential actually unlocks, capability by capability — the same question the
  // generation pickers ask. A key can authenticate and still not do images.
  const unlocked = new Set(
    deriveCapabilityAvailability(state?.app.providers ?? [])
      .filter((a) => a.via.includes(provider))
      .map((a) => a.capability),
  );
  const reaches = (m: ManifestModel): boolean => unlocked.has(m.capability);
  const reachable = models.some(reaches);
  const on = models.filter((m) => reaches(m) && !disabled.has(m.id)).length;
  // The remedy, once, at the heading (R-4): what is missing and the control that supplies it.
  const remedy = !status?.configured
    ? external
      ? "Sign in"
      : "Add a key"
    : troubled
      ? external
        ? "Sign in again"
        : "Replace key"
      : !reachable
        ? external
          ? "Not unlocked by this account"
          : "Not unlocked by this key"
        : null;
  const right =
    remedy === null ? (
      <span className="fy-by__state">{`${on} of ${models.length} on`}</span>
    ) : (
      <button type="button" className="fy-by__fix" aria-expanded={open} onClick={() => setOpen(!open)}>
        {remedy}
      </button>
    );
  return (
    <Section
      id={provider}
      name={info.displayName}
      right={right}
      disclosure={open ? external ? <ProviderToolLine id={provider} /> : <ProviderKeyLine id={provider} /> : undefined}
    >
      {visual ? (
        <div className="fy-tiles">
          {models.map((model) => {
            const enabled = reaches(model) && !disabled.has(model.id);
            return (
              <div key={model.id} className={cx("fy-mtile", !enabled && "fy-mtile--out")} data-testid="model-tile">
                <TilePicture model={model} ghost={!enabled} />
                <div className="fy-mtile__body">
                  <div className="fy-mtile__row">
                    <span className="fy-mtile__name">{model.displayName}</span>
                    {model.unverified === true && <em className="fy-prov__unverified">UNVERIFIED</em>}
                    <ModelSwitch model={model} enabled={enabled} usable={reaches(model)} />
                  </div>
                  <div className="fy-mtile__meta">
                    <span>{modelPriceCopy(model)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="fy-rows">
          {models.map((model) => {
            const enabled = reaches(model) && !disabled.has(model.id);
            return (
              <div key={model.id} className={cx("fy-set__row", !enabled && "fy-set__row--out")} data-testid="model-row">
                <ModelSwitch model={model} enabled={enabled} usable={reaches(model)} />
                <span className="fy-rows__name">{model.displayName}</span>
                {model.unverified === true && <em className="fy-prov__unverified">UNVERIFIED</em>}
                <span style={{ flex: 1 }} />
                <span className="fy-rows__at">{modelPriceCopy(model)}</span>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/** What a local tile prints, whichever projection it came from (R-16). */
interface LocalFacts {
  model: ManifestModel;
  at: string | undefined;
  word: string;
  tone: RuntimeTone | undefined;
  /** Drawn across the foot of the picture while the weights move (R-16). */
  bar: number | undefined;
  reason: { text: string; warn: boolean } | undefined;
  /** SPEC-028 R-35's refusal of a model that is otherwise installed, or the switch-off. */
  note: string | undefined;
  recommended: boolean;
  dim: boolean;
  ready: boolean;
  controls: ReactNode;
  recipe: boolean;
}

/** The facts for a manifest row the engine has not answered for — the row's own, verbatim. */
function entryFacts(entry: Entry, onOpenDownloads: () => void): LocalFacts {
  const elsewhere = entry.locality === "remote";
  const moving = entry.component !== undefined && (entry.component.state === "downloading" || entry.component.state === "paused");
  const controls = elsewhere ? null : (
    <>
      {entry.component !== undefined && <SetupTransferControl component={entry.component} />}
      {entry.state === "available" && entry.closure !== undefined && (
        <Button onClick={() => setupInstall(entry.component!.id)}>Install · {sizeMb(entry.closure.downloadMb)}</Button>
      )}
      {entry.state === "needs-attention" && entry.component !== undefined && (
        <button
          type="button"
          className="fy-set__link"
          onClick={() =>
            entry.component!.repairRequired === true ? setupRepair(entry.component!.id) : setupInstall(entry.component!.id)
          }
        >
          {entry.component.repairRequired === true ? "Repair" : "Retry"}
        </button>
      )}
      {entry.state === "installed" && entry.component?.removable === true && (
        <button type="button" className="fy-set__link" onClick={() => setupRemove(entry.component!.id)}>
          Remove
        </button>
      )}
      {moving && (
        <button type="button" className="fy-set__link" onClick={onOpenDownloads}>
          Downloads
        </button>
      )}
    </>
  );
  return {
    model: entry.model,
    at: entry.sizeMbytes !== undefined ? sizeMb(entry.sizeMbytes) : undefined,
    word: entryStatusLine(entry),
    tone: !elsewhere && (entry.state === "unsupported" || entry.state === "needs-attention") ? "warn" : undefined,
    bar: moving && entry.component !== undefined ? Math.round((entry.component.bytesDone / Math.max(entry.component.bytesTotal, 1)) * 100) : undefined,
    reason:
      entry.reason && (entry.state === "unsupported" || entry.state === "needs-attention")
        ? { text: entry.reason, warn: !elsewhere && entry.state === "unsupported" }
        : undefined,
    note: entry.ineligible,
    recommended: entry.recommended,
    dim: !elsewhere && entry.declined,
    ready: entry.state === "installed",
    controls,
    recipe: false,
  };
}

/** A ComfyUI recipe's facts, from the readiness the engine reported and the weights beside it. */
function recipeTileFacts(
  model: ManifestModel,
  recipe: NonNullable<ReturnType<typeof useStore>["state"]>["app"]["comfyui"] extends infer C
    ? C extends { recipes: readonly (infer R)[] }
      ? R
      : never
    : never,
  weights: SetupComponent | undefined,
  gated: { fit?: "runs-well" | "runs-slowly" | "insufficient" | "unsupported" | "unknown"; reason?: string } | undefined,
  recommended: boolean,
  disabled: boolean,
): LocalFacts {
  const facts = recipeFacts(recipe, weights, gated);
  const controls = (
    <>
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
      {/* For the file that is on disk, intact, and not the bytes the recipe pins — the one case
          Retry cannot answer, because presence is completion to it. */}
      {(facts.settled || weights?.repairRequired === true) && weights !== undefined && (
        <button type="button" className="fy-set__link" onClick={() => setupRepair(weights.id)}>
          Repair
        </button>
      )}
      <button type="button" className="fy-set__link" onClick={() => verifyComfyUiRecipe(recipe.recipeId)}>
        Re-verify
      </button>
    </>
  );
  return {
    model,
    at: weights !== undefined ? sizeMb(weights.sizeMb) : undefined,
    word: facts.word,
    tone: facts.tone,
    bar: facts.moving || facts.paused ? facts.pct : undefined,
    reason: facts.reason,
    note: disabled ? "turned off in AI models" : undefined,
    recommended,
    dim: facts.dim,
    ready: recipe.state === "ready",
    controls,
    recipe: true,
  };
}

/** A local model as a tile: name, size, state, the controls its row had, and its one clause (R-13, R-16). */
function LocalTile({ facts }: { facts: LocalFacts }) {
  return (
    <div
      className={cx("fy-mtile", facts.dim && "fy-mtile--out")}
      data-testid={facts.recipe ? "comfyui-recipe" : "model-tile"}
    >
      <TilePicture model={facts.model} ghost={facts.dim} bar={facts.bar} />
      <div className="fy-mtile__body">
        <div className="fy-mtile__row">
          <span className="fy-mtile__name">{facts.model.displayName}</span>
          {facts.recommended && <span className="fy-prov__unverified">recommended</span>}
        </div>
        <div className="fy-mtile__meta">
          {facts.at !== undefined && <span>{facts.at}</span>}
          <span style={{ flex: 1 }} />
          <RuntimeStatus tone={facts.tone}>{facts.word}</RuntimeStatus>
        </div>
        <div className="fy-mtile__does">{facts.controls}</div>
        {facts.reason !== undefined && (
          <div className="fy-set__why">
            <span className={cx("fy-set__dot", facts.reason.warn && "fy-set__dot--warn")} />
            <span>{facts.reason.text}</span>
          </div>
        )}
        {facts.note !== undefined && (
          <div className="fy-set__why">
            <span className="fy-set__dot fy-set__dot--warn" />
            <span>{facts.note}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** A recipe with no picture — the cloned voice — as a row, from the same facts a tile reads. */
function RecipeRow({ facts }: { facts: LocalFacts }) {
  return (
    <div className={cx("fy-set__row", "fy-set__row--stack", facts.dim && "fy-set__row--off")} data-testid="comfyui-recipe">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">{facts.model.displayName}</div>
        </div>
        {facts.recommended && <span className="fy-prov__unverified">recommended</span>}
        <RuntimeStatus tone={facts.tone}>{[facts.word, facts.at].filter(Boolean).join(" · ")}</RuntimeStatus>
        {facts.controls}
      </div>
      {facts.bar !== undefined && (
        <div className="fy-set__bar">
          <div className="fy-set__barfill" style={{ width: `${facts.bar}%` }} />
        </div>
      )}
      {facts.reason !== undefined && (
        <div className="fy-set__why">
          <span className={cx("fy-set__dot", facts.reason.warn && "fy-set__dot--warn")} />
          <span>{facts.reason.text}</span>
        </div>
      )}
      {facts.note !== undefined && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>{facts.note}</span>
        </div>
      )}
    </div>
  );
}

/**
 * One engine's models of one kind (R-12): headed by the engine, so Voxa is one section carrying
 * Kokoro and whisper.cpp, and read from the same two projections the rows read on Providers —
 * `recipeFacts` for a recipe the engine has answered for, `localEntries` for everything else.
 */
function LocalSection({ engine, models, visual }: { engine: EngineId; models: ManifestModel[]; visual: boolean }) {
  const { state } = useStore();
  const setup = useSetup();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const components = setup?.components ?? [];
  const comfyui = state?.app.comfyui ?? null;
  const disabled = new Set(state?.app.models.disabled ?? []);
  const recipes = new Map((comfyui?.recipes ?? []).map((r) => [r.recipeId, r]));
  const answered = new Set(recipes.keys());
  const gatedById = new Map((state?.app.runtime?.models ?? []).map((m) => [m.modelId, m]));
  const remote = engine === "comfyui" && comfyui?.engine.locality === "remote";
  const onOpenDownloads = () => navigate("/settings/downloads");

  const entriesByProvider = new Map(
    ENGINE_PROVIDERS[engine].map((provider) => [provider, localEntries(state, components, provider, answered)]),
  );
  const ids = new Set(models.map((m) => m.id));
  const items = models.map((model) => {
    const recipe = recipes.get(model.id);
    if (recipe !== undefined) {
      const weights = components.find((c) => c.id === comfyUiWeightsComponentId(model.id));
      const gated = gatedById.get(model.id);
      return {
        model,
        entry: undefined,
        facts: recipeTileFacts(
          model,
          recipe,
          weights,
          gated,
          state?.app.runtime?.recommended[model.capability] === model.id,
          disabled.has(model.id),
        ),
      };
    }
    const entry = entriesByProvider.get(model.provider)?.find((e) => e.model.id === model.id);
    return { model, entry, facts: entry !== undefined ? entryFacts(entry, onOpenDownloads) : undefined };
  });
  const ready = items.filter((i) => i.facts?.ready === true).length;
  const right = (
    <span className="fy-by__state">{remote ? "elsewhere" : `${ready} of ${ids.size} ready`}</span>
  );
  return (
    <Section id={engine} name={ENGINE_LABEL[engine]} right={right}>
      {visual ? (
        <div className="fy-tiles">{items.map((i) => i.facts && <LocalTile key={i.model.id} facts={i.facts} />)}</div>
      ) : (
        <div className="fy-rows">
          {items.map((i) =>
            i.entry !== undefined ? (
              <LocalModelRow
                key={i.model.id}
                entry={i.entry}
                open={open === i.model.id}
                onToggle={() => setOpen(open === i.model.id ? null : i.model.id)}
                onOpenDownloads={onOpenDownloads}
                // A speaking sample is a voice's picture (R-14), and the local voice test is the
                // one sample this build can make: it reads with the model Voxa reads with.
                {...(i.model.provider === "kokoro" && i.entry.state === "installed" ? { play: () => testLocalVoice() } : {})}
              />
            ) : i.facts !== undefined ? (
              <RecipeRow key={i.model.id} facts={i.facts} />
            ) : null,
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * Every model there is to draw: the manifest's, plus any recipe the engine has answered for
 * that the manifest snapshot does not carry. A recipe the engine reports is a ComfyUI model
 * whether or not this build's manifest lists it (SPEC-034 R-7: the recipe list takes what the
 * engine has answered for), and dropping it would withhold the one row with the Download for
 * the files it says are missing.
 */
function allModels(state: ReturnType<typeof useStore>["state"]): ManifestModel[] {
  const manifest = state?.app.manifest?.models ?? [];
  const known = new Set(manifest.map((m) => m.id));
  const recipes = (state?.app.comfyui?.recipes ?? [])
    .filter((r) => !known.has(r.recipeId))
    .map(
      (r): ManifestModel => ({
        id: r.recipeId,
        provider: "comfyui",
        capability: r.capability,
        displayName: r.displayName,
        accepts: { referenceImages: 0, startFrame: false, endFrame: false },
        limits: {},
        pricing: { kind: "unmetered" },
      }),
    );
  return [...manifest, ...recipes];
}

export function SettingsModelsScreen() {
  const { state } = useStore();
  const [params, setParams] = useSearchParams();
  const models = allModels(state);
  const cloud = kindsFor(models, "cloud");
  const local = kindsFor(models, "local");

  // The open kind lives in the URL (R-11), and a remedy that names a model resolves its half and
  // kind from the model itself (R-21).
  const asked = params.get("model");
  const target = asked === null ? undefined : models.find((m) => m.id === asked);
  const half: Half = target !== undefined ? halfOf(target) : params.get("half") === "local" ? "local" : "cloud";
  const kind: Capability | null = target !== undefined ? kindId(kindOf(target)) : (params.get("kind") as Capability | null);
  const kinds = half === "local" ? local : cloud;
  const current =
    kinds.find((k) => kindId(k.row) === kind) ?? kinds[0] ?? (half === "cloud" ? local[0] : cloud[0]) ?? null;
  const currentHalf: Half = current === null ? half : kinds.includes(current) ? half : half === "cloud" ? "local" : "cloud";
  const select = (h: Half, k: Kind) => setParams({ half: h, kind: kindId(k.row) }, { replace: true });

  const column = (h: Half, list: Kind[]) =>
    list.map((k) => {
      const here = current === k && currentHalf === h;
      return (
        <button
          type="button"
          key={`${h}-${kindId(k.row)}`}
          role="tab"
          aria-selected={here}
          className={cx("fy-kind", here && "is-current")}
          onClick={() => select(h, k)}
        >
          <span className="fy-kind__name">{k.row.label}</span>
          <span className="fy-kind__n">{k.models.length}</span>
        </button>
      );
    });

  // Sections, in the supplier's own order: keyed services as Providers lists them, engines as
  // Providers lists them (R-12).
  const sections: ReactNode =
    current === null ? null : currentHalf === "cloud" ? (
      KEYED_PROVIDERS.filter((id) => current.models.some((m) => m.provider === id)).map((id) => (
        <CloudSection
          key={id}
          provider={id}
          models={current.models.filter((m) => m.provider === id)}
          visual={isVisual(current.row)}
        />
      ))
    ) : (
      (["comfyui", "ollama", "voxa"] as const)
        .filter((engine) => current.models.some((m) => engineOfProvider(m.provider) === engine))
        .map((engine) => (
          <LocalSection
            key={engine}
            engine={engine}
            models={current.models.filter((m) => engineOfProvider(m.provider) === engine)}
            visual={isVisual(current.row)}
          />
        ))
    );

  const total = current?.models.length ?? 0;
  return (
    <div data-screen="settings-models" className="fy-cols">
      <div className="fy-cols__list" role="tablist" aria-label="Kinds of model">
        {cloud.length > 0 && (
          <>
            <HalfHeading icon={<Cloud size={14} />}>{HALF_LABEL.cloud}</HalfHeading>
            {column("cloud", cloud)}
          </>
        )}
        {local.length > 0 && (
          <>
            <HalfHeading icon={<Monitor size={14} />}>{HALF_LABEL.local}</HalfHeading>
            {column("local", local)}
          </>
        )}
      </div>
      <div className="fy-cols__pane">
        {current === null ? (
          <div className="fy-pane">
            <div className="fy-pane__head">
              <span className="fy-pane__name">Nothing in the manifest</span>
            </div>
          </div>
        ) : (
          <div className="fy-pane">
            <div className="fy-pane__head">
              <span className="fy-pane__name">{current.row.label}</span>
              <span className="fy-pane__where">{HALF_LABEL[currentHalf]}</span>
              <span style={{ flex: 1 }} />
              <span className="fy-pane__count">{`${total} model${total === 1 ? "" : "s"}`}</span>
            </div>
            {sections}
          </div>
        )}
      </div>
    </div>
  );
}

/** Kept for the kinds column's own icon set; the refresh glyph is the engine pane's. */
export { RefreshCw };
