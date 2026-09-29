import {
  attachmentFor,
  guestsOf,
  lookHoldingScope,
  pendingGuestsOf,
  pendingSheets,
  worldSheets,
  type CharacterLook,
  type CompiledReference,
  type ProductionBundle,
  type Sheet,
  type WorldBundle,
} from "@arke-studio/contracts";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { EmptyState, Screen } from "../components/layout.js";
import {
  characterPortraitPath,
  locationPortraitPath,
  Portrait,
  sheetPortraitPath,
} from "../components/portrait.js";
import { Button, Card, Input, Textarea } from "../components/ui.js";
import { ConnectedProposalPanel } from "../domain/connected.js";
import { useProduction } from "../lib/selectors.js";
import { attachCharacterLook, createSheetFromSentence } from "../lib/store.js";
import { lookTileLabel } from "./character-reference.js";

/**
 * What each character wears in this production (design 67).
 *
 * A look is attached on the character's own looks page, and until now the production it was
 * attached *to* had no idea: `production.tsx` never mentioned character looks, and the dispatch
 * dialog counts references without naming one. So the one decision that changes what a model
 * receives for this production was made on a screen belonging to the world, and confirmed
 * nowhere. This is the return path — the production says who it is sending, and lets the choice
 * be made where the consequence lives.
 *
 * Rows exist only for characters that have accepted looks: a character with no alternatives has
 * no choice to offer, and a row saying so is noise.
 */
function ProductionWardrobe({
  world,
  production,
  characters,
}: {
  world: WorldBundle;
  production: ProductionBundle;
  characters: Sheet[];
}) {
  const rows = characters
    .map((sheet) => {
      const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheet.id) ?? null;
      const looks = kit?.looks ?? [];
      return { sheet, kit, looks };
    })
    .filter((row) => row.looks.length > 0);
  if (rows.length === 0) return null;
  return (
    <>
      <div className="fy-eyebrow-sm" style={{ padding: "10px 90px 0" }}>
        WARDROBE · IN {production.meta.title.toUpperCase()} · {rows.length}
      </div>
      <div className="fy-wardrobe">
        {rows.map(({ sheet, kit, looks }) => {
          // The file the dispatcher would actually attach, resolved by the same function it
          // resolves with — not a second opinion about what rides.
          const riding = attachmentFor(kit, sheet, "primary", { productionId: production.meta.id });
          // The same rule the dispatcher resolves with, not a second `.find` over the same array
          // (codex round 4): on an upgraded kit holding two production-scoped looks, marking the
          // first while the dispatcher carries the latest is a false confirmation of the one
          // thing this row exists to confirm.
          const held = lookHoldingScope(kit, { kind: "production", productionId: production.meta.id });
          /* Scene attachments are stated, not offered: this row is the production's altitude,
             and a scene's own choice belongs on the scene. Narrower scope wins at dispatch, so
             a row claiming to be the whole answer while a scene overrides it would be lying. */
          const labels = lookPickerLabels(looks);
          // Read per scene, not per look, so each scene resolves to the one look the dispatcher
          // would carry. Walking the looks instead listed every claimant, and an upgraded kit can
          // hold two on one scene — so the line reported two live appearances for a scene that
          // dispatches one, on the row whose whole job is saying which. It also reads in scene
          // order now, which is the order somebody looks for a scene in.
          const perScene = production.scenes.flatMap((scene) => {
            const look = lookHoldingScope(kit, {
              kind: "scene",
              productionId: production.meta.id,
              sceneId: scene.id,
            });
            return look ? [{ id: look.id, scene, label: labels.get(look.id) ?? "" }] : [];
          });
          return (
            <div className="fy-wardrobe__row" key={sheet.id}>
              <div className="fy-wardrobe__thumb">
                <Portrait
                  worldSlug={world.meta.slug}
                  path={riding.file ?? sheetPortraitPath(sheet.id)}
                  label={sheet.name}
                  radius={8}
                />
              </div>
              <div className="fy-wardrobe__who">
                <span className="fy-wardrobe__name">{sheet.name}</span>
                {perScene.length > 0 && (
                  <span className="fy-wardrobe__scenes">
                    {perScene.map((entry) => `Sc ${entry.scene.number} · ${entry.label}`).join("  ")}
                  </span>
                )}
              </div>
              <label className="fy-wardrobe__pick">
                <span>Wears</span>
                <select
                  value={held?.id ?? ""}
                  onChange={(event) => {
                    const chosen = event.target.value;
                    // One frame either way (issue 384's lesson about concurrent frames): choosing a
                    // look attaches it and the coordinator displaces the incumbent; choosing the
                    // identity package detaches the one that is held.
                    if (chosen === "") {
                      if (held) attachCharacterLook(world.meta.worldId, sheet.id, held.id, null);
                      return;
                    }
                    attachCharacterLook(world.meta.worldId, sheet.id, chosen, {
                      kind: "production",
                      productionId: production.meta.id,
                    });
                  }}
                >
                  <option value="">Identity package</option>
                  {looks.map((look) => {
                    const elsewhere = lookOptionScope(look, production, world.productions);
                    return (
                      <option key={look.id} value={look.id}>
                        {labels.get(look.id) ?? ""}
                        {elsewhere ? ` · ${elsewhere}` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function ProductionCastScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const [drafting, setDrafting] = useState<{
    type: "character" | "location" | "faction";
    name: string;
    sentence: string;
  } | null>(null);
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);

  if (!world || !production) {
    return (
      <Screen id="production-cast">
        <EmptyState title="Opening the cast…" />
      </Screen>
    );
  }
  const guests = guestsOf(world.sheets, production.meta.id).filter((s) => s.retired !== true);
  const fromWorld = worldSheets(world.sheets).filter((s) => s.retired !== true);
  // Guests under review are kept off the world's surfaces, so they have to be visible here or a
  // staged guest is nowhere at all until it is accepted (SPEC-020 R-8, R-9).
  const pendingGuests = (["character", "location", "faction"] as const).flatMap((kind) =>
    pendingGuestsOf(pendingSheets(world.proposals, kind, world.conversations), production.meta.id),
  );
  const kindLabel = (sheet: Sheet) =>
    sheet.type === "character" ? "character" : sheet.type === "location" ? "location" : "faction";

  const card = (sheet: Sheet, guest: boolean) => (
    <button
      key={sheet.id}
      type="button"
      className="fy-gridcard fy-gridcard--media fy-gridcard--fixed"
      onClick={() =>
        navigate(`/w/${worldId}/${sheet.type === "character" ? "cast" : `${sheet.type}s`}/${sheet.id}`)
      }
    >
      <div className="fy-gridcard__frame" style={{ height: 210 }}>
        <Portrait worldSlug={world.meta.slug}
          path={sheet.type === "character" ? characterPortraitPath(world, sheet.id)
            : sheet.type === "location" ? locationPortraitPath(world, sheet.id) : sheetPortraitPath(sheet.id)}
          label={sheet.name} />
      </div>
      <div className="fy-gridcard__pad">
        <div className="fy-gridcard__title">
          <span className="fy-gridcard__name">{sheet.name}</span>
        </div>
        <div className="fy-gridcard__body">{sheet.role ?? sheet.region ?? kindLabel(sheet)}</div>
        {/* The status was a dot after the name with nothing to read it against (issue 1010, U3).
            It joins the foot, where the world's own cards already put it in words. */}
        <div className="fy-gridcard__foot" style={{ marginTop: 9 }}>
          {guest ? "guest" : kindLabel(sheet)} · {sheet.status === "locked" ? "locked" : "sketch"} · v
          {sheet.version}
        </div>
      </div>
    </button>
  );

  const columns = (n: number) => ({
    gridTemplateColumns: `repeat(${Math.min(Math.max(n, 2), 4)}, minmax(0, 1fr))`,
  });

  return (
    <div className="fy-prodscroll" data-screen="production-cast">
      <div className="fy-hero">
        <div className="fy-eyebrow-sm">CAST · {production.meta.title.toUpperCase()}</div>
        <h1 className="fy-hero__title" style={{ fontSize: 52 }}>
          Cast
        </h1>
        <Button
          variant="primary"
          style={{ marginTop: 16 }}
          onClick={() =>
            setDrafting(drafting === null ? { type: "character", name: "", sentence: "" } : null)
          }
        >
          New guest
        </Button>
      </div>

      {drafting !== null && (
        <Card className="scr-form">
          <div className="scr-field">
            <label className="scr-field__label">
              A guest of {production.meta.title} — a full sheet, kept out of the world's cast until you
              promote it
            </label>
            <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: 8 }}>
              {(["character", "location", "faction"] as const).map((type) => (
                <Button
                  key={type}
                  variant={drafting.type === type ? "primary" : "ghost"}
                  onClick={() => setDrafting({ ...drafting, type })}
                >
                  {type}
                </Button>
              ))}
            </div>
            <Input
              placeholder="Name"
              value={drafting.name}
              onChange={(e) => setDrafting({ ...drafting, name: e.target.value })}
            />
          </div>
          <div className="scr-field">
            <label className="scr-field__label">
              One sentence — the agent drafts the rest inside the sketch
            </label>
            <Textarea
              rows={2}
              value={drafting.sentence}
              onChange={(e) => setDrafting({ ...drafting, sentence: e.target.value })}
            />
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              variant="primary"
              disabled={drafting.name.trim().length === 0 || drafting.sentence.trim().length === 0}
              onClick={() => {
                if (worldId) {
                  createSheetFromSentence(
                    worldId,
                    drafting.type,
                    drafting.name.trim(),
                    drafting.sentence.trim(),
                    false,
                    production.meta.id,
                  );
                }
                setDrafting(null);
              }}
            >
              Stage guest
            </Button>
            <Button variant="ghost" onClick={() => setDrafting(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      <div className="fy-eyebrow-sm" style={{ padding: "10px 90px 0" }}>
        GUESTS · ONLY IN {production.meta.title.toUpperCase()} · {guests.length + pendingGuests.length}
      </div>
      {guests.length + pendingGuests.length === 0 ? (
        <div style={{ padding: "0 90px" }}>
          <EmptyState
            title="No guests yet"
            hint="Add characters, locations or factions that belong only to this production."
          />
        </div>
      ) : (
        <div className="fy-cardgrid" style={columns(guests.length + pendingGuests.length)}>
          {pendingGuests.map((p) => (
            <button
              type="button"
              key={p.proposalId}
              className="fy-gridcard fy-gridcard--media fy-gridcard--fixed fy-gridcard--quiet"
              onClick={() => {
                if (p.decision.mode === "attended" && p.decision.owner.kind === "surface") {
                  setPendingDecision(p.proposalId);
                } else if (p.decision.mode === "attended" && p.decision.owner.kind === "world-chat") {
                  navigate(`/w/${worldId}/chat/${p.decision.owner.conversationId}`);
                } else {
                  navigate(`/w/${worldId}/proposals`);
                }
              }}
            >
              <div className="fy-gridcard__frame" style={{ height: 210 }} />
              <div className="fy-gridcard__pad">
                <div className="fy-gridcard__title">
                  <span className="fy-gridcard__name">{p.name}</span>
                </div>
                <div className="fy-gridcard__body">awaiting review</div>
                <div className="fy-gridcard__foot" style={{ marginTop: 9 }}>
                  guest · not yet accepted
                </div>
              </div>
            </button>
          ))}
          {guests.map((sheet) => card(sheet, true))}
        </div>
      )}
      {(() => {
        const staged = world.proposals.find((proposal) => proposal.proposal.id === pendingDecision);
        return staged ? (
          <div style={{ padding: "0 90px 24px" }}>
            <ConnectedProposalPanel
              key={staged.proposal.id}
              staged={staged}
              conversationPath={staged.proposal.targets[0]!.path}
            />
          </div>
        ) : null;
      })()}

      <div className="fy-eyebrow-sm" style={{ padding: "10px 90px 0" }}>
        FROM {world.meta.name.toUpperCase()} · SHARED · {fromWorld.length}
      </div>
      {fromWorld.length === 0 ? (
        <div style={{ padding: "0 90px" }}>
          <EmptyState
            title="The world has no cast yet"
            hint="Everything this production cites would be its own."
          />
        </div>
      ) : (
        <div className="fy-cardgrid" style={columns(fromWorld.length)}>
          {fromWorld.map((sheet) => card(sheet, false))}
        </div>
      )}

      <ProductionWardrobe
        world={world}
        production={production}
        characters={[...guests, ...fromWorld].filter((sheet) => sheet.type === "character")}
      />
    </div>
  );
}

/**
 * Who rides, and who rides in a look (design 67).
 *
 * `refs ×3` said how many images travel and nothing about what they are — so the one decision a
 * production makes about a character's appearance reached the model without ever appearing on the
 * screen that authorises the spend. A look attached on the character's page changed the request
 * silently, and the only way to find out was to read the take that came back.
 *
 * Subjects are named once each; the count beside it still says how many images that is, which is
 * the other fact, and a subject carrying two references is one subject either way.
 */
export function carriedSubjects(references: readonly CompiledReference[]): string {
  // Keyed by sheet, displayed by name. Two sheets can carry one name — creation uniquifies the
  // slug, never the name — and keying by the name merged them into one entry whose `(look)`
  // could then belong to the other person entirely. Naming who rides is the whole point here.
  const subjects = new Map<string, { subject: string; look: boolean }>();
  for (const reference of references) {
    const held = subjects.get(reference.sheetId);
    subjects.set(reference.sheetId, {
      subject: reference.subject,
      look: (held?.look ?? false) || reference.mode === "scoped-look",
    });
  }
  return [...subjects.values()]
    .map((entry) => (entry.look ? `${entry.subject} (look)` : entry.subject))
    .join(", ");
}

// ---- Cast (SPEC-020) -------------------------------------------------------

/**
 * The production's cast, in two bands: the guests it owns, and the world's cast it draws on.
 *
 * The bands are the whole point of the screen (R-9). Both sets of people are equally usable in a
 * shot — a guest is a full sheet, and resolution never asks who owns it (R-5) — so the only thing
 * separating them is what happens to them when this production ends. Naming that on the surface
 * is cheaper than discovering it later, when a one-off barman has quietly become part of the
 * world's permanent record.
 */
/**
 * The picker's labels, disambiguated only where they collide (codex round 2).
 *
 * A look's caption is the exploration's own words, and one exploration returns several results —
 * so accepting more than one from a batch gives looks whose `prompt` and `kind` are identical and
 * whose ids and files are not. The picker is text, unlike the gallery it came from, so those
 * arrived as several indistinguishable options over different images.
 *
 * Numbered in acceptance order, which is the order the kit stores them in, and only where a
 * caption is claimed more than once — a lone look carries no number to read.
 */
export function lookPickerLabels(looks: readonly CharacterLook[]): Map<string, string> {
  const caption = (look: CharacterLook): string => lookTileLabel(look.prompt, look.kind);
  const claims = new Map<string, number>();
  for (const look of looks) claims.set(caption(look), (claims.get(caption(look)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const look of looks) {
    const text = caption(look);
    if ((claims.get(text) ?? 0) < 2) {
      labels.set(look.id, text);
      continue;
    }
    const nth = (seen.get(text) ?? 0) + 1;
    seen.set(text, nth);
    labels.set(look.id, `${text} ${nth}`);
  }
  return labels;
}

/**
 * What choosing this option would take it away from (design 67, codex round 1).
 *
 * A look holds one `attachedTo`, so picking one that is already spoken for is a *move*: the
 * other production silently drops back to its identity package, or a scene loses its override.
 * The option says where it currently rides, so the move is visible at the point of choice — a
 * label rather than a confirmation, because the change is one field and reattaching undoes it.
 *
 * The look this production already holds says nothing: it is the selected option, and "here" is
 * not news.
 */
export function lookOptionScope(
  look: CharacterLook,
  production: ProductionBundle,
  productions: readonly ProductionBundle[],
): string | null {
  const scope = look.attachedTo;
  if (!scope) return null;
  if (scope.productionId === production.meta.id) {
    if (scope.kind === "production") return null;
    const scene = production.scenes.find((candidate) => candidate.id === scope.sceneId);
    return scene ? `Sc ${scene.number}` : null;
  }
  const owner = productions.find((candidate) => candidate.meta.id === scope.productionId);
  if (!owner) return null;
  if (scope.kind === "production") return `in ${owner.meta.title}`;
  const scene = owner.scenes.find((candidate) => candidate.id === scope.sceneId);
  // A scope whose scene is gone rides nowhere, so there is nothing here to warn about taking.
  return scene ? `in ${owner.meta.title} Sc ${scene.number}` : null;
}
