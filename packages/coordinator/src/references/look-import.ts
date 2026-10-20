import { BrowserMediaFilesSchema, type ClientMessage, type Take } from "@arke-studio/contracts";
import { imageFormatOf } from "../queue/verify.js";
import type { WorldStore } from "../world/store.js";
import { recordUploadedLookTake } from "./takes.js";
import { sha256 } from "../world/text-files.js";

/** User-selected bytes become a pending look, through the same take storage as generated work. */
export async function importCharacterLook(
  store: WorldStore,
  input: Extract<ClientMessage, { kind: "import-character-look" }>,
  stillCurrent: () => boolean,
): Promise<Take> {
  const checked = BrowserMediaFilesSchema.safeParse(input.files);
  if (!checked.success || checked.data.length !== 1) throw new Error("Choose one image up to 48 MB for this look.");
  const file = checked.data[0]!;
  const precondition = () => !stillCurrent() || store.worldId !== input.worldId
    ? "The world changed. Open this character and import again."
    : (() => {
      const character = store.getBundle().sheets.find(sheet => sheet.id === input.sheetId);
      return character?.type !== "character" ? "That character is no longer available."
        : character.neverDepicted ? "This character is never depicted." : null;
    })();
  const stale = precondition();
  if (stale) throw new Error(stale);
  const data = Buffer.from(file.data, "base64");
  if (data.toString("base64") !== file.data) throw new Error("That image could not be read.");
  const format = imageFormatOf(data);
  if (!format) throw new Error("Choose a complete PNG, JPEG or WebP image.");
  const existing = store.getBundle().referenceTakes.find(take => take.params["requestId"] === input.requestId);
  if (existing) {
    if (existing.kind !== "look" || existing.reference?.sheetId !== input.sheetId ||
      existing.params["uploadedHash"] !== sha256(data) || existing.params["sourceFilename"] !== file.name ||
      existing.params["lookKind"] !== input.lookKind || existing.params["lookPrompt"] !== input.name)
      throw new Error("This import request changed. Choose the image again.");
    return existing;
  }
  // Canonical extension follows verified bytes; the original leaf name remains in the take.
  const media = file.name.replace(/\.[^.]*$/, "") + format.extension;
  return recordUploadedLookTake(store, input.sheetId, media, data, {
    requestId: input.requestId, precondition, lookKind: input.lookKind, name: input.name, sourceFilename: file.name,
  }).catch(() => { throw new Error("The image could not be saved. Check Recent looks before trying again."); });
}
