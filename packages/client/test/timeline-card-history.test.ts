import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { applyTimelineCommands, seedFirstPictureTimeline, undoTimelineHistory, type ConversationActionCard } from "@arke-studio/contracts";
import { cardHistoryControl, historyEntryDigest } from "../src/components/timeline-card-history.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("offers only a completed card's exact top entry, and follows that entry to Redo", async () => {
  const production = structuredClone(FIXTURE_STATE.world!.productions[0]!);
  const seed = seedFirstPictureTimeline(production);
  const owned = applyTimelineCommands(seed, [{ kind: "set-track", trackId: seed.tracks[0]!.id, name: "Owned" }], { requestId: "req_owned", label: "Rename picture" });
  production.timeline = { status: "ready", timeline: owned, hash: "sha256:test" };
  const card = { actionId: "act_owner", status: "completed", receipt: { kind: "editor-request", id: "req_owned", summary: "Completed" } } as unknown as ConversationActionCard;
  assert.deepEqual(await cardHistoryControl(card, production), { operation: "undo", revision: owned.revision, label: "Rename picture" });
  const other = applyTimelineCommands(owned, [{ kind: "set-track", trackId: seed.tracks[0]!.id, name: "Other" }], { requestId: "req_other" });
  production.timeline = { status: "ready", timeline: other, hash: "sha256:other" };
  assert.equal(await cardHistoryControl(card, production), null, "Never undo another card's entry");
  const undone = undoTimelineHistory(owned);
  production.timeline = { status: "ready", timeline: undone, hash: "sha256:undone" };
  assert.deepEqual(await cardHistoryControl(card, production), { operation: "redo", revision: undone.revision, label: "Rename picture" });
  const entry = owned.history.undo.at(-1)!;
  if (entry.kind !== "change") throw new Error("Expected change");
  const digest = await historyEntryDigest(entry);
  const stable = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  assert.equal(digest, `sha256:${createHash("sha256").update(stable(entry)).digest("hex")}`, "Browser receipt matching agrees with coordinator canonical hashes");
  const inverse = { ...card, receipt: { kind: "timeline-history", id: "act_inverse", digest, summary: "Undone" } };
  assert.equal((await cardHistoryControl(inverse, production))?.operation, "redo");
  assert.equal(await cardHistoryControl({ ...card, status: "pending" }, production), null);
});
