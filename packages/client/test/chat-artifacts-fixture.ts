import type { ClientState } from "@arke-studio/contracts";
import { FIXTURE_STATE } from "./fixture-state.js";

export const CHAT_ID = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";
export function chatArtifactsFixture(): ClientState {
  const state = structuredClone(FIXTURE_STATE), world = state.world!;
  const at = "2026-09-27T12:00:00Z";
  state.app.health.harness = { status: "healthy" };
  state.app.health.voice = { status: "healthy" };
  state.app.jobs = []; world.proposals = []; world.problems = []; world.externalEdits = [];
  world.conversations = ["The bells and the lock", "Where the salt roads meet", "Who collects rent in the Drowned Quarter", "The Ebb Council’s three seats", "What the tide does to sound", "An older conversation", "Another archive"].map((title, i) => ({
    id: i === 0 ? CHAT_ID : `cv_01J8F3K2QW9VZX4N7M0RTYB6H${i}`, title, status: i > 4 ? "archived" : "open",
    updatedAt: new Date(new Date(at).getTime() - i * 7200000).toISOString(), pointCount: i === 0 ? 5 : 0,
    openProposalCount: i === 1 ? 2 : 0, notCarried: [],
    ...(i === 0 ? { entryContext: { kind: "sheet" as const, sheetKind: "character" as const, sheetId: "maren-kest" } } : {}),
  }));
  state.worldChat = {
    conversationId: CHAT_ID, status: "open", initiative: "collaborate", seq: 12, hasMore: false, actions: [], attachments: [], runStatus: null, runStartedAt: null, retrievalUnavailable: false,
    messages: ["Her aunt taught her the bells, not her mother.", "That changes the line of inheritance. If the aunt held the verse, the Kest women are a lineage, not a line.", "A rule. Anyone can be given them.", "Then the bells are taught, not inherited, which sits with CANON-018. Keep going…"].map((text, i) => ({
      id: `msg_01J8F3K2QW9VZX4N7M0RTYB6H${i}`, role: i % 2 ? "studio" : "user", text, createdAt: at, receipts: i === 1 ? ["read Maren Kest v4", "searched 41 canon entries"] : [], refusals: [],
    })),
    points: [
      { id: "ca_01J8F3K2QW9VZX4N7M0RTYB6H1", subject: "Maren Kest", subjectKind: "sheet · v4", kind: "point", text: "Her aunt taught her the bells, not her mother.", settled: true, revision: 1 },
      { id: "ca_01J8F3K2QW9VZX4N7M0RTYB6H2", subject: "The western lock", subjectKind: "new rule", kind: "point", text: "Bells cannot ring below the western lock.", settled: true, revision: 1 },
      { id: "ca_01J8F3K2QW9VZX4N7M0RTYB6H3", subject: "The bells", subjectKind: "new rule", kind: "point", text: "Anyone can be taught the bells.", settled: true, revision: 1 },
      { id: "ca_01J8F3K2QW9VZX4N7M0RTYB6H4", subject: "Maren Kest", subjectKind: "question", kind: "question", text: "Whether the aunt is still alive.", settled: false, revision: 1 },
      { id: "ca_01J8F3K2QW9VZX4N7M0RTYB6H5", subject: "The western lock", subjectKind: "question", kind: "question", text: "Who guards the lock?", settled: false, revision: 1 },
    ],
  };
  const files = ["tide-study.mp4", "harbour-bells.wav", "undersong-treatment.pdf", "key-art.png", "drowned-quarter.png"];
  world.artifacts = files.map((file, i) => ({
    id: `ar_01J8G0000000000000000000X${i}`, kind: i === 0 ? "video" : i === 1 ? "audio" : i === 2 ? "document" : "image",
    file, hash: "sha256:6a1e02b9c44d7f31", origin: { by: "user" }, links: [], created: at,
    ...(i < 2 ? { mediaInfo: { durationSec: i === 0 ? 15 : 134, hasAudio: true } } : {}),
  }));
  return state;
}
