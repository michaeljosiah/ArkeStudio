import { z } from "zod";
import { CanonIdSchema, ConversationIdSchema, MessageIdSchema, SceneIdSchema, ShotIdSchema, SlugSchema } from "./ids.js";

/**
 * Where a piece of readable prose lives (issue 857).
 *
 * An address, never the words. Read-aloud names what it wants and the coordinator reads the
 * authoritative record — the same rule the sheet and bible reads have always followed, for the
 * same reason: the screen's copy of a paragraph is a snapshot, and narrating a snapshot means
 * the voice and the page can disagree about what the world says.
 *
 * Each arm carries exactly the ids that address its own record. A shot needs the production and
 * scene it belongs to, because those ids are scoped to it; a canon entry and a conversation reply
 * do not, because they are the world's.
 */
export const ProseReadSourceSchema = z.discriminatedUnion("of", [
  /** A canon entry's statement — the Markdown body under its frontmatter. */
  z.object({ of: z.literal("canon"), canonId: CanonIdSchema }).strict(),
  /**
   * A shot's script — the description that says what happens.
   *
   * There is no scene-level arm beside it, because a scene's script is these: the workspace draws
   * the shots and nothing renders `script.blocks` as prose. A synopsis is one line under a title,
   * which is read faster than a press.
   */
  z
    .object({ of: z.literal("shot"), productionId: SlugSchema, sceneId: SceneIdSchema, shotId: ShotIdSchema })
    .strict(),
  /**
   * The production overview: the pieces of `story.json` and the freeform treatment beside it.
   * `acts` is a list rather than a paragraph, so it is read whole or not at all.
   */
  z
    .object({
      of: z.literal("story"),
      productionId: SlugSchema,
      field: z.enum(["logline", "spine", "acts", "treatment"]),
    })
    .strict(),
  /** The season record's two authored answers (SPEC-023 R-10). */
  z
    .object({ of: z.literal("season"), productionId: SlugSchema, field: z.enum(["question", "ending"]) })
    .strict(),
  /** The Series' engine, which a season screen shows read-only (SPEC-023 R-9). */
  z.object({ of: z.literal("series"), seriesId: SlugSchema }).strict(),
  /**
   * One reply in a conversation. Arke's replies are frequently long and are exactly what
   * somebody may want read back rather than read; the user's own turns are not offered, because
   * nobody needs their own sentence spoken to them.
   */
  z.object({ of: z.literal("reply"), conversationId: ConversationIdSchema, messageId: MessageIdSchema }).strict(),
]);
export type ProseReadSource = z.infer<typeof ProseReadSourceSchema>;
