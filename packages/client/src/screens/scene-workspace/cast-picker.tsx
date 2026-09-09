import { useEffect, useRef } from "react";
import {
  guestsOf,
  orderedShots,
  pickableSheets,
  resolveCast,
  type ProductionBundle,
  type SceneRecord,
  type Sheet,
  type WorldBundle,
} from "@arke-studio/contracts";
import { X } from "../../components/icons.js";
import { characterPortraitPath, locationPortraitPath } from "../../components/portrait.js";
import { initials } from "../../lib/format.js";
import { mediaUrl } from "../../lib/media.js";

export type CastPickerMode = "character" | "location" | "change-location";

/** A scene's shots, or none: another scene's malformed flow is its own problem, not this door's. */
function shotsOf(scene: SceneRecord) {
  try { return orderedShots(scene); } catch { return []; }
}

/**
 * The scene's cast, in the order the tiles draw it (SPEC-044 R-1): the characters its shots cite,
 * by first appearance, then the members added by hand in the order they were added. A member
 * whose citing shot is gone stays a member (R-5), so the explicit half is every cast key.
 */
export function sceneCast(scene: SceneRecord, sheets: readonly Sheet[]): string[] {
  const order: string[] = [];
  for (const shot of orderedShots(scene)) {
    for (const entry of resolveCast(shot.description, sheets as Sheet[]).cast) {
      if (entry.sheet.type === "character" && !order.includes(entry.sheet.id)) order.push(entry.sheet.id);
    }
  }
  for (const sheetId of Object.keys(scene.cast ?? {})) if (!order.includes(sheetId)) order.push(sheetId);
  return order;
}

/**
 * A sheet's picture with its initial behind it. The portrait paths are conventions, not
 * promises — a location without a view names a file that has never existed — so a picture
 * that does not arrive leaves the initial standing rather than a broken-image glyph.
 */
export function SheetPicture({ world, sheet }: { world: WorldBundle; sheet: Sheet }) {
  const path = sheet.type === "location" ? locationPortraitPath(world, sheet.id) : characterPortraitPath(world, sheet.id);
  return (
    <>
      <span aria-hidden="true">{initials(sheet.name).slice(0, 1)}</span>
      <img
        src={mediaUrl(world.meta.slug, path)}
        alt=""
        draggable={false}
        onError={(event) => { event.currentTarget.style.display = "none"; }}
      />
    </>
  );
}

/**
 * One picker for both doors (SPEC-044 R-4): the production's own cast first, then the world's,
 * as portrait cards. A press adds and closes; nothing else is asked, because a member's voice and
 * look have defaults (R-8). Modal on the app frame like the lightbox, and for the same reason:
 * it is a choice about this scene, not a place to go.
 */
export function CastPicker({
  world,
  production,
  scene,
  mode,
  onPick,
  onClose,
}: {
  world: WorldBundle;
  production: ProductionBundle;
  scene: SceneRecord;
  mode: CastPickerMode;
  onPick: (sheetId: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (node === null) return;
    if (node.showModal !== undefined) node.showModal();
    else node.setAttribute("open", "");
  }, []);
  const type = mode === "character" ? "character" : "location";
  const offered = pickableSheets(world.sheets, production.meta.id).filter((sheet) => sheet.type === type && sheet.retired !== true);
  // The production's own: what its scenes cite or stand in, plus its guests — the Cast screen's
  // two bands, in the order the world keeps them.
  const cited = new Set(
    production.scenes.flatMap((candidate) => [
      ...(candidate.inherits?.location === undefined ? [] : [candidate.inherits.location]),
      ...shotsOf(candidate).flatMap((shot) => resolveCast(shot.description, world.sheets).cast.map((entry) => entry.sheet.id)),
    ]),
  );
  const guests = new Set(guestsOf(world.sheets, production.meta.id).map((sheet) => sheet.id));
  const own = offered.filter((sheet) => cited.has(sheet.id) || guests.has(sheet.id));
  const rest = offered.filter((sheet) => !own.includes(sheet));
  const held = new Set(type === "character" ? sceneCast(scene, world.sheets) : scene.inherits?.location === undefined ? [] : [scene.inherits.location]);
  const title = mode === "character" ? `Add a character · scene ${scene.number}` : mode === "location" ? "Add a location" : "Change location";
  const section = (label: string, sheets: Sheet[]) =>
    sheets.length === 0 ? null : (
      <div className="fy-castpicker__section" key={label}>
        <div className="fy-castpicker__label">{label}</div>
        <div className="fy-castpicker__cards">
          {sheets.map((sheet) => {
            const inScene = held.has(sheet.id);
            return (
              <button
                type="button"
                key={sheet.id}
                className="fy-castpicker__card"
                disabled={inScene}
                aria-label={inScene ? `${sheet.name} · in the scene` : sheet.name}
                onClick={() => onPick(sheet.id)}
              >
                <span className="fy-castpicker__portrait" aria-hidden="true"><SheetPicture world={world} sheet={sheet} /></span>
                <span className="fy-castpicker__name">{sheet.name}</span>
                <span className="fy-castpicker__meta">{inScene ? "in the scene" : `sheet v${sheet.version}`}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  return (
    <dialog
      ref={dialog}
      className="fy-castpicker"
      aria-label={title}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="fy-castpicker__panel">
        <div className="fy-castpicker__head">
          <span className="fy-castpicker__title">{title}</span>
          <button type="button" className="fy-castpicker__close" aria-label="Close" onClick={onClose}><X size={13} /></button>
        </div>
        {section(`In ${production.meta.title}`, own)}
        {section("From the world", rest)}
        {offered.length === 0 ? <div className="fy-castpicker__empty">{type === "character" ? "no characters in this world yet" : "no locations in this world yet"}</div> : null}
      </div>
    </dialog>
  );
}
