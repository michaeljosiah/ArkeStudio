import type { Proposal } from "@arke-studio/contracts";
import { MarkdownFile, sha256 } from "../world/text-files.js";

/** Metadata, heading renames and whitespace cannot turn a saved brief into authored prose. */
export function sheetProseHash(content: string): string {
  return sha256(JSON.stringify(MarkdownFile.parse(content).sections()
    .map(section => section.body.replace(/\s+/gu, " ").trim())
    .filter(body => body !== "" && body !== "—")));
}

export function undraftedSheetProblem(proposal: Proposal, content: string | null): { path: string; message: string } | null {
  const seed = proposal.sheetSeed;
  if (!seed) return null;
  const bodyHash = content === null ? null : sheetProseHash(content);
  if (bodyHash !== null && bodyHash !== sha256("[]") && bodyHash !== seed.bodyHash) return null;
  return { path: seed.path, message: "This is still the saved brief. Draft the sheet or edit its prose before accepting." };
}
