import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountPerson, AccountState } from "@arke-studio/contracts";
import { ArrowUpRight, LoaderCircle, LogOut, User } from "./icons.js";
import { Avatar, Button, cx } from "./ui.js";
import {
  cancelAccountSignIn,
  createAccount,
  openAccountPage,
  signInAccount,
  signOutAccount,
  useStore,
} from "../lib/store.js";

/**
 * The Arke account in the chrome (design turn 151): the last control in the bar's right group,
 * and the menu under it.
 *
 * It is the one thing in the bar about the person rather than the screen, which is why it sits
 * at the end and why it is quiet when no one is signed in — no dot, no badge, nothing that
 * sells. The app is whole without an account (SPEC-025: it runs on a machine with no network
 * and no account), so the control is a door, not a notice. The one dot it ever wears is the
 * bell's warning, for a session that has expired, and it means what the bell's means.
 *
 * The menu holds account things only. Settings, theme, language and help each have a place
 * already — the gear is beside this — and one thing has one place. Anything that leaves the app
 * wears the ↗ and opens the system browser: the app draws no billing, no profile form and never
 * a password field. Sign-in is a browser handoff, as vendor sign-in is (SPEC-030); the state
 * lives in the coordinator and arrives as `app.account`, so every window agrees on who is in.
 */
export function AccountControl() {
  const { state } = useStore();
  const account: AccountState = state?.app.account ?? { kind: "signed-out", refusal: null };
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLButtonElement>(null);
  const expired = account.kind === "signed-in" && account.session === "expired";
  const close = useCallback(() => setOpen(false), []);
  return (
    <span className="fy-account">
      <button
        ref={control}
        type="button"
        className={cx("fy-iconbtn", "fy-account__control", open && "fy-iconbtn--current")}
        title={expired ? "Arke account — session expired" : "Arke account"}
        aria-label="Arke account"
        aria-haspopup="menu"
        aria-expanded={open}
        data-account-control=""
        onClick={() => setOpen((was) => !was)}
      >
        {account.kind === "signed-in" ? (
          <span className="fy-account__mark">
            <Picture person={account.person} />
          </span>
        ) : (
          <User size={13} />
        )}
        {expired && <span className="fy-iconbtn__dot" />}
      </button>
      {open && <AccountMenu account={account} control={control} close={close} />}
    </span>
  );
}

/**
 * The person's picture, or their initials when there is none — or when the address does not
 * load. The desktop's CSP admits only the page's own origin, data URLs and loopback, so a service
 * that hands the renderer a remote address gets a broken image; initials are what that shows as,
 * rather than the browser's torn-page glyph in the chrome (SPEC-025 R-27).
 */
function Picture({ person }: { person: AccountPerson }) {
  const [broken, setBroken] = useState<string | null>(null);
  const image = person.picture !== null && person.picture !== broken ? person.picture : undefined;
  return <Avatar name={person.name} image={image} onImageError={() => setBroken(person.picture)} />;
}

function AccountMenu({
  account,
  control,
  close,
}: {
  account: AccountState;
  control: React.RefObject<HTMLButtonElement | null>;
  close: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);

  // `role="menu"` promises the arrows work, Escape closes, and focus comes back where it left;
  // so they do. An outside press closes it too — the control is not outside, it is the toggle,
  // and taking its press here would close the menu a beat before its own handler reopened it.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
    const press = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || root.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-account-control]")) return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("keydown", key, true);
    const opener = control.current;
    return () => {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("keydown", key, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [close, control]);

  // A refusal is the one clause a rejected sign-in leaves; it belongs to the press that earned it
  // and goes with the menu, or a stale line would greet the next opening. Read at unmount and
  // only then: clearing on every change of state would cancel the handoff a press just began.
  const latest = useRef(account);
  latest.current = account;
  useEffect(
    () => () => {
      const last = latest.current;
      if (last.kind === "signed-out" && last.refusal !== null) cancelAccountSignIn();
    },
    [],
  );

  return (
    <div
      ref={root}
      className="fy-account__menu"
      role="menu"
      aria-label="Arke account"
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']")];
        const from = items.indexOf(document.activeElement as HTMLElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        // From outside the list — focus on the menu itself — down is the first item and up the last.
        const next = from === -1 ? (step === 1 ? 0 : items.length - 1) : (from + step + items.length) % items.length;
        items[next]?.focus();
      }}
    >
      {account.kind === "signed-in" ? <SignedIn account={account} /> : <SignedOut account={account} />}
    </div>
  );
}

function SignedOut({ account }: { account: Extract<AccountState, { kind: "signed-out" | "signing-in" }> }) {
  return (
    <>
      <div className="fy-account__title">Arke account</div>
      {account.kind === "signing-in" ? (
        <div className="fy-account__waiting">
          <span className="fy-account__state">
            <LoaderCircle size={13} />
            <span>waiting for the browser</span>
          </span>
          <button type="button" role="menuitem" className="fy-account__link" onClick={() => cancelAccountSignIn()}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          {account.refusal !== null && (
            <div className="fy-account__refusal">
              <span className="fy-account__state fy-account__state--warn">{account.refusal}</span>
            </div>
          )}
          <div className="fy-account__buttons">
            <Button variant="primary" role="menuitem" onClick={() => signInAccount()}>
              Sign in
              <ArrowUpRight size={12} />
            </Button>
            <Button variant="outline" role="menuitem" onClick={() => createAccount()}>
              Create account
              <ArrowUpRight size={12} />
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function SignedIn({ account }: { account: Extract<AccountState, { kind: "signed-in" }> }) {
  const { person, plan, session } = account;
  return (
    <>
      <div className="fy-account__who">
        <span className="fy-account__mark fy-account__mark--large">
          <Picture person={person} />
        </span>
        <div className="fy-account__lines">
          <div className="fy-account__name">{person.name}</div>
          <div className="fy-account__mail">{person.email}</div>
        </div>
      </div>
      <div className="fy-account__band">
        {session === "expired" ? (
          <div className="fy-account__row">
            <span className="fy-account__state fy-account__state--warn">session expired</span>
            <span className="fy-account__end">
              <button type="button" role="menuitem" className="fy-account__act" onClick={() => signInAccount()}>
                <span>Sign in</span>
                <ArrowUpRight size={12} />
              </button>
            </span>
          </div>
        ) : (
          <>
            <div className="fy-account__row">
              <span className="fy-account__label">Plan</span>
              <span className="fy-account__value">
                <span className="fy-account__badge">{plan.name}</span>
              </span>
              <span className="fy-account__end">
                {session === "offline" ? (
                  <span className="fy-account__state">offline</span>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    className="fy-account__act"
                    onClick={() => openAccountPage("plan")}
                  >
                    <span>{plan.paid ? "Manage" : "Upgrade"}</span>
                    <ArrowUpRight size={12} />
                  </button>
                )}
              </span>
            </div>
            <button
              type="button"
              role="menuitem"
              className="fy-account__row fy-account__row--item"
              onClick={() => openAccountPage("account")}
            >
              <span className="fy-account__value">Account</span>
              <span className="fy-account__end">
                <ArrowUpRight size={14} />
              </span>
            </button>
          </>
        )}
      </div>
      <div className="fy-account__band">
        <button
          type="button"
          role="menuitem"
          className="fy-account__row fy-account__row--item"
          onClick={() => signOutAccount()}
        >
          <LogOut size={14} />
          <span className="fy-account__value">Sign out</span>
        </button>
      </div>
    </>
  );
}
