import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ArkeVersionTargetSchema, type ArkeVersionTarget, type WorldBundle } from "@arke-studio/contracts";
import { containedWorldFilePath } from "../world/contained-file.js";
import { readContainedMediaBytes } from "../world/reference-files.js";
import { MarkdownFile, sha256 } from "../world/text-files.js";

export interface VersionRow { version: number; hash: string; title?: string }
export const versionTargetId = (target: ArkeVersionTarget): string => target.kind === "sheet" ? `sheet:${target.sheetType}:${target.id}` : target.kind === "canon" ? `canon:${target.id}` : target.kind;

/** Discovery for the existing restore cards, scoped by identity rather than a model-supplied path. */
export async function readVersionHistory(worldDir: string, bundle: WorldBundle, input: ArkeVersionTarget): Promise<VersionRow[]> {
  const target = ArkeVersionTargetSchema.parse(input);
  let directory: string;
  if (target.kind === "sheet") {
    if (!bundle.sheets.some(sheet => sheet.id === target.id && sheet.type === target.sheetType)) throw new Error("That sheet is unavailable.");
    directory = `.history/${target.sheetType === "character" ? "characters" : target.sheetType === "location" ? "locations" : "factions"}/${target.id}`;
  } else if (target.kind === "canon") {
    if (!bundle.canon.some(entry => entry.id === target.id)) throw new Error("That Canon entry is unavailable.");
    directory = `.history/canon/${target.id}`;
  } else directory = `.history/${target.kind}`;
  const rows = new Map<number, VersionRow>();
  // Early art-direction versions are embedded in the live record; restore supports both forms.
  if (target.kind === "art-direction") for (const entry of bundle.artDirection.history) rows.set(entry.version, { version: entry.version, hash: sha256(JSON.stringify(entry)) });
  const extension = target.kind === "art-direction" ? "json" : "md";
  let names: string[];
  try {
    const probe = await containedWorldFilePath(worldDir, `${directory}/v1.${extension}`, false, "version-history", true);
    names = await readdir(dirname(probe));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...rows.values()].sort((a, b) => a.version - b.version); throw error; }
  for (const name of names) {
    const match = /^v([1-9]\d*)\.(md|json)$/.exec(name);
    if (!match || match[2] !== extension || !Number.isSafeInteger(Number(match[1]))) continue;
    const version = Number(match[1]);
    if (rows.has(version)) continue;
    const bytes = await readContainedMediaBytes(worldDir, `${directory}/${name}`, undefined, 2 * 1024 * 1024);
    const raw = Buffer.from(bytes).toString("utf8"), data = extension === "md" ? MarkdownFile.parse(raw).data : JSON.parse(raw);
    const title = data.title ?? data.name;
    rows.set(version, { version, hash: sha256(bytes), ...(typeof title === "string" ? { title: title.slice(0, 200) } : {}) });
  }
  return [...rows.values()].sort((a, b) => a.version - b.version);
}
