import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { BenchSessionSummary } from "@arke-studio/contracts";
import { WaitingTakeLinks, waitingTakeSessions } from "../src/screens/scene-workspace/rows.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

it("links each completed undecided take back to its exact shot session", () => {
  const subject = {
    kind: "shot" as const,
    productionId: "saltlight",
    productionTitle: "Saltlight",
    sceneId: "sc_04",
    sceneNumber: 4,
    sceneTitle: "The verse rises",
    shotId: "sh_12",
    shotNumber: 12,
    shotTitle: "Maren at the rail, listening",
    durationSec: 4,
    aspect: "16:9",
  };
  const summary = (id: string, waitingCount: number, shotId = "sh_12"): BenchSessionSummary => ({
    id,
    subject: { ...subject, shotId },
    title: "A shot session",
    mode: "video" as const,
    updatedAt: "2026-08-16T10:01:00.000Z",
    takeCount: waitingCount,
    runningCount: 0,
    failedCount: 0,
    waitingCount,
  });
  const firstId = "sess_01JMMMMMMMMMMMMMMMMMMMMMM1";
  const secondId = "sess_01JMMMMMMMMMMMMMMMMMMMMMM2";
  const sessions = [
    summary(firstId, 1),
    summary(secondId, 2),
    summary("sess_01JMMMMMMMMMMMMMMMMMMMMMM3", 4, "sh_13"),
    summary("sess_01JMMMMMMMMMMMMMMMMMMMMMM4", 0),
  ];
  const waiting = waitingTakeSessions(sessions, "saltlight", "sc_04", "sh_12");
  assert.equal(waiting.reduce((total, entry) => total + entry.waitingCount, 0), 3);
  const html = renderToString(<WaitingTakeLinks sessions={waiting} worldId={FIXTURE_WORLD_ID} />);
  const document = parseHTML(html).document;
  const links = [...document.querySelectorAll<HTMLAnchorElement>(".fy-swrow__waiting a")];
  assert.deepEqual(links.map((link) => link.textContent?.trim()), ["1 take waiting · video", "2 takes waiting · video"]);
  assert.deepEqual(links.map((link) => link.getAttribute("href")), [
    `#/w/${FIXTURE_WORLD_ID}/artifacts/bench/${firstId}`,
    `#/w/${FIXTURE_WORLD_ID}/artifacts/bench/${secondId}`,
  ]);
});
