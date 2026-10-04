import {
  findHarnessModel,
  harnessModelReference,
  PROVIDERS,
  type ClientState,
  type ModelInfo,
} from "@arke-studio/contracts";
import { harnessModelLabel, harnessModelUnavailableReason } from "./harness-models.js";

/** One model as the picker lists it: what to call it, and why it cannot be picked, if it cannot. */
export interface PickerModel {
  model: ModelInfo;
  /** `provider/id`, the one reference every choice is kept under. */
  ref: string;
  label: string;
  /** The words Arke has always used for a model this chat cannot use; absent means it can be picked. */
  reason?: string;
  /**
   * Cannot be picked: for the reason above, or because the catalogue is not one the harness has
   * just confirmed (still loading, failed, or the harness stopped), when nothing is known to say.
   */
  locked: boolean;
}

export interface PickerGroup {
  provider: string;
  /** The harness's name for the provider, else Arke's name for a known one, else the id. */
  name: string;
  models: PickerModel[];
}

/**
 * The names of the providers a harness serves that Arke's own table (`PROVIDERS`, the services it
 * holds keys for) does not carry, as their own pages name them. OpenCode's `opencode` provider is
 * its Zen gateway: 195b heads it `OpenCode Zen`, and the installed app read `opencode` when the
 * harness stated no name (local.15).
 */
const HARNESS_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub Copilot",
  xai: "xAI",
  deepseek: "DeepSeek",
  groq: "Groq",
  "amazon-bedrock": "Amazon Bedrock",
  azure: "Azure",
  vercel: "Vercel",
  moonshotai: "Moonshot AI",
  zai: "Z.AI",
  lmstudio: "LM Studio",
};

/**
 * The letter a provider with no bundled logo wears on its plate: its name's first letter, except
 * where that letter would name another — 195b plates OpenCode Zen `Z`, since the OpenAI group
 * beside it is `O` too.
 */
export function providerMarkLetter(provider: string, name: string): string {
  return provider === "opencode" ? "Z" : name.slice(0, 1).toUpperCase();
}

/**
 * The provider's heading: the harness's own name first, since only the harness knows its private
 * providers — unless that name is only the id again, which is no name — then Arke's for a known
 * provider, then the id (195's catalogue rule).
 */
export function providerHeading(provider: string, models: readonly ModelInfo[]): string {
  const stated = models.find((model) => model.providerName !== undefined && model.providerName.toLowerCase() !== provider.toLowerCase())?.providerName;
  if (stated !== undefined) return stated;
  const known = (PROVIDERS as Record<string, { displayName: string } | undefined>)[provider];
  return known?.displayName ?? HARNESS_PROVIDER_NAMES[provider] ?? provider;
}

/** Providers in the order the harness first reports them, each with its models in the harness's order. */
export function modelGroups(
  state: ClientState | null,
  models: readonly ModelInfo[],
  /** The catalogue is not one the harness has just confirmed: every model is listed and none can be picked. */
  notReady: boolean,
  needsTools: boolean,
): PickerGroup[] {
  const byProvider = new Map<string, ModelInfo[]>();
  for (const model of models) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  return [...byProvider].map(([provider, list]) => ({
    provider,
    name: providerHeading(provider, list),
    models: list.map((model) => {
      const reason = notReady ? undefined : harnessModelUnavailableReason(state, model, false, needsTools);
      return {
        model,
        ref: harnessModelReference(model),
        label: harnessModelLabel(state, model),
        locked: notReady || reason !== undefined,
        ...(reason !== undefined ? { reason } : {}),
      };
    }),
  }));
}

/** The models last picked, newest first, that the catalogue still has. */
export function recentModels(
  state: ClientState | null,
  groups: readonly PickerGroup[],
  recent: readonly string[],
): PickerModel[] {
  const all = groups.flatMap((group) => group.models);
  const out: PickerModel[] = [];
  for (const reference of recent) {
    const found = all.find((entry) => entry.ref === reference) ??
      (() => {
        const model = findHarnessModel(reference, all.map((entry) => entry.model), state?.app.manifest?.models);
        return model === undefined ? undefined : all.find((entry) => entry.model === model);
      })();
    if (found !== undefined && !out.includes(found)) out.push(found);
  }
  return out;
}

/** Letters and digits only, lowercased: the one spelling a query and a name are compared in. */
export function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Whether a model answers to a query: its name, its id or its provider's name, ignoring case, spaces and punctuation. */
export function modelMatches(entry: PickerModel, groupName: string, query: string): boolean {
  const wanted = squash(query);
  if (wanted === "") return true;
  return [entry.label, entry.model.id, groupName].some((text) => squash(text).includes(wanted));
}

/**
 * Where the query falls in a name, as the span to set in bold, or null when the name itself does
 * not hold it (the model matched on its id or its provider). `gpt5` marks `GPT-5` in `GPT-5.4`: the
 * span runs over any punctuation the query skipped.
 */
export function matchSpan(label: string, query: string): [number, number] | null {
  const wanted = squash(query);
  if (wanted === "") return null;
  const kept: number[] = [];
  let squashed = "";
  for (let index = 0; index < label.length; index++) {
    const folded = squash(label.charAt(index));
    for (let letter = 0; letter < folded.length; letter++) kept.push(index);
    squashed += folded;
  }
  const at = squashed.indexOf(wanted);
  if (at === -1) return null;
  // `kept` says where in the name each letter of the squashed text came from; the span ends after the last one matched.
  return [kept[at]!, kept[at + wanted.length - 1]! + 1];
}

/** The groups that hold a match, each cut to its matches. */
export function filterGroups(groups: readonly PickerGroup[], query: string): PickerGroup[] {
  if (squash(query) === "") return [...groups];
  return groups
    .map((group) => ({ ...group, models: group.models.filter((entry) => modelMatches(entry, group.name, query)) }))
    .filter((group) => group.models.length > 0);
}

/** `$1.25`, `$10`, `$0.075`: the price as stated, never rounded into another number. */
export function formatDollars(amount: number): string {
  if (Number.isInteger(amount)) return `$${amount}`;
  const cents = amount.toFixed(2);
  return Number(cents) === amount ? `$${cents}` : `$${amount}`;
}

export interface CardRows {
  /** Why this model cannot be picked, the card's first line. */
  why?: string;
  title: string;
  reference: string;
  /** Only what the harness stated: a row with nothing known is left out, never written as unknown. */
  rows: Array<{ label: string; value: string }>;
}

/** What a phone's row shows when its info press opens it in place: the card, less the provider (the group names it) and the tools (a reason says it). */
export function phoneDetailRows(entry: PickerModel, groupName: string): CardRows["rows"] {
  return modelCard(entry, groupName).rows.filter((row) => row.label !== "Provider" && row.label !== "Tools");
}

/** The hovered model's card. */
export function modelCard(entry: PickerModel, groupName: string): CardRows {
  const { model } = entry;
  const rows: CardRows["rows"] = [{ label: "Provider", value: groupName }];
  if (model.inputModalities !== undefined && model.inputModalities.length > 0) {
    const kinds = model.inputModalities.join(", ");
    rows.push({ label: "Inputs", value: kinds.charAt(0).toUpperCase() + kinds.slice(1) });
  }
  if (model.reasoning !== undefined) rows.push({ label: "Reasoning", value: model.reasoning ? "Allows reasoning" : "No" });
  if (model.inputTokenLimit !== undefined) rows.push({ label: "Context", value: `${model.inputTokenLimit.toLocaleString("en-US")} tokens` });
  if (model.tools !== undefined) rows.push({ label: "Tools", value: model.tools ? "Yes" : "No" });
  if (model.cost !== undefined) {
    rows.push({
      label: "Price",
      value: model.cost.inputPerMTok === 0 && model.cost.outputPerMTok === 0
        ? "Free"
        : `${formatDollars(model.cost.inputPerMTok)} in · ${formatDollars(model.cost.outputPerMTok)} out per M`,
    });
  }
  return {
    // The reason keeps the words Arke has always used; the card sets one in a sentence's first letter, as 195d draws it.
    ...(entry.reason !== undefined ? { why: entry.reason.charAt(0).toUpperCase() + entry.reason.slice(1) } : {}),
    title: entry.label,
    reference: entry.ref,
    rows,
  };
}
