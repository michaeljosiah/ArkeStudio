import { useRef, useState, type RefObject } from "react";
import { useNavigate, useParams } from "react-router";
import type {
  ArtDirectionHistoryEntry,
  ResolvedArtDirection,
  SizeTier,
  WorldBundle,
} from "@arke-studio/contracts";
import { worldImagePrompt } from "@arke-studio/contracts";
import { ArtStyleGrid } from "../components/art-style-picker.js";
import { resolveModel, resolveOutputChoice, usableModels } from "../components/dispatch-bar.js";
import { authoredPrompt, GenerationDialog } from "../components/generation-dialog.js";
import { seedFrom } from "../lib/art-styles.js";
import { Button } from "../components/ui.js";
import { Portrait } from "../components/portrait.js";
import { shortDate } from "../lib/format.js";
import {
  acceptProposal,
  clearMasterLookReference,
  discardMasterLook,
  discardProposal,
  discardWorldImage,
  generateMasterLook,
  generateWorldImage,
  pickMasterLookReference,
  setArtDirection,
  uploadMasterLook,
  uploadWorldImage,
  useMasterLook,
  useStore,
  useWorld,
  useWorldImage,
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
 * A master look is a plate — a palette, a light, a place — and everything downstream lays it
 * beside other landscape work. Named rather than repeated, because the dialog and the coordinator
 * both have to agree about it: `masterLookRequest` builds the job landscape, and a dialog that
 * offered portrait shapes would have been choosing for a request that ignored the choice.
 */
const MASTER_LOOK_IS_LANDSCAPE = true;

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

/*
 * What this page no longer says.
 *
 * It used to end in two inventories — WHAT FOLLOWS THIS LOOK, counting the work riding the current
 * version, and NOT FOLLOWING IT, listing the overrides that are not. Both were true, and neither
 * was why anybody came here: the reach counts are stated where they change something (the propose
 * screen's ripples, next to Accept), and the overrides belong to the work that carries them.
 *
 * Key art went the other way. Turn 62 sent it to the world hub, on the reasoning that the image it
 * feeds was the thing on screen there; 63a cleared the hub of controls and left key art with no
 * setter at all; 64 brings it back here as a picture of its own — which is where it always
 * belonged, because this is the page about the world's pictures and there are two of them.
 */

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
 * The picture, and the two doors onto it.
 *
 * The doors used to be a row of buttons a third of the way down the other column, which put the
 * verb a long way from its object: the thing being replaced was the large image on the left, and
 * nothing on the left said so. They sit on the picture now and appear when the pointer is over it
 * — or when the keyboard reaches them, which is why the overlay answers `focus-within` as well as
 * `hover`, and why the buttons are always in the document rather than mounted on hover.
 */
function MasterLookHero({
  world,
  direction,
  onGenerate,
  generateRef,
  running,
}: {
  world: WorldBundle;
  direction: ResolvedArtDirection;
  onGenerate: () => void;
  generateRef: RefObject<HTMLButtonElement | null>;
  running: boolean;
}) {
  const controls = (
    <div className="fy-artdirection__hover">
      <Button ref={generateRef} variant="primary" onClick={onGenerate} disabled={running}>
        {running ? "Making one…" : "Generate"}
      </Button>
      <Button variant="secondary" onClick={() => uploadMasterLook(world.meta.worldId)}>
        Upload
      </Button>
    </div>
  );

  if (direction.masterLook) {
    return (
      <div className="fy-artdirection__master">
        {directionImage(world.meta.slug, direction.masterLook, `${world.meta.name} master look`, 0)}
        {controls}
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
    );
  }
  /*
   * No stand-in any more (design 64).
   *
   * The accepted key art used to fill this frame whenever no master look was set, on the reasoning
   * that a page about the world's visual language should not refuse to show the world's one image.
   * It showed it — under two controls that made a *master look*, so the one gesture the picture
   * invited was the one gesture it did not perform. Key art has its own block and its own doors on
   * this page now, so the empty state can be honest again: there is no master look, and that is
   * what this frame is for.
   */
  return (
    <div className="fy-artdirection__master fy-artdirection__master--empty">
      <div className="fy-artdirection__empty-mark">NO MASTER LOOK</div>
      <div>
        <strong>Make the world look concrete.</strong>
        <p>The description currently comes from tone and genre.</p>
      </div>
      {controls}
    </div>
  );
}

/**
 * The world's other picture, and the two doors onto it (design 64).
 *
 * Key art had no setter anywhere between design 63a taking the row off the world hub and this.
 * It belongs here rather than back on the hub for the reason 63a gave — a hub is a way in, not a
 * workbench — and because this is the page about the world's pictures, which is a thing it can
 * only be if it carries both of them.
 *
 * The two are never mixed. A master look is a treatment sent *to* models; key art is a picture
 * *of* the world that is never sent anywhere. So they get separate frames, separate captions and
 * separate doors, and the caption on each says which of the two you are looking at — because for
 * two turns this page showed one of them under controls that made the other.
 */
function WorldKeyArtPanel({ world }: { world: WorldBundle }) {
  const { state } = useStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  // Null is "the words the app would have sent", which is where the box always opens. A draft is
  // kept only while the dialog is open; reopening re-composes, because the look may have changed.
  const [draft, setDraft] = useState<string | null>(null);
  const [choice, setChoice] = useState<{ modelId?: string }>({});
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [count, setCount] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const generateRef = useRef<HTMLButtonElement>(null);
  const worldId = world.meta.worldId;

  // The same resolver the bar in the dialog uses, so the button and the picker cannot disagree
  // about which model this surface will send.
  const resolved = resolveModel(state, "image", choice.modelId);
  const model = resolved.stranded === null ? resolved.model : null;
  const offered = usableModels(state, "image");
  const why =
    model !== null
      ? undefined
      : offered.length > 0
        ? "The default image model is switched off — pick another one here, or upload an image instead."
        : undefined;

  const mine = (state?.app.jobs ?? []).filter(
    (job) => job.worldId === worldId && job.target.kind === "world-image",
  );
  const running = mine.some(
    (job) => job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled",
  );
  const newest = [...mine].reverse()[0];
  const failed = newest?.status === "failed" && !dismissed.includes(newest.id) ? newest : undefined;
  // From the disk, not from the job: a finished job stays in the queue log for good, so asking it
  // "did you land a file" answered yes long after that file had been used or thrown away.
  const candidates = world.keyArtCandidates;
  // What the app composes when nobody writes anything — the same function the coordinator uses,
  // so the box opens showing exactly what would otherwise be sent.
  const composed = worldImagePrompt(world.meta, world.artDirection);
  const prompt = draft ?? composed;

  const doors = (
    <div className="fy-artdirection__hover">
      <Button
        ref={generateRef}
        variant="primary"
        disabled={running}
        onClick={() => {
          setDraft(null);
          setDialogOpen(true);
        }}
      >
        {running ? "Making one…" : "Generate"}
      </Button>
      <Button variant="secondary" onClick={() => uploadWorldImage(worldId)}>
        Upload
      </Button>
    </div>
  );

  return (
    <>
      <section className="fy-artdirection__section">
        <h2>WORLD KEY ART</h2>
        <div
          className={
            world.keyArt ? "fy-artdirection__keyart" : "fy-artdirection__keyart fy-artdirection__keyart--empty"
          }
        >
          {world.keyArt ? (
            <Portrait worldSlug={world.meta.slug} path={world.keyArt} label={`${world.meta.name} key art`} />
          ) : (
            <div className="fy-artdirection__empty-mark">NO KEY ART</div>
          )}
          {doors}
        </div>
        <p className="fy-artdirection__keyart-note">
          A picture <i>of</i> the world. The worlds list, the world's own hero and a production
          with no frame of its own all show it — and nothing sends it to a model, which is why it
          may carry the faces a master look may not.
        </p>
        {/*
          The set is answered in the dialog's own preview column now (design 65) — this line only
          says one is waiting, and reopens the dialog to deal with it. Two places to answer the
          same offer would be two places to leave it half-answered.
        */}
        {candidates.length > 0 ? (
          <p className="fy-artdirection__offer-why">
            {candidates.length === 1 ? "One key art is" : `${candidates.length} key art previews are`} waiting on
            you —{" "}
            <button type="button" className="fy-set__link" onClick={() => setDialogOpen(true)}>
              choose or discard
            </button>
          </p>
        ) : (
          failed && (
            <p className="fy-artdirection__offer-why">
              The key art did not come back — {failed.error ?? "the provider refused it"}
            </p>
          )
        )}
      </section>
      {/* Outside the section on purpose: it is a modal, not section content, and nesting it there
          put its own <h2> under the section's eyebrow styling. */}
      <GenerationDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        returnFocus={generateRef}
        title="Generate the world's key art"
        lede="One picture of this world, for the app to show it by."
        prompt={prompt}
        onPrompt={setDraft}
        promptHint="Opens as the words this would send on its own — the look, the logline, the tone. Edit them and yours are sent as written, with the standing clause added after, and the studio writes nothing of its own on top."
        worldSlug={world.meta.slug}
        // No reference row: there is nowhere in the world to stage one for key art, and a slot
        // that opened a picker whose result had no home would be worse than none.
        workflow="main-photo"
        // The request carries no output spec at all, so the provider's own size is what runs.
        size={false}
        aspect={false}
        count={count}
        onCount={setCount}
        choice={choice}
        onChoice={setChoice}
        submitLabel={count === 1 ? "Generate" : `Generate ${count}`}
        submitDisabled={model === null || running}
        {...(why !== undefined ? { why } : {})}
        previews={candidates.map((path, index) => ({
          key: path,
          path,
          label: `Key art preview ${index + 1}`,
        }))}
        generating={running}
        waitingHint="Previews land here and in Activity. Nothing replaces the world's picture until you say so."
        selected={picked}
        onSelect={setPicked}
        commit={{
          label: "Use as key art",
          onCommit: () => {
            if (picked !== null) useWorldImage(worldId, picked);
            setPicked(null);
            setDialogOpen(false);
          },
          note: candidates.length > 0 ? "Choosing one replaces the world's picture and discards the rest." : undefined,
          ...(candidates.length > 0
            ? {
                secondary: {
                  label: "Discard all",
                  onAction: () => {
                    discardWorldImage(worldId);
                    setPicked(null);
                  },
                },
              }
            : {}),
        }}
        onSubmit={() => {
          if (failed) setDismissed((prev) => [...prev, failed.id]);
          const authored = authoredPrompt(prompt, composed);
          generateWorldImage(worldId, {
            ...(model ? { modelId: model.id } : {}),
            ...(authored !== undefined ? { prompt: authored } : {}),
            ...(count !== 1 ? { count } : {}),
          });
          // The dialog stays open: the previews it asked for land in its own right-hand column,
          // and closing on submit would send the person away from the thing they just paid for.
        }}
      />
    </>
  );
}

export function ArtDirectionScreen() {
  const { worldId } = useParams();
  const navigate = useNavigate();
  const world = useWorld();
  const { state } = useStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  // Null is "the look's own words", which is where the box always starts. A draft is kept only
  // while the dialog is open; reopening it re-reads the look, because the look may have changed.
  const [draft, setDraft] = useState<string | null>(null);
  const [choice, setChoice] = useState<{ modelId?: string; tier?: SizeTier; resolution?: string }>({});
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [count, setCount] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const generateRef = useRef<HTMLButtonElement>(null);
  if (!world || world.meta.worldId !== worldId) return null;
  const direction = world.artDirection;
  const display = splitDescription(direction.description);
  const proposed = world.proposals.find((item) => item.proposal.kind === "art-direction");
  const candidates = world.masterLookCandidates;

  // The same resolver the bar in the dialog uses, so the button and the picker cannot disagree
  // about which model this surface will send — and a stranded default blocks rather than quietly
  // running as something else.
  const resolved = resolveModel(state, "image", choice.modelId);
  const model = resolved.stranded === null ? resolved.model : null;
  // What the bar in the dialog will actually send, asked of the bar rather than read off the last
  // click: switching models drops a size or a shape the new row cannot reach.
  const sending = model
    ? resolveOutputChoice(model, choice, { aspect: true, landscape: MASTER_LOOK_IS_LANDSCAPE })
    : {};
  // What the bar in the dialog does not already say. With nothing in the manifest at all the bar
  // states it itself, and repeating it put the same sentence on screen twice; a routed default
  // that is merely switched off is the case the bar shows a model row for and cannot explain.
  const offered = usableModels(state, "image");
  const why =
    model !== null
      ? undefined
      : offered.length > 0
        ? "The default image model is switched off — pick another one here, or upload an image instead."
        : undefined;
  const mine = (state?.app.jobs ?? []).filter(
    (job) => job.worldId === world.meta.worldId && job.target.kind === "master-look",
  );
  const running = mine.some(
    (job) => job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled",
  );
  const newest = [...mine].reverse()[0];
  const failed = newest?.status === "failed" && !dismissed.includes(newest.id) ? newest : undefined;
  const prompt = draft ?? direction.description;

  return (
    <div className="fy-artdirection" data-screen="world-art-direction">
      <MasterLookHero
        world={world}
        direction={direction}
        running={running}
        generateRef={generateRef}
        onGenerate={() => {
          setDraft(null);
          setDialogOpen(true);
        }}
      />
      <GenerationDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        returnFocus={generateRef}
        title="Generate the master look"
        lede="One picture of this look, for other work to be made against."
        prompt={prompt}
        onPrompt={setDraft}
        promptHint="Starts as the look's own words. Whatever is here is sent as written — with the standing clause forbidding people, faces, text and montage added after it, because this image rides along with other characters' portraits."
        worldSlug={world.meta.slug}
        reference={world.masterLookReference}
        referenceHint="Optional. A palette, a frame or a lighting study for the model to look at while it works."
        onAttachReference={() => pickMasterLookReference(world.meta.worldId)}
        onClearReference={() => clearMasterLookReference(world.meta.worldId)}
        // "main-photo" is borrowed for its price band only — a master look is not a portrait, and
        // the coordinator builds this request landscape, so the orientation is stated rather than
        // inferred from the workflow. Without it the dialog would default to a portrait shape and
        // price a portrait base for a landscape plate.
        workflow="main-photo"
        landscape={MASTER_LOOK_IS_LANDSCAPE}
        count={count}
        onCount={setCount}
        choice={choice}
        onChoice={setChoice}
        submitLabel={count === 1 ? "Generate" : `Generate ${count}`}
        submitDisabled={model === null || running}
        {...(why !== undefined ? { why } : {})}
        previews={candidates.map((path, index) => ({
          key: path,
          path,
          label: `Master look preview ${index + 1}`,
        }))}
        generating={running}
        waitingHint="Previews land here and in Activity. The look does not change until you accept one."
        selected={picked}
        onSelect={setPicked}
        commit={{
          label: `Use this · v${direction.version + 1}`,
          // The gate allows one open look change at a time. Without this the button was live, the
          // gate refused it, and the candidate simply stayed on screen saying nothing.
          disabled: proposed !== undefined,
          onCommit: () => {
            if (picked !== null) useMasterLook(world.meta.worldId, picked);
            setPicked(null);
            setDialogOpen(false);
          },
          note:
            proposed !== undefined
              ? "A change to this look is already proposed. Settle it first — these images wait."
              : candidates.length > 0
                ? `Accepting lands it as v${direction.version + 1}; earlier work keeps the look it was made under.`
                : undefined,
          ...(candidates.length > 0
            ? {
                secondary: {
                  label: "Discard all",
                  onAction: () => {
                    discardMasterLook(world.meta.worldId);
                    setPicked(null);
                  },
                },
              }
            : {}),
        }}
        onSubmit={() => {
          if (failed) setDismissed((prev) => [...prev, failed.id]);
          generateMasterLook(world.meta.worldId, {
            ...(model ? { modelId: model.id } : {}),
            // Only when it is not simply the look read back. "Nothing was overridden" is a real
            // state worth being able to see in the request, rather than a coincidence of strings.
            ...(prompt.trim() !== direction.description.trim() ? { prompt } : {}),
            // The size and shape as the bar resolved them, not as they were last clicked: a model
            // change drops a tier or an aspect the new row cannot reach, and the request has to
            // agree with what the screen is showing.
            ...(sending.tier !== undefined ? { tier: sending.tier } : {}),
            ...(sending.aspect !== undefined ? { aspect: sending.aspect } : {}),
            ...(count !== 1 ? { count } : {}),
          });
          // Left open: what was asked for lands in this dialog's own preview column.
        }}
      />
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
        {/* Answered in the dialog's preview column (design 65); this only says one is waiting. */}
        {candidates.length > 0 ? (
          <p className="fy-artdirection__offer-why">
            {candidates.length === 1 ? "One master look is" : `${candidates.length} master looks are`} waiting on
            you —{" "}
            <button type="button" className="fy-set__link" onClick={() => setDialogOpen(true)}>
              choose or discard
            </button>
          </p>
        ) : (
          failed && (
            <p className="fy-artdirection__offer-why">
              The master look did not come back — {failed.error ?? "the provider refused it"}
            </p>
          )
        )}
        <div className="fy-artdirection__spacer" />
        {/* The world's other picture, below the look's own business and above its history — the
            page carries both pictures or it is not the page about the world's pictures. */}
        <WorldKeyArtPanel world={world} />
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
