import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
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
import "./screens/production-setup.css";
import "./screens/publications.css";
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
import "./screens/launch.css";
import "./screens/home.css";
import "./screens/world.css";
import "./screens/character-pages.css";
import "./screens/bible-canon.css";
import "./screens/chat-artifacts.css";
import "./screens/productions.css";
import "./screens/settings-adapters.css";
import "./screens/scene-workspace/workspace.css";
import "./screens/scene-workspace/shot-page.css";
import "./screens/branch-map.css";
// After fidelity.css: the panel re-dresses the provider-call inspector with a rule of equal
// specificity, and the later sheet wins.
import "./components/activity-panel.css";
import "./components/account-menu.css";
import { App } from "./App.js";
import { initStore } from "./lib/store.js";
import { isRemoteSession } from "./lib/remote-session.js";
import { RemoteEntry } from "./components/remote-entry.js";
import "./screens/remote-access.css";
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
  return route === "" || route === "/" || route === "/starting";
};
window.arke?.chromeOverPlate?.(onLaunchRoute());

initializeTheme();
if (!isRemoteSession()) initStore();

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
      {isRemoteSession() ? <RemoteEntry><App /></RemoteEntry> : <App />}
    </HashRouter>
  </StrictMode>,
);
import "./components/design-voice-dialog.css";
