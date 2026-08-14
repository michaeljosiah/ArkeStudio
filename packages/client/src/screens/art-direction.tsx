import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { ArtDirectionHistoryEntry, ResolvedArtDirection } from "@arke-studio/contracts";
import { ArtStyleGrid } from "../components/art-style-picker.js";
import { resolveModel } from "../components/dispatch-bar.js";
import { seedFrom } from "../lib/art-styles.js";
import { Button } from "../components/ui.js";
import { Portrait } from "../components/portrait.js";
import { shortDate } from "../lib/format.js";
import {
  acceptProposal,
  discardMasterLook,
  discardProposal,
  generateMasterLook,
  setArtDirection,
  uploadMasterLook,
  useMasterLook,
  useStore,
  useWorld,
} from "../lib/store.js";

/**
 * Longest heading the 42px display type can carry before it stops reading as a heading.
 *
 * Not a truncation: whatever the heading gives up starts the paragraph underneath, so the words
 * on screen are the same words either way. This only decides where the type size changes.
 */
const TITLE_MAX = 120;

/** Where a run-on first sentence is willing to be broken, in the order we would rather break it. */
const CLAUSE_BREAKS = [":", ";", "—"];

/**
 * The heading is the description's first sentence — until the first sentence is the description.
 *
 * A look is often written as one long comma-spliced line ("Cinematic painterly 3D animation with
 * an Arcane-like sensibility: premium production quality, hand-painted textures, …"), and the
 * sentence rule then promoted ninety words to 42px and left the paragraph beneath it empty. So a
 * first sentence too long to be a heading is broken at its own first structural break instead,
 * and everything past that point becomes the body. Nothing is dropped in either case: title plus
 * body is always the whole description.
 */
export function splitDescription(description: string): { title: string; body: string } {
  const text = description.trim();
  const sentence = /^(.+?[.!?])(?:\s+|$)(.*)$/s.exec(text);
  const head = sentence ? sentence[1]! : text;
  const tail = (sentence ? (sentence[2] ?? "") : "").trim();
  if (head.length <= TITLE_MAX) return { title: head, body: tail };

  const at = clauseBreak(head);
  if (at === null) return { title: head, body: tail };
  const rest = head.slice(at + 1).trim();
  return { title: head.slice(0, at).trim(), body: [rest, tail].filter((part) => part !== "").join(" ") };
}

/** The index of the character to break a too-long heading at, or null if it offers nowhere. */
function clauseBreak(head: string): number | null {
  for (const mark of CLAUSE_BREAKS) {
    const at = head.indexOf(mark);
    if (at > 0 && at <= TITLE_MAX) return at;
  }
  // No structural break, so the last comma that still fits — as much of the opening as the
  // heading can hold, rather than the first fragment of it.
  const at = head.lastIndexOf(",", TITLE_MAX);
  return at > 0 ? at : null;
}

/**
 * What the proposal does to the master image, by presence rather than by fallback.
 *
 * The three cases are genuinely different and were previously two: a look change that keeps the
 * image, one that replaces it, and one that removes it. A conversation's look change carries no
 * image at all, so without the third case every one of them read as "retained" while accepting
 * removed it.
 */
export function proposedMasterLookNote(proposed: string | null, current: string | null, staged: boolean): string {
  if (!staged) return "New style · master image retained";
  if (proposed === current) return "New style · master image retained";
  if (proposed === null) return "New style · master image removed";
  return "New master image";
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

/**
 * Setting the master look — the thing this screen has always described and never offered.
 *
 * The record has carried a `masterLook` since the look was versioned: history keeps one per
 * version, the reach counts it, the review names it, and the copy above explains how it travels
 * into other work. Nothing in the app could put one there, so every world's was empty and the
 * page stood in the world's key art instead.
 *
 * Two doors, because the two are genuinely different intentions. Generating asks the look to
 * illustrate itself, from its own words and nothing else. Uploading is for an author who already
 * knows what the world looks like — a frame grab, a painting, a photograph — and does not need a
 * model's opinion about it.
 */
function MasterLook({
  worldId,
  slug,
  version,
  proposalOpen,
}: {
  worldId: string;
  slug: string;
  version: number;
  /** A look change already staged. The gate allows one, so accepting here would be refused. */
  proposalOpen: boolean;
}) {
  const { state } = useStore();
  const candidate = state?.world?.masterLookCandidate ?? null;
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const model = resolveModel(state, "image").model;
  const stranded = resolveModel(state, "image").stranded;
  const usable = model !== null && stranded === null;

  const mine = (state?.app.jobs ?? []).filter(
    (job) => job.worldId === worldId && job.target.kind === "master-look",
  );
  const running = mine.find(
    (job) => job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled",
  );
  const newest = [...mine].reverse()[0];
  const failed = newest?.status === "failed" && !dismissed.includes(newest.id) ? newest : undefined;

  // The offer, whenever there is one: a candidate outranks a running job, because a candidate is
  // a decision waiting on the person and a job is only the studio being busy.
  if (candidate !== null) {
    return (
      <section className="fy-artdirection__masterlook">
        <div className="fy-artdirection__masterlook-shot">
          <Portrait worldSlug={slug} path={candidate} label="Master look, just made" radius={8} />
        </div>
        <p>
          Keep this as the world's master look? It lands as v{version + 1} — earlier work keeps the
          look it was made under.
        </p>
        <div className="fy-artdirection__masterlook-row">
          <Button variant="primary" onClick={() => useMasterLook(worldId)} disabled={proposalOpen}>
            Use this · v{version + 1}
          </Button>
          <Button variant="ghost" onClick={() => discardMasterLook(worldId)}>
            Not this one
          </Button>
        </div>
        {/* The gate allows one open look change at a time. Without this the button was live, the
            gate refused it, and the candidate simply stayed on screen saying nothing. */}
        {proposalOpen && (
          <p className="fy-artdirection__masterlook-why">
            A change to this look is already proposed. Settle it first — this image waits.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="fy-artdirection__masterlook">
      {failed && (
        <p className="fy-artdirection__masterlook-why">
          The master look did not come back — {failed.error ?? "the provider refused it"}
        </p>
      )}
      <div className="fy-artdirection__masterlook-row">
        <Button
          onClick={() => {
            if (failed) setDismissed((prev) => [...prev, failed.id]);
            generateMasterLook(worldId, model?.id);
          }}
          disabled={!usable || running !== undefined}
        >
          {running ? "Making one…" : failed ? "Try again" : "Generate from this look"}
        </Button>
        <Button variant="ghost" onClick={() => uploadMasterLook(worldId)}>
          Upload an image
        </Button>
      </div>
      <p className="fy-artdirection__masterlook-why">
        {usable
          ? "Generating sends this look's own words as the prompt, and nothing else."
          : "No image model is available, so only an upload can set the look right now."}
      </p>
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
        {/* Only when there is one. A one-line look used to print the same sentence twice: once
            as the heading and again as its own description. */}
        {display.body !== "" && <p className="fy-artdirection__description">{display.body}</p>}
        <div className="fy-artdirection__badges">
          <span>WORLD LOOK · v{direction.version}</span>
          <span>CARRIES AS TEXT TOO</span>
        </div>
        {/* The heading is a typographic split, and the screen has to say so. Somebody reading a
            bold line above a grey one reasonably concludes the bold part is the one that counts. */}
        <p className="fy-artdirection__carries">
          Every word of this description goes into every new generation. The heading is just where
          it starts — not a summary of it, and not the part that carries.
        </p>
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
        <MasterLook
          worldId={world.meta.worldId}
          slug={world.meta.slug}
          version={direction.version}
          proposalOpen={proposed !== undefined}
        />
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
  // Null is "untouched": the box then shows the world's current words, since a draft of a
  // change starts from what the look already is — never from another world's sample copy.
  const [description, setDescription] = useState<string | null>(null);
  // Null is "your own words", which is where this screen starts: the world already has a look,
  // and the words in the box are a draft of the change, not a preset's.
  const [presetId, setPresetId] = useState<string | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  if (!world || world.meta.worldId !== worldId) return null;

  const direction = world.artDirection;
  const staged = world.proposals.find((item) => item.proposal.kind === "art-direction");
  const proposed = staged?.artDirection;
  const nextVersion = direction.version + 1;
  const draft = description ?? direction.description;
  const shownDescription = proposed?.description ?? draft;
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
              {/*
                A staged look says what it says, including saying nothing.

                This used to fall back to the current master image whenever the proposal carried
                none, and label it "master image retained" — so a proposal that removes the master
                look showed the very image it was about to delete, over a caption promising it
                would stay. A conversation's look change carries no image, so that was every one
                of them. Only a draft with nothing staged yet borrows the current image, because
                there is no proposal to misdescribe.
              */}
              {directionImage(
                world.meta.slug,
                proposed ? proposed.masterLook : direction.masterLook,
                "Proposed look",
                0,
              )}
              <span>PROPOSED</span>
            </div>
            <p>{proposedMasterLookNote(proposed?.masterLook ?? null, direction.masterLook ?? null, Boolean(proposed))}</p>
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
          {presetId !== null
            ? "the preset seeded these words · your edits win"
            : description === null
              ? "the current look's words · edit them to draft the change"
              : "your own words · nothing was seeded"}
        </div>
        <div className="fy-artproposal__buttons">
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          {/* The human's own action (the assign-voice rule): typing the look and being asked to
              approve your own typing was two steps for one decision. An agent's staged change
              still reviews in the aside; this button is for the person, so it just applies.
              Navigation only follows a send that happened — a disconnected studio keeps the
              edit on screen and says so, rather than discarding it behind a page change. */}
          <Button
            variant="primary"
            disabled={Boolean(staged) || draft.trim().length === 0}
            onClick={() => {
              if (setArtDirection(world.meta.worldId, draft, direction.masterLook ?? null)) {
                navigate(`/w/${world.meta.worldId}/art-direction`);
              } else {
                setSendFailed(true);
              }
            }}
          >
            {staged ? "Change staged by the agent" : `Set the look · v${nextVersion}`}
          </Button>
        </div>
        {sendFailed && (
          <div className="fy-artproposal__seedline" role="alert">
            The studio is disconnected — nothing was changed. Your words are still here; try again
            when the coordinator is back.
          </div>
        )}
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
          {/*
            Everything already behind, plus everything made under the look this replaces.

            The gate's own preview counts both; this screen counted only the first, so the number
            immediately before Accept was the smaller one — and it is the takes made since the
            last change, usually the ones being thought about, that the omission dropped.
          */}
          <div>
            <i className="fy-artproposal__dot-muted" />
            {direction.reach.earlierAcceptedTakes + (direction.reach.acceptedTakesAtCurrentVersion ?? 0)} accepted
            takes remain pinned to their original look
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
