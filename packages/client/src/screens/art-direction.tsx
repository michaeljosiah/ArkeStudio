import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { ArtDirectionHistoryEntry, ResolvedArtDirection } from "@arke-studio/contracts";
import { ArtStyleGrid } from "../components/art-style-picker.js";
import { seedFrom } from "../lib/art-styles.js";
import { Button } from "../components/ui.js";
import { Portrait } from "../components/portrait.js";
import { shortDate } from "../lib/format.js";
import { acceptProposal, discardProposal, setArtDirection, useWorld } from "../lib/store.js";

const PROPOSED_DESCRIPTION =
  "Editorial maritime illustration on weathered paper. Dry-brush pigment and charcoal contours; slate and sea-glass blue with one lantern-orange accent; broad graphic shadows, loose fog and visible grain.";

function splitDescription(description: string): { title: string; body: string } {
  const first = /^(.+?[.!?])(?:\s+|$)(.*)$/s.exec(description.trim());
  if (!first) return { title: description.trim(), body: description.trim() };
  return { title: first[1]!, body: first[2]?.trim() || first[1]! };
}

function directionImage(worldSlug: string, path: string | undefined, label: string, radius = 0) {
  return path ? (
    <Portrait worldSlug={worldSlug} path={path} label={label} radius={radius} />
  ) : (
    <div className="fy-artdirection__empty-image">No master look set</div>
  );
}

function Reach({ direction }: { direction: ResolvedArtDirection }) {
  const rows = [
    [`${direction.reach.visualAssets} visual assets`, `on v${direction.version}`],
    [`${direction.reach.referenceKits} reference kits`, `on v${direction.version}`],
    [`${direction.reach.productions} productions`, `on v${direction.version}`],
    [`${direction.reach.earlierAcceptedTakes} accepted takes`, "made under earlier looks"],
  ];
  return (
    <section className="fy-artdirection__section">
      <h2>WHAT FOLLOWS THIS LOOK</h2>
      {rows.map(([label, note]) => (
        <div className="fy-artdirection__fact" key={label}>
          <span>{label}</span>
          <span>{note}</span>
        </div>
      ))}
      <p>Earlier work is never re-rendered. It keeps the look it was made under.</p>
    </section>
  );
}

function Overrides({ direction }: { direction: ResolvedArtDirection }) {
  return (
    <section className="fy-artdirection__section">
      <h2>NOT FOLLOWING IT</h2>
      {direction.overrides.length === 0 ? (
        <div className="fy-artdirection__fact">
          <span>No overrides</span>
          <span>one shared look</span>
        </div>
      ) : (
        direction.overrides.map((override) => (
          <div className="fy-artdirection__fact" key={`${override.kind}:${override.id}`}>
            <span>{override.name}</span>
            <span>{override.kind} · own look</span>
          </div>
        ))
      )}
      <p>
        An override travels with its own work. Changing the world look leaves
        {direction.overrides.length === 1 ? " it" : " these"} alone.
      </p>
    </section>
  );
}

function History({ worldSlug, history }: { worldSlug: string; history: ArtDirectionHistoryEntry[] }) {
  return (
    <section className="fy-artdirection__section">
      <h2>HISTORY</h2>
      {history.length === 0 ? (
        <div className="fy-artdirection__history-empty">No earlier accepted looks yet.</div>
      ) : (
        [...history]
          .sort((a, b) => b.version - a.version)
          .map((entry) => {
            const display = splitDescription(entry.description);
            return (
              <div className="fy-artdirection__history" key={entry.version} title={entry.description}>
                <span className="fy-artdirection__thumb">
                  {directionImage(worldSlug, entry.masterLook, `World look v${entry.version}`)}
                </span>
                <span className="fy-artdirection__history-version">v{entry.version}</span>
                <span className="fy-artdirection__history-copy">{display.title}</span>
                <time>{shortDate(entry.acceptedAt)}</time>
              </div>
            );
          })
      )}
    </section>
  );
}

export function ArtDirectionScreen() {
  const { worldId } = useParams();
  const navigate = useNavigate();
  const world = useWorld();
  if (!world || world.meta.worldId !== worldId) return null;
  const direction = world.artDirection;
  const display = splitDescription(direction.description);
  const proposed = world.proposals.find((item) => item.proposal.kind === "art-direction");

  return (
    <div className="fy-artdirection" data-screen="world-art-direction">
      {direction.masterLook ? (
        <div className="fy-artdirection__master">
          {directionImage(world.meta.slug, direction.masterLook, `${world.meta.name} master look`, 0)}
          <div className="fy-artdirection__master-caption">
            <div>
              <strong>Master look</strong>
              <span>v{direction.version}</span>
            </div>
            <p>
              {direction.acceptedAt
                ? `set ${shortDate(direction.acceptedAt)}`
                : "derived from tone and genre"}{" "}
              · used by new generations
            </p>
          </div>
        </div>
      ) : world.hasKeyArt ? (
        /* The accepted key art stands in while no master look is set. The user made and
           accepted this image; a page about the world's visual language that refuses to show
           the world's one image reads as a bug, not a distinction. */
        <div className="fy-artdirection__master">
          {directionImage(world.meta.slug, "world-art.png", `${world.meta.name} key art`, 0)}
          <div className="fy-artdirection__master-caption">
            <div>
              <strong>World key art</strong>
              <span>standing in</span>
            </div>
            <p>the master look is not set — Make it concrete below to author the shared look</p>
          </div>
        </div>
      ) : (
        <div className="fy-artdirection__master fy-artdirection__master--empty">
          <div className="fy-artdirection__empty-mark">NO MASTER LOOK</div>
          <div>
            <strong>Make the world look concrete.</strong>
            <p>The description currently comes from tone and genre.</p>
          </div>
        </div>
      )}
      <div className="fy-artdirection__detail">
        <div className="fy-artdirection__eyebrow">WORLD ART DIRECTION</div>
        <h1>{display.title}</h1>
        <p className="fy-artdirection__description">{display.body}</p>
        <div className="fy-artdirection__badges">
          <span>WORLD LOOK · v{direction.version}</span>
          <span>CARRIES AS TEXT TOO</span>
        </div>
        {direction.derived ? (
          <div className="fy-artdirection__derived">
            This direction is derived from the world's tone and genre. No master look is set yet. Make it
            concrete to author the shared look explicitly.
          </div>
        ) : (
          <div className="fy-artdirection__safety">
            A master look is carried for its treatment, never its subject. A palette, a lighting study or a
            place travels more safely than a portrait — a face here can arrive in other characters' work.
          </div>
        )}
        <div className="fy-artdirection__action">
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/art-direction/propose`)}>
            {proposed
              ? "Review proposed change"
              : direction.derived
                ? "Make it concrete"
                : "Propose a change"}
          </Button>
        </div>
        <div className="fy-artdirection__spacer" />
        <Reach direction={direction} />
        <Overrides direction={direction} />
        <History worldSlug={world.meta.slug} history={direction.history} />
      </div>
    </div>
  );
}

function Sparkle() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </svg>
  );
}

export function ArtDirectionProposalScreen() {
  const { worldId } = useParams();
  const navigate = useNavigate();
  const world = useWorld();
  const [description, setDescription] = useState(PROPOSED_DESCRIPTION);
  // Null is "your own words", which is where this screen starts: the world already has a look,
  // and the words in the box are a draft of the change, not a preset's.
  const [presetId, setPresetId] = useState<string | null>(null);
  if (!world || world.meta.worldId !== worldId) return null;

  const direction = world.artDirection;
  const staged = world.proposals.find((item) => item.proposal.kind === "art-direction");
  const proposed = staged?.artDirection;
  const nextVersion = direction.version + 1;
  const shownDescription = proposed?.description ?? description;
  const cancel = () => {
    if (staged) discardProposal(world.meta.worldId, staged.proposal.id);
    navigate(`/w/${world.meta.worldId}/art-direction`);
  };

  return (
    <div className="fy-artproposal" data-screen="art-direction-proposal">
      <main className="fy-artproposal__main">
        <header className="fy-artproposal__header">
          <div>
            <div className="fy-artproposal__eyebrow">MASTER LOOK · PROPOSED v{nextVersion}</div>
            <h1>Change the world's visual language</h1>
          </div>
          <span>{staged ? "ready to accept" : "draft · nothing changed"}</span>
        </header>
        <div className="fy-artproposal__previews">
          <div className="fy-artproposal__preview">
            <div>{directionImage(world.meta.slug, direction.masterLook, "Current look", 0)}</div>
            <p>Current · v{direction.version}</p>
          </div>
          <div className="fy-artproposal__preview">
            <div className="fy-artproposal__proposed-image">
              {directionImage(
                world.meta.slug,
                proposed?.masterLook ?? direction.masterLook,
                "Proposed look",
                0,
              )}
              <span>PROPOSED</span>
            </div>
            <p>
              {proposed?.masterLook === direction.masterLook || !proposed
                ? "New style · master image retained"
                : "New master image"}
            </p>
          </div>
        </div>
        {/* The same nine presets genesis offers (design turn 38c). A look chosen a year in should
            be the same choice, worded the same way, as one chosen on the first screen. */}
        {!staged && (
          <div className="fy-artproposal__presets">
            <div className="fy-artproposal__eyebrow">START FROM A LOOK</div>
            <ArtStyleGrid
              selectedId={presetId}
              onSelect={(preset) => {
                setPresetId(preset?.id ?? null);
                setDescription(seedFrom(preset));
              }}
            />
          </div>
        )}
        <label className="fy-artproposal__label" htmlFor="art-direction-description">
          Style description
        </label>
        <div className="fy-artproposal__field">
          <textarea
            id="art-direction-description"
            value={shownDescription}
            disabled={Boolean(staged)}
            onChange={(event) => setDescription(event.target.value)}
          />
          <button type="button" title="Flesh this out with AI" aria-label="Flesh this out with AI" disabled>
            <Sparkle />
          </button>
        </div>
        <div className="fy-artproposal__seedline">
          {presetId === null
            ? "your own words · nothing was seeded"
            : "the preset seeded these words · your edits win"}
        </div>
        <div className="fy-artproposal__buttons">
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          {/* The human's own action (the assign-voice rule): typing the look and being asked to
              approve your own typing was two steps for one decision. An agent's staged change
              still reviews in the aside; this button is for the person, so it just applies. */}
          <Button
            variant="primary"
            disabled={Boolean(staged) || description.trim().length === 0}
            onClick={() => {
              setArtDirection(world.meta.worldId, description, direction.masterLook ?? null);
              navigate(`/w/${world.meta.worldId}/art-direction`);
            }}
          >
            {staged ? "Change staged by the agent" : `Set the look · v${nextVersion}`}
          </Button>
        </div>
      </main>
      <aside className="fy-artproposal__ripple">
        <div className="fy-artproposal__eyebrow">RIPPLES</div>
        <strong>{direction.reach.visualAssets} visual assets</strong>
        <p>stay as they are, but new work sees v{nextVersion}.</p>
        <div className="fy-artproposal__ripple-list">
          <div>
            <i />
            {direction.reach.referenceKits} reference kits see a newer world look
          </div>
          <div>
            <i />
            {direction.reach.productions} productions inherit v{nextVersion} next dispatch
          </div>
          <div>
            <i className="fy-artproposal__dot-muted" />
            {direction.reach.earlierAcceptedTakes} accepted takes remain pinned to their original look
          </div>
          {direction.overrides.length > 0 && (
            <div>
              <i className="fy-artproposal__dot-muted" />
              {direction.overrides.length} overrides keep their own look
            </div>
          )}
        </div>
        <div className="fy-artproposal__accept">
          <Button
            variant="primary"
            disabled={!staged}
            onClick={() => {
              if (!staged) return;
              acceptProposal(world.meta.worldId, staged.proposal.id);
              navigate(`/w/${world.meta.worldId}/art-direction`);
            }}
          >
            Accept · world look v{nextVersion}
          </Button>
        </div>
        <p className="fy-artproposal__commit">one commit · prior versions remain in history</p>
      </aside>
    </div>
  );
}
