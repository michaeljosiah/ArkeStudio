import { z } from "zod";
import { BenchModeSchema, BenchParamsSchema, WorldFilePathSchema } from "./bench.js";
import { BIBLE_HELPER_BOUNDS, BibleHelperKindSchema } from "./bible.js";
import { ClientStateSchema } from "./client-state.js";
import { MAX_CLIP_LANE } from "./cut.js";
import { TimelineClipIdSchema, TimelineMoveDirectionSchema, TimelineSourceFingerprintSchema } from "./timeline.js";
import { DomainEventSchema } from "./events.js";
import { ArtifactIdSchema, CandidateIdSchema, ConversationIdSchema, EpisodeIdSchema, FrameRunIdSchema, GenesisIdSchema, JobIdSchema, PresetIdSchema, SceneIdSchema, SessionIdSchema, ShotIdSchema, SlugSchema, TakeIdSchema, TurnIdSchema, UlidSchema, prefixedIdSchema } from "./ids.js";
import { ShotSchema } from "./scene.js";

/**
 * The shot fields an edit may clear (SPEC-029 R-36). Identity and the required text are absent
 * deliberately: a shot with no id, number, title or description is not a shot, and clearing one
 * would be a deletion wearing an edit's name.
 */
export const CLEARABLE_SHOT_FIELDS = [
  "camera",
  "audio",
  "durationSec",
  "intent",
  "beats",
  "framing",
  "continuity",
  "covers",
  "promptOverride",
  "staging",
] as const;
import { ShotAnchorSchema } from "./scene-operations.js";
import { SizeTierSchema } from "./manifest.js";
import { CapabilitySchema, ProviderIdSchema } from "./provider.js";
import { ReferenceAngleSchema } from "./reference.js";
import { HarnessEngineSchema } from "./harness.js";
import { BackgroundNotificationPreferenceSchema, NarratorSettingsSchema, ThemePreferenceSchema } from "./settings.js";
import { MAX_IMAGE_PREVIEWS, STAGED_REFERENCE_KEY } from "./planning.js";
import { CHARACTER_ROLE_MAX, FrameRateSchema, ProductionFormatSchema, ProductionMediumSchema } from "./world.js";
import { DeliverySchema } from "./voice.js";
import { WorldChatContextSchema, WorldChatInitiativeSchema } from "./world-chat.js";

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
/** A staged-reference key, as strictly as the coordinator needs it to be — it becomes a folder. */
const StagedReferenceKeySchema = z.string().min(1).max(120).regex(STAGED_REFERENCE_KEY);

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
       * The look, asked for during genesis rather than inferred from the logline (SPEC-017,
       * design turn 38). Absent when the author chose "Decide later": the world then has no
       * recorded look and falls back to one derived from tone and genre, which is a different
       * state from having chosen, and is shown as such.
       */
      artDirection: z.string().trim().min(1).max(2000).optional(),
      /**
       * The Bible the founding conversation wrote, born as v1 with the world (master §4.5).
       *
       * Absent means no bible, which is the ordinary state of a world begun by typing a name:
       * there was no conversation, so there is nothing of the author's to keep. Editable the
       * moment the world opens, like every later version — this is a starting point, not a
       * decision, and it is the only genesis field that is never inferred.
       */
      bible: z.string().trim().min(1).max(8000).optional(),
      /**
       * Begun from a genesis conversation: whatever was attached to it waits in that sandbox
       * and is filed into the world as it opens. Without this the files would be swept with
       * the sandbox, and handing something over would have meant nothing.
       */
      genesisId: GenesisIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("read-sheet-section"),
      requestId: UlidSchema,
      worldId: UlidSchema,
      sheetId: SlugSchema,
      // The reader names a section — the prose never travels; the server reads the authoritative
      // sheet. A character's Essence and Appearance are the descriptive prose worth hearing.
      sectionHeading: z.enum(["Essence", "Appearance"]),
      confirmationToken: z.string().min(1).optional(),
    })
    .strict(),
  /**
   * The same for a section of the bible (2026-08-24).
   *
   * A separate frame rather than a widened `read-sheet-section`, because the two differ in the
   * one field that matters: a sheet's readable sections are a closed pair the app authored, and
   * a bible's headings belong to whoever wrote it. Folding them together would have meant a
   * `sheetId` that is sometimes absent and an enum that is sometimes a free string — two
   * optional fields standing in for one real distinction.
   *
   * Asked for by an author who had the whole arc in the bible and no way to hear it: the sheets
   * could be read aloud and the one long-form document in the world could not.
   */
  z
    .object({
      kind: z.literal("read-bible-section"),
      requestId: UlidSchema,
      worldId: UlidSchema,
      // Named, never sent: the prose does not travel, the server reads the bible on disk. Free
      // text because `splitBible` takes the author's own `## ` headings as it finds them.
      sectionHeading: z.string().min(1),
      confirmationToken: z.string().min(1).optional(),
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
  z
    .object({
      kind: z.literal("generate-world-image"),
      worldId: UlidSchema,
      requestId: UlidSchema,
      /** Override the routed model for this generation only. */
      modelId: z.string().min(1).optional(),
      /**
       * The words, when the author wrote them (design 64).
       *
       * Absent is the long-standing path: the harness writes the prompt from the world's brief,
       * falling back to the plain assembly. Present outranks both — an author who has opened the
       * box and edited it has said what the picture is, and an art-director rewrite on top of
       * that would be the studio's taste in front of theirs. The standing constraint suffix is
       * still appended either way; it is not the author's to drop.
       */
      prompt: z.string().min(1).optional(),
      /**
       * How many to make, 1–4 (design 65). Absent is one, so every caller written before the
       * count still asks for exactly what it used to.
       */
      count: z.number().int().min(1).max(MAX_IMAGE_PREVIEWS).optional(),
      // No size here: a world image carries no output spec at all today, so the provider's own
      // default is what runs. Offering a control that changed nothing would be worse than not
      // offering one.
    })
    .strict(),
  /**
   * Or bring your own key art. The counterpart to generating it: an author who already has the
   * image — a frame, a painting, a photograph — should not have to ask a model for one.
   */
  z.object({ kind: z.literal("upload-world-image"), worldId: UlidSchema, requestId: UlidSchema }).strict(),
  /**
   * Keep one of the candidates that came back — it becomes the world's key art.
   *
   * `file` names which, world-relative, now that a generation may land four (design 65). Absent
   * means the only one there is, which is what every caller meant while there could only be one.
   */
  z.object({ kind: z.literal("use-world-image"), worldId: UlidSchema, file: z.string().min(1).optional() }).strict(),
  /** Or do not: every candidate is deleted and the world keeps the image it had. */
  z.object({ kind: z.literal("discard-world-image"), worldId: UlidSchema }).strict(),
  /**
   * SPEC-017: the world look as a picture. The record has carried a `masterLook` since the look
   * was versioned; these are the first way to put one there.
   *
   * The prompt defaults to the look's own description, unedited — a picture of the look written
   * from different words would not be a picture of it. It can be overridden for one generation,
   * because a description is a brief for every take and this is a brief for one image; the
   * standing safety clause is added on top either way and is not the author's to drop.
   */
  z
    .object({
      kind: z.literal("generate-master-look"),
      worldId: UlidSchema,
      requestId: UlidSchema,
      /** Override the routed model for this generation only. */
      modelId: z.string().min(1).optional(),
      /** Override the look's own words for this generation only. Absent means send the look. */
      prompt: z.string().min(1).max(4000).optional(),
      /** The size, in the normalised tier vocabulary. Absent leaves it to the provider. */
      tier: SizeTierSchema.optional(),
      /**
       * The shape, as the model's own manifest spells it — "16:9". Validated against that model
       * rather than against a list here: which ratios exist is a property of the row, and a
       * shape it does not take is dropped rather than sent.
       */
      aspect: z.string().min(1).max(16).optional(),
      /**
       * How many to make, 1–4 (design 65). Absent is one. Every one of them is priced and
       * charged, which is why the dialog states the figure for the set rather than for one.
       */
      count: z.number().int().min(1).max(MAX_IMAGE_PREVIEWS).optional(),
    })
    .strict(),
  /**
   * Stage an image for a generation to look at (design 67). The host opens the picker and copies
   * what comes back into the world, so no path and no bytes cross into the renderer — it learns
   * only that a reference is now staged, from the snapshot.
   *
   * One per key, like the candidate: picking again replaces it. The key names the surface, and is
   * validated here because it becomes a directory: a fixed vocabulary plus an optional sheet slug,
   * never anything typed.
   */
  z
    .object({
      kind: z.literal("pick-staged-reference"),
      worldId: UlidSchema,
      requestId: UlidSchema,
      key: StagedReferenceKeySchema,
    })
    .strict(),
  /** Unstage it. That generation goes back to being made from words alone. */
  z
    .object({ kind: z.literal("clear-staged-reference"), worldId: UlidSchema, key: StagedReferenceKeySchema })
    .strict(),
  /**
   * Or bring your own. Opens the host's file picker: the renderer never handles the bytes, and
   * the format is decided by reading them rather than by trusting the name.
   */
  z.object({ kind: z.literal("upload-master-look"), worldId: UlidSchema, requestId: UlidSchema }).strict(),
  /**
   * Keep the candidate. Accepting is a look change, not a file copy: the image lands as the next
   * version's master look, with the same history, ripples and change record any other look
   * change produces.
   */
  z
    .object({
      kind: z.literal("use-master-look"),
      worldId: UlidSchema,
      /** Which candidate, world-relative, now that a generation may land four (design 65). */
      file: z.string().min(1).optional(),
    })
    .strict(),
  /** Or do not: every candidate is deleted and the look keeps the image it had, or none. */
  z.object({ kind: z.literal("discard-master-look"), worldId: UlidSchema }).strict(),
  z.object({ kind: z.literal("archive-world"), worldId: UlidSchema }).strict(),
  /**
   * Install the sample world (SPEC-016 R-6). No arguments: which world ships is a property of
   * the build, and offering a choice the build cannot honour would be offering a lie. Asking
   * twice is not an error — the second copy is a world of its own, slugged accordingly.
   */
  z.object({ kind: z.literal("install-sample-world") }).strict(),
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
      /**
       * Characters only. The one frontmatter field the form edits, bounded here because this is
       * the write path: an over-long role is refused before it reaches disk, where the read
       * schema would have to tolerate it (SPEC-007 R-6). Empty string clears the field.
       */
      role: z.string().trim().max(CHARACTER_ROLE_MAX).optional(),
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
  /**
   * The human's own action (the assign-voice rule): a look the user set on the art-direction
   * screen applies at once — versioned, rippled, recorded in history — but is never staged as
   * a proposal for the same person to accept. Agents keep staging.
   */
  z
    .object({
      kind: z.literal("set-art-direction"),
      worldId: UlidSchema,
      description: z.string().trim().min(1).max(4000),
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
  z
    .object({ kind: z.literal("proposal-discard"), worldId: UlidSchema, proposalId: z.string().min(1) })
    .strict(),
  z
    .object({ kind: z.literal("proposal-rebase"), worldId: UlidSchema, proposalId: z.string().min(1) })
    .strict(),
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
  /**
   * #70 §11.4.1, §12.1: change one field of a staged proposal before accepting it.
   *
   * `field` is the label the review projection showed — "Title", "Statement", "Name", a section
   * heading — because the person is editing the line they were looking at, not a file offset.
   *
   * `expectedDraftRevision` is refused when stale rather than merged. Two people, or two windows,
   * editing the same proposal must not silently combine into a version neither of them read: the
   * losing edit comes back and says so. `requestId` makes the retry after that idempotent.
   */
  z
    .object({
      kind: z.literal("proposal-update-field"),
      worldId: UlidSchema,
      requestId: z.string().min(1),
      proposalId: z.string().min(1),
      path: z.string().min(1),
      field: z.string().min(1),
      value: z.string().max(20_000),
      expectedDraftRevision: z.number().int().min(1),
    })
    .strict(),
  /**
   * #70: open one conversation's workspace, or close the open one.
   *
   * A null id closes it. The client holds one conversation at a time, so leaving a screen should
   * release the transcript rather than accumulate every conversation the session has visited.
   */
  z
    .object({
      kind: z.literal("world-chat-open"),
      worldId: UlidSchema,
      conversationId: ConversationIdSchema.nullable(),
    })
    .strict(),
  /**
   * #70 §10.1.1: say something, and take a turn.
   *
   * `expectedConversationSeq` is refused when stale rather than silently re-planned: the reply
   * must be to the conversation the person was actually looking at.
   */
  z
    .object({
      kind: z.literal("world-chat-send"),
      worldId: UlidSchema,
      requestId: z.string().min(1),
      conversationId: ConversationIdSchema,
      text: z.string().min(1).max(16_000),
      attachmentIds: z.array(z.string().min(1)).max(20).default([]),
    })
    .strict(),
  /**
   * #70 §10.1.1: turn the conversation into proposals and close it.
   *
   * One command. A stale `expectedConversationSeq` is refused rather than silently re-planned,
   * because what gets written must be what the person was last shown.
   */
  z
    .object({
      kind: z.literal("world-chat-wrap-up"),
      worldId: UlidSchema,
      requestId: z.string().min(1),
      conversationId: ConversationIdSchema,
      expectedConversationSeq: z.number().int().min(0),
    })
    .strict(),
  /**
   * Write one point into the world, from the conversation it was understood in.
   *
   * The design this replaces decided twice — once to turn a whole conversation into proposals,
   * once to approve them on another screen — and both decisions were about everything at once.
   * In practice a conversation produces a dozen points of which two are wrong, and the only way
   * to say so was to carry all twelve to a second screen and reject two there. Deciding where the
   * point is, as it arrives, is fewer steps and the same authority.
   *
   * Saving is writing: this stages the proposition and accepts it in one motion, exactly as the
   * art-direction form does for a look the person typed themselves. The conversation stays open —
   * only Accept all closes it.
   *
   * `expectedCandidateRevision` is the revision the rail was showing. A point that has been
   * corrected by talking since is refused rather than written as it was.
   */
  z
    .object({
      kind: z.literal("world-chat-save-point"),
      worldId: UlidSchema,
      requestId: z.string().min(1),
      conversationId: ConversationIdSchema,
      candidateId: z.string().min(1),
      expectedCandidateRevision: z.number().int().min(1),
      /**
       * What the rail was showing for every member of this point's atomic group.
       *
       * A group lands together, so saving one writes all of them. Without the revisions it showed
       * for each, a sibling corrected in another window would be written unseen as part of a save
       * nobody made about it.
       */
      expectedGroupRevisions: z
        .array(z.object({ candidateId: z.string().min(1), revision: z.number().int().min(1) }).strict())
        .max(40)
        .optional(),
    })
    .strict(),
  /**
   * Drop one point. It is not written, and it stops being offered.
   *
   * Distinct from correcting it by talking, which is how a point that is nearly right gets fixed.
   * This is for one that should not exist at all, and it is reversible only by saying it again.
   */
  z
    .object({
      kind: z.literal("world-chat-reject-point"),
      worldId: UlidSchema,
      requestId: z.string().min(1),
      conversationId: ConversationIdSchema,
      candidateId: z.string().min(1),
      expectedCandidateRevision: z.number().int().min(1),
      /** As for a save: rejecting a grouped point drops its siblings, so it names them too. */
      expectedGroupRevisions: z
        .array(z.object({ candidateId: z.string().min(1), revision: z.number().int().min(1) }).strict())
        .max(40)
        .optional(),
    })
    .strict(),
  /** Prepare or reopen a Bench session from a durable media candidate. Nothing is dispatched. */
  z
    .object({
      kind: z.literal("world-chat-open-media"),
      worldId: UlidSchema,
      requestId: UlidSchema,
      conversationId: ConversationIdSchema,
      candidateId: CandidateIdSchema,
      expectedCandidateRevision: z.number().int().min(1),
    })
    .strict(),
  /**
   * #70 §10.1.1: run a failed turn again.
   *
   * Names an existing failed, cancelled or interrupted turn and starts a new run against it. No
   * second user message is appended — messages are immutable and the person already said this
   * once; asking them to retype it to recover from our timeout would be the app charging them
   * for its own failure.
   */
  z
    .object({
      kind: z.literal("world-chat-retry-turn"),
      worldId: UlidSchema,
      requestId: z.string().min(1),
      conversationId: ConversationIdSchema,
      turnId: TurnIdSchema,
    })
    .strict(),
  /** #70 R-34a: return a proposal to the conversation it came from, and reopen it. */
  z
    .object({
      kind: z.literal("proposal-send-back"),
      worldId: UlidSchema,
      proposalId: z.string().min(1),
    })
    .strict(),
  /** #70: stop the turn in flight. Local and immediate. */
  z
    .object({
      kind: z.literal("world-chat-cancel"),
      worldId: UlidSchema,
      conversationId: ConversationIdSchema,
    })
    .strict(),
  /** #70: create a conversation, optionally about something in particular. */
  z
    .object({
      kind: z.literal("world-chat-create"),
      worldId: UlidSchema,
      requestId: z.string().min(1),
      title: z.string().min(1).max(200),
      entryContext: WorldChatContextSchema.optional(),
    })
    .strict(),
  /**
   * #70 R-50 §15.1: delete a conversation permanently.
   *
   * The `requestId` names the tombstone the directory is renamed to, which is what makes a
   * repeated Delete idempotent rather than a second deletion of something already gone. The
   * coordinator rechecks the preconditions itself: the row carries a reason so the button can
   * say why it is unavailable, but a row is a snapshot and a turn may have started since.
   */
  z
    .object({
      kind: z.literal("world-chat-delete"),
      worldId: UlidSchema,
      requestId: z.string().min(1),
      conversationId: ConversationIdSchema,
    })
    .strict(),
  /**
   * #70 §15.1: shelve a conversation, reversibly and losing nothing.
   *
   * The answer whenever Delete is refused, which is most of the time a conversation has done
   * anything: proposals from its wrap-up outlive it and hold deletion open until they are
   * decided. No `requestId` — appending the same lifecycle event twice folds to the same status.
   */
  z
    .object({
      kind: z.literal("world-chat-set-initiative"),
      worldId: UlidSchema,
      conversationId: ConversationIdSchema,
      initiative: WorldChatInitiativeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("world-chat-archive"),
      worldId: UlidSchema,
      conversationId: ConversationIdSchema,
    })
    .strict(),
  /** #70 §15.1: take it back off the shelf. */
  z
    .object({
      kind: z.literal("world-chat-unarchive"),
      worldId: UlidSchema,
      conversationId: ConversationIdSchema,
    })
    .strict(),
  /**
   * #70 §10.1.1, §13.1: hand a file to one conversation, privately.
   *
   * Host-mediated exactly as artifact filing is: the window holds the dropped File, the host
   * resolves where it lives, and only the path crosses on this frame — the renderer never sees
   * one (SPEC-001 R-9). What lands is conversation-private workspace, not a world artifact: a
   * document dropped in to think out loud with has not been agreed to anything.
   */
  z
    .object({
      kind: z.literal("world-chat-attach"),
      worldId: UlidSchema,
      conversationId: ConversationIdSchema,
      sourcePath: z.string().min(1),
    })
    .strict(),
  /** #70 §13.1: the same gesture through the host's picker, for people who do not drag. */
  z
    .object({
      kind: z.literal("world-chat-attach-files"),
      worldId: UlidSchema,
      conversationId: ConversationIdSchema,
    })
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
  /** Local-runtime setup: leave one out, try one again, replace one, or stop the lot. */
  z.object({ kind: z.literal("setup-skip"), componentId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("setup-retry"), componentId: z.string().min(1) }).strict(),
  /**
   * Discard what is on disk for one component and fetch it again. Retry trusts what is already
   * there — presence is completion — so it is no answer to a file that arrived intact and is
   * the wrong bytes. Repair is the answer to a digest that did not match.
   */
  z.object({ kind: z.literal("setup-repair"), componentId: z.string().min(1) }).strict(),
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
  /**
   * The review before the press (SPEC-031 R-10..R-12): fold the blueprint, check every
   * precondition, compile the plan. Answered by a `build.plan` event; nothing is created.
   */
  z
    .object({
      kind: z.literal("plan-founding-build"),
      genesisId: GenesisIdSchema,
      requestId: UlidSchema,
      /**
       * The look as the author left the words step, read the same way the press reads it.
       * The review asks R-54's carry question against the words the world would actually be
       * founded on, so a preview the author then rewrote is named as lost, not as carried.
       */
      look: z.string().trim().max(2000).optional(),
    })
    .strict(),
  /**
   * The press (SPEC-031 R-13, R-16): one aggregate authorization covering every acceptance
   * in the run. Idempotent on the request id — a second press, a replayed frame or a resumed
   * session joins the existing run rather than starting a second one. The coordinator drives
   * everything from this one frame (R-17); the renderer never sequences a build.
   */
  z
    .object({
      kind: z.literal("begin-founding-build"),
      genesisId: GenesisIdSchema,
      requestId: UlidSchema,
      /**
       * The look as the author left the words step: absent keeps the blueprint's, non-empty
       * is their rewrite, and the empty string is "Decide later" — founded with no look.
       * The record holds what was actually founded on, which is what the carried preview's
       * staleness test reads (R-54).
       */
      look: z.string().trim().max(2000).optional(),
    })
    .strict(),
  /** The author's Stop — the only halt a run has (SPEC-031 R-35). */
  z.object({ kind: z.literal("stop-founding-build"), worldId: UlidSchema }).strict(),
  /**
   * What key art would carry and drop, before anything is paid for (SPEC-031 R-59, R-60;
   * SPEC-010 R-15): the dialog names the drop before the user commits, and opens its prompt
   * box with the words the dispatch would actually compose. Answered by a world-image.plan
   * event; nothing is created.
   */
  z.object({ kind: z.literal("plan-key-art"), worldId: UlidSchema, requestId: UlidSchema }).strict(),
  /**
   * One picture of the look, from inside the founding conversation (SPEC-031 R-50, R-51).
   * The agent proposes; a person presses — the estimate is on the control, and the prompt is
   * the look's own words unrewritten (R-52). Lands in the sandbox; carries in at Begin only
   * if the look it was made from is the look the world is founded on (R-53, R-54).
   */
  z
    .object({ kind: z.literal("generate-look-preview"), genesisId: GenesisIdSchema, requestId: UlidSchema })
    .strict(),
  /**
   * Run one build item — or, with no key, everything runnable that has not landed, which is
   * how a text-only build's images run later "in one press" (SPEC-031 R-11, R-48, R-49). A
   * retry and a first run are the same operation with the same landing: settled, anchored,
   * designated — never a proposal or a candidate.
   */
  z
    .object({
      kind: z.literal("run-build-item"),
      worldId: UlidSchema,
      itemKey: z.string().min(1).max(200).optional(),
      requestId: UlidSchema,
    })
    .strict(),
  /** The completion notice is dismissed (SPEC-031 R-45). It stays dismissed across restarts. */
  z.object({ kind: z.literal("dismiss-build-notice"), worldId: UlidSchema }).strict(),
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
      /**
       * SPEC-020 R-1: file this as a guest of that production rather than into the world's cast.
       * The sheet is a full sheet either way; this decides only where it is shown.
       */
      production: SlugSchema.optional(),
    })
    .strict(),
  /**
   * SPEC-020 R-14: promote a guest into the world. Clears `production` and nothing else — no
   * file moves, no slug changes, no version resets, so every citation survives it.
   */
  z.object({ kind: z.literal("promote-guest"), worldId: UlidSchema, path: z.string().min(1) }).strict(),
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
      /**
       * Rename the world — its label, never its folder. The directory is the address every
       * path, artifact and lock resolves through, so a rename changes the word on the screen
       * and nothing else.
       */
      kind: z.literal("rename-world"),
      worldId: UlidSchema,
      name: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rename-sheet"),
      worldId: UlidSchema,
      path: z.string().min(1),
      name: z.string().min(1).max(200),
    })
    .strict(),
  /** The human's own action: assigning (or clearing) a voice commits straight to the sheet —
   *  it still versions and ripples, but does not stage a proposal for the same person to accept. */
  z
    .object({
      kind: z.literal("assign-voice"),
      /** Correlates the terminal assignment result; a refusal must not leave Assign spinning. */
      requestId: UlidSchema,
      worldId: UlidSchema,
      path: z.string().min(1),
      voice: z
        .object({
          provider: z.string().min(1),
          /** Optional only for an older renderer; the coordinator migrates before writing. */
          model: z.string().min(1).optional(),
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
    .object({
      kind: z.literal("set-credential"),
      provider: ProviderIdSchema,
      key: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ kind: z.literal("clear-credential"), provider: ProviderIdSchema }).strict(),
  /** SPEC-008 R-3: probe per capability; the answer is what the key unlocks, not that it authenticates. */
  z.object({ kind: z.literal("validate-provider"), provider: ProviderIdSchema }).strict(),
  /**
   * Providers whose credential lives in a tool we drive (issue #137). Signing in opens a
   * browser and can take minutes, so it is three messages rather than one: start it, stop
   * waiting on it, and re-ask where things stand.
   */
  z.object({ kind: z.literal("sign-in-provider-tool"), provider: ProviderIdSchema }).strict(),
  z.object({ kind: z.literal("cancel-provider-tool-sign-in"), provider: ProviderIdSchema }).strict(),
  z.object({ kind: z.literal("refresh-provider-tool"), provider: ProviderIdSchema }).strict(),
  /** Which account the provider bills. null hands billing back to the personal context. */
  z
    .object({
      kind: z.literal("select-provider-workspace"),
      provider: ProviderIdSchema,
      workspaceId: z.string().min(1).nullable(),
    })
    .strict(),
  /**
   * Vendor sign-in through the harness (SPEC-030). Same split as the provider tools above and
   * for the same reason: a sign-in opens a browser and can take minutes, so starting, giving
   * up, and re-asking are separate messages. Vendor and method ids are the harness's own
   * strings (R-7), so no closed enum can carry them.
   */
  z.object({ kind: z.literal("refresh-vendor-auth") }).strict(),
  z
    .object({
      kind: z.literal("begin-vendor-sign-in"),
      vendor: z.string().min(1).max(128),
      /** The oauth method's id. Key methods go through submit-vendor-key instead. */
      method: z.string().min(1).max(128),
      /** Answers to the method's form fields, when it has any — keyed by field key. */
      answers: z.record(z.string().max(2048)).optional(),
    })
    .strict(),
  /**
   * The one-time code a `code`-mode attempt handed the person to bring back. Write-only and
   * passed straight through to the harness; nothing retains or echoes it (R-1).
   */
  z
    .object({
      kind: z.literal("submit-vendor-sign-in-code"),
      vendor: z.string().min(1).max(128),
      code: z.string().min(1).max(512),
    })
    .strict(),
  /**
   * The typed-secret method (§2.2): the key goes to the harness in one call and is not
   * retained. Write-only — no message or event ever carries it back.
   */
  z
    .object({
      kind: z.literal("submit-vendor-key"),
      vendor: z.string().min(1).max(128),
      key: z.string().min(1).max(4096),
      answers: z.record(z.string().max(2048)).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("cancel-vendor-sign-in") }).strict(),
  /** Remove a stored connection — performed by the harness, never a file deletion (R-9a). */
  z
    .object({
      kind: z.literal("remove-vendor-connection"),
      vendor: z.string().min(1).max(128),
      credential: z.string().min(1).max(256),
    })
    .strict(),
  /** SPEC-008 R-20: a routing default is a concrete model, displayed as its provider (D1). */
  z
    .object({
      kind: z.literal("set-routing-default"),
      capability: CapabilitySchema,
      modelId: z.string().min(1),
    })
    .strict(),
  /**
   * Offer a model, or stop offering it. A model switched off appears in no picker and cannot be
   * chosen as a routing default; one that is already routed becomes a named fault rather than
   * being silently re-routed to something else.
   */
  z
    .object({
      kind: z.literal("set-model-enabled"),
      modelId: z.string().min(1),
      enabled: z.boolean(),
    })
    .strict(),
  /** Whether the Studio may read a page online when a conversation asks it to (SPEC-005 R-10). */
  z
    .object({
      kind: z.literal("set-research-web"),
      enabled: z.boolean(),
    })
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
  /**
   * Look for the harnesses this machine has. Discovery only — finding a binary and reading its
   * version — and deliberately NOT the confinement probe, which spends a real turn against the
   * user's subscription. Opening a settings screen must not cost anybody a request.
   */
  z.object({ kind: z.literal("detect-harnesses") }).strict(),
  /**
   * Choose the engine. The coordinator refuses a harness it has not found, so this is a request
   * rather than an instruction — the screen disabling the control is a courtesy, not the rule.
   */
  z.object({ kind: z.literal("set-harness-engine"), engine: HarnessEngineSchema }).strict(),
  /** Point Arke at a Claude Code the PATH does not carry. The host owns the file dialog. */
  z.object({ kind: z.literal("choose-claude-executable") }).strict(),
  z.object({ kind: z.literal("clear-claude-executable") }).strict(),
  /** Voxa configuration stays host-owned: none of these messages contains a filesystem path. */
  z.object({ kind: z.literal("choose-voxa-executable") }).strict(),
  z.object({ kind: z.literal("clear-voxa-executable") }).strict(),
  z.object({ kind: z.literal("use-bundled-voxa") }).strict(),
  z.object({ kind: z.literal("restart-voxa") }).strict(),
  /**
   * The ComfyUI engine (SPEC-021 §2.2). Filesystem paths never originate in the renderer:
   * choosing a path or models folder goes through the host's own picker, and adopting a
   * detected install names a location the host itself discovered and just published — the
   * coordinator refuses one it did not.
   */
  z.object({ kind: z.literal("choose-comfyui-path") }).strict(),
  z.object({ kind: z.literal("choose-comfyui-models-dir") }).strict(),
  z.object({ kind: z.literal("clear-comfyui-models-dir") }).strict(),
  z.object({ kind: z.literal("set-comfyui-url"), url: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("clear-comfyui-engine") }).strict(),
  z.object({ kind: z.literal("use-detected-comfyui"), location: z.string().min(1) }).strict(),
  /** Re-read node classes and dependency identity on demand — the Settings refresh. */
  z.object({ kind: z.literal("comfyui-refresh") }).strict(),
  /**
   * SPEC-033 R-70: restart the engine. Distinct from refresh, which re-measures the engine that
   * is running — this stops the supervised child and resolves the selection again, which is the
   * only thing that helps an engine that came up wrong.
   */
  z.object({ kind: z.literal("comfyui-restart") }).strict(),
  /**
   * SPEC-028 R-5's one-action activation, over the whole declared closure (SPEC-033 R-40).
   * Distinct from `setup-retry`, which starts one component and leaves a dependant blocked on a
   * runtime nobody asked for.
   */
  z.object({ kind: z.literal("setup-install"), componentId: z.string().min(1) }).strict(),
  /** SPEC-033 R-43: give the disk back, and say what went and what would not. */
  z.object({ kind: z.literal("setup-remove"), componentId: z.string().min(1) }).strict(),
  /** Re-read node classes and re-hash one recipe's pins (§2.5): the "Re-verify" affordance. */
  z.object({ kind: z.literal("comfyui-verify-recipe"), recipeId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("repair-voice-models") }).strict(),
  z.object({ kind: z.literal("open-model-folder") }).strict(),
  z.object({ kind: z.literal("test-local-voice"), requestId: UlidSchema }).strict(),
  z
    .object({
      kind: z.literal("set-background-notifications"),
      preference: BackgroundNotificationPreferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set-appearance-theme"),
      preference: ThemePreferenceSchema,
    })
    .strict(),
  /**
   * Choose who reads the app's prose aloud (asked for 2026-08-17). Null returns to the shipped
   * local voice, which costs nothing — the point of having a default at all.
   */
  z
    .object({
      kind: z.literal("set-narrator"),
      voice: NarratorSettingsSchema,
    })
    .strict(),
  /** SPEC-009 R-14: cancel a job in any non-terminal state; remote cancel attempted where supported. */
  z.object({ kind: z.literal("cancel-job"), jobId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("list-provider-calls"), jobId: JobIdSchema.nullable() }).strict(),
  z.object({ kind: z.literal("retry-job-finalization"), jobId: z.string().min(1) }).strict(),
  /**
   * Drop a finished job from Activity's history (SPEC-014 R-13). Ignored for anything the state
   * cannot perform it on — non-terminal work is cancelled, not deleted. The ledger entry and any
   * landed files stay: this removes a row, not what it produced or what it cost.
   */
  z.object({ kind: z.literal("delete-job"), jobId: z.string().min(1) }).strict(),
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
      requestId: UlidSchema,
      worldId: UlidSchema,
      sheetId: SlugSchema,
      count: z.number().int().min(1).max(8),
    })
    .strict(),
  /** SPEC-010 D2: the chosen candidate becomes the anchor — the most consequential accept. */
  z
    .object({
      kind: z.literal("choose-anchor"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      selection: z.discriminatedUnion("source", [
        z.object({ source: z.literal("take"), takeId: TakeIdSchema }).strict(),
        z
          .object({
            source: z.literal("candidate"),
            file: z.string().regex(/^[^/\\]+\.(?:png|jpe?g|webp)$/i, "expected an image filename"),
          })
          .strict(),
      ]),
    })
    .strict(),
  /**
   * Location views (#243, design turn 57). Deliberately their own commands rather than the
   * character ones with a different sheet id: a location is generated from its Look, anchored to
   * an establishing view rather than a face, and named — none of which the main-photo commands
   * carry, and pretending otherwise would make one screen's copy wrong on the other.
   */
  z
    .object({
      kind: z.literal("generate-location-view"),
      modelId: z.string().min(1).optional(),
      tier: SizeTierSchema.optional(),
      requestId: UlidSchema,
      worldId: UlidSchema,
      sheetId: SlugSchema,
      /** What this angle is called; becomes the view's name when it is accepted. */
      name: z.string().trim().min(1).max(80),
      /** Optional extra direction for this angle. */
      prompt: z.string().trim().max(2000).optional(),
      count: z.number().int().min(1).max(MAX_IMAGE_PREVIEWS),
      /** Replace the establishing view rather than adding an angle beside it. */
      establishing: z.boolean().optional(),
    })
    .strict(),
  /**
   * The host picker, landing a candidate view — never accepted in the same motion, and so
   * carrying no name: naming *is* the acceptance, and asking for one here would put the
   * duplicate-name confirmation behind a file dialog that has already closed.
   */
  z
    .object({
      kind: z.literal("import-location-view-candidate"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
    })
    .strict(),
  /**
   * Accept a candidate as an active view and rebuild the sheet.
   *
   * `replaceExistingName` is the confirmation the design turn requires: without it a colliding
   * name refuses, because superseding an angle somebody may still want is a loss they would
   * only notice later, in a shot.
   *
   * The selection is the same union `choose-anchor` carries, for the same reason (issue 274): a
   * generated view lands in `candidates/` and only becomes a take when its job finalizes, so a
   * finalization that never ran leaves a picture somebody paid for with no take to name it by.
   * Accepting one by filename records the take from its job first, then accepts that.
   */
  z
    .object({
      kind: z.literal("accept-location-view"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      selection: z.discriminatedUnion("source", [
        z.object({ source: z.literal("take"), takeId: TakeIdSchema }).strict(),
        z
          .object({
            source: z.literal("candidate"),
            file: z.string().regex(/^[^/\\]+\.(?:png|jpe?g|webp)$/i, "expected an image filename"),
          })
          .strict(),
      ]),
      name: z.string().trim().min(1).max(80),
      establishing: z.boolean().optional(),
      replaceExistingName: z.boolean().optional(),
    })
    .strict(),
  /** Ask the trusted host picker for an image; it lands as a candidate, never straight as identity. */
  z
    .object({ kind: z.literal("import-main-photo-candidate"), worldId: UlidSchema, sheetId: SlugSchema })
    .strict(),
  /**
   * The whole main photo, brought in by hand (PR #241).
   *
   * Distinct from `import-main-photo-candidate`, which adds one option to a set the user then
   * chooses from. Here the choosing already happened — in the host's own file dialog, on a file
   * the user pointed at — so the picked image becomes the identity anchor in the same motion.
   * The dialog IS the confirmation; a second "are you sure" would be asking twice.
   */
  z.object({ kind: z.literal("import-main-photo"), worldId: UlidSchema, sheetId: SlugSchema }).strict(),
  /** The same hand-carried route for the composite: no provider, no cost, no review step. */
  z.object({ kind: z.literal("import-character-sheet"), worldId: UlidSchema, sheetId: SlugSchema }).strict(),
  z
    .object({
      kind: z.literal("generate-main-photo"),
      /** Override the routed model for this generation only. */
      modelId: z.string().min(1).optional(),
      /** Output size, as the normalised tier the user picked. */
      tier: SizeTierSchema.optional(),
      requestId: UlidSchema,
      worldId: UlidSchema,
      sheetId: SlugSchema,
      prompt: z.string().trim().min(1).max(2000),
      count: z.number().int().min(1).max(MAX_IMAGE_PREVIEWS),
      identityReferences: z.array(z.string().min(1)).max(4),
    })
    .strict(),
  /** SPEC-017: one composite generation, conditioned on the accepted main photo. */
  z
    .object({
      kind: z.literal("generate-character-sheet"),
      /** Override the routed model for this generation only. */
      modelId: z.string().min(1).optional(),
      /** Output size, as the normalised tier the user picked. */
      tier: SizeTierSchema.optional(),
      requestId: UlidSchema,
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
      takeId: TakeIdSchema,
    })
    .strict(),
  /** Optional looks stay outside identity until promotion or scoped attachment. */
  z
    .object({
      kind: z.literal("generate-character-looks"),
      /** Override the routed model for this generation only. */
      modelId: z.string().min(1).optional(),
      /** Output size, as the normalised tier the user picked. */
      tier: SizeTierSchema.optional(),
      requestId: UlidSchema,
      worldId: UlidSchema,
      sheetId: SlugSchema,
      lookKind: z.enum(["costume", "pose-expression", "condition-age"]),
      mode: z.enum(["stay-close", "push-it"]),
      prompt: z.string().trim().min(1).max(2000),
      count: z.number().int().min(1).max(MAX_IMAGE_PREVIEWS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("accept-character-look"),
      worldId: UlidSchema,
      sheetId: SlugSchema,
      takeId: TakeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reject-reference-take"),
      worldId: UlidSchema,
      takeId: z.string().min(1),
      field: z.string().min(1).max(200),
      note: z.string().max(1000).optional(),
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
          z
            .object({ kind: z.literal("scene"), productionId: SlugSchema, sceneId: z.string().min(1) })
            .strict(),
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
      requestId: UlidSchema,
      worldId: UlidSchema,
      sheetId: SlugSchema,
      group: z.enum(["head", "body"]),
    })
    .strict(),
  /** SPEC-010 R-4: regenerate one tile; acceptance supersedes, never overwrites. */
  z
    .object({
      kind: z.literal("regenerate-tile"),
      requestId: UlidSchema,
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
   * The plain catalogue, for the bench (design 70). Deliberately NOT `voice-candidates`: that
   * one ranks the catalogue against a character's written voice, which is the wrong question
   * for a voice that is only reading. No sheet id, and nothing ranked.
   */
  /**
   * `worldId` is optional because the catalogue is the app's — local presets plus whatever the
   * stored keys unlock. A world only adds `usedBy`, so Settings can ask for it with no world
   * open. It could not, at first: an empty id failed frame validation and the request was
   * dropped, leaving the picker reading a catalogue that never arrived.
   */
  z.object({ kind: z.literal("voice-catalogue"), worldId: UlidSchema.optional() }).strict(),
  /**
   * Speak a shot's line in its character's own voice (SPEC-011 R-14). The voice is not a
   * parameter: it is the speaker's, read from their sheet at dispatch, so a retake keeps it by
   * construction and only the delivery can change.
   */
  z
    .object({
      kind: z.literal("voice-line"),
      requestId: UlidSchema,
      worldId: UlidSchema,
      productionId: SlugSchema,
      shotId: z.string().min(1),
      /** Opaque engine instance explicitly approved as a remote biometric-upload destination. */
      voiceUploadConfirmedFor: z.string().min(1).optional(),
      /** One of DELIVERIES; absent leaves the read at the provider's own default. */
      delivery: DeliverySchema.optional(),
    })
    .strict(),
  /**
   * SPEC-011 R-9/R-10: audition one candidate with the character's line. Cloud previews cost;
   * the client shows the stated figure before this message is sent.
   */
  z
    .object({
      kind: z.literal("voice-preview"),
      requestId: UlidSchema,
      worldId: UlidSchema,
      sheetId: SlugSchema,
      /**
       * A provider id, not the two voice providers that existed when this was written (SPEC-022).
       * The closed pair meant a cloned voice could be OFFERED by the catalogue and never ASKED FOR
       * — the wire had no way to name it — which is the same assumption the preview cache key and
       * `SpeechSpec.provider` carried, one layer further out.
       *
       * `ProviderIdSchema` rather than a free string: the coordinator still refuses a provider that
       * cannot preview, and a typo should fail at the frame rather than reach that check.
       */
      provider: ProviderIdSchema,
      model: z.string().min(1),
      voiceId: z.string().min(1),
      /** Opaque engine instance explicitly approved as a remote biometric-upload destination. */
      voiceUploadConfirmedFor: z.string().min(1).optional(),
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
  /**
   * SPEC-012 R-1/R-2: a production is a lens over the world — nothing is copied.
   * SPEC-023 R-1/R-2/R-5: `medium` is step one of the dialog; `productionKind` the named
   * format beneath it; the Microdrama path also names its Series and its editable defaults.
   * `format` stays for compatibility and is only consulted when `medium` is absent.
   */
  z
    .object({
      kind: z.literal("create-production"),
      worldId: UlidSchema,
      /** Correlates the production.create-result event; redelivery is idempotent (#384). */
      requestId: UlidSchema.optional(),
      title: z.string().min(1).max(200),
      format: ProductionFormatSchema.optional(),
      medium: ProductionMediumSchema.optional(),
      productionKind: z.string().min(1).max(80).optional(),
      seriesTitle: z.string().min(1).max(200).optional(),
      aspect: z.string().min(1).max(20).optional(),
      frameRate: FrameRateSchema.optional(),
      defaults: z
        .object({
          episodeCount: z.number().int().min(1).optional(),
          episodeSecondsMin: z.number().positive().optional(),
          episodeSecondsMax: z.number().positive().optional(),
          hookWindowSec: z.number().positive().optional(),
          episodeEnding: z.string().min(1).optional(),
          exportPreset: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
      logline: z.string().max(500).optional(),
    })
    .strict(),
  /**
   * issue #385: the structured overview is authored through the gate. Direct editing stages a
   * story-overview proposal from named fields; nothing is written live before acceptance.
   */
  z
    .object({
      kind: z.literal("propose-story-overview"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      logline: z.string().min(1).max(500).optional(),
      spine: z.string().min(1).max(4000).optional(),
      targetLength: z.string().min(1).max(120).optional(),
      acts: z
        .array(z.object({ title: z.string().min(1).max(200), summary: z.string().max(1000).optional() }).strict())
        .max(12)
        .optional(),
    })
    .strict(),
  /** issue #385: AI drafting of the overview — stages the same proposal kind, writes nothing live. */
  z
    .object({
      kind: z.literal("draft-story-overview"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      instruction: z.string().min(1).max(2000),
    })
    .strict(),
  /** issue #397: the season record, staged through the gate from named fields. */
  z
    .object({
      kind: z.literal("propose-season"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      question: z.string().min(1).max(500).optional(),
      ending: z.string().min(1).max(1000).optional(),
      direction: z.string().min(1).max(2000).optional(),
      arcs: z
        .array(
          z
            .object({
              id: SlugSchema,
              title: z.string().min(1).max(200),
              note: z.string().max(500).optional(),
              // Episode ids, as SeasonSchema requires (ep_<slug>): a free string here parsed at
              // the transport and then failed the gate's season lane — refused far from the
              // field that caused it. The frame now speaks the schema's own vocabulary.
              setup: EpisodeIdSchema.optional(),
              turn: EpisodeIdSchema.optional(),
              payoff: EpisodeIdSchema.optional(),
            })
            .strict(),
        )
        .max(20)
        .optional(),
    })
    .strict(),
  /** issue #397: one episode — a create mints identity from the title; an amend names its id. */
  z
    .object({
      kind: z.literal("propose-episode"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      episodeId: z.string().optional(),
      title: z.string().min(1).max(200).optional(),
      order: z.number().int().min(1).optional(),
      promise: z
        .object({
          opens: z.string().max(500).optional(),
          turn: z.string().max(500).optional(),
          closes: z.string().max(500).optional(),
        })
        .strict()
        .optional(),
      scenes: z.array(SceneIdSchema).optional(),
    })
    .strict(),
  /** issue #397: reorder episodes by stable id — order fields rewrite, nothing renames. */
  z
    .object({
      kind: z.literal("reorder-episodes"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      orderedIds: z.array(z.string().min(1)).min(1),
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
  /** Turn 97: undo. v<n> comes back as a new version; nothing between it and now is lost. */
  z
    .object({
      kind: z.literal("restore-scene"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      /** A scanner-compatible stem, never a path. */
      sceneFile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      version: z.number().int().min(1),
    })
    .strict(),
  /**
   * Remove a scene. Refused in words while accepted footage or a branch-map edge still depends
   * on it; otherwise the file goes, and the episode memberships and shot selections that were
   * only bookkeeping about it go in the same commit. History keeps the file.
   */
  z
    .object({
      kind: z.literal("delete-scene"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      /** A scanner-compatible stem, never a path. */
      sceneFile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    })
    .strict(),
  /**
   * One scene edit, named (SPEC-029 R-36).
   *
   * Every command says what happened and carries the scene version it was composed against, so a scene
   * that moved refuses the command rather than merging edges by array position (R-62), and the
   * coordinator commits exactly one validated record or writes nothing at all (R-61).
   *
   * The payload is shot ids and shot fields — never nodes and edges. There is deliberately no
   * "save graph" command: arbitrary graph JSON is what these exist to replace.
   */
  z
    .object({
      kind: z.literal("scene-command"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      /** A scanner-compatible stem, never a path. */
      sceneFile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      /**
       * The scene this was composed against, by id — the stem alone cannot say which scene it
       * is. Deleting a scene frees its id and its stem for a new one drafted at the same path,
       * and a delayed command would otherwise pass a version check into a different scene.
       */
      sceneId: SceneIdSchema,
      baseVersion: z.number().int().min(1),
      command: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("edit-scene"),
            /** Null explicitly clears the optional synopsis; omission is not a command. */
            synopsis: z.string().min(1).nullable(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("insert-shot"),
            at: ShotAnchorSchema,
            /** The beat, without identity: the coordinator mints the id past the whole production. */
            shot: ShotSchema.omit({ id: true, number: true }),
          })
          .strict(),
        z.object({ kind: z.literal("move-shot"), shotId: ShotIdSchema, to: ShotAnchorSchema }).strict(),
        z.object({ kind: z.literal("duplicate-shot"), shotId: ShotIdSchema }).strict(),
        z
          .object({
            kind: z.literal("edit-shot"),
            shotId: ShotIdSchema,
            /** A patch: a field the change omits is left exactly as the shot has it. */
            change: ShotSchema.omit({ id: true, number: true }).partial(),
            /**
             * Fields to remove, named rather than sent as a value.
             *
             * JSON cannot carry `undefined`, and an omitted key means "leave it" — so without
             * this there is no way to clear an optional field at all: no way to drop a hand-
             * tuned prompt override, a camera line, or a continuity flag once written.
             */
            clear: z.array(z.enum(CLEARABLE_SHOT_FIELDS)).optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("set-prompt-override"),
            shotId: ShotIdSchema,
            text: z.string().max(4000).nullable(),
          })
          .strict(),
        z.object({ kind: z.literal("delete-shot"), shotId: ShotIdSchema }).strict(),
        z
          .object({
            kind: z.literal("set-board-override"),
            shotId: ShotIdSchema,
            override: z.enum(["split", "merge"]),
          })
          .strict(),
        z
          .object({
            kind: z.literal("clear-board-override"),
            shotId: ShotIdSchema,
            override: z.enum(["split", "merge"]),
          })
          .strict(),
        z
          .object({
            kind: z.literal("move-board-boundary"),
            fromShotId: ShotIdSchema,
            toShotId: ShotIdSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("set-board-prompt"),
            members: z.array(ShotIdSchema).min(1),
            text: z.string().min(1),
          })
          .strict(),
        z
          .object({
            kind: z.literal("clear-board-prompt"),
            members: z.array(ShotIdSchema).min(1),
          })
          .strict(),
      ]),
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
  /**
   * R-BIBLE-2: the author's Bible saves in place, like chapter prose — no proposal, no approval.
   *
   * Unlike chapter prose it *does* cut a version on every save, and that is the point: the
   * version and its `.history/` snapshot are what stand in for the accept step, for the author
   * here and for the Studio's own edits. `baseVersion` is what the editor had loaded, so a save
   * written against a bible that has since moved is refused rather than merged.
   */
  z
    .object({
      kind: z.literal("save-bible"),
      worldId: UlidSchema,
      text: z.string(),
      baseVersion: z.number().int().min(1).optional(),
    })
    .strict(),
  /** R-HIST-2: undo. v<n> comes back as a new version; nothing between it and now is lost. */
  z
    .object({
      kind: z.literal("restore-bible"),
      worldId: UlidSchema,
      /**
       * 0 undoes the edit that started the bible, and empties it (2026-08-22).
       *
       * The undo card sends back the `fromVersion` it was given, so a bound of 1 here made the
       * button on the one edit that starts a bible unparseable — dropped at the wire, no undo,
       * no refusal, nothing on screen. Widened rather than special-cased on the client: the
       * card's contract is "send back what you were shown".
       */
      version: z.number().int().min(0),
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
  /** issue #387: reorder scenes by stable id — order fields rewrite, nothing renames. */
  z
    .object({
      kind: z.literal("reorder-scenes"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      orderedIds: z.array(SceneIdSchema).min(1),
    })
    .strict(),
  /** issue 389: change the aspect a production delivers in — normalized and refused by name. */
  z
    .object({
      kind: z.literal("set-production-aspect"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      aspect: z.string().min(1).max(20),
    })
    .strict(),
  /**
   * SPEC-033 R-74: which model this production reaches for, per capability. `modelId: null`
   * clears the choice, which is different from setting one — it puts the production back on
   * whatever the picker would have opened on anyway.
   */
  z
    .object({
      kind: z.literal("set-production-model"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      capability: CapabilitySchema,
      modelId: z.string().min(1).nullable(),
    })
    .strict(),
  /** Compile the exact server-side price and option identity before authorization. */
  z
    .object({
      kind: z.literal("frame-run-quote"),
      requestId: UlidSchema,
      worldId: UlidSchema,
      productionId: SlugSchema,
      sceneId: SceneIdSchema,
      mode: z.enum(["per-shot", "board"]),
      modelId: z.string().min(1),
      scope: z.enum(["missing", "all"]),
      /** A singular row action quotes only this shot; absent means scene scope. */
      shotId: ShotIdSchema.optional(),
    })
    .strict(),
  /** SPEC-036 §2.7: authorize the exact quote; the coordinator recompiles before spending. */
  z
    .object({
      kind: z.literal("frame-run-start"),
      requestId: UlidSchema,
      quoteId: UlidSchema,
      quoteSignature: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      quotedMicroUsd: z.number().int().min(0),
      worldId: UlidSchema,
      productionId: SlugSchema,
      sceneId: SceneIdSchema,
      mode: z.enum(["per-shot", "board"]),
      modelId: z.string().min(1),
      scope: z.enum(["missing", "all"]),
      shotId: ShotIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("frame-run-pause"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      runId: FrameRunIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("frame-run-resume"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      runId: FrameRunIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("frame-run-cancel"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      runId: FrameRunIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("frame-run-retry-step"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      runId: FrameRunIdSchema,
      stepIndex: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("frame-run-retry-cell"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      runId: FrameRunIdSchema,
      stepIndex: z.number().int().min(0),
      shotId: ShotIdSchema,
    })
    .strict(),
  /** Refresh a production's active and completed-but-undismissed runs. */
  z
    .object({
      kind: z.literal("frame-run-list"),
      worldId: UlidSchema,
      productionId: SlugSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("frame-run-dismiss"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      runId: FrameRunIdSchema,
    })
    .strict(),
  /** SPEC-024 R-12: create a durable dispatch plan — idempotent by requestId, durable before spend. */
  z
    .object({
      kind: z.literal("dispatch-scene-planned"),
      requestId: UlidSchema,
      worldId: UlidSchema,
      productionId: SlugSchema,
      sceneFile: z.string().min(1),
      mode: z.enum(["per-shot", "whole-scene"]),
      modelId: z.string().min(1),
      policy: z.enum(["review-gated", "pre-authorized"]),
      resolution: z.string().min(1).optional(),
      tier: SizeTierSchema.optional(),
    })
    .strict(),
  /** SPEC-024 R-16: the visible act a review-gated plan requires before its next pass. */
  z
    .object({
      kind: z.literal("plan-continue"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      planId: z.string().min(1),
      passIndex: z.number().int().min(0),
    })
    .strict(),
  /** SPEC-024 R-17: the fresh act that covers an estimate the authorization did not. */
  z
    .object({
      kind: z.literal("plan-reconfirm"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      planId: z.string().min(1),
      passIndex: z.number().int().min(0),
    })
    .strict(),
  /** SPEC-024 R-25: stop all future materialisation; landed work is untouched. */
  z
    .object({
      kind: z.literal("plan-cancel"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      planId: z.string().min(1),
    })
    .strict(),
  /** SPEC-024 R-10: ask for the folded states of a production's plans. */
  z
    .object({
      kind: z.literal("list-plans"),
      worldId: UlidSchema,
      productionId: SlugSchema,
    })
    .strict(),
  /** Epic 401 (brief §2): save the routing record — strict parse IS the no-state import gate. */
  z
    .object({
      kind: z.literal("save-routing"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      routing: z.unknown(),
    })
    .strict(),
  /** Epic 401 (brief §4/§5): one preview traversal, appended durably. */
  z
    .object({
      kind: z.literal("record-traversal"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      choiceId: z.string().min(1),
      from: SceneIdSchema,
      to: SceneIdSchema,
      route: z.array(SceneIdSchema),
    })
    .strict(),
  /** Epic 401 (brief §4): ask for the named findings. */
  z
    .object({
      kind: z.literal("list-routing-findings"),
      worldId: UlidSchema,
      productionId: SlugSchema,
    })
    .strict(),
  /** Epic 401 (brief §7): promote a branch outcome to canon — explicit, gated, route named. */
  z
    .object({
      kind: z.literal("propose-branch-canon"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      sceneId: SceneIdSchema,
      route: z.array(SceneIdSchema),
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(4000),
    })
    .strict(),
  /** Epic 401 (brief §6): export the self-hostable package; refused while blockers stand. */
  z
    .object({
      kind: z.literal("export-interactive"),
      worldId: UlidSchema,
      productionId: SlugSchema,
    })
    .strict(),
  /** SPEC-012 R-11/R-12: compile the board — local, free, scene-version stamped. */
  z
    .object({
      kind: z.literal("compile-scene-board"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      sceneFile: z.string().min(1),
    })
    .strict(),
  /** SPEC-012 R-13: export files exactly one artifact; recompiling files none. */
  z
    .object({
      kind: z.literal("export-scene-board"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      sceneFile: z.string().min(1),
    })
    .strict(),
  /** SPEC-012 R-17..R-20: dispatch what the dialog planned — per shot or whole scene. */
  z
    .object({
      kind: z.literal("dispatch-scene"),
      requestId: UlidSchema,
      worldId: UlidSchema,
      productionId: SlugSchema,
      sceneFile: z.string().min(1),
      mode: z.enum(["per-shot", "whole-scene"]),
      modelId: z.string().min(1),
      resolution: z.string().optional(),
      /** Stills: the size tier, which the plan turns into real output dimensions. */
      tier: SizeTierSchema.optional(),
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
  /** Bring one image into a shot's Variants and accept it through the ordinary still path. */
  z
    .object({
      kind: z.literal("import-shot-frame"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      shotId: ShotIdSchema,
      requestId: UlidSchema,
    })
    .strict(),
  /**
   * File a playblast the Stage rendered onto its shot. The bytes arrive the way a pasted
   * picture does — spooled by the host, which appends `sourcePath` — and the artifact is then
   * pinned on the shot's staging through the ordinary versioned scene write, so a stale scene
   * refuses it by name rather than pinning a move onto keys that have since changed.
   */
  z
    .object({
      kind: z.literal("stage-playblast"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      sceneFile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      sceneId: SceneIdSchema,
      baseVersion: z.number().int().min(1),
      shotId: ShotIdSchema,
      /** The staging version the playblast was rendered from — what the pin records. */
      stagingVersion: z.number().int().min(1),
      sourcePath: z.string().min(1),
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
      citation: z
        .object({ sheet: SlugSchema, field: z.string().min(1), note: z.string().optional() })
        .strict(),
    })
    .strict(),
  /**
   * SPEC-013 R-8, #253: where a shot starts inside its selected media.
   *
   * The only authored edit the cut offers. It writes the selection, never the take (R-1) and
   * never the anchor — the take is immutable and the anchor is the window on the track.
   */
  z
    .object({
      kind: z.literal("set-trim"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      shotId: ShotIdSchema,
      /** Seconds from the material's own start. Trim is from the in-point only; there is no out. */
      trimInSec: z.number().min(0).finite(),
    })
    .strict(),
  /** SPEC-037: materialise if needed, then move one Picture clip by one position. */
  z
    .object({
      kind: z.literal("timeline-move-picture"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      clipId: TimelineClipIdSchema,
      direction: TimelineMoveDirectionSchema,
      /** Null means the command was composed against the unsaved first assembly. */
      baseRevision: z.number().int().min(0).nullable(),
      sourceFingerprint: TimelineSourceFingerprintSchema,
    })
    .strict(),
  /** SPEC-037: move one durable Picture history entry between Undo and Redo. */
  z
    .object({
      kind: z.literal("timeline-history"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      action: z.enum(["undo", "redo"]),
      baseRevision: z.number().int().min(0),
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
  /**
   * 82a: file new artifacts into the world from the artifact panel.
   *
   * The host opens the picker and the renderer never sees the bytes, the same arrangement key art
   * has. They land on the **world's** shelf, not the production's: an artifact laid over one cut
   * is still the world's, and the panel says so by being the world's.
   */
  z.object({ kind: z.literal("upload-artifacts"), worldId: UlidSchema, requestId: UlidSchema }).strict(),
  /**
   * 82a: place an artifact over the picture for a window.
   *
   * The only stored position on the cut. It amends turn 80's third binding for this lane alone —
   * a shot still cannot be dragged, because where a shot sits is the story's answer or the song's.
   */
  z
    .object({
      kind: z.literal("place-overlay"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      artifactId: ArtifactIdSchema,
      startSec: z.number().min(0).finite(),
      endSec: z.number().positive().finite(),
      /** Which lane received the drop; absent lands it on the bottom one. */
      lane: z.number().int().min(0).max(MAX_CLIP_LANE).optional(),
    })
    .strict(),
  /** 82a, lanes: move a clip already placed, which is the same act as placing it. */
  z
    .object({
      kind: z.literal("move-overlay"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      overlayId: prefixedIdSchema("ov"),
      startSec: z.number().min(0).finite(),
      endSec: z.number().positive().finite(),
      /** Absent leaves it on the lane it is on, so trimming need not restate that. */
      lane: z.number().int().min(0).max(MAX_CLIP_LANE).optional(),
    })
    .strict(),
  /** Lanes: separate a clip's sound onto the lane below, as two clips over one file. */
  z
    .object({
      kind: z.literal("split-overlay-audio"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      overlayId: prefixedIdSchema("ov"),
    })
    .strict(),
  /** Lanes: the exact inverse — the picture carries its own sound again and the twin goes. */
  z
    .object({
      kind: z.literal("rejoin-overlay-audio"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      overlayId: prefixedIdSchema("ov"),
    })
    .strict(),
  /** 82a: remove the placement. The artifact is untouched — it was only ever cited. */
  z
    .object({
      kind: z.literal("remove-overlay"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      overlayId: prefixedIdSchema("ov"),
    })
    .strict(),
  /** SPEC-013 R-19..R-21: local render of the derived cut; gaps become labelled slates. */
  z
    .object({
      kind: z.literal("export-cut"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      /** One episode's deliverable (issue #396); absent exports the production-wide cut. */
      episodeId: z.string().optional(),
      /** The saved timeline revision shown when this export was requested; null means legacy derivation. */
      timelineRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
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
      /**
       * Who owns the filed artifact (SPEC-020 R-11). Three states, all meaningful:
       * a slug files it to that production, `null` files it to the world *explicitly*, and
       * absent leaves ownership to whatever the artifact already had.
       *
       * The distinction between `null` and absent is what makes the documented escape hatch work
       * (§2.5): re-filing scoped material from a world surface must be able to say "the world's",
       * and dedup returns an existing sidecar rather than creating one, so silence cannot mean it.
       */
      production: SlugSchema.nullable().optional(),
    })
    .strict(),
  /**
   * Attach from a chat: the host opens the picker and files what comes back. No path crosses
   * into the renderer in either direction — it asks, and learns only that artifacts now exist.
   */
  z
    .object({
      kind: z.literal("attach-files"),
      worldId: UlidSchema,
      links: z.array(z.string()).optional(),
      /** Ownership for everything the picker returns — same three states as `file-artifact`. */
      production: SlugSchema.nullable().optional(),
    })
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
  /**
   * SPEC-022 T-10: make a voice from a recording.
   *
   * `consent` is `z.literal(true)`, not a boolean. The model cannot tell whether the speaker in a
   * clip agreed to be cloned and neither can the app, so the wire refuses an unconsented clone
   * rather than leaving it to a handler that might forget — there is no way to spell the frame
   * that would carry `false`.
   *
   * `description` is required for the same reason `newClonedVoice` refuses without one:
   * `rankVoices` buries a candidate with no attributes, so a voice cloned FOR a character would
   * sink below every preset when ranked against her.
   */
  z
    .object({
      kind: z.literal("clone-voice"),
      worldId: UlidSchema,
      /**
       * A clip already staged by `stage-voice-clip`, never a path. The renderer has no path to
       * give: for a chosen file the host owns the dialog and what it returns (SPEC-001 R-9), and
       * for a recording there was never a file at all. Staging settles both before the name is
       * typed, which is also the order 74c draws.
       */
      clipId: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1),
      consent: z.literal(true),
      /** The sheet this was cloned while casting — a link for provenance, never ownership. */
      sheetId: SlugSchema.optional(),
    })
    .strict(),
  /**
   * SPEC-022 T-10: choose the clip, before anything is named.
   *
   * Two gestures reach the same staging point. `recorded` carries bytes because the renderer
   * genuinely holds them — the same shape `transcribe-dictation` already sends. `chosen` carries
   * nothing: the host opens its own picker and keeps the path, and what comes back to the
   * renderer is a name and a duration it can draw, never somewhere on disk.
   *
   * Staging validates the clip on arrival rather than at Save, so 74c can refuse a clip while it
   * is still the only thing on screen instead of losing a typed name to a refusal.
   */
  z
    .object({
      kind: z.literal("stage-voice-clip"),
      worldId: UlidSchema,
      requestId: z.string().min(1),
      source: z.discriminatedUnion("from", [
        z.object({ from: z.literal("chosen") }).strict(),
        z
          .object({
            from: z.literal("recorded"),
            audioBase64: z.string().min(1).max(8_000_000),
            contentType: z.string().min(1),
          })
          .strict(),
      ]),
    })
    .strict(),
  /** Let a staged clip go: the dialog was cancelled, and the temp file should not outlive it. */
  z.object({ kind: z.literal("discard-voice-clip"), clipId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("import-folder"), worldId: UlidSchema, sourcePath: z.string().min(1) }).strict(),
  /** SPEC-015 R-12..R-14: stage two — grounded extraction into a pending batch. */
  z
    .object({ kind: z.literal("extract-artifact"), worldId: UlidSchema, artifactId: z.string().min(1) })
    .strict(),
  /** Stop reading it. The turn is interrupted and the file stays filed, unread. */
  z
    .object({ kind: z.literal("stop-extraction"), worldId: UlidSchema, artifactId: z.string().min(1) })
    .strict(),
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
  /** SPEC-016 R-13: download the update now. */
  z.object({ kind: z.literal("download-update") }).strict(),
  /** Shut local work down safely, then hand the downloaded update to the installer. */
  z.object({ kind: z.literal("install-update-and-restart") }).strict(),
  /** Arm the downloaded update for installation after the next confirmed clean close. */
  z.object({ kind: z.literal("install-update-on-close") }).strict(),
  /** Clear a one-time successful-update notification after the renderer presents it. */
  z.object({ kind: z.literal("acknowledge-update") }).strict(),
  /** SPEC-016 R-15: a diagnostics bundle safe to paste publicly. */
  z.object({ kind: z.literal("generate-diagnostics") }).strict(),
  /**
   * SPEC-032 R-33's on-demand half: opening the Diagnostics view asks for a fresh derivation,
   * so a quiet session's staleness marks and derivation instant are current when somebody
   * finally looks. Coalesced like any other trigger; never a timer.
   */
  z.object({ kind: z.literal("refresh-diagnostics") }).strict(),
  /** SPEC-016 R-17: open the data location in the file manager. */
  z.object({ kind: z.literal("open-data-folder") }).strict(),

  // ---- the bench (issue 305) ----------------------------------------------
  /**
   * Open a session: by id from a durable URL, or with none — which resumes the world's most
   * recently updated session and creates one only when the world has none. The answer is the
   * snapshot's `bench` workspace; nothing is queued and nothing is spent.
   */
  z
    .object({ kind: z.literal("bench-open"), worldId: UlidSchema, sessionId: SessionIdSchema.optional() })
    .strict(),
  /** Prepare a fresh production-bound session from authoritative scene state. Nothing is spent. */
  z
    .object({
      kind: z.literal("bench-open-subject"),
      worldId: UlidSchema,
      requestId: UlidSchema,
      productionId: SlugSchema,
      sceneId: SceneIdSchema,
      subject: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("shot"), shotId: ShotIdSchema }).strict(),
        z.object({ kind: z.literal("board"), memberShotIds: z.array(ShotIdSchema).min(1) }).strict(),
      ]),
      /**
       * A shot opens in image mode (SPEC-036 R-23) unless the Stage asks for video — `Render
       * with this` wants the clip, with the playblast riding and the move written as beats.
       * Ignored for a board, which is video by definition.
       */
      mode: z.enum(["image", "video"]).optional(),
    })
    .strict(),
  /** Reassemble a subject session's words from the current production and script. */
  z
    .object({
      kind: z.literal("bench-rebuild-subject"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
    })
    .strict(),
  /** Clear-the-bench: a NEW session. The old one keeps running; nothing is cancelled by this. */
  z.object({ kind: z.literal("bench-new-session"), worldId: UlidSchema }).strict(),
  z.object({ kind: z.literal("bench-close"), worldId: UlidSchema }).strict(),
  z
    .object({
      kind: z.literal("bench-set-title"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      title: z.string().max(200).nullable(),
    })
    .strict(),
  /** The composer, whole. Debounced by the client; each landing replaces the previous state. */
  z
    .object({
      kind: z.literal("bench-compose"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      mode: BenchModeSchema,
      provider: z.string(),
      model: z.string(),
      params: BenchParamsSchema,
      brief: z.string().max(100_000),
    })
    .strict(),
  /**
   * Attach already-filed sources, in the order picked. Token allocation is the coordinator's:
   * re-adding a source the registry knows restores its old token; a new source takes the next
   * number of its kind. Each pick's `replace` names the active token that gives way when the
   * set is at the model's ceiling. One message on purpose — the picker commits a checked set
   * together, and N separate frames would race each other's token allocation.
   */
  z
    .object({
      kind: z.literal("bench-add-reference"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      picks: z
        .array(
          z
            .object({
              source: z.discriminatedUnion("source", [
                z.object({ source: z.literal("artifact"), artifactId: z.string().min(1) }).strict(),
                z.object({ source: z.literal("take"), takeId: TakeIdSchema }).strict(),
                // A picture that lives in the world without being an artifact — everything under
                // a character. No hash here: the client names the file, the coordinator reads the
                // bytes and hashes what it actually found.
                z.object({ source: z.literal("world-file"), path: WorldFilePathSchema }).strict(),
              ]),
              replace: z.string().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(24),
      /** Which lane the picks land in. Absent is the reference lane (issue 305 §3). */
      lane: z.enum(["reference", "keyframe"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bench-remove-reference"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      token: z.string().min(1),
      /** Which lane loses the token. Absent is the reference lane (issue 305 §3). */
      lane: z.enum(["reference", "keyframe"]).optional(),
    })
    .strict(),
  /**
   * Host file dialog → file into the world on arrival → attach each as a reference. The filing
   * outcome returns as `artifact.filed-batch` under this requestId; cancelling the picker later
   * does not unfile what landed (issue 305 §4).
   */
  z
    .object({
      kind: z.literal("bench-upload-references"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      allowLarge: z.boolean().optional(),
      /** Which lane the uploads attach to. Absent is the reference lane (issue 305 §3). */
      lane: z.enum(["reference", "keyframe"]).optional(),
    })
    .strict(),
  /**
   * The art director rewrites the author's ask for the chosen model, grounded in the world's
   * look and settled canon. Answered by `bench.brief-enhanced` under this requestId — the
   * enhanced words land in the composer only by the author's hand, never by surprise.
   */
  z
    .object({
      kind: z.literal("bench-enhance-brief"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      brief: z.string().min(1).max(100_000),
      provider: z.string().min(1),
      model: z.string().min(1),
    })
    .strict(),
  /**
   * "Write for me" (design turn 73): a description of what the song is about, drafted into
   * lyrics. Answered by `bench.lyrics-drafted` under this requestId, and the answer opens a
   * dialog — nothing reaches the song until the author presses Use these words, so a
   * generation can never carry words nobody read.
   *
   * The style rides along because a draft written blind to the arrangement is a draft written
   * for a different song, but it is optional: a style is not required to describe a subject.
   */
  /**
   * A helper run against a passage of the bible (design turn 90).
   *
   * Answered by `bible.helper-answered` under this requestId. The answer opens nothing and
   * changes nothing — it lands in the rail beside the editor, and only Replace moves it into the
   * document. The bible has no accept step and gains none here: what stands in for one is the
   * version and Earlier versions, which is why this may be a plain one-shot rather than a
   * proposal.
   *
   * Only the passage travels. The document itself is read from the store on the other side, so a
   * long bible is not carried up the socket on every press.
   */
  z
    .object({
      kind: z.literal("bible-helper-run"),
      worldId: UlidSchema,
      requestId: UlidSchema,
      helper: BibleHelperKindSchema,
      /** The passage the author highlighted, verbatim. */
      selection: z.string().min(1).max(BIBLE_HELPER_BOUNDS.selection),
    })
    .strict(),

  z
    .object({
      kind: z.literal("bench-draft-lyrics"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      /** What the song is about, in the author's words. */
      description: z.string().min(1).max(4000),
      /** The composer's STYLE line, when one has been written. */
      style: z.string().max(4000).optional(),
      provider: z.string().min(1),
      model: z.string().min(1),
    })
    .strict(),
  /**
   * Save the composer's current setup as a preset (issue 305 §3). Saving under an existing
   * name replaces that preset; the coordinator validates the model against the manifest.
   */
  z
    .object({
      kind: z.literal("bench-preset-save"),
      requestId: UlidSchema,
      name: z.string().min(1).max(80),
      mode: BenchModeSchema,
      provider: z.string().min(1),
      model: z.string().min(1),
      params: BenchParamsSchema,
      brief: z.string().max(100_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bench-preset-delete"),
      requestId: UlidSchema,
      presetId: PresetIdSchema,
    })
    .strict(),
  /** Dispatch the composer as written. Count N reserves N takes and enqueues N jobs. */
  z
    .object({
      kind: z.literal("bench-dispatch"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      /** The exact draft this press reviewed; persisted before the coordinator plans the job. */
      composer: z
        .object({
          mode: BenchModeSchema,
          provider: z.string(),
          model: z.string(),
          params: BenchParamsSchema,
          brief: z.string().max(100_000),
        })
        .strict(),
      /** Opaque engine instance explicitly approved as a remote biometric-upload destination. */
      voiceUploadConfirmedFor: z.string().min(1).optional(),
    })
    .strict(),
  /** A new numbered take from an old take's immutable snapshot. Always exactly one. */
  z
    .object({
      kind: z.literal("bench-rerun"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      takeId: TakeIdSchema,
      /** Opaque engine instance explicitly approved as a remote biometric-upload destination. */
      voiceUploadConfirmedFor: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bench-keep"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      takeId: TakeIdSchema,
    })
    .strict(),
  /** Subject sessions file into production; the world-scoped bench keeps using bench-keep. */
  z
    .object({
      kind: z.literal("bench-accept"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      takeId: TakeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("bench-discard"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      takeId: TakeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("bench-clear-view"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      takeId: TakeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("bench-select-take"),
      worldId: UlidSchema,
      sessionId: SessionIdSchema,
      requestId: UlidSchema,
      takeId: TakeIdSchema,
    })
    .strict(),
  /**
   * Stage an already-filed artifact on a standard generation surface's reference slot
   * (issue 305 §4): the staged path becomes the artifact's own file, no copy is made, and
   * clearing the slot later removes a pointer rather than the artifact.
   */
  z
    .object({
      kind: z.literal("stage-artifact-reference"),
      worldId: UlidSchema,
      key: StagedReferenceKeySchema,
      artifactId: z.string().min(1),
    })
    .strict(),
  /**
   * The GenerationDialog picker's upload lane: host dialog → file into the world → answer with
   * `artifact.filed-batch`. Unlike bench-upload-references this attaches nothing anywhere;
   * what to do with the ids is the caller's.
   */
  z
    .object({
      kind: z.literal("attach-files-correlated"),
      worldId: UlidSchema,
      requestId: UlidSchema,
      links: z.array(z.string()).optional(),
      allowLarge: z.boolean().optional(),
    })
    .strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
