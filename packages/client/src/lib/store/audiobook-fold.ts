// How the audiobook's events land in the store: handleFrame's audiobook arms, moved here (issue 2800).
import type { DomainEvent } from "@arke-studio/contracts";
import { type FrameSlices, type Folded, current } from "./core.js";
import { pendingQueueRequests } from "./events.js";
import { landDoorAnswer } from "./audiobook-door.js";

/** handleFrame's arms for audiobook.started … direction.finished, in their order (issue 2800). */
export function foldAudiobookEvent(slices: FrameSlices, event: DomainEvent): Folded {
  if (event.type === "audiobook.started") {
    // A replayed start tells a reconnecting window which run can be stopped. Keep progress
    // already observed if an older host also replays it on ordinary refreshes.
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    if (event.replayed !== true || slices.audiobook[key] === undefined) {
      slices.audiobook = {
        ...slices.audiobook,
        [key]: {
          state: "reading", requestId: event.requestId, toMake: event.toMake, blocks: event.blocks, made: event.made ?? 0, flagged: 0,
          ...(event.requests !== undefined ? { requests: event.requests, groups: event.groups ?? [], request: event.request ?? 0 } : {}),
        },
      };
    }
    // The run's request is minted by the coordinator, so it is registered here rather than
    // at send time: a cloned voice's upload consent is routed by request (codex on PR 1180),
    // and without this entry the consent would be dropped on the floor and the run would
    // wait for an answer no window could give. A chapter read under the book carries the
    // book's request, whose command is registered already and stands (codex on PR 1187).
    if (!pendingQueueRequests.has(event.requestId)) pendingQueueRequests.set(event.requestId, { command: "read-audiobook-chapter" });
  } else if (event.type === "audiobook.priced") {
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    const held = slices.audiobook[key] ?? { toMake: 0, blocks: 0, made: 0, flagged: 0 };
    slices.audiobook = {
      ...slices.audiobook,
      [key]: { ...held, state: "priced", price: { ...(event.previews !== undefined ? { previews: event.previews } : {}), characters: event.characters, estimatedMicroUsd: event.estimatedMicroUsd, confirmationToken: event.confirmationToken, voices: event.voices, notices: event.notices ?? [], ...(event.freePlan !== undefined ? { freePlan: event.freePlan } : {}), ...(event.requests !== undefined ? { requests: event.requests } : {}), ...(event.perParagraph !== undefined ? { perParagraph: event.perParagraph } : {}), ...(event.groupingUnavailable === true ? { groupingUnavailable: true } : {}), ...(event.toCast !== undefined ? { toCast: event.toCast } : {}) } },
    };
  } else if (event.type === "audiobook.request") {
    // A grouped request begins (design turn 185b): the margin darkens its bracket.
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    const held = slices.audiobook[key];
    if (held !== undefined) slices.audiobook = { ...slices.audiobook, [key]: { ...held, request: event.index, requests: event.of, requestKeys: event.keys } };
  } else if (event.type === "audiobook.progress") {
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    const held = slices.audiobook[key] ?? { state: "reading" as const, toMake: event.toMake, blocks: 0, made: 0, flagged: 0 };
    slices.audiobook = {
      ...slices.audiobook,
      [key]: {
        ...held,
        state: "reading",
        toMake: event.toMake,
        made: event.made,
        flagged: held.flagged + (event.outcome === "flagged" ? 1 : 0),
        last: { block: event.block, outcome: event.outcome, ...(event.reason !== undefined ? { reason: event.reason } : {}) },
      },
    };
  } else if (event.type === "audiobook.finished") {
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    const held = slices.audiobook[key] ?? { toMake: 0, blocks: 0, made: 0, flagged: 0 };
    slices.audiobook = {
      ...slices.audiobook,
      [key]: {
        ...held,
        state: event.outcome,
        made: event.made,
        flagged: event.flagged,
        price: undefined,
        ...(event.record !== undefined ? { record: event.record } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      },
    };
  } else if (event.type === "audiobook.script") {
    if (slices.speakerLines[event.requestId] !== undefined) {
      slices.speakerLines = {
        ...slices.speakerLines,
        [event.requestId]:
          event.refused !== undefined
            ? { kind: slices.speakerLines[event.requestId]!.kind, state: "refused", refused: event.refused }
            : { kind: slices.speakerLines[event.requestId]!.kind, state: "done", chapters: event.chapters, recorded: event.recorded, awaiting: event.awaiting, ...(event.output !== undefined ? { output: event.output } : {}), ...(event.lines !== undefined ? { lines: event.lines } : {}), ...(event.notCast !== undefined ? { notCast: event.notCast } : {}) },
      };
    }
  } else if (event.type === "audiobook.lines-staged") {
    if (slices.speakerLines[event.requestId] !== undefined) {
      slices.speakerLines = {
        ...slices.speakerLines,
        [event.requestId]: event.refused !== undefined ? { kind: "files", state: "refused", refused: event.refused } : { kind: "files", state: "done", rows: event.rows },
      };
    }
  } else if (event.type === "audiobook.narrator-quote") {
    if (slices.narratorQuotes[event.requestId] !== undefined) {
      slices.narratorQuotes = {
        ...slices.narratorQuotes,
        [event.requestId]:
          event.refused !== undefined
            ? { state: "refused", refused: event.refused }
            : { state: "done", stale: event.stale ?? 0, held: event.held ?? 0, directed: event.directed ?? 0, estimatedMicroUsd: event.estimatedMicroUsd ?? 0, kept: event.kept ?? 0 },
      };
    }
  } else if (event.type === "audiobook.heard") {
    if (slices.heardLines[event.requestId] !== undefined) {
      slices.heardLines = { ...slices.heardLines, [event.requestId]: event.file !== undefined ? { state: "done", file: event.file } : event.quote !== undefined ? { state: "priced", ...event.quote } : { state: "refused", refused: event.refused ?? "could not hear it" } };
    }
  } else if (event.type === "direction.reads") {
    if (slices.audiobookAsks[event.requestId] !== undefined) {
      slices.audiobookAsks = { ...slices.audiobookAsks, [event.requestId]: event.reads !== undefined ? { state: "reads", reads: event.reads } : { state: "refused", refused: event.refused ?? "could not read the book" } };
    }
  } else if (event.type === "illustration.started") {
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    // Older hosts also replay on refresh: a window already making pictures keeps its progress.
    if (slices.illustration[key]?.state !== "making") slices.illustration = { ...slices.illustration, [key]: { state: "reading", skipped: [], without: [] } };
  } else if (event.type === "illustration.finished") {
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    const before = slices.illustration[key];
    if (event.outcome === "proposed" && event.proposal !== undefined) {
      // What is left after a run keeps the author's skips for the rows still in it, and how the run ended.
      const present = new Set(event.proposal.rows.map((row) => row.block));
      const shown = new Map((before?.proposal?.rows ?? []).map((row) => [row.block, new Set(row.disagrees ?? [])]));
      slices.illustration = {
        ...slices.illustration,
        [key]: {
          state: "proposed",
          proposal: event.proposal,
          skipped: (before?.skipped ?? []).filter((block) => present.has(block)),
          // A row refused again is held again: consent to try it was for the run that just ended (codex on PR 1559).
          // So is one the run found a look disagreeing on that it never showed: the consent was not to that (codex on PR 1868).
          without: (event.proposal.refreshed === true && event.proposal.proposalId !== before?.proposal?.proposalId ? [] : before?.without ?? []).filter((block) => {
            const row = event.proposal!.rows.find((candidate) => candidate.block === block);
            return row !== undefined && row.refused === undefined && (row.disagrees ?? []).every((who) => shown.get(block)?.has(who) === true);
          }),
          ...((before?.state === "done" || before?.state === "stopped") && before.progress !== undefined ? { progress: before.progress } : {}),
        },
      };
    } else {
      slices.illustration = { ...slices.illustration, [key]: { state: event.outcome === "proposed" ? "failed" : event.outcome, skipped: [], without: [], ...(event.reason !== undefined ? { reason: event.reason } : {}) } };
    }
  } else if (event.type === "illustration.progress") {
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    const before = slices.illustration[key];
    if (event.refused !== undefined) {
      // Refused before it began: the proposal stands, with the clause that says why.
      if (before !== undefined) slices.illustration = { ...slices.illustration, [key]: { ...before, state: before.proposal !== undefined ? "proposed" : before.state, refreshing: false, reason: event.refused } };
    } else {
      slices.illustration = {
        ...slices.illustration,
        [key]: {
          state: event.progress.state,
          ...(before?.proposal !== undefined ? { proposal: before.proposal } : {}),
          skipped: before?.skipped ?? [],
          without: before?.without ?? [],
          progress: event.progress,
        },
      };
    }
  } else if (event.type === "audiobook.looks") {
    if (slices.audiobookAsks[event.requestId] !== undefined) slices.audiobookAsks = { ...slices.audiobookAsks, [event.requestId]: { state: "looks", usage: event.usage, ...(event.coverage === undefined ? {} : { coverage: event.coverage }) } };
  } else if (event.type === "audiobook.picture-suggestion") {
    if (slices.audiobookAsks[event.requestId] !== undefined) {
      slices.audiobookAsks = { ...slices.audiobookAsks, [event.requestId]: event.suggestion !== undefined ? { state: "suggested", suggestion: event.suggestion } : { state: "refused", refused: event.refused ?? "no picture suggested" } };
    }
  } else if (event.type === "audiobook.picture-prompt") {
    if (slices.audiobookAsks[event.requestId] !== undefined) {
      slices.audiobookAsks = { ...slices.audiobookAsks, [event.requestId]: event.prompt !== undefined ? { state: "prompt", prompt: event.prompt } : { state: "refused", refused: event.refused ?? "the prompt was not updated" } };
    }
  } else if (event.type === "audiobook.picture-made") {
    // A picture on its block carries the record it stands in, taken as any record write is: a window that has it
    // from this event alone shows the chip and the panel without waiting for a reopen.
    if (event.record !== undefined) {
      const recordKey = `${event.worldId}/${event.productionId}/${event.chapterId}`;
      slices.audiobookRecords = { ...slices.audiobookRecords, [recordKey]: { seq: (slices.audiobookRecords[recordKey]?.seq ?? 0) + 1, requestId: event.requestId, record: event.record } };
    }
    if (slices.audiobookAsks[event.requestId] !== undefined && event.state !== "making") {
      slices.audiobookAsks = { ...slices.audiobookAsks, [event.requestId]: event.state === "made" ? { state: "made", ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}) } : { state: "failed", reason: event.reason ?? "the picture was not made", ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}) } };
    }
  } else if (event.type === "audiobook.speaker-notes") {
    if (slices.audiobookAsks[event.requestId] !== undefined) {
      slices.audiobookAsks = { ...slices.audiobookAsks, [event.requestId]: event.refused !== undefined ? { state: "refused", refused: event.refused } : { state: "drafted", drafted: event.drafted } };
    }
  } else if (event.type === "audiobook.lines-kept") {
    const held = slices.speakerLines[event.requestId];
    if (held !== undefined) {
      slices.speakerLines = { ...slices.speakerLines, [event.requestId]: { ...held, state: "done", kept: event.kept, ...(event.refused !== undefined ? { refused: event.refused } : {}) } };
    }
  } else if (event.type === "audiobook.take-staged") {
    const held = slices.stagedTakes[event.requestId];
    if (held !== undefined) {
      slices.stagedTakes = {
        ...slices.stagedTakes,
        [event.requestId]:
          event.refused !== undefined
            ? { ...held, state: "refused", refused: event.refused }
            : {
                ...held,
                state: "staged",
                ...(event.file !== undefined ? { file: event.file } : {}),
                checks: {
                  durationSec: event.durationSec ?? null,
                  sampleRateHz: event.sampleRateHz ?? null,
                  channels: event.channels ?? null,
                  rmsDbfs: event.rmsDbfs ?? null,
                  samplePeakDbfs: event.samplePeakDbfs ?? null,
                  noiseFloor: event.noiseFloor ?? "unavailable",
                  words: event.words ?? "unchecked",
                  differences: event.differences ?? 0,
                },
              },
      };
    }
  } else if (event.type === "audiobook.record") {
    // A recording kept, or refused at the keep (turn 155c): its own answer, by its request id.
    if (event.requestId !== undefined && slices.stagedTakes[event.requestId] !== undefined) {
      const { [event.requestId]: kept, ...rest } = slices.stagedTakes;
      slices.stagedTakes = event.record !== undefined ? rest : { ...rest, [event.requestId]: { ...kept!, state: "staged", refused: event.refused ?? "refused" } };
    }
    // A write outside a run (turn 146): the record, or why nothing was written. A card being
    // accepted takes the answer as its own — accepted, or refused and held for another try.
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    const seq = (slices.audiobookRecords[key]?.seq ?? 0) + 1;
    slices.audiobookRecords = { ...slices.audiobookRecords, [key]: { seq, ...(event.requestId !== undefined ? { requestId: event.requestId } : {}), ...(event.record !== undefined ? { record: event.record } : {}), ...(event.refused !== undefined ? { refused: event.refused } : {}) } };
    // Only its own answer (codex on PR 1186): another window's block write lands as the same
    // event, and would otherwise mark the card accepted while the acceptance itself is still
    // on its way to a refusal it could no longer show.
    const card = slices.direction[key];
    if (card?.state === "accepting" && event.requestId !== undefined && event.requestId === card.requestId) {
      slices.direction = {
        ...slices.direction,
        [key]: event.record !== undefined
          ? { ...card, state: "accepted", dropped: card.dropped + (event.dropped ?? 0), proposed: undefined, requestId: undefined }
          : { ...card, state: "directed", requestId: undefined, ...(event.refused !== undefined ? { reason: event.refused } : {}) },
      };
    }
  } else if (event.type === "audiobook.door") {
    // Any answer newer than the one shown, and only for the world that is open: an older
    // answer is older news, and one for a world since closed would repopulate a same-named
    // production in the next (codex on PR 1187).
    if (landDoorAnswer(event.worldId, event.productionId, event.requestId) && current.state?.world?.meta.worldId === event.worldId) {
      slices.audiobookDoor = { ...slices.audiobookDoor, [event.productionId]: { door: event.door, requestId: event.requestId, ...(event.refused !== undefined ? { refused: event.refused } : {}) } };
    }
  } else if (event.type === "audiobook.credits") {
    // Only for the world that is open: productions recur by name across worlds. A refusal keeps
    // the credits last shown, with its clause beside them.
    if (current.state?.world?.meta.worldId === event.worldId) {
      const held = slices.audiobookCredits[event.productionId]?.credits ?? null;
      slices.audiobookCredits = { ...slices.audiobookCredits, [event.productionId]: { credits: event.credits ?? held, ...(event.refused !== undefined ? { refused: event.refused } : {}) } };
    }
  } else if (event.type === "audiobook.book-started") {
    // The book's state is keyed by production, and productions recur by name across worlds:
    // a run's late word from a world since closed is not this world's (codex on PR 1187).
    if (current.state?.world?.meta.worldId === event.worldId) {
      // A replayed start carries the counts the book has reached: a window that holds the
      // run keeps what it knows, and one that rejoined takes them.
      if (event.replayed !== true || slices.audiobookBook[event.productionId] === undefined) {
        slices.audiobookBook = {
          ...slices.audiobookBook,
          [event.productionId]: { state: "reading", requestId: event.requestId, chapters: event.chapters, blocks: event.blocks, done: event.done ?? 0, chaptersRead: 0, chaptersRefused: 0, made: 0, flagged: 0 },
        };
      }
      // The book's request is the coordinator's (SPEC-047 R-17): a cloned voice's consent is
      // routed by it, so it is registered here as the chapter's is.
      pendingQueueRequests.set(event.requestId, { command: "read-audiobook-book" });
    }
  } else if (event.type === "audiobook.book-priced") {
    if (current.state?.world?.meta.worldId === event.worldId) {
      const held = slices.audiobookBook[event.productionId] ?? { chapters: event.chapters, blocks: event.blocks, done: 0, chaptersRead: 0, chaptersRefused: 0, made: 0, flagged: 0 };
      slices.audiobookBook = { ...slices.audiobookBook, [event.productionId]: { ...held, state: "priced", price: event } };
    }
  } else if (event.type === "audiobook.book-progress") {
    if (current.state?.world?.meta.worldId === event.worldId) {
      const held = slices.audiobookBook[event.productionId] ?? { chapters: event.chapters, blocks: 0, done: 0, chaptersRead: 0, chaptersRefused: 0, made: 0, flagged: 0 };
      slices.audiobookBook = { ...slices.audiobookBook, [event.productionId]: { ...held, state: "reading", done: event.done, chapters: event.chapters } };
    }
  } else if (event.type === "audiobook.book-finished") {
    if (current.state?.world?.meta.worldId === event.worldId) {
      const held = slices.audiobookBook[event.productionId] ?? { chapters: 0, blocks: 0, done: 0, chaptersRead: 0, chaptersRefused: 0, made: 0, flagged: 0 };
      slices.audiobookBook = {
        ...slices.audiobookBook,
        [event.productionId]: {
          ...held,
          state: event.outcome,
          price: undefined,
          chaptersRead: event.chaptersRead,
          chaptersRefused: event.chaptersRefused,
          made: event.made,
          flagged: event.flagged,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      };
    }
  } else if (event.type === "audiobook.conformed") {
    if (current.state?.world?.meta.worldId === event.worldId) {
      slices.audiobookNotes = { ...slices.audiobookNotes, [event.productionId]: { dropped: event.dropped, held: event.held ?? 0, chapters: event.chapters, seq: (slices.audiobookNotes[event.productionId]?.seq ?? 0) + 1 } };
    }
  } else if (event.type === "audiobook.beats") {
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    slices.beats = {
      ...slices.beats,
      [key]: {
        state: event.outcome,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        ...(event.before !== undefined ? { before: event.before } : {}),
        ...(event.after !== undefined ? { after: event.after } : {}),
      },
    };
  } else if (event.type === "direction.started") {
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    // Older hosts also replay on refresh: a window already directing keeps its progress.
    if (slices.direction[key]?.state !== "directing" && slices.direction[key]?.state !== "accepting") slices.direction = { ...slices.direction, [key]: { state: "directing", directed: 0, dropped: 0 } };
  } else if (event.type === "direction.finished") {
    const key = `${event.worldId}/${event.productionId}/${event.chapterId}`;
    const before = slices.direction[key];
    // A held proposal replay must not re-arm its Accept while its write is pending or after
    // that write was acknowledged. Only a genuinely new proposal replaces that decision.
    const decided = event.proposalId !== undefined && event.proposalId === before?.proposalId
      && (before.state === "accepting" || before.state === "accepted");
    if (!decided) {
      slices.direction = {
        ...slices.direction,
        [key]: {
          state: event.outcome,
          directed: event.directed,
          dropped: event.dropped,
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
          ...(event.proposed !== undefined ? { proposed: event.proposed } : {}),
          ...(event.hash !== undefined ? { hash: event.hash } : {}),
          ...(event.chapterVersion !== undefined ? { chapterVersion: event.chapterVersion } : {}),
          ...(event.cast !== undefined ? { cast: event.cast } : {}),
          ...(event.castRecord !== undefined ? { castRecord: event.castRecord } : {}),
          ...(event.proposalId !== undefined ? { proposalId: event.proposalId } : {}),
          ...(event.proposed !== undefined ? { moved: Object.values(event.proposed).filter((input) => (input.delivery !== undefined && input.delivery !== "measured") || input.note !== undefined || input.speed !== 1 || input.cues.length > 0).length } : {}),
          ...(event.speakerNotes !== undefined ? { speakerNotes: event.speakerNotes } : {}),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        },
      };
    }
  } else return "none";
  return "done";
}
