import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { openPromise } from "yauzl";
import { type CreatorPackagePreview } from "@arke-studio/contracts";
import { listArkePlayerPackages } from "../productions/arke-player-export.js";
import { checkWorldPackageZip } from "../productions/world-package.js";
import { containedWorldFile } from "../productions/interactive.js";
import type { WorldStore } from "../world/store.js";
import { toExtendedLength } from "../world/paths.js";
import type { AonikConfiguration } from "./config.js";
import { PublishingRefusal } from "./api.js";
import { lockDownAcl } from "../credentials/store.js";

export async function freezePlayerEdition(store: WorldStore, productionId: string, exportId: string, root: string, configuration: AonikConfiguration, signal: AbortSignal): Promise<CreatorPackagePreview> {
  const maxAssets = configuration.capacityProfile === "large-v1" ? 2048 : 1024;
  const maxEntries = configuration.capacityProfile === "large-v1" ? maxAssets * 4 + 64 : 1025;
  const listed = (await listArkePlayerPackages(store)).find(p => p.exportId === exportId && p.productionId === productionId);
  if (!listed || listed.bytes < 1 || listed.bytes > configuration.maxPackageBytes) throw new PublishingRefusal("edition-unavailable", "Choose a completed Player edition within the channel's package limit.");
  const source = await containedWorldFile(store.dir, listed.file); if (!source) throw new PublishingRefusal("edition-unavailable", "The selected edition is no longer available in this world.");
  const candidateId = randomUUID(); await mkdir(toExtendedLength(join(root, "packages")), { recursive: true, mode: 0o700 });
  const destination = join(root, "packages", candidateId + ".zip");
  let kept = false;
  try {
    const hash = createHash("sha256"); let bytes = 0;
    const input = await open(toExtendedLength(source), "r");
    try {
      const output = await open(toExtendedLength(destination), "wx", 0o600);
      try {
        await lockDownAcl(destination);
        for await (const chunk of input.createReadStream({ autoClose: false, signal })) { const data = chunk as Buffer; bytes += data.length; if (bytes > listed.bytes) throw new PublishingRefusal("edition-changed", "This export changed. Make a new Player edition before submitting it."); hash.update(data); await output.writeFile(data); }
        await output.sync();
      } finally { await output.close(); }
    } finally { await input.close(); }
    if (bytes !== listed.bytes || hash.digest("hex") !== listed.sha256) throw new PublishingRefusal("edition-changed", "This export changed. Make a new Player edition before submitting it.");
    // Bound the documents before the owning reader materialises them; no archive is extracted.
    const zip = await openPromise(toExtendedLength(destination), { autoClose: false, strictFileNames: true, validateEntrySizes: true });
    try {
      const entries = new Map<string, number>(); const documents: string[] = []; let count = 0;
      for await (const entry of zip.eachEntry()) {
        if (++count > maxEntries || entry.compressionMethod !== 0 || entries.has(entry.fileName.toLowerCase()) || entry.fileName.split("/").some(p => p === ".." || p === ".") || entry.fileName.startsWith("/") || entry.fileName.includes("\\") || entry.fileName.includes(":") || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new PublishingRefusal("package-refused", "This is not a supported frozen Player package.");
        entries.set(entry.fileName.toLowerCase(), entry.uncompressedSize);
        if (entry.fileName === "world.json") {
          if (entry.uncompressedSize > 4194304) throw new PublishingRefusal("package-refused", "The package manifest exceeds its limit.");
          const parts: Buffer[] = []; for await (const part of await zip.openReadStreamPromise(entry)) parts.push(part as Buffer);
          const manifest = JSON.parse(Buffer.concat(parts).toString("utf8")) as { assets?: Record<string, { path: string; mediaType: string; byteLength: number }> };
          const inventory = Object.values(manifest.assets ?? {});
          if (inventory.length > maxAssets || (configuration.capacityProfile === "large-v1" && inventory.some(asset => asset.byteLength > 67108864))) throw new PublishingRefusal("package-refused", "This package exceeds the configured asset limits.");
          for (const asset of Object.values(manifest.assets ?? {})) if (asset.mediaType.endsWith("+json")) { documents.push(asset.path.toLowerCase()); if (asset.byteLength > 4194304) throw new PublishingRefusal("package-refused", "A package document exceeds its limit."); }
        }
      }
      if (documents.some(path => (entries.get(path) ?? Infinity) > 4194304)) throw new PublishingRefusal("package-refused", "A package document exceeds its limit.");
    } finally { zip.close(); }
    const checked = await checkWorldPackageZip(destination, signal);
    if (!checked.ok) throw new PublishingRefusal("package-refused", "The selected package no longer passes the Player export checks. Export it again.");
    const m = checked.manifest;
    if (Object.keys(m.assets).length > maxAssets || checked.sha256 !== listed.sha256 || checked.bytes !== listed.bytes) throw new PublishingRefusal("edition-changed", "The package no longer matches the frozen edition.");
    const kind: CreatorPackagePreview["kind"] = m.part ? "part" : m.productions.length === 0 ? "guide" : m.alone ? m.productions[0]?.comic ? "comic" : m.productions[0]?.story ? "story" : "production" : "world";
    // A part inherits its approved base cover; selecting an incidental illustration would replace it.
    const artwork = kind === "part" ? "" : [m.keyArt, ...m.productions.map(p => p.picture), ...Object.keys(m.assets)].find(id => id && ["image/png", "image/jpeg"].includes(m.assets[id]!.mediaType) && m.assets[id]!.byteLength <= 4194304);
    if (kind !== "part" && !artwork) throw new PublishingRefusal("artwork-required", "Export this edition with a PNG or JPEG cover up to 4 MiB before submitting it.");
    signal.throwIfAborted(); kept = true;
    return { candidateId, exportId, title: m.name, creatorDisplayName: "", summary: m.logline ?? "", worldId: m.id, edition: m.edition, kind,
      fileName: listed.file.split("/").at(-1)!, bytes: listed.bytes, sha256: listed.sha256, channelKey: configuration.channelKey,
      rightsDeclarationVersion: configuration.rightsDeclarationVersion, permissionText: configuration.permissionText, artworkAssetId: artwork ?? "",
      assets: Object.entries(m.assets).map(([id, a]) => ({ id, path: a.path, mediaType: a.mediaType, bytes: a.byteLength })) };
  } finally { if (!kept) await rm(toExtendedLength(destination), { force: true }); }
}
