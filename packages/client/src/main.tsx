import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
// The launch screen wordmark only (--font-wordmark). Two weights, because the lockup is two
// lines: the mark at 200 and the tagline at 300. Nothing else in the app uses this face.
import "@fontsource/jost/200.css";
import "@fontsource/jost/300.css";
import "./theme/tokens/colors.css";
import "./theme/tokens/typography.css";
import "./theme/tokens/spacing.css";
import "./theme/tokens/effects.css";
import "./theme/tokens/launch.css";
import "./theme/globals.css";
// Component styles are gathered here (not in component modules) so the node test runner can
// import the component graph without a CSS loader.
import "./components/ui.css";
import "./components/layout.css";
import "./components/toast.css";
import "./components/player.css";
import "./components/image-actions.css";
import "./components/editor/editor.css";
import "./domain/domain.css";
import "./screens/screens.css";
import "./screens/fidelity.css";
import { App } from "./App.js";
import { initStore } from "./lib/store.js";
import { initializeTheme } from "./lib/theme.js";

/*
 * Whether the first paint is the launch screen's dark plate, decided here rather than in the
 * screen's own effect.
 *
 * `initializeTheme()` signals theme-ready synchronously, before React mounts, and the host shows
 * the window on that signal — so a mount effect lands *after* the window is already up. On a
 * light-theme machine that is a white titlebar with dark caption symbols flashing over the plate
 * before flipping. Sending it from here puts it ahead of the show, and reading the route rather
 * than assuming it keeps a reload onto any other screen honest. The launch screen keeps its own
 * effect for the navigation that follows.
 */
const onLaunchRoute = (): boolean => {
  const route = window.location.hash.replace(/^#/, "");
  return route === "" || route === "/";
};
window.arke?.chromeOverPlate?.(onLaunchRoute());

initializeTheme();
initStore();

// Under the desktop shell the native frame is hidden and overlay window controls sit
// in the top-right — in-app titlebars shift their own right-side content clear of them.
if ((window as { arke?: unknown }).arke !== undefined) {
  document.documentElement.classList.add("is-desktop");
}

// A file dropped anywhere but a drop target would otherwise be *opened* — the window navigates
// to it and the studio is replaced by a picture of a bell tower, with no way back. The composer
// stops its own drops with preventDefault; this stops every other one.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => {
    if (!e.defaultPrevented) e.preventDefault();
  });
}

// Hash routing so the same bundle works from Vite, file:// and the packaged app.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
