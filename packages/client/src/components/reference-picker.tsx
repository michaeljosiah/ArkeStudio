import { useEffect, useMemo, useRef, useState } from "react";
import {
  admitReference,
  benchSourceKey,
  benchTokenFor,
  formatSeconds,
  multimediaCapacity,
  parseBenchToken,
  isGeneratedArtifact,
  pickableArtifacts,
  type ArtifactSidecar,
  type BenchSession,
  type ManifestModel,
  type MultimediaReference,
  type ReferenceKind,
  type ReferenceKit,
  type Take,
} from "@arke-studio/contracts";
import { Button, cx } from "./ui.js";
import { generatedOriginLabel } from "../lib/format.js";
import { Portrait } from "./portrait.js";
import { Search, Upload } from "./icons.js";
import { Wave } from "../screens/production.js";

/**
 * One reference picker for every surface that asks for one (issue 305 §4, design 69).
 *
 * Three entrances, two frames: the bench opens it as a dialog and picks an ordered set —
 * checked tiles are a selection, committed together by "Add N" the way the master commits
 * them (69a) — while the standard GenerationDialog hands it the dialog's own panel and picks
 * exactly one, immediately; never a dialog over a dialog. The refusals here are predictions
 * made with the SAME functions the coordinator re-runs before enqueue, so a tile that says
 * "this model takes no audio" is the same sentence dispatch would have refused with.
 */

export interface PickerSource {
  key: string;
  kind: ReferenceKind | "document" | "other";
  name: string;
  /** World-relative image path for the thumbnail, where there is one. */
  imagePath?: string;
  meta: string;
  durationSec: number | null;
  /** The token this source already carries in the session, active or not. */
  existingToken?: string;
  /** Active right now — offered as "already riding", not pickable again. */
  active?: boolean;
  pick:
    | { source: "artifact"; artifactId: string }
    | { source: "take"; takeId: string }
    | { source: "world-file"; path: string };
}

/**
 * The world's artifacts as picker rows, supersession already excluded. `activeIn` names the
 * lane whose tokens read as "already riding" — a picture riding as a style reference is still
 * pickable as a keyframe, and the other way round (issue 305 §3).
 */
export function worldPickerSources(
  artifacts: readonly ArtifactSidecar[],
  session: BenchSession | null,
  activeIn: "reference" | "keyframe" = "reference",
): PickerSource[] {
  const registry = new Map((session?.tokenRegistry ?? []).map((e) => [benchSourceKey(e.source), e.token]));
  const active = new Set(
    (activeIn === "keyframe" ? session?.composer.keyframeTokens : session?.composer.activeTokens) ?? [],
  );
  return pickableArtifacts(artifacts).map((a) => {
    const kind: PickerSource["kind"] =
      a.kind === "image" || a.kind === "board" ? "image" : a.kind === "audio" || a.kind === "video" ? a.kind : a.kind === "document" ? "document" : "other";
    const token = registry.get(`artifact:${a.id}`);
    return {
      key: `artifact:${a.id}`,
      kind,
      name: a.file,
      ...(kind === "image" ? { imagePath: `artifacts/${a.file}` } : {}),
      meta: [
        a.file.includes(".") ? a.file.split(".").pop() : a.kind,
        ...(a.mediaInfo ? [formatSeconds(a.mediaInfo.durationSec)] : []),
        ...(isGeneratedArtifact(a) ? [generatedOriginLabel(a)] : []),
      ].join(" · "),
      durationSec: kind === "image" ? 0 : (a.mediaInfo?.durationSec ?? null),
      ...(token !== undefined ? { existingToken: token, active: active.has(token) } : {}),
      pick: { source: "artifact", artifactId: a.id },
    };
  });
}

/**
 * Which of two artifacts filed from one source file is the later one.
 *
 * By stamp, then by id: an artifact id is a ULID, so it breaks a tie in the order the two were
 * actually minted rather than in whatever order they happened to be read.
 */
function newerArtifact(candidate: ArtifactSidecar, incumbent: ArtifactSidecar): boolean {
  const a = Date.parse(candidate.created);
  const b = Date.parse(incumbent.created);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b;
  return candidate.id > incumbent.id;
}

/**
 * Every picture a character has, as picker rows (2026-08-18).
 *
 * The world holds far more pictures than the artifacts folder, and none of them could be picked:
 * accepted identity, looks, the candidates still waiting on review, and every take ever
 * generated. Aurora alone had nine against the world's two artifacts.
 *
 * Each row says what it is — accepted, look, candidate, take — because the whole set is offered
 * and a picture that has not passed review is one press from a paid generation. The accept step
 * exists to keep unreviewed pictures out of dispatches; this deliberately reaches past it, so
 * the label is the only thing left telling you which is which.
 */
export function characterPickerSources(
  world: {
    sheets: readonly { id: string; name: string }[];
    referenceKits: readonly ReferenceKit[];
    referenceTakes: readonly Take[];
    referenceCandidates: Readonly<Record<string, readonly string[]>>;
    /** The world's shelf, so a picture filed from a reference is offered under ONE identity. */
    artifacts?: readonly ArtifactSidecar[];
  },
  session: BenchSession | null,
  activeIn: "reference" | "keyframe" = "reference",
): PickerSource[] {
  const registry = new Map((session?.tokenRegistry ?? []).map((e) => [benchSourceKey(e.source), e.token]));
  const active = new Set(
    (activeIn === "keyframe" ? session?.composer.keyframeTokens : session?.composer.activeTokens) ?? [],
  );
  /**
   * Reference path to the artifact filed from it (issue 475).
   *
   * Every generated reference is now also an artifact, so this lane and the world lane hold the
   * same picture. The row stays here — "Aurora · identity" is what a person is looking for, and
   * an artifact filename is not — but it picks by artifact id, so the two lanes share one token
   * instead of offering the same bytes twice under two names.
   */
  const artifactByFile = new Map<string, ArtifactSidecar>();
  for (const artifact of pickableArtifacts(world.artifacts ?? [])) {
    if (artifact.generation?.source !== "character-reference") continue;
    const existing = artifactByFile.get(artifact.generation.sourceFile);
    // Newest wins, explicitly (Codex round 1). The legacy tile path lands every regeneration of
    // an angle on ONE filename, so two artifacts can name one source file — and bundle order is
    // the scan's alphabetical sort, where the collision name `…-front-2.png.json` sorts BEFORE
    // `…-front.png.json`. Last-write-wins therefore handed back the OLDEST bytes while the row's
    // thumbnail showed the current ones: a paid generation carrying a picture nobody could see.
    if (existing === undefined || newerArtifact(artifact, existing)) {
      artifactByFile.set(artifact.generation.sourceFile, artifact);
    }
  }
  const nameOf = new Map(world.sheets.map((sheet) => [sheet.id, sheet.name]));
  const rows: PickerSource[] = [];
  /*
   * Two ways in, because this world holds paths in both shapes. A kit names its files relative
   * to the sheet (`head-front.png`, `looks/coat.png`); `referenceCandidates` holds them
   * world-relative already, the way the scan emits them. Passing one where the other is meant
   * built `references/<id>/references/<id>/candidates/…`, and every candidate row pointed at a
   * file that does not exist — pickable, and broken the moment it was carried.
   */
  const addPath = (sheetId: string, path: string, what: string): void => {
    const file = path.split("/").pop() ?? path;
    if (!/\.(png|jpg|jpeg|webp)$/i.test(file)) return; // a path alone cannot price a clip
    // The identity this session already knows wins (Codex round 1). A session that picked the
    // picture before an artifact existed for it — a world opened after this shipped replays old
    // finalizations, which file one — carries it as `file:<path>`. Switching the row to the
    // artifact id would lose that registry entry, so the picture would read as addable again and
    // the coordinator would mint a SECOND token for it: source identity, not content, is what
    // deduplicates. Aliasing is for rows the session has no opinion about.
    const fileKey = `file:${path}`;
    const artifact = registry.has(fileKey) ? undefined : artifactByFile.get(path);
    const key = artifact ? `artifact:${artifact.id}` : fileKey;
    if (rows.some((r) => r.key === key)) return; // a tile and a compilation can name one file
    const token = registry.get(key);
    rows.push({
      key,
      kind: "image",
      name: `${nameOf.get(sheetId) ?? sheetId} · ${what}`,
      imagePath: path,
      meta: [what, file].filter(Boolean).join(" · "),
      durationSec: 0,
      ...(token !== undefined ? { existingToken: token, active: active.has(token) } : {}),
      pick: artifact ? { source: "artifact", artifactId: artifact.id } : { source: "world-file", path },
    });
  };
  /** The kit's own shape: a file named relative to `references/<sheetId>/`. */
  const add = (sheetId: string, file: string, what: string): void =>
    addPath(sheetId, `references/${sheetId}/${file}`, what);

  for (const kit of world.referenceKits) {
    if (kit.mainPhoto?.file) add(kit.sheetId, kit.mainPhoto.file, "identity");
    if (kit.anchor) add(kit.sheetId, kit.anchor, "identity");
    if (kit.designatedCompilation) add(kit.sheetId, kit.designatedCompilation, "model sheet");
    for (const tile of kit.tiles) if (tile.file) add(kit.sheetId, tile.file, tile.angle);
    for (const look of kit.looks ?? []) if (look.file) add(kit.sheetId, look.file, `look · ${look.kind}`);
  }
  for (const take of world.referenceTakes) {
    const sheetId = take.reference?.sheetId;
    if (sheetId && take.media) add(sheetId, `takes/${take.id}/${take.media}`, "take");
  }
  for (const [sheetId, paths] of Object.entries(world.referenceCandidates)) {
    for (const path of paths) addPath(sheetId, path, "candidate · not reviewed");
  }
  return rows;
}

/** The session's own takes as picker rows — picking an unkept one keeps its bytes riding. */
export function sessionPickerSources(
  session: BenchSession,
  activeIn: "reference" | "keyframe" = "reference",
): PickerSource[] {
  const registry = new Map(session.tokenRegistry.map((e) => [benchSourceKey(e.source), e.token]));
  const active = new Set(activeIn === "keyframe" ? session.composer.keyframeTokens : session.composer.activeTokens);
  return session.takes
    .filter((t) => t.media !== undefined)
    .map((t) => {
      const kind: ReferenceKind = t.request.mode === "video" ? "video" : "image";
      const token = registry.get(`take:${t.id}`);
      return {
        key: `take:${t.id}`,
        kind,
        name: `Take ${t.n}`,
        ...(kind === "image" ? { imagePath: `.sessions/${session.id}/media/${t.id}/${t.media!.file}` } : {}),
        meta: [t.request.model, t.disposition === "filed" ? "kept" : t.disposition].join(" · "),
        durationSec: kind === "image" ? 0 : (t.media!.info?.durationSec ?? null),
        ...(token !== undefined ? { existingToken: token, active: active.has(token) } : {}),
        pick: { source: "take", takeId: t.id },
      };
    });
}

/** A staged pick: the tile, and — at the image ceiling — which active token gives way. */
interface StagedPick {
  source: PickerSource;
  replace?: string;
}

const KIND_LABEL: Record<string, string> = {
  image: "Images",
  video: "Video",
  audio: "Audio",
  document: "Documents",
};

export function ReferencePickerBody({
  mode,
  worldSlug,
  model,
  carried,
  world,
  session,
  characters,
  onAdd,
  onChoose,
  onUpload,
  onClose,
  title,
  note,
  only,
  budget = "model",
}: {
  /** "bench": ordered multi-pick with tokens. "slot": exactly one, no token namespace. */
  mode: "bench" | "slot";
  /** The dialog's own words, where the default headline is not the ask (keyframes). */
  title?: string;
  note?: string;
  /** Offer only sources of this kind — the keyframe lane takes pictures alone. */
  only?: ReferenceKind;
  /** "none": picks are not budgeted references (keyframes), so no capacity arithmetic. */
  budget?: "model" | "none";
  worldSlug: string | undefined;
  /** The chosen model, whose row is the only authority the capacity chip speaks from. */
  model: ManifestModel | null;
  /** What is already riding, durations resolved — consumed capacity (issue 305 §4). */
  carried: readonly MultimediaReference[];
  world: PickerSource[];
  session: PickerSource[];
  /** Everything under the world's characters. Absent where the picker has no world to read. */
  characters?: PickerSource[];
  /** Bench: the checked set, committed together and in order — one message, not N races. */
  onAdd?: (picks: ReadonlyArray<{ pick: PickerSource["pick"]; replace?: string }>) => void;
  /** Slot: the one choice. */
  onChoose?: (pick: PickerSource["pick"]) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  const [lane, setLane] = useState<"world" | "characters" | "session">("world");
  const [kindFilter, setKindFilter] = useState<PickerSource["kind"] | null>(null);
  const [search, setSearch] = useState("");
  /** The checked set, in pick order — committed together by Add (design 69a). */
  const [picks, setPicks] = useState<StagedPick[]>([]);
  /** The image tile waiting on "which token gives way" at the ceiling. */
  const [replacing, setReplacing] = useState<PickerSource | null>(null);

  const offered = (list: PickerSource[]): PickerSource[] => (only !== undefined ? list.filter((s) => s.kind === only) : list);
  const sources = offered(lane === "world" ? world : lane === "characters" ? (characters ?? []) : session);
  const searched = search.trim().toLowerCase();
  const visible = sources.filter(
    (s) =>
      (kindFilter === null || s.kind === kindFilter) &&
      (searched.length === 0 || s.name.toLowerCase().includes(searched) || s.meta.toLowerCase().includes(searched)),
  );

  const staged = (source: PickerSource): boolean => picks.some((p) => p.source.key === source.key);

  // Capacity counts what is riding AND what is checked — the chip answers "if I press Add".
  // A staged replacement frees the token it names, so the freed image leaves the count.
  const effectiveCarried = useMemo<MultimediaReference[]>(() => {
    const replaced = new Set(picks.map((p) => p.replace).filter((r): r is string => r !== undefined));
    return [
      ...(carried as Array<MultimediaReference & { token?: string }>).filter(
        (c) => c.token === undefined || !replaced.has(c.token),
      ),
      ...picks
        .filter((p) => p.source.kind !== "document" && p.source.kind !== "other")
        .map((p) => ({ kind: p.source.kind as ReferenceKind, durationSec: p.source.durationSec })),
    ];
  }, [carried, picks]);

  const capacity = model ? multimediaCapacity(effectiveCarried, model) : null;
  const sendable = visible.filter((s) => refusalFor(s) === null).length;

  /** The tile's refusal, or null when it can be picked as things stand. */
  function refusalFor(source: PickerSource): string | null {
    if (source.active || staged(source)) return null; // a state, not a refusal
    if (source.kind === "document") return "a document cannot be sent";
    if (source.kind === "other") return "this file cannot be sent";
    if (!model) return "choose a model first";
    if (budget === "none") return null;
    const verdict = admitReference({ kind: source.kind, durationSec: source.durationSec }, effectiveCarried, model);
    if (verdict.ok) return null;
    // At the image ceiling in bench mode the tile stays pickable — picking asks which token
    // gives way instead of refusing outright ("A fourth replaces one", design 69b).
    if (verdict.binding === "images" && mode === "bench" && replaceableTokens().length > 0) return null;
    return verdict.reason;
  }

  /** Active image tokens not already claimed by a staged replacement. */
  function replaceableTokens(): string[] {
    const claimed = new Set(picks.map((p) => p.replace).filter((r): r is string => r !== undefined));
    return (carried as Array<MultimediaReference & { token?: string }>)
      .filter((c) => c.kind === "image" && typeof c.token === "string" && !claimed.has(c.token))
      .map((c) => c.token as string);
  }

  /** The names the checked set will carry, said before they are added (issue 305 §4). */
  const previews = useMemo(() => {
    const used = new Map<ReferenceKind, number>();
    // Every lane, not the two this started with: a character's picture holds a number too, and
    // reading past it previewed a name already taken (issue 505).
    for (const s of [...world, ...session, ...(characters ?? [])]) {
      if (s.existingToken === undefined) continue;
      const parsed = parseBenchToken(s.existingToken);
      if (parsed) used.set(parsed.kind, Math.max(used.get(parsed.kind) ?? 0, parsed.n));
    }
    const byKey = new Map<string, string>();
    for (const p of picks) {
      if (p.source.existingToken !== undefined) {
        byKey.set(p.source.key, p.source.existingToken);
        continue;
      }
      if (p.source.kind === "document" || p.source.kind === "other") continue;
      const next = (used.get(p.source.kind) ?? 0) + 1;
      used.set(p.source.kind, next);
      byKey.set(p.source.key, benchTokenFor(p.source.kind, next));
    }
    return byKey;
  }, [picks, world, session, characters]);

  function pickTile(source: PickerSource): void {
    if (source.active) return;
    if (mode === "slot") {
      if (refusalFor(source) === null) onChoose?.(source.pick);
      return;
    }
    if (staged(source)) {
      setPicks((prev) => prev.filter((p) => p.source.key !== source.key));
      return;
    }
    if (refusalFor(source) !== null || !model) return;
    const verdict = admitReference(
      { kind: source.kind as ReferenceKind, durationSec: source.durationSec },
      effectiveCarried,
      model,
    );
    if (!verdict.ok && verdict.binding === "images") {
      // The replacement chooser (issue 305 §4): the new source takes its own next token; the
      // replaced token goes inactive; nothing inherits the removed name.
      setReplacing(source);
      return;
    }
    setPicks((prev) => [...prev, { source }]);
  }

  const capacityChip =
    model && capacity && budget === "model" ? (
      <span className="fy-refpicker__capacity">
        <strong style={{ fontWeight: 600, color: "var(--foreground)", fontFamily: "var(--font-sans)" }}>{model.displayName}</strong>
        <span>
          {`${capacity.imagesUsed} of ${capacity.imageCeiling} images`}
          {capacity.audioCeilingSec > 0
            ? ` · ${formatSeconds(capacity.audioUsedSec)} of ${formatSeconds(capacity.audioCeilingSec)} audio`
            : ""}
          {capacity.videoCeilingSec > 0
            ? ` · ${formatSeconds(capacity.videoUsedSec)} of ${formatSeconds(capacity.videoCeilingSec)} video`
            : ""}
        </span>
      </span>
    ) : null;

  const kindsPresent = (["image", "video", "audio", "document"] as const).filter(
    (k) => sources.some((s) => s.kind === k) || kindFilter === k,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="reference-picker">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, font: "650 17px var(--font-sans)", letterSpacing: "-0.01em" }}>
            {title ?? (mode === "slot" ? "Reference image" : "Add a reference")}
          </h2>
        </div>
        <button
          type="button"
          className="fy-gendialog__close"
          aria-label="Close the reference picker"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="fy-refpicker__lanes" role="group" aria-label="Where from">
          <button type="button" aria-pressed={lane === "world"} onClick={() => setLane("world")}>
            {`World artifacts ${offered(world).length}`}
          </button>
          {offered(characters ?? []).length > 0 && (
            <button
              type="button"
              data-testid="picker-lane-characters"
              aria-pressed={lane === "characters"}
              onClick={() => setLane("characters")}
            >
              {`Characters ${offered(characters ?? []).length}`}
            </button>
          )}
          {offered(session).length > 0 && (
            <button type="button" aria-pressed={lane === "session"} onClick={() => setLane("session")}>
              {`This session ${offered(session).length}`}
            </button>
          )}
          <button type="button" aria-pressed={false} onClick={onUpload}>
            Upload
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <span className="fy-refpicker__searchwrap">
          <Search size={13} />
          <input
            className="fy-refpicker__search"
            placeholder="Search artifacts"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          className={cx("fy-filterchip", kindFilter === null && "fy-filterchip--active")}
          onClick={() => setKindFilter(null)}
        >
          {`All ${sources.length}`}
        </button>
        {kindsPresent.map((k) => (
          <button
            key={k}
            type="button"
            className={cx("fy-filterchip", kindFilter === k && "fy-filterchip--active")}
            onClick={() => setKindFilter(k)}
          >
            {`${KIND_LABEL[k]} ${sources.filter((s) => s.kind === k).length}`}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {capacityChip}
      </div>

      {searched.length > 0 && (
        <div
          style={{
            padding: "10px 14px",
            border: "1px dashed var(--border)",
            borderRadius: 11,
            font: "400 11.5px var(--font-mono)",
            color: "var(--muted-foreground)",
          }}
        >
          {visible.length} result{visible.length === 1 ? "" : "s"} for “{search.trim()}” · {sendable} can be sent
        </div>
      )}

      <div className="fy-refpicker__grid">
        {visible.map((source) => {
          const isStaged = staged(source);
          const refusal = source.active || isStaged ? null : refusalFor(source);
          const preview = isStaged ? previews.get(source.key) : null;
          const checked = source.active === true || isStaged;
          return (
            <button
              key={source.key}
              type="button"
              className={cx("fy-refpicker__tile", checked && "fy-refpicker__tile--picked")}
              data-testid="picker-tile"
              data-refused={refusal !== null || undefined}
              disabled={refusal !== null && !source.active}
              onClick={() => pickTile(source)}
            >
              <div className="fy-refpicker__thumb">
                {source.imagePath ? (
                  <Portrait worldSlug={worldSlug} path={source.imagePath} label={source.name} radius={0} />
                ) : source.kind === "audio" ? (
                  <span className={cx("fy-refpicker__wave", refusal !== null && "fy-refpicker__wave--muted")}>
                    <Wave seed={source.name} width={104} height={20} />
                  </span>
                ) : source.kind === "document" ? (
                  <span className="fy-refpicker__doc" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </span>
                ) : (
                  <div className="fy-refpicker__kind">{source.kind}</div>
                )}
                {/* The mark exists only where picking is possible — an ineligible tile carries
                    its reason, not an empty circle (design 69a). */}
                {(refusal === null || source.active) && (
                  <span className={cx("fy-refpicker__check", checked && "fy-refpicker__check--on")} aria-hidden="true">
                    {checked ? "✓" : ""}
                  </span>
                )}
                {source.kind === "audio" && source.durationSec !== null && (
                  <span className="fy-refpicker__stamp">{formatSeconds(source.durationSec)}</span>
                )}
                {(source.active ? source.existingToken : (preview ?? source.existingToken)) && (
                  <span className="fy-refpicker__token">
                    {source.active ? `already ${source.existingToken}` : (preview ?? source.existingToken)}
                  </span>
                )}
              </div>
              <div className={cx("fy-refpicker__name", refusal !== null && "fy-refpicker__name--muted")}>{source.name}</div>
              <div className={cx("fy-refpicker__meta", refusal !== null && "fy-refpicker__meta--refused")}>
                {refusal ?? source.meta}
              </div>
            </button>
          );
        })}
        <button type="button" className="fy-refpicker__upload" onClick={onUpload}>
          <Upload size={16} />
          Upload a file
        </button>
      </div>

      {replacing !== null && (
        <div role="group" aria-label="Choose which reference to replace" className="fy-refpicker__replace">
          <span style={{ flex: 1, font: "400 11.5px var(--font-sans)" }}>
            <strong style={{ fontWeight: 600 }}>
              {`${capacity?.imageCeiling} of ${capacity?.imageCeiling} images.`}
            </strong>{" "}
            Which does {replacing.name} replace?
          </span>
          {replaceableTokens().map((token) => (
            <Button
              key={token}
              variant="ghost"
              onClick={() => {
                setPicks((prev) => [...prev, { source: replacing, replace: token }]);
                setReplacing(null);
              }}
            >
              {token}
            </Button>
          ))}
          <Button variant="ghost" onClick={() => setReplacing(null)}>
            Neither
          </Button>
        </div>
      )}

      <div className="fy-refpicker__foot">
        <span style={{ flex: 1, display: "inline-flex", alignItems: "center", gap: 7, font: "400 11.5px var(--font-sans)", color: "var(--muted-foreground)" }}>
          {mode === "bench" ? (
            picks.length === 0 ? (
              "Nothing picked yet."
            ) : (
              <>
                <strong style={{ fontWeight: 600, color: "var(--foreground)" }}>{`${picks.length} picked`}</strong>
                {picks.map((p) => {
                  const token = previews.get(p.source.key);
                  return token !== undefined ? (
                    <span key={p.source.key} className="fy-refpicker__pickchip">
                      {token}
                    </span>
                  ) : null;
                })}
                <button type="button" className="fy-refpicker__clear" onClick={() => setPicks([])}>
                  Clear
                </button>
              </>
            )
          ) : (
            note ?? "One picture rides with this brief."
          )}
        </span>
        {mode === "bench" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="picker-add"
              disabled={picks.length === 0}
              onClick={() => {
                onAdd?.(picks.map((p) => ({ pick: p.source.pick, ...(p.replace !== undefined ? { replace: p.replace } : {}) })));
                setPicks([]);
                onClose();
              }}
            >
              {picks.length > 0 ? `Add ${picks.length}` : "Add"}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Back to the brief
          </Button>
        )}
      </div>
    </div>
  );
}

/** The bench's frame: its own dialog. The slot frame is GenerationDialog's `panel`. */
export function ReferencePickerDialog({
  open,
  onClose,
  ...body
}: { open: boolean } & Parameters<typeof ReferencePickerBody>[0]) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="fy-gendialog fy-gendialog--wide"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className="fy-gendialog__panel">{open && <ReferencePickerBody {...body} onClose={() => dialog.current?.close()} />}</div>
    </dialog>
  );
}

/**
 * The active set as budget items WITH their tokens, for the picker's capacity + replacement.
 *
 * `sources` is every row a token could have come from — one list, not a lane at a time, so a
 * source the caller forgets cannot quietly resolve to no duration (issue 505).
 */
export function carriedForPicker(session: BenchSession, sources: readonly PickerSource[]): Array<MultimediaReference & { token: string }> {
  const byToken = new Map<string, PickerSource>();
  for (const s of sources) if (s.existingToken !== undefined) byToken.set(s.existingToken, s);
  return session.composer.activeTokens.map((token) => {
    const source = byToken.get(token);
    const entry = session.tokenRegistry.find((e) => e.token === token);
    return {
      token,
      kind: entry?.kind ?? "image",
      durationSec: source ? source.durationSec : null,
    };
  });
}
