import type { ManifestModel } from "./manifest.js";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * The characters a vendor will bill for this text, by the row's unit — what `estimateMicroUsd`
 * wants in `characters`, never `text.length` alone for a row that counts differently (SPEC-046
 * R-8; codex on PR 1153 found the CJK half-estimate). A row with no unit, or no per-character
 * pricing, counts characters. A delivery the row carries as a tag in the text — `(whispers) `,
 * `[voice breaking, through tears] ` — is billed as text too, so a caller that knows the
 * delivery names it and the tag's characters are counted before the line is priced — but only
 * when the tag will actually go: a paren-syntax vendor's English tag goes into a line stated to
 * be English and no other (SPEC-046 R-23), so the estimate follows the same rule (codex on PR
 * 1153). A bracket-syntax tag is a phrase the vendor reads in any language and always goes.
 */
export function billableCharacters(model: Pick<ManifestModel, "pricing"> & Partial<Pick<ManifestModel, "cadence">>, text: string, delivery?: string, language?: string): number {
  const paren = model.cadence?.tagSyntax === "paren";
  const tag = delivery !== undefined && (!paren || language === "en") ? model.cadence?.deliveryMappings[delivery]?.tag : undefined;
  const counted = tag !== undefined ? `${paren ? `(${tag})` : `[${tag}]`} ${text}` : text;
  const unit = model.pricing.kind === "perCharacter" ? model.pricing.unit : undefined;
  if (unit === "utf8-byte") return new TextEncoder().encode(counted).length;
  if (unit === "cjk-double") return counted.length + (counted.match(CJK)?.length ?? 0);
  return counted.length;
}

