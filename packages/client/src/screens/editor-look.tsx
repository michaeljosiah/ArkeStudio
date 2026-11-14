import { describeTimelineCommand, type TimelineCommand, type TimelinePictureLook } from "@arke-studio/contracts";

/*
 * The Cut's look (SPEC-038 R-45..R-50): the panel that sets it, and what the Viewer wears for it.
 *
 * The Viewer's half is an approximation by design. The export grades and grains the finished
 * picture in FFmpeg; here a CSS filter and a layer of noise stand in for it, on the elements that
 * show the picture and never in the frames the shared renderer draws, which are held to fixed
 * digests and compared with the export's.
 */

const GRADES: ReadonlyArray<[TimelinePictureLook["grade"], string]> = [[undefined, "Off"], ["film", "Film"]];
const GRAINS: ReadonlyArray<[TimelinePictureLook["grain"], string]> = [[undefined, "Off"], ["light", "Light"], ["medium", "Medium"]];

/**
 * The film's one look, set with no clip selected, beside the mix: both belong to the whole film,
 * and the panel wears the mix panel's classes because it is the same kind of thing.
 */
export function LookPanel({ look, disabled, onCommands }: {
  look: TimelinePictureLook | undefined;
  disabled: boolean;
  onCommands: (commands: TimelineCommand[], label?: string) => void;
}) {
  // The whole look goes each time, and the last part turned off sends none: no record holds an empty look.
  const set = (part: TimelinePictureLook) => {
    const grade = "grade" in part ? part.grade : look?.grade, grain = "grain" in part ? part.grain : look?.grain;
    // The chip already pressed asks for the look the film has, which the coordinator would refuse as no change.
    if (grade === look?.grade && grain === look?.grain) return;
    const command: TimelineCommand = { kind: "set-picture-look", look: grade || grain ? { ...(grade ? { grade } : {}), ...(grain ? { grain } : {}) } : null };
    onCommands([command], describeTimelineCommand(command));
  };
  return (
    <div className="fy-mixpanel" aria-label="Look">
      <div className="fy-cutinspect__eyebrow">LOOK</div>
      <div className="fy-cutinspect__rows">
        <div className="fy-cutinspect__row fy-framestep" role="group" aria-label="Grade">
          <span>Grade</span>
          <strong>
            {GRADES.map(([grade, label]) => (
              <button key={label} type="button" className="fy-takepick__use" aria-label={`Grade ${label.toLowerCase()}`} aria-pressed={look?.grade === grade} disabled={disabled} onClick={() => set({ grade })}>
                {label}
              </button>
            ))}
          </strong>
        </div>
        <div className="fy-cutinspect__row fy-framestep" role="group" aria-label="Grain">
          <span>Grain</span>
          <strong>
            {GRAINS.map(([grain, label]) => (
              <button key={label} type="button" className="fy-takepick__use" aria-label={`Grain ${label.toLowerCase()}`} aria-pressed={look?.grain === grain} disabled={disabled} onClick={() => set({ grain })}>
                {label}
              </button>
            ))}
          </strong>
        </div>
      </div>
    </div>
  );
}

/** What a picture element wears under a grade. Only the picture: the cue and the controls over it keep their colour. */
export const lookPictureClass = (look: TimelinePictureLook | null | undefined): string | false => look?.grade === "film" && "fy-cutlook-film";

/** The grain, drawn after the picture and before whatever sits on it, so it lies over one and under the other. */
export function LookGrain({ look }: { look: TimelinePictureLook | null | undefined }) {
  return look?.grain ? <span className={`fy-cutlook-grain fy-cutlook-grain--${look.grain}`} aria-hidden="true" /> : null;
}
