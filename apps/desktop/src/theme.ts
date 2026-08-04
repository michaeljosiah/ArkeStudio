import type { ThemePreference } from "@arke-studio/contracts";

export type ResolvedTheme = "light" | "dark";

export interface ThemePalette {
  background: string;
  overlay: string;
  symbols: string;
}

export function resolveTheme(preference: ThemePreference, systemUsesDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemUsesDark ? "dark" : "light") : preference;
}

export function themePalette(theme: ResolvedTheme): ThemePalette {
  return theme === "dark"
    ? { background: "#0A0A0A", overlay: "#0A0A0A", symbols: "#FAFAFA" }
    : { background: "#FFFFFF", overlay: "#FFFFFF", symbols: "#0A0A0A" };
}
