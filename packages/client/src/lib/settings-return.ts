/**
 * Where Settings sends you when you leave (SPEC-042 R-6).
 *
 * The panel's close used to call `navigate("/worlds")` from wherever it was opened, so leaving
 * Settings from inside a production landed in the world picker — the one thing a modal promises
 * and the one it never did. The chrome's gear now records the route it was pressed from, and
 * pressing it again on a Settings surface goes back there.
 *
 * A module variable rather than router state: the route inside Settings changes on every tab,
 * and history state does not follow a NavLink, so anything carried in `location.state` was gone
 * by the second click.
 */
let returnTo: string | null = null;

export function rememberSettingsReturn(path: string): void {
  // Settings is never somewhere to return to — a second press would loop on itself.
  if (isSettingsPath(path)) return;
  returnTo = path;
}

/** Whether an address is inside Settings — the sheet's routes, which render over the screen tree. */
export function isSettingsPath(path: string): boolean {
  return path === "/settings" || path.startsWith("/settings/");
}

/**
 * The route to leave to, or the world picker where nothing was remembered — a deep link, a fresh
 * launch. Since design turn 150 it is also what renders *behind* the sheet while Settings is up,
 * so leaving is a change of address and not a change of screen.
 */
export function settingsReturnPath(): string {
  return returnTo ?? "/worlds";
}

/** Tests only: the remembered route is process state, and one test must not leak into the next. */
export function __resetSettingsReturnForTest(): void {
  returnTo = null;
}
