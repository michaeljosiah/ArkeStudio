import type { ArtifactSidecar } from "./artifact.js";
import type { WorldBundle } from "./client-state.js";
import { orderedShots } from "./scene-flow.js";

/**
 * How an artifact is named to a person (issue 1005).
 *
 * The file is the download identity; the name is what the file is *about* — the sheet, the
 * canon entry, the production, the scene or the shot it is linked to — and only when nothing
 * names it does the file name stand in. One rule, kept in contracts because three surfaces
 * state it: the Artifacts page, the Cut's Library and its clips, and the coordinator when it
 * lists another world's shelf for the Library to borrow from (issue 1033).
 */

/** How a link is spelled to a person: the record's name, or the link itself when nothing names it. */
export type LinkName = (link: string, links?: readonly string[]) => string;

/**
 * Resolve link ids against a world's records. Sheets and canon by id; a production by its slug;
 * an episode, scene or shot by the production the artifact's other links name, or any production
 * when they name none. An id nothing owns keeps its spelling.
 */
export function linkNameResolver(world: Pick<WorldBundle, "sheets" | "canon" | "productions"> | null | undefined): LinkName {
  return (link, links = []) => {
    const name = world?.sheets.find((s) => s.id === link)?.name ?? world?.canon.find((c) => c.id === link)?.title;
    if (name) return name;
    const owning = world?.productions.filter((production) => links.includes(production.meta.id)) ?? [];
    const names: string[] = [];
    for (const production of owning.length ? owning : world?.productions ?? []) {
      if (production.meta.id === link) return production.meta.title;
      const episode = production.episodes.find((candidate) => candidate.id === link);
      if (episode) names.push(episode.title);
      for (const scene of production.scenes) {
        if (scene.id === link) names.push(scene.title);
        const shot = orderedShots(scene).find((candidate) => candidate.id === link);
        if (shot) names.push(`Shot ${shot.number} · ${shot.title}`);
      }
    }
    return names.length === 1 ? names[0]! : link;
  };
}

/** Linked names title the shelf and its viewer; the file remains the download identity. */
export function artifactDisplayName(artifact: Pick<ArtifactSidecar, "links" | "file">, linkName: LinkName): string {
  const names = artifact.links.map((link) => linkName(link, artifact.links)).filter((name, index) => name !== artifact.links[index]);
  return [...new Set(names)].slice(0, 2).join(" · ") || artifact.file.split("/").pop() || artifact.file;
}
