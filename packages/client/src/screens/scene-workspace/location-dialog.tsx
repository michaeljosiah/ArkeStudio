import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import {
  lookHoldingScope,
  mainPhotoFor,
  orderedLocationViews,
  type ProductionBundle,
  type SceneRecord,
  type WorldBundle,
} from "@arke-studio/contracts";
import { X } from "../../components/icons.js";
import { Button } from "../../components/ui.js";
import { locationPortraitPath } from "../../components/portrait.js";
import { mediaUrl } from "../../lib/media.js";
import { attachCharacterLook } from "../../lib/store.js";
import { Card } from "./character-dialog.js";

/**
 * The scene's place (SPEC-044 R-17..R-21), in the character dialog's shape with one row. A
 * location is context, not cast: the plate on the left is what every shot set here rides, and
 * the row chooses which of the kit's views that is. A view pressed becomes a look attached to
 * this scene on the location's kit, so the planner's one scoping rule carries it (R-18, §2.6).
 */
export function LocationDialog({ world, production, scene, onClose, onChangeLocation }: {
  world: WorldBundle; production: ProductionBundle; scene: SceneRecord; onClose: () => void; onChangeLocation: () => void;
}) {
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (node === null) return;
    if (node.showModal !== undefined) node.showModal();
    else node.setAttribute("open", "");
  }, []);
  const worldId = world.meta.worldId, productionId = production.meta.id;
  const sheetId = scene.inherits?.location ?? "";
  const sheet = world.sheets.find((candidate) => candidate.id === sheetId);
  const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheetId) ?? null;
  const name = sheet?.name ?? sheetId;
  const views = kit === null ? [] : orderedLocationViews(kit);
  const establishing = views.find((view) => view.id === kit?.establishingViewId) ?? views[0];
  const photo = kit === null ? null : mainPhotoFor(kit);
  const sceneLook = lookHoldingScope(kit, { kind: "scene", productionId, sceneId: scene.id });
  const inUse = sceneLook?.file ?? establishing?.file ?? photo?.file;
  const picture = inUse === undefined ? locationPortraitPath(world, sheetId) : `references/${sheetId}/${inUse}`;
  // A shot cannot override the scene's place today (a shot's overrides are its framing), so the
  // plate is every shot's; R-21's "shots set here" waits for a shot-level place to exist.
  const facts = ["location", sheet === undefined ? null : `sheet v${sheet.version}`, "every shot in the scene", scene.inherits?.timeOfDay ?? null]
    .filter((part): part is string => part !== null);
  const thumb = (file: string) => (
    <span className="fy-chardialog__thumb"><img src={mediaUrl(world.meta.slug, `references/${sheetId}/${file}`)} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /></span>
  );
  const others = views.filter((view) => view.id !== establishing?.id);
  return (
    <dialog
      ref={dialog}
      className="fy-chardialog"
      aria-label={`${name} in scene ${scene.number}`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="fy-chardialog__panel">
        <div className="fy-chardialog__picture" aria-hidden="true">
          <img src={mediaUrl(world.meta.slug, picture)} alt="" draggable={false} onError={(event) => { event.currentTarget.style.display = "none"; }} />
        </div>
        <div className="fy-chardialog__body">
          <div className="fy-chardialog__head">
            <span className="fy-chardialog__title">
              <span className="fy-chardialog__name">{name}</span>
              <span className="fy-chardialog__facts">{facts.join(" · ")}</span>
            </span>
            <button type="button" className="fy-chardialog__close" aria-label="Close" onClick={onClose}><X size={13} /></button>
          </div>
          <div className="fy-chardialog__row" aria-label="Plate">
            <div className="fy-chardialog__label">Plate</div>
            <div className="fy-chardialog__cards">
              <Card
                on={sceneLook === undefined}
                label={establishing?.name ?? "Establishing view"}
                sub="kit"
                thumb={establishing !== undefined ? thumb(establishing.file) : photo !== null ? thumb(photo.file) : undefined}
                disabled={establishing === undefined && photo === null}
                onPress={() => { if (sceneLook !== undefined) attachCharacterLook(worldId, sheetId, sceneLook.id, null); }}
              />
              {others.map((view) => (
                <Card
                  key={view.id}
                  on={sceneLook?.id === view.id}
                  label={view.name}
                  sub={sceneLook?.id === view.id ? "this scene" : "view"}
                  thumb={thumb(view.file)}
                  onPress={() => attachCharacterLook(worldId, sheetId, view.id, { kind: "scene", productionId, sceneId: scene.id })}
                />
              ))}
              <Card door label="Add a plate" sub="Location page" onPress={() => { onClose(); navigate(`/w/${worldId}/locations/${sheetId}/reference`); }} />
            </div>
          </div>
          <span className="fy-chardialog__spacer" />
          <div className="fy-chardialog__foot">
            <Button variant="ghost" size="sm" onClick={onChangeLocation}>Change location</Button>
            <span className="fy-chardialog__spacer" />
            <Button variant="primary" size="sm" onClick={onClose}>Done</Button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
