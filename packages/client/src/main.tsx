import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./theme/tokens/colors.css";
import "./theme/tokens/typography.css";
import "./theme/tokens/spacing.css";
import "./theme/tokens/effects.css";
import "./theme/globals.css";
// Component styles are gathered here (not in component modules) so the node test runner can
// import the component graph without a CSS loader.
import "./components/ui.css";
import "./components/layout.css";
import "./domain/domain.css";
import "./screens/screens.css";
import "./screens/fidelity.css";
import { App } from "./App.js";
import { initStore } from "./lib/store.js";

initStore();

// Under the desktop shell the native frame is hidden and white overlay window controls sit
// in the top-right — in-app titlebars shift their own right-side content clear of them.
if ((window as { arke?: unknown }).arke !== undefined) {
  document.documentElement.classList.add("is-desktop");
}

// Hash routing so the same bundle works from Vite, file:// and the packaged app.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
