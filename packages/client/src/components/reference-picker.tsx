import { useEffect, useMemo, useRef, useState } from "react";
import {
  admitReference,
  benchSourceKey,
  benchTokenFor,
  formatSeconds,
  multimediaCapacity,
  parseBenchToken,
  pickableArtifacts,
  type ArtifactSidecar,
  type BenchSession,
  type ManifestModel,
  type MultimediaReference,
  type ReferenceKind,
} from "@arke-studio/contracts";
import { Button, cx } from "./ui.js";
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
  pick: { source: "artifact"; artifactId: string } | { source: "take"; takeId: string };
}

/** The world's artifacts as picker rows, supersession already excluded. */
export function worldPickerSources(
  artifacts: readonly ArtifactSidecar[],
  session: BenchSession | null,
): PickerSource[] {
  const registry = new Map((session?.tokenRegistry ?? []).map((e) => [benchSourceKey(e.source), e.token]));
  const active = new Set(session?.composer.activeTokens ?? []);
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
        ...(a.origin.by === "system" && a.origin.producedBy === "bench" ? ["made here"] : []),
      ].join(" · "),
      durationSec: kind === "image" ? 0 : (a.mediaInfo?.durationSec ?? null),
      ...(token !== undefined ? { existingToken: token, active: active.has(token) } : {}),
      pick: { source: "artifact", artifactId: a.id },
    };
  });
}

/** The session's own takes as picker rows — picking an unkept one keeps its bytes riding. */
export function sessionPickerSources(session: BenchSession): PickerSource[] {
  const registry = new Map(session.tokenRegistry.map((e) => [benchSourceKey(e.source), e.token]));
  const active = new Set(session.composer.activeTokens);
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
  onAdd,
  onChoose,
  onUpload,
  onClose,
}: {
  /** "bench": ordered multi-pick with tokens. "slot": exactly one, no token namespace. */
  mode: "bench" | "slot";
  worldSlug: string | undefined;
  /** The chosen model, whose row is the only authority the capacity chip speaks from. */
  model: ManifestModel | null;
  /** What is already riding, durations resolved — consumed capacity (issue 305 §4). */
  carried: readonly MultimediaReference[];
  world: PickerSource[];
  session: PickerSource[];
  /** Bench: the checked set, committed together and in order — one message, not N races. */
  onAdd?: (picks: ReadonlyArray<{ pick: PickerSource["pick"]; replace?: string }>) => void;
  /** Slot: the one choice. */
  onChoose?: (pick: PickerSource["pick"]) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  const [lane, setLane] = useState<"world" | "session">("world");
  const [kindFilter, setKindFilter] = useState<PickerSource["kind"] | null>(null);
  const [search, setSearch] = useState("");
  /** The checked set, in pick order — committed together by Add (design 69a). */
  const [picks, setPicks] = useState<StagedPick[]>([]);
  /** The image tile waiting on "which token gives way" at the ceiling. */
  const [replacing, setReplacing] = useState<PickerSource | null>(null);

  const sources = lane === "world" ? world : session;
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
    for (const s of [...world, ...session]) {
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
  }, [picks, world, session]);

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
    model && capacity ? (
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
            {mode === "slot" ? "Reference image" : "Add a reference"}
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
            {`World artifacts ${world.length}`}
          </button>
          {mode === "bench" && (
            <button type="button" aria-pressed={lane === "session"} onClick={() => setLane("session")}>
              {`This session ${session.length}`}
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
            "One picture rides with this brief."
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

/** The active set as budget items WITH their tokens, for the picker's capacity + replacement. */
export function carriedForPicker(session: BenchSession, world: PickerSource[], sessionSources: PickerSource[]): Array<MultimediaReference & { token: string }> {
  const byToken = new Map<string, PickerSource>();
  for (const s of [...world, ...sessionSources]) if (s.existingToken !== undefined) byToken.set(s.existingToken, s);
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
