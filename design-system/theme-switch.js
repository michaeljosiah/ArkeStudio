/*
 * Appearance for the design documents · System / Light / Dark.
 *
 * The same three-state contract the app ships in packages/client/src/lib/theme.ts:
 * `system` follows prefers-color-scheme live, an explicit light or dark ignores the OS
 * until the preference goes back to system, and the resolved theme is written to the root
 * as `.dark`, `data-theme` and `color-scheme` together. The app persists its preference
 * through the coordinator into %USERPROFILE%/ArkeStudio/settings.json; a static document
 * has no such boundary, so it keeps the choice in localStorage instead. Everything else
 * about the behaviour matches, deliberately: this control is how the design master proves
 * the screens re-theme from tokens alone.
 */
(() => {
  "use strict";

  // The dc runtime compiles the helmet again when it re-fetches the document, so a helmet
  // script can be appended to <head> more than once. Without this guard a second copy would
  // build a second control with its own closed-over state, and the two would disagree.
  if (window.__arkeThemeSwitchLoaded) return;
  window.__arkeThemeSwitchLoaded = true;

  const KEY = "arke-design-theme";
  const MEDIA = "(prefers-color-scheme: dark)";
  const OPTIONS = [
    { preference: "system", title: "System", detail: "Follow this machine" },
    { preference: "light", title: "Light", detail: "Always use the light theme" },
    { preference: "dark", title: "Dark", detail: "Always use the dark theme" },
  ];

  const media = window.matchMedia ? window.matchMedia(MEDIA) : null;
  let preference = read();
  let resolved = resolve(preference);

  function isPreference(value) {
    return value === "system" || value === "light" || value === "dark";
  }

  /** Unknown or malformed values fall back to system, as the app's schema does. */
  function read() {
    let stored = null;
    try {
      stored = window.localStorage.getItem(KEY);
    } catch {
      /* private mode, file:// with storage disabled — system is the right answer anyway */
    }
    return isPreference(stored) ? stored : "system";
  }

  function write(value) {
    try {
      window.localStorage.setItem(KEY, value);
    } catch {
      /* the preference simply does not survive a reload; the document still re-themes */
    }
  }

  function resolve(pref) {
    return pref === "system" ? (media && media.matches ? "dark" : "light") : pref;
  }

  function applyRoot(theme) {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    // The dc runtime paints the canvas behind the screens and listens for this message.
    window.postMessage({ type: "__dc_theme", theme }, "*");
  }

  function apply(pref, { persist } = { persist: false }) {
    preference = pref;
    resolved = resolve(pref);
    if (persist) write(pref);
    applyRoot(resolved);
    syncControl();
  }

  // Applied before first paint rather than from a mounted component, so the document never
  // flashes white on its way to dark — the same reason the app resolves theme in main.ts.
  applyRoot(resolved);

  if (media) {
    const onSystemThemeChanged = () => {
      if (preference === "system") apply("system");
    };
    if (media.addEventListener) media.addEventListener("change", onSystemThemeChanged);
    else media.addListener(onSystemThemeChanged);
  }

  let control = null;

  function syncControl() {
    if (!control) return;
    for (const button of control.querySelectorAll("button[data-preference]")) {
      const selected = button.dataset.preference === preference;
      button.setAttribute("aria-checked", String(selected));
      button.classList.toggle("is-selected", selected);
    }
    control.querySelector(".dv-theme__now").textContent = "currently " + resolved;
  }

  function buildControl() {
    control = document.createElement("div");
    control.className = "dv-theme";
    control.setAttribute("role", "radiogroup");
    control.setAttribute("aria-label", "Theme");
    control.innerHTML =
      '<div class="dv-theme__row">' +
      OPTIONS.map(
        (option) =>
          '<button type="button" role="radio" data-preference="' +
          option.preference +
          '" title="' +
          option.detail +
          '">' +
          option.title +
          "</button>",
      ).join("") +
      '</div><div class="dv-theme__now"></div>';
    control.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-preference]");
      if (button) apply(button.dataset.preference, { persist: true });
    });
    document.body.appendChild(control);
    syncControl();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildControl, { once: true });
  } else {
    buildControl();
  }

  // The prototype's own Settings → Appearance tab drives the document through this, so picking
  // a mode inside the mock does what picking it in the app does, rather than miming it.
  window.arkeDesignTheme = {
    set: (pref) => {
      if (isPreference(pref)) apply(pref, { persist: true });
    },
    preference: () => preference,
    resolved: () => resolved,
  };
})();
