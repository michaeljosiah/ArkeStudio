import { useEffect, useRef, useState } from "react";
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

/**
 * One reference picker for every surface that asks for one (issue 305 §4, design 69).
 *
 * Three entrances, two frames: the bench opens it as a dialog and picks an ordered set; the
 * standard GenerationDialog hands it the dialog's own panel and picks exactly one — never a
 * dialog over a dialog. The refusals here are predictions made with the SAME functions the
 * coordinator re-runs before enqueue, so a tile that says "this model takes no audio" is the
 * same sentence dispatch would have refused with.
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
  /** Bench: one pick, optionally replacing an active token at the image ceiling. */
  onAdd?: (pick: PickerSource["pick"], replace?: string) => void;
  /** Slot: the one choice. */
  onChoose?: (pick: PickerSource["pick"]) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  const [lane, setLane] = useState<"world" | "session">("world");
  const [kindFilter, setKindFilter] = useState<PickerSource["kind"] | null>(null);
  const [search, setSearch] = useState("");
  /** The image tile waiting on "which token gives way" at the ceiling. */
  const [replacing, setReplacing] = useState<PickerSource | null>(null);

  const sources = lane === "world" ? world : session;
  const searched = search.trim().toLowerCase();
  const visible = sources.filter(
    (s) =>
      (kindFilter === null || s.kind === kindFilter) &&
      (searched.length === 0 || s.name.toLowerCase().includes(searched) || s.meta.toLowerCase().includes(searched)),
  );
  const sendable = visible.filter((s) => refusalFor(s) === null).length;

  const capacity = model ? multimediaCapacity(carried, model) : null;

  /** The tile's refusal, or null when it can be picked as things stand. */
  function refusalFor(source: PickerSource): string | null {
    if (source.active) return null; // "already riding" is a state, not a refusal
    if (source.kind === "document") return "a document cannot be sent";
    if (source.kind === "other") return "this file cannot be sent";
    if (!model) return "choose a model first";
    const verdict = admitReference({ kind: source.kind, durationSec: source.durationSec }, carried, model);
    if (verdict.ok) return null;
    // At the image ceiling in bench mode the tile stays pickable — picking asks which token
    // gives way instead of refusing outright ("A fourth replaces one", design 69b).
    if (verdict.binding === "images" && mode === "bench" && activeImageTokens().length > 0) return null;
    return verdict.reason;
  }

  function activeImageTokens(): string[] {
    return (carried as Array<MultimediaReference & { token?: string }>)
      .filter((c) => c.kind === "image" && typeof c.token === "string")
      .map((c) => c.token as string);
  }

  /** The name a NEW pick will carry, said before it is added (issue 305 §4). */
  function tokenPreview(source: PickerSource): string | null {
    if (mode !== "bench" || !session) return null;
    if (source.existingToken !== undefined) return source.existingToken;
    if (source.kind === "document" || source.kind === "other") return null;
    // Next number of this kind, from the workspace the host passed via existing tokens.
    const used = [...world, ...session]
      .map((s) => s.existingToken)
      .filter((t): t is string => t !== undefined)
      .map((t) => parseBenchToken(t))
      .filter((p): p is NonNullable<ReturnType<typeof parseBenchToken>> => p !== null && p.kind === source.kind)
      .map((p) => p.n);
    const next = used.length === 0 ? 1 : Math.max(...used) + 1;
    return benchTokenFor(source.kind, next);
  }

  function pickTile(source: PickerSource): void {
    if (source.active) return;
    const refusal = refusalFor(source);
    if (refusal !== null) return;
    if (mode === "slot") {
      onChoose?.(source.pick);
      return;
    }
    if (!model) return;
    const verdict = admitReference({ kind: source.kind as ReferenceKind, durationSec: source.durationSec }, carried, model);
    if (!verdict.ok && verdict.binding === "images") {
      // The replacement chooser (issue 305 §4): the new source takes its own next token; the
      // replaced token goes inactive; nothing inherits the removed name.
      setReplacing(source);
      return;
    }
    onAdd?.(source.pick);
  }

  const capacityChip =
    model && capacity ? (
      <span className="fy-filterchip" style={{ cursor: "default", display: "inline-flex", gap: 8 }}>
        <strong style={{ fontWeight: 600 }}>{model.displayName}</strong>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted-foreground)" }}>
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
        <div className="fy-filterrow" style={{ marginTop: 0 }}>
          <button
            type="button"
            className={cx("fy-filterchip", lane === "world" && "fy-filterchip--active")}
            onClick={() => setLane("world")}
          >
            {`World artifacts ${world.length}`}
          </button>
          {mode === "bench" && (
            <button
              type="button"
              className={cx("fy-filterchip", lane === "session" && "fy-filterchip--active")}
              onClick={() => setLane("session")}
            >
              {`This session ${session.length}`}
            </button>
          )}
          <button type="button" className="fy-filterchip" onClick={onUpload}>
            Upload
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <input
          className="scr-input"
          style={{ minWidth: 180, height: 30 }}
          placeholder="Search artifacts"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {([null, "image", "video", "audio", "document"] as const).map((k) => (
          <button
            key={k ?? "all"}
            type="button"
            className={cx("fy-filterchip", kindFilter === k && "fy-filterchip--active")}
            onClick={() => setKindFilter(k)}
          >
            {k === null ? `All ${sources.length}` : `${k[0]!.toUpperCase()}${k.slice(1)} ${sources.filter((s) => s.kind === k).length}`}
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

      <div className="fy-cardgrid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, paddingTop: 0 }}>
        {visible.map((source) => {
          const refusal = source.active ? null : refusalFor(source);
          const preview = refusal === null && !source.active ? tokenPreview(source) : null;
          return (
            <button
              key={source.key}
              type="button"
              className="fy-gridcard"
              data-testid="picker-tile"
              data-refused={refusal !== null || undefined}
              disabled={refusal !== null && !source.active}
              onClick={() => pickTile(source)}
              style={{
                padding: 10,
                textAlign: "left",
                opacity: refusal !== null || source.active ? 0.55 : 1,
                cursor: refusal !== null || source.active ? "not-allowed" : "pointer",
              }}
            >
              <div style={{ width: "100%", height: 84, position: "relative" }}>
                {source.imagePath ? (
                  <Portrait worldSlug={worldSlug} path={source.imagePath} label={source.name} />
                ) : (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      borderRadius: 7,
                      background: "var(--muted)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      font: "400 10px var(--font-mono)",
                      color: "var(--muted-foreground)",
                    }}
                  >
                    {source.kind}
                    {source.durationSec !== null && source.kind !== "image" ? ` · ${formatSeconds(source.durationSec)}` : ""}
                  </div>
                )}
                {(source.existingToken ?? preview) && (
                  <span
                    style={{
                      position: "absolute",
                      left: 6,
                      bottom: 6,
                      padding: "2px 7px",
                      borderRadius: 5,
                      background: "color-mix(in srgb, var(--media-overlay-bg) 68%, transparent)",
                      color: "var(--media-overlay-fg)",
                      font: "500 9.5px var(--font-sans)",
                    }}
                  >
                    {source.active ? `already ${source.existingToken}` : (source.existingToken ?? preview)}
                  </span>
                )}
              </div>
              <div style={{ font: "600 11.5px var(--font-sans)", marginTop: 8, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                {source.name}
              </div>
              <div
                style={{
                  font: "400 9.5px var(--font-mono)",
                  color: refusal !== null ? "var(--destructive)" : "var(--neutral-400)",
                  marginTop: 2,
                }}
              >
                {refusal ?? source.meta}
              </div>
            </button>
          );
        })}
        <button
          type="button"
          onClick={onUpload}
          style={{
            border: "1.5px dashed var(--neutral-300)",
            borderRadius: 11,
            minHeight: 120,
            background: "transparent",
            color: "var(--muted-foreground)",
            font: "500 11px var(--font-sans)",
            cursor: "pointer",
          }}
        >
          Upload a file
        </button>
      </div>

      {replacing !== null && (
        <div
          role="group"
          aria-label="Choose which reference to replace"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 12px",
            border: "1px solid var(--border)",
            borderLeft: "2px solid var(--warning)",
            borderRadius: 9,
            background: "var(--muted)",
          }}
        >
          <span style={{ flex: 1, font: "400 11.5px var(--font-sans)" }}>
            <strong style={{ fontWeight: 600 }}>
              {`${capacity?.imageCeiling} of ${capacity?.imageCeiling} images.`}
            </strong>{" "}
            Which does {replacing.name} replace?
          </span>
          {activeImageTokens().map((token) => (
            <Button
              key={token}
              variant="ghost"
              onClick={() => {
                onAdd?.(replacing.pick, token);
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

      <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
        <span style={{ flex: 1, font: "400 11.5px var(--font-sans)", color: "var(--muted-foreground)" }}>
          {mode === "bench" ? `${carried.length} riding` : "One picture rides with this brief."}
        </span>
        <Button variant="ghost" onClick={onClose}>
          {mode === "slot" ? "Back to the brief" : "Done"}
        </Button>
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
