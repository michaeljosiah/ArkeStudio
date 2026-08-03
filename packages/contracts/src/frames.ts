import { z } from "zod";
import { ClientStateSchema } from "./client-state.js";
import { DomainEventSchema } from "./events.js";
import { GenesisIdSchema, ShotIdSchema, SlugSchema, UlidSchema } from "./ids.js";
import { CapabilitySchema, ProviderIdSchema } from "./provider.js";
import { ReferenceAngleSchema } from "./reference.js";

/**
 * Coordinator transport (SPEC-001 §2.5): one `snapshot` frame then `event` frames, sequence
 * numbers monotonic per connection. A reconnecting client sends its last-seen sequence and
 * receives a fresh snapshot — partial replay is deliberately not offered (D4).
 */

export const FrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), seq: z.number().int().min(1), state: ClientStateSchema }).strict(),
  z.object({ kind: z.literal("event"), seq: z.number().int().min(1), event: DomainEventSchema }).strict(),
]);
export type Frame = z.infer<typeof FrameSchema>;

/** What a client may send up. Commands arrive with their owning specs. */
export const ClientMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello"), lastSeq: z.number().int().min(0).optional() }).strict(),
  z.object({ kind: z.literal("open-world"), worldId: UlidSchema }).strict(),
  /** SPEC-002: create a world folder under the app root. */
  z
    .object({
      kind: z.literal("create-world"),
      name: z.string().min(1).max(200),
      logline: z.string().max(500).optional(),
      tone: z.string().max(200).optional(),
      genre: z.string().max(200).optional(),
      /**
       * Begun from a genesis conversation: whatever was attached to it waits in that sandbox
       * and is filed into the world as it opens. Without this the files would be swept with
       * the sandbox, and handing something over would have meant nothing.
       */
      genesisId: GenesisIdSchema.optional(),
    })
    .strict(),
  /**
   * Archive a world: out of the library, still on the disk. The folder moves to `archive/`
   * whole, so what comes next — recovery, or deleting it for good — is a decision taken later
   * and somewhere else, never a side effect of tidying up.
   */
  /**
   * The world's key image, from what the world already says about itself: name, logline, tone
   * and genre become one image job through the ordinary queue — estimated before it runs,
   * recorded in the ledger, cancellable like anything else that spends.
   */
  z.object({ kind: z.literal("generate-world-image"), worldId: UlidSchema }).strict(),
  /** Keep the candidate that came back — it becomes world-art.png. */
  z.object({ kind: z.literal("use-world-image"), worldId: UlidSchema }).strict(),
  /** Or do not: the candidate is deleted and the world keeps the image it had. */
  z.object({ kind: z.literal("discard-world-image"), worldId: UlidSchema }).strict(),
  z.object({ kind: z.literal("archive-world"), worldId: UlidSchema }).strict(),
  /** SPEC-002: reload after an external change made the open world stale (R-23). */
  z.object({ kind: z.literal("reload-world"), worldId: UlidSchema }).strict(),
  /** SPEC-002: adopt one closed-world edit — snapshot, bump, log (R-28). */
  z
    .object({ kind: z.literal("reconcile-external-edit"), worldId: UlidSchema, path: z.string().min(1) })
    .strict(),
  /** SPEC-004: stage a sheet edit as a proposal — the form editor's whole flow in one message. */
  z
    .object({
      kind: z.literal("stage-sheet-edit"),
      worldId: UlidSchema,
      /** World-relative sheet path, e.g. "characters/maren-kest.md". */
      path: z.string().min(1),
      summary: z.string().min(1).max(300),
      sections: z.array(z.object({ heading: z.string().min(1), body: z.string() }).strict()).min(1),
    })
    .strict(),
  /** SPEC-017: changing the shared world look is staged, never written as a field edit. */
  z
    .object({
      kind: z.literal("stage-art-direction-change"),
      worldId: UlidSchema,
      description: z.string().trim().min(1).max(4000),
      /** World-relative path of a master look already admitted to the world. */
      masterLook: z.string().min(1).nullable().optional(),
    })
    .strict(),
  /** SPEC-004: gate decisions. confirmRipples carries the authoritative signature on re-confirm (R-10). */
  z
    .object({
      kind: z.literal("proposal-accept"),
      worldId: UlidSchema,
      proposalId: z.string().min(1),
      confirmRipples: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("proposal-discard"), worldId: UlidSchema, proposalId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("proposal-rebase"), worldId: UlidSchema, proposalId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("proposal-resolve-conflict"),
      worldId: UlidSchema,
      proposalId: z.string().min(1),
      path: z.string().min(1),
      field: z.string().min(1),
      choice: z.enum(["mine", "theirs"]),
    })
    .strict(),
  /** SPEC-004 R-7: the user has seen the merged result; the proposal becomes acceptable again. */
  z
    .object({ kind: z.literal("proposal-mark-seen"), worldId: UlidSchema, proposalId: z.string().min(1) })
    .strict(),
  /** SPEC-005: stage a proposal and run an authoring agent inside it. */
  z
    .object({
      kind: z.literal("draft-with-studio"),
      worldId: UlidSchema,
      /** World-relative target path the draft revises, e.g. "characters/maren-kest.md". */
      path: z.string().min(1),
      instruction: z.string().min(1).max(4000),
      summary: z.string().min(1).max(300),
      /**
       * Continue the conversation on an existing proposal instead of staging a new one — the
       * proposal's session persists between turns, so the agent keeps its context.
       */
      proposalId: z.string().min(1).optional(),
    })
    .strict(),
  /** SPEC-005 R-13: cancellation is immediate and leaves the proposal intact. */
  z
    .object({ kind: z.literal("authoring-cancel"), worldId: UlidSchema, proposalId: z.string().min(1) })
    .strict(),
  /** Local-runtime setup: leave one out, try one again, or stop the lot. */
  z.object({ kind: z.literal("setup-skip"), componentId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("setup-retry"), componentId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("setup-cancel") }).strict(),
  /** Genesis conversation: shape a world that does not exist yet, in a sandbox session. */
  z
    .object({
      kind: z.literal("genesis-chat"),
      genesisId: GenesisIdSchema,
      text: z.string().min(1).max(4000),
    })
    .strict(),
  /** The genesis conversation is over (begun or abandoned) — the sandbox is removed. */
  z.object({ kind: z.literal("genesis-discard"), genesisId: GenesisIdSchema }).strict(),
  /** SPEC-005 R-16: a human's decision on a harness backstop prompt. */
  z
    .object({
      kind: z.literal("permission-reply"),
      permissionId: z.string().min(1),
      decision: z.enum(["once", "always", "reject"]),
    })
    .strict(),
  /** SPEC-006: ask canon. The answer (or refusal) arrives as a canon.answer event. */
  z
    .object({
      kind: z.literal("canon-ask"),
      worldId: UlidSchema,
      askId: z.string().min(1).max(64),
      question: z.string().min(1).max(2000),
    })
    .strict(),
  /** SPEC-006 R-18: list search over the same retrieval path Q&A uses. */
  z
    .object({
      kind: z.literal("canon-search"),
      worldId: UlidSchema,
      searchId: z.string().min(1).max(64),
      query: z.string().min(1).max(500),
    })
    .strict(),
  /** SPEC-006 §2.5: an entry's computed detail — cited-by and speculative ripples. */
  z.object({ kind: z.literal("canon-refs"), worldId: UlidSchema, entryId: z.string().min(1) }).strict(),
  /** SPEC-006: stage a new entry (settled on accept) through the gate. */
  z
    .object({
      kind: z.literal("stage-canon-entry"),
      worldId: UlidSchema,
      entryType: z.enum(["rule", "lore", "location", "faction", "timeline", "tone"]),
      title: z.string().min(1).max(200),
      statement: z.string().min(1).max(5000),
    })
    .strict(),
  /** SPEC-006: stage an amendment to an existing entry. */
  z
    .object({
      kind: z.literal("stage-canon-amendment"),
      worldId: UlidSchema,
      entryId: z.string().min(1),
      statement: z.string().min(1).max(5000),
    })
    .strict(),
  /** SPEC-006 R-13/R-14: open a question as a thread — id allocated now, citable immediately. */
  z
    .object({
      kind: z.literal("open-thread"),
      worldId: UlidSchema,
      title: z.string().min(1).max(200),
      question: z.string().min(1).max(5000),
      candidates: z.array(z.string()).max(10).default([]),
    })
    .strict(),
  /** SPEC-006 R-15: stage the settlement of an open thread. */
  z
    .object({
      kind: z.literal("settle-thread"),
      worldId: UlidSchema,
      entryId: z.string().min(1),
      resolvedType: z.enum(["rule", "lore", "location", "faction", "timeline", "tone"]),
      statement: z.string().min(1).max(5000),
    })
    .strict(),
  /** SPEC-006 R-19: retire an entity — stays resolvable, drops out of retrieval. */
  z.object({ kind: z.literal("retire-entity"), worldId: UlidSchema, path: z.string().min(1) }).strict(),
  /** SPEC-007 R-10: create a sheet from a sentence — lands as a sketch through the gate. */
  z
    .object({
      kind: z.literal("create-sheet-from-sentence"),
      worldId: UlidSchema,
      sheetType: z.enum(["character", "location", "faction"]),
      name: z.string().min(1).max(200),
      sentence: z.string().min(1).max(2000),
      /**
       * Settle it as soon as it is drafted, without asking. Used when beginning a world: the
       * author already said yes to this cast by pressing Begin, and a sheet is a sketch that
       * can be changed by typing in it. Asking six times in a row for permission to write down
       * what they just described is a toll, not a gate.
       *
       * Everywhere else the gate stands. Joining the cast later is a deliberate act, and the
       * review is the point of it.
       */
      settle: z.boolean().optional(),
    })
    .strict(),
  /** SPEC-007 R-12: duplicate a sheet — sketch, origin recorded at the source's version. */
  z
    .object({
      kind: z.literal("duplicate-sheet"),
      worldId: UlidSchema,
      path: z.string().min(1),
      newName: z.string().min(1).max(200),
    })
    .strict(),
  /** SPEC-007 R-6/R-8: lock or unlock through the gate, with the ripple. */
  z
    .object({
      kind: z.literal("set-sheet-status"),
      worldId: UlidSchema,
      path: z.string().min(1),
      status: z.enum(["sketch", "locked"]),
    })
    .strict(),
  /** SPEC-007 R-2/R-3: rename edits frontmatter only — the id and file never move. */
  z
    .object({
      kind: z.literal("rename-sheet"),
      worldId: UlidSchema,
      path: z.string().min(1),
      name: z.string().min(1).max(200),
    })
    .strict(),
  /** SPEC-007 R-15: voice assignment is a gated sheet change. */
  z
    .object({
      kind: z.literal("assign-voice"),
      worldId: UlidSchema,
      path: z.string().min(1),
      voice: z
        .object({
          provider: z.string().min(1),
          voiceId: z.string().min(1),
          label: z.string().optional(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  /** SPEC-007 R-16: a sheet's computed detail — refs and incoming links from the index. */
  z.object({ kind: z.literal("sheet-refs"), worldId: UlidSchema, sheetId: z.string().min(1) }).strict(),
  /**
   * SPEC-008 R-5: store a credential. Write-only — no message or event ever carries one back,
   * and the plaintext exists in the main process for the write alone (R-8).
   */
  z
    .object({ kind: z.literal("set-credential"), provider: ProviderIdSchema, key: z.string().min(1).max(4096) })
    .strict(),
  z.object({ kind: z.literal("clear-credential"), provider: ProviderIdSchema }).strict(),
  /** SPEC-008 R-3: probe per capability; the answer is what the key unlocks, not that it authenticates. */
  z.object({ kind: z.literal("validate-provider"), provider: ProviderIdSchema }).strict(),
  /** SPEC-008 R-20: a routing default is a concrete model, displayed as its provider (D1). */
  z
    .object({ kind: z.literal("set-routing-default"), capability: CapabilitySchema, modelId: z.string().min(1) })
    .strict(),
  /**
   * Configure one agent: which model runs it, and what it is for. Clearing a field returns
   * that half to the shipped default. The confinement rules are not addressable here.
   */
  z
    .object({
      kind: z.literal("set-agent-config"),
      agent: z.string().min(1).max(64),
      /** null clears the override and returns the agent to the harness's own model. */
      model: z.string().min(1).nullable().optional(),
      /** null clears the override and returns the agent to its shipped brief. */
      brief: z.string().min(1).max(8000).nullable().optional(),
    })
    .strict(),
  /** Ask the harness what it can run — providers, their models, and its own defaults. */
  z.object({ kind: z.literal("list-harness-models") }).strict(),
  /** SPEC-008 R-19: the rolling spend threshold — alerts, never blocks (D10). */
  z
    .object({
      kind: z.literal("set-spend-threshold"),
      thresholdMicroUsd: z.number().int().min(0),
      periodDays: z.number().int().min(1).max(365),
    })
    .strict(),
  /** SPEC-008 R-22: re-run local runtime detection on demand. */
  z.object({ kind: z.literal("detect-runtimes") }).strict(),
  /** SPEC-009 R-14: cancel a job in any non-terminal state; remote cancel attempted where supported. */
  z.object({ kind: z.literal("cancel-job"), jobId: z.string().min(1) }).strict(),
  /**
   * SPEC-009 R-4/D4: resolve a job held as needs-reconciliation. "resubmit" accepts the stated
   * duplicate risk; "discard" abandons the attempt (its ledger entry still lands, R-15).
   */
  z
    .object({
      kind: z.literal("resolve-held-job"),
      jobId: z.string().min(1),
      decision: z.enum(["resubmit", "discard"]),
    })
    .strict(),
  /** SPEC-009 D7: resume a paused provider queue — the message IS the explicit confirmation. */
  z.object({ kind: z.literal("queue-resume"), provider: z.string().min(1) }).strict(),
  /** SPEC-010 R-5: generate first-look candidates from the sheet text and the world's style. */
  z
    .object({
      kind: z.literal("establish-look"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      count: z.number().int().min(1).max(8),
    })
    .strict(),
  /** SPEC-010 D2: the chosen candidate becomes the anchor — the most consequential accept. */
  z
    .object({ kind: z.literal("choose-anchor"), worldId: UlidSchema, sheetId: SlugSchema, file: z.string().min(1) })
    .strict(),
  /** Ask the trusted host picker for an image; it lands as a candidate, never straight as identity. */
  z.object({ kind: z.literal("import-main-photo-candidate"), worldId: UlidSchema, sheetId: SlugSchema }).strict(),
  z
    .object({
      kind: z.literal("generate-main-photo"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      prompt: z.string().trim().min(1).max(2000),
      count: z.number().int().min(1).max(4),
      identityReferences: z.array(z.string().min(1)).max(4),
    })
    .strict(),
  /** SPEC-017: one composite generation, conditioned on the accepted main photo. */
  z
    .object({
      kind: z.literal("generate-character-sheet"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      styleOverride: z.string().trim().min(1).max(4000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("accept-character-sheet"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      file: z.string().min(1),
    })
    .strict(),
  /** Optional looks stay outside identity until promotion or scoped attachment. */
  z
    .object({
      kind: z.literal("generate-character-looks"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      lookKind: z.enum(["costume", "pose-expression", "condition-age"]),
      mode: z.enum(["stay-close", "push-it"]),
      prompt: z.string().trim().min(1).max(2000),
      count: z.number().int().min(1).max(4),
    })
    .strict(),
  z
    .object({
      kind: z.literal("accept-character-look"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      file: z.string().min(1),
      lookKind: z.enum(["costume", "pose-expression", "condition-age"]),
      prompt: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("promote-character-look"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      lookId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("attach-character-look"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      lookId: z.string().min(1),
      scope: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("production"), productionId: SlugSchema }).strict(),
          z.object({ kind: z.literal("scene"), productionId: SlugSchema, sceneId: z.string().min(1) }).strict(),
        ])
        .nullable(),
    })
    .strict(),
  /** SPEC-010 R-3: admit a generated tile to the reference set. */
  z
    .object({
      kind: z.literal("lock-tile"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      angle: ReferenceAngleSchema,
      name: z.string().optional(),
    })
    .strict(),
  /** SPEC-010 R-18: batch-generate missing tiles for a group; body is head-gated (R-7). */
  z
    .object({
      kind: z.literal("generate-missing-tiles"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      group: z.enum(["head", "body"]),
    })
    .strict(),
  /** SPEC-010 R-4: regenerate one tile; acceptance supersedes, never overwrites. */
  z
    .object({
      kind: z.literal("regenerate-tile"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      angle: ReferenceAngleSchema,
    })
    .strict(),
  /** SPEC-010 R-10: compile the classic grid — local, free, deterministic. */
  z.object({ kind: z.literal("compile-grid"), worldId: UlidSchema, sheetId: SlugSchema }).strict(),
  /** SPEC-010 R-13: pin the compilation that rides along with dispatches. */
  z
    .object({
      kind: z.literal("designate-compilation"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      file: z.string().min(1),
    })
    .strict(),
  /** SPEC-010 R-16: per-sheet rendering-style override; canon stays untouched. */
  z
    .object({
      kind: z.literal("set-style-override"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      style: z.string().max(500).nullable(),
    })
    .strict(),
  /** SPEC-011 R-7: rank the voice catalogue against the sheet's written voice. */
  z.object({ kind: z.literal("voice-candidates"), worldId: UlidSchema, sheetId: SlugSchema }).strict(),
  /**
   * SPEC-011 R-9/R-10: audition one candidate with the character's line. Cloud previews cost;
   * the client shows the stated figure before this message is sent.
   */
  z
    .object({
      kind: z.literal("voice-preview"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      provider: z.string().min(1),
      voiceId: z.string().min(1),
    })
    .strict(),
  /** SPEC-011 R-17: local push-to-talk transcription. Audio goes to loopback, nowhere else. */
  z
    .object({
      kind: z.literal("transcribe-dictation"),
      requestId: z.string().min(1),
      audioBase64: z.string().min(1).max(8_000_000),
      contentType: z.string().min(1),
    })
    .strict(),
  /** SPEC-012 R-1/R-2: a production is a lens over the world — nothing is copied. */
  z
    .object({
      kind: z.literal("create-production"),
      worldId: UlidSchema,
      title: z.string().min(1).max(200),
      format: z.enum(["story", "video", "stills"]),
      logline: z.string().max(500).optional(),
    })
    .strict(),
  /** SPEC-012 R-7: draft a scene in conversation; accepting creates shots, dispatches nothing. */
  z
    .object({
      kind: z.literal("draft-scene"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      brief: z.string().min(1).max(2000),
    })
    .strict(),
  /** SPEC-012 R-10: shot edits, reordering and insertion go through the gate and version. */
  z
    .object({
      kind: z.literal("stage-scene-edit"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      sceneFile: z.string().min(1),
      summary: z.string().min(1).max(300),
      scene: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create-chapter"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      title: z.string().min(1).max(200),
      order: z.number().int().min(1),
    })
    .strict(),
  /** SPEC-012 R-5: direct authoring saves in place — no proposal, no version cut. */
  z
    .object({
      kind: z.literal("save-chapter"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      chapterFile: z.string().min(1),
      body: z.string(),
    })
    .strict(),
  /** SPEC-012 R-5: agent drafts arrive as proposals and cut a version on acceptance. */
  z
    .object({
      kind: z.literal("draft-chapter"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      chapterFile: z.string().min(1),
      instruction: z.string().min(1).max(2000),
    })
    .strict(),
  /** SPEC-012 R-4: reorder via frontmatter — no file renamed, no history path moved. */
  z
    .object({
      kind: z.literal("reorder-chapters"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      orderedFiles: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  /** SPEC-012 R-15/R-16: an edited prompt is an override on the shot; null resets. */
  z
    .object({
      kind: z.literal("set-prompt-override"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      sceneFile: z.string().min(1),
      shotId: ShotIdSchema,
      text: z.string().max(4000).nullable(),
    })
    .strict(),
  /** SPEC-012 R-11/R-12: compile the board — local, free, scene-version stamped. */
  z
    .object({ kind: z.literal("compile-scene-board"), worldId: UlidSchema, productionId: SlugSchema, sceneFile: z.string().min(1) })
    .strict(),
  /** SPEC-012 R-13: export files exactly one artifact; recompiling files none. */
  z
    .object({ kind: z.literal("export-scene-board"), worldId: UlidSchema, productionId: SlugSchema, sceneFile: z.string().min(1) })
    .strict(),
  /** SPEC-012 R-17..R-20: dispatch what the dialog planned — per shot or whole scene. */
  z
    .object({
      kind: z.literal("dispatch-scene"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      sceneFile: z.string().min(1),
      mode: z.enum(["per-shot", "whole-scene"]),
      modelId: z.string().min(1),
      resolution: z.string().optional(),
    })
    .strict(),
  /** SPEC-012 R-22: accept/reject from the contact sheet; the full loop is SPEC-013's. */
  z
    .object({
      kind: z.literal("record-review"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      takeId: z.string().min(1),
      shotId: ShotIdSchema.optional(),
      decision: z.enum(["accept", "reject"]),
      citation: z
        .object({ sheet: SlugSchema, field: z.string().optional(), note: z.string().optional() })
        .strict()
        .optional(),
    })
    .strict(),
  /** SPEC-013 R-9: accept = decision + selection in one commit; continuity chains (R-12). */
  z
    .object({
      kind: z.literal("accept-take"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      takeId: z.string().min(1),
      shotId: ShotIdSchema,
    })
    .strict(),
  /** SPEC-013 R-10: rejection requires the cited sheet and field; selection untouched. */
  z
    .object({
      kind: z.literal("reject-take"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      takeId: z.string().min(1),
      shotId: ShotIdSchema.optional(),
      citation: z.object({ sheet: SlugSchema, field: z.string().min(1), note: z.string().optional() }).strict(),
    })
    .strict(),
  /** SPEC-013 R-16/R-17: cut.json holds audio tracks and placement only. */
  z
    .object({
      kind: z.literal("save-audio-tracks"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      cut: z.unknown(),
    })
    .strict(),
  /** SPEC-013 R-19..R-21: local render of the derived cut; gaps become labelled slates. */
  z
    .object({
      kind: z.literal("export-cut"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      preset: z.enum(["review-cut", "master", "social-excerpt"]),
    })
    .strict(),
  z.object({ kind: z.literal("cancel-export"), worldId: UlidSchema, exportId: z.string().min(1) }).strict(),
  /** SPEC-013 R-22: a folder that reopens identically elsewhere — history kept, caches dropped. */
  z.object({ kind: z.literal("export-world"), worldId: UlidSchema }).strict(),
  /** SPEC-015 R-1/R-6: file one artifact; large files come back needing stated-size consent. */
  z
    .object({
      kind: z.literal("file-artifact"),
      worldId: UlidSchema,
      sourcePath: z.string().min(1),
      links: z.array(z.string()).optional(),
      allowLarge: z.boolean().optional(),
      /** Files a replacement recording what it supersedes (R-5). */
      supersedes: z.string().optional(),
    })
    .strict(),
  /**
   * Attach from a chat: the host opens the picker and files what comes back. No path crosses
   * into the renderer in either direction — it asks, and learns only that artifacts now exist.
   */
  z
    .object({ kind: z.literal("attach-files"), worldId: UlidSchema, links: z.array(z.string()).optional() })
    .strict(),
  /**
   * The same two gestures before a world exists. A genesis conversation has no world to file
   * into, so what is attached waits in the sandbox — which is also the agent's own working
   * directory, so it can read what you handed it — and moves into the world at Begin.
   */
  z
    .object({ kind: z.literal("genesis-attach"), genesisId: GenesisIdSchema, sourcePath: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("genesis-attach-files"), genesisId: GenesisIdSchema }).strict(),
  /** SPEC-015 R-9..R-11: stage one — file everything, exclude system files, report all of it. */
  z.object({ kind: z.literal("import-folder"), worldId: UlidSchema, sourcePath: z.string().min(1) }).strict(),
  /** SPEC-015 R-12..R-14: stage two — grounded extraction into a pending batch. */
  z.object({ kind: z.literal("extract-artifact"), worldId: UlidSchema, artifactId: z.string().min(1) }).strict(),
  /** Stop reading it. The turn is interrupted and the file stays filed, unread. */
  z.object({ kind: z.literal("stop-extraction"), worldId: UlidSchema, artifactId: z.string().min(1) }).strict(),
  /** SPEC-015 R-15: per-candidate resolution; accepts commit individually, rejects leave no trace. */
  z
    .object({
      kind: z.literal("resolve-extraction"),
      worldId: UlidSchema,
      artifactId: z.string().min(1),
      candidateHash: z.string().min(1),
      decision: z.enum(["accept", "reject"]),
    })
    .strict(),
  /** SPEC-016 R-12: check for an update; nothing installs without the user. */
  z.object({ kind: z.literal("check-updates") }).strict(),
  /** SPEC-016 R-13: download the update now; it installs at exit, interrupting nothing. */
  z.object({ kind: z.literal("download-update") }).strict(),
  /** SPEC-016 R-15: a diagnostics bundle safe to paste publicly. */
  z.object({ kind: z.literal("generate-diagnostics") }).strict(),
  /** SPEC-016 R-17: open the data location in the file manager. */
  z.object({ kind: z.literal("open-data-folder") }).strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
