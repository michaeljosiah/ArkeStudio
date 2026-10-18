import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  DRAMA_NARRATOR, DramaRoleSchema,
  type AudiobookReader, type DramaRole, type EpisodeScriptBlock, type ProductionBundle, type WorldBundle,
} from "@arke-studio/contracts";
import { EmptyState, Screen } from "../components/layout.js";
import { Button, IconButton, cx } from "../components/ui.js";
import { Lock, X } from "../components/icons.js";
import { VoicePickerDialog } from "../components/voice-picker.js";
import { SentList, useHearQuote } from "../components/audio-drama-hear.js";
import { dramaBlocks, dramaCastRoles, takesOutOfDate, type DramaCastRole } from "../lib/audio-drama-cast.js";
import { setDramaRole } from "../lib/store.js";

/**
 * An audio drama's Cast (design turn 230k, SPEC-057 R-55..R-60): every speaking role, its voice and
 * where that comes from, How they sound, and its lines. A role opens to its notes — the actor's,
 * and the narrator's version where the narrator quotes them — its hidden identity, What's sent and
 * Change voice…. All of it is this production's (R-85); the character's sheet is never written.
 */
export function DramaCastScreen({ world, production }: { world: WorldBundle; production: ProductionBundle }) {
  const roles = dramaCastRoles(world, production);
  const [open, setOpen] = useState<string | null>(null);
  const silent = roles.filter((role) => role.voice === null && role.key !== DRAMA_NARRATOR).length;
  return (
    <Screen id="drama-cast">
      <div className="fy-ad-cast">
        <header className="fy-ad-cast__head">
          <h1>Cast</h1>
          <p>This production · {roles.length} role{roles.length === 1 ? "" : "s"}{silent > 0 ? ` · ${silent} without a voice` : ""}</p>
        </header>
        {roles.length === 0 ? <EmptyState title="No one speaks yet." /> : (
          <div role="table" aria-label="Cast" className="fy-ad-cast__table">
            <div role="row" className="fy-ad-cast__row fy-ad-cast__row--head">
              <span role="columnheader">Role</span><span role="columnheader">Voice</span>
              <span role="columnheader">How they sound</span><span role="columnheader">Lines</span>
            </div>
            {roles.map((role) => (
              <CastRow key={role.key} world={world} production={production} role={role} open={open === role.key}
                onOpen={() => setOpen(open === role.key ? null : role.key)} />
            ))}
          </div>
        )}
      </div>
    </Screen>
  );
}

/** A role's changes, emptied fields dropped; null when nothing of this production's is left. */
function nextRole(was: DramaRole | undefined, patch: Partial<DramaRole>): DramaRole | null {
  const merged: Record<string, unknown> = { ...was, ...patch };
  for (const [field, value] of Object.entries(merged)) if (value === undefined || value === "") delete merged[field];
  return Object.keys(merged).length === 0 ? null : merged as DramaRole;
}

function voiceLine(role: DramaCastRole) {
  if (role.voice) return <><b>{role.voice.label ?? role.voice.voiceId}</b><small>{role.voice.provider}{role.voice.model ? ` ${role.voice.model}` : ""} · {role.from === "production" ? "this production" : "from character"}</small></>;
  if (role.key === DRAMA_NARRATOR) return <><b>App narrator</b><small>from Settings</small></>;
  return <><b className="fy-ad-cast__none">No voice</b><small>Choose a voice</small></>;
}

function CastRow({ world, production, role, open, onOpen }: {
  world: WorldBundle; production: ProductionBundle; role: DramaCastRole; open: boolean; onOpen: () => void;
}) {
  const hidden = role.role?.publicLabel !== undefined;
  return (
    <div role="rowgroup" className={cx("fy-ad-cast__group", open && "fy-ad-cast__group--open")} data-role={role.key}>
      <div role="row" className="fy-ad-cast__row" aria-expanded={open} tabIndex={0} onClick={onOpen}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}>
        <span role="cell" className="fy-ad-cast__role">
          <b>{hidden ? role.role!.publicLabel : role.name}</b>
          {role.key === DRAMA_NARRATOR ? <small>optional role</small>
            : hidden ? <small><Lock size={11} /> {role.name} until episode {role.role!.revealEpisode}</small>
            : !role.sheet ? <small>no character sheet</small> : null}
        </span>
        <span role="cell" className="fy-ad-cast__voice">{voiceLine(role)}</span>
        <span role="cell" className="fy-ad-cast__sound">
          {role.sound ?? "—"}
          {role.narration && <small>When the narrator quotes them: {role.narration}</small>}
        </span>
        <span role="cell" className="fy-ad-cast__lines">{role.lines}</span>
      </div>
      {open && <CastDetail world={world} production={production} role={role} />}
    </div>
  );
}

type VoiceChoice = { voice: AudiobookReader | null; label: string };

function CastDetail({ world, production, role }: { world: WorldBundle; production: ProductionBundle; role: DramaCastRole }) {
  const [sent, setSent] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState<VoiceChoice | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [label, setLabel] = useState(role.role?.publicLabel ?? "");
  const [reveal, setReveal] = useState(role.role?.revealEpisode ? String(role.role.revealEpisode) : "");
  // The role as last sent (codex on PR 1873): two edits before the world answers build on each
  // other, never both on the same stale role.
  const latest = useRef(role.role);
  useEffect(() => { latest.current = role.role; }, [JSON.stringify(role.role ?? null)]);
  const save = (patch: Partial<DramaRole>) => {
    const next = nextRole(latest.current, patch);
    if (next !== null) {
      const checked = DramaRoleSchema.safeParse(next);
      if (!checked.success) { setProblem(checked.error.issues[0]?.message ?? "Not saved."); return; }
    }
    setProblem(null);
    if (!setDramaRole(world.meta.worldId, production.meta.id, role.key, next)) { setProblem("The studio is disconnected."); return; }
    latest.current = next ?? undefined;
  };
  // Both or neither (R-59): a label waits for its episode, and clearing both shows the name again.
  const saveHidden = (nextLabel: string, nextReveal: string) => {
    const episode = Number(nextReveal);
    if (nextLabel.trim() === "" && nextReveal === "") save({ publicLabel: undefined, revealEpisode: undefined });
    else if (nextLabel.trim() !== "" && Number.isInteger(episode) && episode >= 2) save({ publicLabel: nextLabel.trim(), revealEpisode: episode });
  };
  const sheetVoice = role.sheet?.voice;
  const target = pending?.voice ?? (pending && sheetVoice ? sheetVoice : null);
  const stale = pending && target ? takesOutOfDate(production, role.key, target) : [];
  const confirm = () => {
    if (!pending) return;
    save({ voice: pending.voice ?? undefined });
    setPending(null);
  };
  return (
    <div className="fy-ad-cast__detail">
      <label className="fy-ad-cast__field">
        <span>How {role.key === DRAMA_NARRATOR ? "the narrator sounds" : "they sound"}</span>
        <textarea rows={2} maxLength={300} defaultValue={role.role?.sound ?? ""} placeholder={role.sheetSound ?? "Close, unhurried."}
          onBlur={(event) => { if (event.target.value.trim() !== (role.role?.sound ?? "")) save({ sound: event.target.value.trim() || undefined }); }} />
        {role.sheetSound && <small>Starts from {role.name}'s sheet: {role.sheetSound}</small>}
      </label>
      {role.quoted > 0 && (
        <label className="fy-ad-cast__field">
          <span>When the narrator quotes them</span>
          <textarea rows={2} maxLength={300} defaultValue={role.role?.narration ?? ""} placeholder={role.sheet?.narration ?? "A little of their slowness."}
            onBlur={(event) => { if (event.target.value.trim() !== (role.role?.narration ?? "")) save({ narration: event.target.value.trim() || undefined }); }} />
          <small>{role.quoted} narrated line{role.quoted === 1 ? "" : "s"}</small>
        </label>
      )}
      {role.key !== DRAMA_NARRATOR && (
        <fieldset className="fy-ad-cast__hidden">
          <legend>Hidden identity</legend>
          <input aria-label="Public label" placeholder="Public label" maxLength={80} value={label}
            onChange={(event) => setLabel(event.target.value)} onBlur={() => saveHidden(label, reveal)} />
          <label>until episode
            <input aria-label="Revealed in episode" type="number" min={2} max={200} value={reveal}
              onChange={(event) => setReveal(event.target.value)} onBlur={() => saveHidden(label, reveal)} />
          </label>
        </fieldset>
      )}
      <div className="fy-ad-cast__acts">
        <button type="button" className="fy-linkbtn" aria-expanded={sent} onClick={() => setSent(!sent)}>What's sent</button>
        <span className="gap" />
        {role.from === "production" && sheetVoice && <Button size="sm" variant="ghost" onClick={() => setPending({ voice: null, label: sheetVoice.label ?? sheetVoice.voiceId })}>Use the character's voice</Button>}
        <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>Change voice…</Button>
      </div>
      {problem && <p className="fy-ad-cast__problem" role="alert">{problem}</p>}
      {sent && <RoleSent world={world} production={production} role={role} />}
      {pending && (
        <section className="fy-ad-cast__confirm" aria-label="Change voice">
          <p><b>{role.name} → {pending.label}</b></p>
          {stale.length === 0 ? <p>No kept take goes out of date.</p> : (
            <>
              <p>{stale.length} kept take{stale.length === 1 ? "" : "s"} will be out of date:</p>
              <ul>
                {stale.slice(0, 8).map((take) => <li key={take.block}>Episode {take.episode} · “{take.words.slice(0, 80)}”</li>)}
                {stale.length > 8 && <li>and {stale.length - 8} more</li>}
              </ul>
            </>
          )}
          <div className="fy-ad-cast__acts">
            <span className="gap" />
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={confirm}>Change voice</Button>
          </div>
        </section>
      )}
      <VoicePickerDialog open={picking} worldId={world.meta.worldId} chosenId={role.voice?.voiceId}
        {...(role.voice ? { chosenProvider: role.voice.provider, chosenModel: role.voice.model } : {})}
        onClose={() => setPicking(false)}
        onPick={(voice) => {
          setPicking(false);
          setPending({ voice: { provider: voice.provider, model: voice.model, voiceId: voice.voiceId, label: voice.label }, label: voice.label });
        }} />
    </div>
  );
}

/** The request for this role's first line, as Hear would send it (R-60): priced, never made here. */
function RoleSent({ world, production, role }: { world: WorldBundle; production: ProductionBundle; role: DramaCastRole }) {
  const first = dramaBlocks(production).find(({ block }) => role.key === DRAMA_NARRATOR ? block.kind === "narration" : block.kind === "dialogue" && block.speaker === role.key);
  // Priced from the saved script, as Hear is: the request shown is the one a press would send.
  const saved = production.episodeScripts?.find((entry) => entry.script.episode === first?.episode)?.hash ?? null;
  const quote = useHearQuote(world.meta.worldId, production.meta.id, first?.episode ?? 1, first ? [first.block.id] : [], {}, JSON.stringify(role.role ?? null), false, saved);
  if (!first) return <p className="fy-ad-cast__sent">No line yet.</p>;
  if (!quote) return <p className="fy-ad-cast__sent">Pricing…</p>;
  if (quote.disposition === "refused") return <p className="fy-ad-cast__sent">{quote.reason}</p>;
  if ((quote.missing ?? []).length > 0) return <p className="fy-ad-cast__sent">No voice yet.</p>;
  return <div className="fy-ad-cast__sent"><SentList requests={quote.quote?.requests ?? []} /></div>;
}

/** The score's Cast column (230j): the scene's roles, each with How they sound. */
export function CastColumn({ world, production, blocks, base, onClose }: {
  world: WorldBundle; production: ProductionBundle; blocks: readonly EpisodeScriptBlock[]; base: string; onClose: () => void;
}) {
  const here = new Set(blocks.flatMap((block) => block.kind === "dialogue" ? [block.speaker] : block.kind === "narration" ? [DRAMA_NARRATOR] : []));
  const roles = dramaCastRoles(world, production).filter((role) => here.has(role.key));
  return (
    <aside className="fy-ad-source fy-ad-castcol" aria-label="Cast">
      <header><h2>Cast</h2><small>this scene</small><span className="gap" /><IconButton label="Close cast" onClick={onClose}><X size={14} /></IconButton></header>
      {roles.length === 0 ? <p className="fy-ad-castcol__empty">No one speaks here yet.</p> : roles.map((role) => (
        <section key={role.key} className="fy-ad-castcol__role">
          <h3>{role.name}<small>{role.voice ? role.voice.label ?? role.voice.voiceId : role.key === DRAMA_NARRATOR ? "App narrator" : "No voice"}</small></h3>
          <p>{role.sound ?? "No note yet."}</p>
          {role.narration && <p><small>When the narrator quotes them: {role.narration}</small></p>}
        </section>
      ))}
      <Link className="fy-linkbtn" to={`${base}/cast`}>Open Cast</Link>
    </aside>
  );
}
