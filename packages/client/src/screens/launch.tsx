import { useEffect } from "react";
import { useNavigate } from "react-router";
import { Cloud, GraduationCap, Monitor, PlaySolid, Shield, Users, Book, Cog, Message } from "../components/icons.js";

/**
 * The launch screen (design master 75a).
 *
 * It sits ahead of everything — before the coordinator is waited on, before setup runs, before
 * any world is open. Two ways in, of which one is built. It is the only screen in the app that
 * does not theme: the plate is always the dark one, so every value it uses is theme-invariant
 * (see theme/tokens/launch.css for why the neutral ramp is the right tool here and
 * --foreground/--background are not).
 *
 * The screen remembers nothing. There is no skip-next-time, by decision rather than omission:
 * every launch asks, so the choice stays a choice while cloud is still becoming one.
 */

/** Lives in public/ rather than being imported, so it stays a plain file the bundler passes through. */
const PLATE = "./launch-plate.webp";

/**
 * Four destinations that do not exist yet. They are drawn because the screen is drawn, and
 * rendered as text rather than as buttons — a control that does nothing is worse than a label,
 * and the binding for 75a says so. They become buttons when they have somewhere to go.
 */
const FOOTER = [
  { label: "Documentation", Icon: Book },
  { label: "Learn", Icon: GraduationCap },
  { label: "Community", Icon: Message },
  { label: "Settings", Icon: Cog },
];

export function LaunchScreen() {
  const navigate = useNavigate();

  // The host paints the caption buttons; over this plate they have to be the dark ones in
  // every theme. Released on the way out so the rest of the app gets its own chrome back.
  useEffect(() => {
    window.arke?.chromeOverPlate?.(true);
    return () => window.arke?.chromeOverPlate?.(false);
  }, []);

  return (
    <div className="fy-app fy-launch" data-screen="launch">
      <img className="fy-launch__plate" src={PLATE} alt="" aria-hidden />
      {/* The window has no frame of its own here, so the top strip is what you drag it by. */}
      <div className="fy-launch__drag" aria-hidden />

      <div className="fy-launch__lockup">
        <div className="fy-launch__mark">
          <span className="fy-launch__bar" aria-hidden />
          <span className="fy-launch__streak" aria-hidden />
          <span className="fy-launch__flare" aria-hidden />
          <h1 className="fy-launch__wordmark">Arke Studio</h1>
        </div>
        <p className="fy-launch__tagline">Build worlds. Tell any story.</p>
      </div>

      <div className="fy-launch__ways">
        <section className="fy-launch__card">
          <span className="fy-launch__icon" aria-hidden>
            <Monitor size={56} />
          </span>
          <h2 className="fy-launch__title">Launch Locally</h2>
          <p className="fy-launch__body">
            Work on your worlds offline with
            <br />
            full power and privacy.
          </p>
          <button
            type="button"
            className="fy-launch__action"
            onClick={() => navigate("/starting", { replace: true })}
          >
            <PlaySolid size={15} />
            Launch Arke Studio
          </button>
          <p className="fy-launch__note">
            <Shield size={15} />
            Runs on this device
          </p>
        </section>

        <section className="fy-launch__card fy-launch__card--soon">
          <span className="fy-launch__icon" aria-hidden>
            <Cloud size={56} />
          </span>
          <h2 className="fy-launch__title">Arke Studio Cloud</h2>
          <p className="fy-launch__body">
            Access your worlds anywhere.
            <br />
            Sync, collaborate, create.
          </p>
          {/*
            Named, not offered. The card stays — the choice is the point of the screen — and the
            action carries the reason it cannot be taken rather than a tooltip that has to be
            hunted for.
          */}
          <button type="button" className="fy-launch__action fy-launch__action--off" disabled>
            <Cloud size={16} />
            Coming soon
          </button>
          <p className="fy-launch__note fy-launch__note--off">
            <Users size={15} />
            Sync across devices
          </p>
        </section>
      </div>

      <div className="fy-launch__foot">
        {FOOTER.map(({ label, Icon }, i) => (
          <span key={label} className="fy-launch__link-wrap">
            {i > 0 && <span className="fy-launch__sep" aria-hidden />}
            <span className="fy-launch__link">
              <Icon size={20} />
              {label}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
